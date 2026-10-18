import type { Sql } from '../../shared/db.js';
import { adoptPresetProfile, LEVELS, tagRank, type LevelDimension, type Preset } from '../business/index.js';

import { publishDictionaryEntry, type DictionaryEntry } from './dictionaries.js';

interface StoredEntry {
    dimension: DictionaryEntry['dimension'];
    code: string;
    label: string;
    rank: number;
    active: boolean;
    description: string;
    examples: string[];
    version: number;
}

const LEVEL_DIMENSIONS: LevelDimension[] = ['urgency', 'complexity'];

function presetEntries(preset: Preset, stored: StoredEntry[]): DictionaryEntry[] {
    const tags = preset.tags.map((tag, index): DictionaryEntry => ({
        dimension: 'tag',
        ...tag,
        rank: tagRank(preset, index),
        active: true,
    }));

    const levels = LEVEL_DIMENSIONS.flatMap((dimension) =>
        LEVELS[dimension].map(({ code, label }, rank): DictionaryEntry => {
            const current = stored.find((entry) => entry.dimension === dimension && entry.code === code);
            const description = preset[dimension].find((level) => level.code === code)?.description ?? '';

            return {
                dimension,
                code,
                label: current?.label ?? label,
                rank: current?.rank ?? rank,
                active: current?.active ?? true,
                description,
                examples: current?.examples ?? [],
            };
        }),
    );

    return [...tags, ...levels];
}

function retiredTags(preset: Preset, stored: StoredEntry[]): StoredEntry[] {
    const kept = new Set(preset.tags.map((tag) => tag.code));

    return stored.filter((entry) => entry.dimension === 'tag' && entry.active && !kept.has(entry.code));
}

function changed(entry: DictionaryEntry, current: StoredEntry): boolean {
    return (
        entry.label !== current.label ||
        entry.rank !== current.rank ||
        entry.active !== current.active ||
        entry.description !== current.description ||
        JSON.stringify(entry.examples) !== JSON.stringify(current.examples)
    );
}

async function storedEntries(db: Sql, org: string, lock: boolean): Promise<StoredEntry[]> {
    const { rows } = await db.query<StoredEntry & Record<string, unknown>>(
        `SELECT dimension,code,label,rank,active,description,examples,version FROM dictionaries
     WHERE org_id=$1 ORDER BY dimension,code${lock ? ' FOR UPDATE' : ''}`,
        [org],
    );

    return rows;
}

function plan(preset: Preset, stored: StoredEntry[]) {
    const find = (entry: DictionaryEntry) =>
        stored.find((current) => current.dimension === entry.dimension && current.code === entry.code);

    const entries = presetEntries(preset, stored);
    const added = entries.filter((entry) => !find(entry));

    const updated = entries.filter((entry) => {
        const current = find(entry);

        return current !== undefined && changed(entry, current);
    });

    return { entries, added, updated, retired: retiredTags(preset, stored), find };
}

export async function previewPreset(db: Sql, org: string, preset: Preset) {
    const { added, updated, retired } = plan(preset, await storedEntries(db, org, false));

    const tagLabels = (entries: { dimension: string; label: string }[]) =>
        entries.filter((entry) => entry.dimension === 'tag').map((entry) => entry.label);

    return {
        id: preset.id,
        title: preset.title,
        add: tagLabels(added),
        update: tagLabels(updated),
        deactivate: tagLabels(retired),
        levels_described: updated.some((entry) => entry.dimension !== 'tag'),
    };
}

export async function applyPreset(tx: Sql, org: string, preset: Preset) {
    const { added, updated, retired, find } = plan(preset, await storedEntries(tx, org, true));

    for (const entry of [...added, ...updated]) {
        await publishDictionaryEntry(tx, org, { body: entry, expectedVersion: find(entry)?.version ?? 0 });
    }

    for (const entry of retired) {
        await publishDictionaryEntry(tx, org, {
            body: { ...entry, active: false },
            expectedVersion: entry.version,
        });
    }

    return { profile: await adoptPresetProfile(tx, org, preset) };
}
