import { one, type Sql } from '../../shared/db.js';
import { EMPLOYEE_STATUS_SQL } from '../../shared/staff.js';
import type { Employee } from '../../shared/types/entities.js';

export async function listEmployees(db: Sql, org: string) {
    const result = await db.query(
        `SELECT id,name,role,${EMPLOYEE_STATUS_SQL},version FROM employees WHERE org_id=$1 ORDER BY name`,
        [org],
    );

    return { items: result.rows };
}

export async function findActiveAdmin(db: Sql, org: string): Promise<Employee | undefined> {
    return one<Employee>(
        db,
        `SELECT * FROM employees WHERE org_id=$1 AND role='admin' AND NOT blocked AND activated_at IS NOT NULL
     ORDER BY created_at LIMIT 1`,
        [org],
    );
}
