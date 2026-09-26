import type { Sql } from '../../shared/db.js';
import { EMPLOYEE_STATUS_SQL } from '../../shared/staff.js';

export async function listEmployees(db: Sql, org: string) {
    const result = await db.query(
        `SELECT id,name,role,${EMPLOYEE_STATUS_SQL},version FROM employees WHERE org_id=$1 ORDER BY name`,
        [org],
    );

    return { items: result.rows };
}
