import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import { codeFromLabel } from './dictionary-code.js';

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export const dictionaryBody = z
    .object({
        dimension: z.enum(['tag', 'urgency', 'complexity']),
        code: z.string().regex(CODE).optional(),
        label: z.string().trim().min(1).max(120),
        rank: z.number().int().min(0).max(100),
        active: z.boolean(),
        description: z.string().trim().max(200).optional(),
        examples: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
    })
    .strict();

export type DictionaryBody = z.infer<typeof dictionaryBody>;
export type DictionaryEntry = DictionaryBody & { code: string };

function isProtectedDefault({ dimension, code }: DictionaryEntry): boolean {
    return (dimension === 'tag' && code === 'undefined') || (dimension !== 'tag' && code === 'medium');
}

export async function newDictionaryCode(tx: Sql, org: string, body: DictionaryBody): Promise<string> {
    const base = codeFromLabel(body.label);

    const { rows } = await tx.query<{ code: string }>(
        'SELECT code FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND (code=$3 OR code LIKE $4)',
        [org, body.dimension, base, `${base}\\_%`],
    );

    const taken = new Set(rows.map((row) => row.code));
    let code = base;

    for (let suffix = 2; taken.has(code); suffix++) {
        code = `${base.slice(0, 60)}_${suffix}`;
    }

    return code;
}

export async function publishDictionaryEntry(
    tx: Sql,
    org: string,
    { body, expectedVersion }: { body: DictionaryEntry; expectedVersion: number },
) {
    ensure(body.active || !isProtectedDefault(body), 'protected_default', 422);

    const old = await one(tx, 'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 FOR UPDATE', [
        org,
        body.dimension,
        body.code,
    ]);

    ensure(old ? old.version === expectedVersion : expectedVersion === 0, 'version_conflict');

    if (old) {
        await tx.query(
            `UPDATE tickets SET classification_labels=jsonb_set(classification_labels,ARRAY[$2],$4::jsonb)
       WHERE org_id=$1 AND ${body.dimension}=$3 AND NOT classification_labels ? $2`,
            [org, body.dimension, body.code, JSON.stringify({ label: old.label, version: old.version })],
        );
    }

    return one(
        tx,
        `INSERT INTO dictionaries(org_id,dimension,code,label,rank,active,description,examples)
     VALUES($1,$2,$3,$4,$5,$6,coalesce($7,''),coalesce($8::text[],'{}'))
     ON CONFLICT(org_id,dimension,code)
     DO UPDATE SET label=$4,rank=$5,active=$6,description=coalesce($7,dictionaries.description),
       examples=coalesce($8::text[],dictionaries.examples),version=dictionaries.version+1 RETURNING *`,
        [
            org,
            body.dimension,
            body.code,
            body.label,
            body.rank,
            body.active,
            body.description ?? null,
            body.examples ?? null,
        ],
    );
}
