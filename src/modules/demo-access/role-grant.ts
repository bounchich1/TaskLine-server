import type { Role } from '../../shared/access.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { audit, emit } from '../../shared/events.js';
import type { Employee } from '../../shared/types/entities.js';

export type GrantOutcome = 'created' | 'changed' | 'unchanged' | 'blocked';

export interface RoleRequest {
    userId: string;
    name: string;
    role: Role;
}

export async function grantRole(tx: Sql, org: string, request: RoleRequest): Promise<GrantOutcome> {
    await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [org]);

    const employee = await one<Employee>(tx, 'SELECT * FROM employees WHERE org_id=$1 AND max_user_id=$2 FOR UPDATE', [
        org,
        request.userId,
    ]);

    if (employee?.blocked) {
        return 'blocked';
    }

    if (employee?.role === request.role) {
        return 'unchanged';
    }

    const id = employee ? await changeRole(tx, employee, request.role) : await createEmployee(tx, org, request);

    await audit(tx, org, {
        actor: id,
        action: 'employee.demo_role',
        objectId: id,
        detail: { role: request.role, previous: employee?.role ?? null },
    });

    await emit(tx, org, { type: 'admin.changed', ticketId: null, payload: { route: 'employee.demo_role' } });

    return employee ? 'changed' : 'created';
}

async function createEmployee(tx: Sql, org: string, { userId, name, role }: RoleRequest): Promise<string> {
    const created = await requireOne<{ id: string }>(
        tx,
        'INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',
        [org, userId, name, role],
    );

    return created.id;
}

async function changeRole(tx: Sql, employee: Employee, role: Role): Promise<string> {
    await tx.query('UPDATE staff_sessions SET revoked=true WHERE employee_id=$1', [employee.id]);
    await tx.query('UPDATE employees SET role=$2,version=version+1 WHERE id=$1', [employee.id, role]);

    return employee.id;
}
