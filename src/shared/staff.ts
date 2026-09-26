import { permissionsOf } from './access.js';
import { one, type Sql } from './db.js';
import type { Employee } from './types/entities.js';

type EmployeeStatus = 'pending' | 'active' | 'blocked';

export const EMPLOYEE_STATUS_SQL =
    "CASE WHEN blocked THEN 'blocked' WHEN activated_at IS NULL THEN 'pending' ELSE 'active' END AS status";

export async function findActiveEmployee(tx: Sql, org: string, employeeId: unknown): Promise<Employee | undefined> {
    return one<Employee>(
        tx,
        'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked AND activated_at IS NOT NULL',
        [org, employeeId],
    );
}

function employeeStatus(employee: Pick<Employee, 'blocked' | 'activated_at'>): EmployeeStatus {
    if (employee.blocked) {
        return 'blocked';
    }

    return employee.activated_at === null ? 'pending' : 'active';
}

export function sessionProfile(employee: Employee) {
    return {
        employee: {
            id: employee.id,
            name: employee.name,
            role: employee.role,
            max_user_id: employee.max_user_id,
            status: employeeStatus(employee),
            version: employee.version,
        },
        permissions: permissionsOf(employee.role),
    };
}
