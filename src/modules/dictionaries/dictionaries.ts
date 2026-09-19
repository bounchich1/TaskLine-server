import { one, type Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

export type DictionaryDimension = 'tag' | 'urgency' | 'complexity';

/** Active entries in the shape the AI triage snapshot (and its version hash) is built from. */
export async function snapshotActiveDictionaries(tx: Sql, org: string): Promise<Row[]> {
  const result = await tx.query(
    `SELECT dimension,code,label,rank,version FROM dictionaries
     WHERE org_id=$1 AND active ORDER BY dimension,code`,
    [org],
  );
  return result.rows;
}

export async function findActiveDictionaryEntry(
  tx: Sql,
  org: string,
  dimension: DictionaryDimension,
  code: unknown,
): Promise<Row | undefined> {
  return one(
    tx,
    'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active',
    [org, dimension, code],
  );
}
