import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

export const dictionaryBody = z
  .object({
    dimension: z.enum(['tag', 'urgency', 'complexity']),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(120),
    rank: z.number().int().min(0).max(100),
    active: z.boolean(),
  })
  .strict();

export type DictionaryBody = z.infer<typeof dictionaryBody>;

function isProtectedDefault({ dimension, code }: DictionaryBody): boolean {
  return (
    (dimension === 'tag' && code === 'undefined') || (dimension !== 'tag' && code === 'medium')
  );
}

export async function publishDictionaryEntry(
  tx: Sql,
  org: string,
  { body, expectedVersion }: { body: DictionaryBody; expectedVersion: number },
) {
  ensure(body.active || !isProtectedDefault(body), 'protected_default', 422);
  const old = await one(
    tx,
    'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 FOR UPDATE',
    [org, body.dimension, body.code],
  );
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
    `INSERT INTO dictionaries(org_id,dimension,code,label,rank,active) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(org_id,dimension,code)
     DO UPDATE SET label=$4,rank=$5,active=$6,version=dictionaries.version+1 RETURNING *`,
    [org, body.dimension, body.code, body.label, body.rank, body.active],
  );
}
