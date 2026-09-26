import { z } from 'zod';

import { ROLES, roleRank } from '../../shared/access.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { EMPLOYEE_STATUS_SQL } from '../../shared/staff.js';
import type { Employee } from '../../shared/types/entities.js';

const maxUserId = z.string().regex(/^\d{1,20}$/);
const name = z.string().trim().min(1).max(120);
const role = z.enum(ROLES);

export const newEmployeeBody = z.object({ max_user_id: maxUserId, name, role }).strict();

export const employeeChangesBody = z
    .object({
        max_user_id: maxUserId.optional(),
        name: name.optional(),
        role: role.optional(),
        blocked: z.boolean().optional(),
    })
    .strict()
    .refine((changes) => Object.keys(changes).length > 0, 'Nothing to change');

export type NewEmployee = z.infer<typeof newEmployeeBody>;

export type EmployeeChanges = z.infer<typeof employeeChangesBody>;

const RETURNING = `RETURNING id,max_user_id,name,role,blocked,activated_at,version,created_at,${EMPLOYEE_STATUS_SQL}`;

export async function createEmployee(tx: Sql, org: string, actor: Employee, body: NewEmployee) {
    assertAssignableRole(actor, body.role);
    await assertMaxIdFree(tx, org, body.max_user_id);

    return one(tx, `INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,$2,$3,$4) ${RETURNING}`, [
        org,
        body.max_user_id,
        body.name,
        body.role,
    ]);
}

export async function updateEmployee(
    tx: Sql,
    org: string,
    actor: Employee,
    { id, changes, expectedVersion }: { id: string; changes: EmployeeChanges; expectedVersion: number },
) {
    const target = await one<Employee>(tx, 'SELECT * FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE', [org, id]);

    ensure(target, 'not_found', 404);
    ensure(target.version === expectedVersion, 'version_conflict');
    const next = applyChanges(target, changes);

    assertMayChange(actor, target, next);

    if (next.max_user_id !== target.max_user_id) {
        await assertMaxIdFree(tx, org, next.max_user_id);
    }

    await tx.query('UPDATE staff_sessions SET revoked=true WHERE employee_id=$1', [id]);

    return one(
        tx,
        `UPDATE employees SET max_user_id=$3,name=$4,role=$5,blocked=$6,version=version+1
     WHERE org_id=$1 AND id=$2 ${RETURNING}`,
        [org, id, next.max_user_id, next.name, next.role, next.blocked],
    );
}

function applyChanges(target: Employee, changes: EmployeeChanges): Employee {
    return {
        ...target,
        max_user_id: changes.max_user_id ?? target.max_user_id,
        name: changes.name ?? target.name,
        role: changes.role ?? target.role,
        blocked: changes.blocked ?? target.blocked,
    };
}

function assertMayChange(actor: Employee, target: Employee, next: Employee): void {
    const identityChanged = next.max_user_id !== target.max_user_id;
    const accessChanged = next.role !== target.role || next.blocked !== target.blocked;

    if (target.id === actor.id) {
        ensure(
            !identityChanged && !accessChanged,
            'self_change_forbidden',
            403,
            'В своей учётной записи можно изменить только имя.',
        );

        return;
    }

    const pending = target.activated_at === null;

    ensure(
        pending || roleRank(target.role) < roleRank(actor.role),
        'employee_protected',
        403,
        'Нельзя изменить сотрудника с такой же или более высокой ролью.',
    );

    ensure(
        !identityChanged || pending,
        'employee_already_active',
        409,
        'Сотрудник уже вошёл в приложение, MAX ID больше нельзя изменить.',
    );

    assertAssignableRole(actor, next.role);
}

function assertAssignableRole(actor: Employee, role: string): void {
    ensure(roleRank(role) <= roleRank(actor.role), 'forbidden', 403, 'Нельзя назначить роль выше своей.');
}

async function assertMaxIdFree(tx: Sql, org: string, maxId: string): Promise<void> {
    const taken = await one(tx, 'SELECT id FROM employees WHERE org_id=$1 AND max_user_id=$2', [org, maxId]);

    ensure(!taken, 'max_id_taken', 409, 'Сотрудник с таким MAX ID уже есть.');
}
