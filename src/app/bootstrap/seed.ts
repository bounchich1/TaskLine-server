import { ensureProfile, findPreset, LEVELS, tagRank, type Preset } from '../../modules/business/index.js';
import { ensureSlaDefaults } from '../../modules/sla/index.js';
import { DEFAULT_TEMPLATES } from '../../modules/templates/index.js';
import type { Config } from '../../shared/config.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export async function seed(db: Database, config: Config): Promise<void> {
    await db.tx(async (tx) => {
        await tx.query('INSERT INTO organizations(id,name,timezone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
            config.ORG_ID,
            config.ORG_NAME,
            config.ORG_TIMEZONE,
        ]);

        await tx.query('INSERT INTO ai_settings(id,cap) VALUES(1,$1) ON CONFLICT DO NOTHING', [
            config.AI_MAX_CONCURRENCY,
        ]);

        await ensureTicketSequence(tx, config.ORG_ID);
        await tx.query('INSERT INTO memory_writer(org_id) VALUES($1) ON CONFLICT DO NOTHING', [config.ORG_ID]);
        await seedBusiness(tx, config);
        await ensureSlaDefaults(tx, config.ORG_ID);

        for (const [code, body] of Object.entries(DEFAULT_TEMPLATES)) {
            await tx.query('INSERT INTO templates(org_id,code,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
                config.ORG_ID,
                code,
                body,
            ]);
        }
    });
}

async function seedBusiness(tx: Sql, config: Config): Promise<void> {
    const preset = findPreset(config.ORG_PRESET);
    const seeded = await one(tx, 'SELECT 1 AS found FROM dictionaries WHERE org_id=$1 LIMIT 1', [config.ORG_ID]);

    if (!seeded) {
        await seedDictionary(tx, config.ORG_ID, preset);
    }

    await ensureProfile(tx, config.ORG_ID, seeded ? null : preset);
}

async function seedDictionary(tx: Sql, org: string, preset: Preset): Promise<void> {
    const entries = [
        ...preset.tags.map((tag, index) => ({ dimension: 'tag', ...tag, rank: tagRank(preset, index) })),
        ...(['urgency', 'complexity'] as const).flatMap((dimension) =>
            LEVELS[dimension].map(({ code, label }, rank) => ({
                dimension,
                code,
                label,
                rank,
                description: preset[dimension].find((level) => level.code === code)?.description ?? '',
                examples: [],
            })),
        ),
    ];

    for (const { dimension, code, label, rank, description, examples } of entries) {
        await tx.query(
            `INSERT INTO dictionaries(org_id,dimension,code,label,rank,description,examples)
       VALUES($1,$2,$3,$4,$5,$6,$7::text[]) ON CONFLICT DO NOTHING`,
            [org, dimension, code, label, rank, description, examples],
        );
    }
}

const SHARED_SEQUENCE = 'ticket_number_seq';

async function ensureTicketSequence(tx: Sql, org: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(7136002)');
    const own = await requireOne(tx, 'SELECT ticket_sequence FROM organizations WHERE id=$1', [org]);

    const sharedWithOthers = await one(
        tx,
        'SELECT 1 AS taken FROM organizations WHERE id<>$1 AND ticket_sequence=$2 LIMIT 1',
        [org, SHARED_SEQUENCE],
    );

    if (own.ticket_sequence !== SHARED_SEQUENCE || !sharedWithOthers) {
        return;
    }

    ensure(/^[\da-f-]{36}$/.test(org), 'invalid_org_id', 422);
    const name = `${SHARED_SEQUENCE}_${org.replaceAll('-', '')}`;

    const next = await requireOne(tx, 'SELECT coalesce(max(ticket_number),0)+1 AS n FROM tickets WHERE org_id=$1', [
        org,
    ]);

    await tx.query(
        `CREATE SEQUENCE IF NOT EXISTS ${name} MINVALUE 1 MAXVALUE 2147483647 START ${Number(next.n)} NO CYCLE CACHE 1`,
    );

    await tx.query('UPDATE organizations SET ticket_sequence=$2 WHERE id=$1', [org, name]);
}
