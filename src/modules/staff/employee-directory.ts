import type { Sql } from '../../shared/db.js';

export async function listEmployees(db: Sql, org: string) {
    const result = await db.query('SELECT id,name,role,blocked,version FROM employees WHERE org_id=$1 ORDER BY name', [
        org,
    ]);

    return { items: result.rows };
}
