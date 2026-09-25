import { one, type Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';

export type DictionaryDimension = 'tag' | 'urgency' | 'complexity';

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
    return one(tx, 'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active', [
        org,
        dimension,
        code,
    ]);
}

export async function findActiveDictionaryLabel(
    tx: Sql,
    org: string,
    dimension: DictionaryDimension,
    code: unknown,
): Promise<Row | undefined> {
    return one(tx, 'SELECT label,version FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active', [
        org,
        dimension,
        code,
    ]);
}

export async function listDictionaries(db: Sql, org: string) {
    const result = await db.query('SELECT * FROM dictionaries WHERE org_id=$1 ORDER BY dimension,rank DESC,code', [
        org,
    ]);

    return { items: result.rows };
}
