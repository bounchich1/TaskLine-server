import type { Sql } from '../../shared/db.js';

/** Colleagues for assignment and transfer pickers: no contact or MAX identifiers. */
export async function listEmployees(db: Sql, org: string) {
  const result = await db.query(
    'SELECT id,name,role,blocked,version FROM employees WHERE org_id=$1 ORDER BY name',
    [org],
  );
  return { items: result.rows };
}
