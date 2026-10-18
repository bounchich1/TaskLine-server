import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { ensure } from '../../shared/errors.js';
import { serverFile } from '../../shared/paths.js';

import { glossaryEntry, ruleText, toneSchema } from './profile-schema.js';

const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const description = z.string().max(200);
const example = z.string().min(1).max(100);

const presetTag = z
    .object({ code, label: z.string().min(1).max(120), description, examples: z.array(example).max(3) })
    .strict();

const presetLevel = z.object({ code, description }).strict();

const presetSchema = z
    .object({
        id: code,
        title: z.string().min(1).max(60),
        summary: z.string().min(1).max(160),
        profile: z
            .object({ tone: toneSchema, rules: z.array(ruleText).max(8), glossary: z.array(glossaryEntry).max(20) })
            .strict(),
        tags: z.array(presetTag).min(2).max(30),
        urgency: z.array(presetLevel),
        complexity: z.array(presetLevel),
    })
    .strict()
    .refine((preset) => preset.tags.some((tag) => tag.code === 'undefined'));

export type Preset = z.infer<typeof presetSchema>;
export type LevelDimension = 'urgency' | 'complexity';

export const LEVELS: Record<LevelDimension, { code: string; label: string }[]> = {
    urgency: [
        { code: 'low', label: 'Низкая' },
        { code: 'medium', label: 'Средняя' },
        { code: 'high', label: 'Высокая' },
        { code: 'critical', label: 'Критическая' },
    ],
    complexity: [
        { code: 'low', label: 'Низкая' },
        { code: 'medium', label: 'Средняя' },
        { code: 'high', label: 'Высокая' },
    ],
};

const PRESET_IDS = ['general', 'ecommerce', 'clinic', 'saas', 'telecom'] as const;

const PRESETS: readonly Preset[] = PRESET_IDS.map((id) =>
    presetSchema.parse(JSON.parse(readFileSync(serverFile(`presets/${id}.json`), 'utf8'))),
);

export function listPresets() {
    return PRESETS.map(({ id, title, summary, tags }) => ({
        id,
        title,
        summary,
        topics: tags.filter((tag) => tag.code !== 'undefined').map((tag) => tag.label),
    }));
}

export function findPreset(id: string): Preset {
    const preset = PRESETS.find((candidate) => candidate.id === id);

    ensure(preset, 'unknown_preset', 404, 'Такого отраслевого набора нет.');

    return preset;
}

export function tagRank(preset: Preset, index: number): number {
    return Math.min(100, preset.tags.length - 1 - index);
}
