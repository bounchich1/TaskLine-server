import { one, requireOne, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import type { Preset } from './presets.js';
import type { GlossaryEntry, ProfileBody } from './profile-schema.js';

type ProfileRow = {
    preset: string | null;
    description: string;
    offerings: string;
    tone: 'formal' | 'friendly';
    rules: string[];
    glossary: GlossaryEntry[];
    configured_at: string | null;
    version: number;
};

const COLUMNS = 'preset,description,offerings,tone,rules,glossary,configured_at,version';
const MAX_RULES = 8;
const MAX_GLOSSARY = 20;

const EMPTY_BRIEF = {
    version: 0,
    name: '',
    description: '',
    offerings: '',
    tone: 'formal',
    rules: [] as string[],
    glossary: [] as GlossaryEntry[],
};

function view({ configured_at: configuredAt, ...row }: ProfileRow) {
    return { ...row, configured: configuredAt !== null };
}

export async function ensureProfile(tx: Sql, org: string, preset: Preset | null): Promise<void> {
    await tx.query(
        `INSERT INTO business_profiles(org_id,preset,tone,rules,glossary) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
     ON CONFLICT DO NOTHING`,
        [
            org,
            preset?.id ?? null,
            preset?.profile.tone ?? 'formal',
            JSON.stringify(preset?.profile.rules ?? []),
            JSON.stringify(preset?.profile.glossary ?? []),
        ],
    );
}

export async function readProfile(db: Sql, org: string) {
    return view(await requireOne<ProfileRow>(db, `SELECT ${COLUMNS} FROM business_profiles WHERE org_id=$1`, [org]));
}

export async function saveProfile(
    tx: Sql,
    org: string,
    { body, expectedVersion }: { body: ProfileBody; expectedVersion: number },
) {
    const row = await one<ProfileRow>(
        tx,
        `UPDATE business_profiles SET description=$2,offerings=$3,tone=$4,rules=$5::jsonb,glossary=$6::jsonb,
       configured_at=CASE WHEN $7::boolean THEN coalesce(configured_at,now()) ELSE configured_at END,
       version=version+1
     WHERE org_id=$1 AND version=$8 RETURNING ${COLUMNS}`,
        [
            org,
            body.description,
            body.offerings,
            body.tone,
            JSON.stringify(body.rules),
            JSON.stringify(body.glossary),
            body.configured,
            expectedVersion,
        ],
    );

    ensure(row, 'version_conflict');

    return view(row);
}

function mergeRules(current: string[], added: string[]): string[] {
    return [...new Set([...current, ...added])].slice(0, MAX_RULES);
}

function mergeGlossary(current: GlossaryEntry[], added: GlossaryEntry[]): GlossaryEntry[] {
    const known = new Set(current.map((entry) => entry.term.toLowerCase()));

    return [...current, ...added.filter((entry) => !known.has(entry.term.toLowerCase()))].slice(0, MAX_GLOSSARY);
}

export async function adoptPresetProfile(tx: Sql, org: string, preset: Preset) {
    const current = await requireOne<ProfileRow>(
        tx,
        `SELECT ${COLUMNS} FROM business_profiles WHERE org_id=$1 FOR UPDATE`,
        [org],
    );

    const row = await requireOne<ProfileRow>(
        tx,
        `UPDATE business_profiles SET preset=$2,tone=$3,rules=$4::jsonb,glossary=$5::jsonb,version=version+1
     WHERE org_id=$1 RETURNING ${COLUMNS}`,
        [
            org,
            preset.id,
            current.configured_at ? current.tone : preset.profile.tone,
            JSON.stringify(mergeRules(current.rules, preset.profile.rules)),
            JSON.stringify(mergeGlossary(current.glossary, preset.profile.glossary)),
        ],
    );

    return view(row);
}

export async function businessBrief(db: Sql, org: string) {
    const row = await one<ProfileRow & { name: string }>(
        db,
        `SELECT o.name,coalesce(p.description,'') AS description,coalesce(p.offerings,'') AS offerings,
       coalesce(p.tone,'formal') AS tone,coalesce(p.rules,'[]') AS rules,coalesce(p.glossary,'[]') AS glossary,
       coalesce(p.version,0) AS version
     FROM organizations o LEFT JOIN business_profiles p ON p.org_id=o.id WHERE o.id=$1`,
        [org],
    );

    const { version, name, description, offerings, tone, rules, glossary } = row ?? EMPTY_BRIEF;

    return { version, brief: { name, description, offerings, tone, rules, glossary } };
}
