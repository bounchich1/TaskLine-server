import { z } from 'zod';

import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';

export const employeeBody = z
  .object({
    max_user_id: z.string().regex(/^\d{1,20}$/),
    name: z.string().min(1).max(120),
    role: z.enum(['support', 'supervisor', 'admin']),
    blocked: z.boolean().default(false),
  })
  .strict();

export type EmployeeBody = z.infer<typeof employeeBody>;

export async function createEmployee(tx: Sql, org: string, body: EmployeeBody) {
  return one(
    tx,
    'INSERT INTO employees(org_id,max_user_id,name,role,blocked) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [org, body.max_user_id, body.name, body.role, body.blocked],
  );
}

/**
 * Updates an employee. The last active administrator cannot be demoted or blocked, and any
 * change ends the employee's sessions (their permissions may have changed).
 */
export async function updateEmployee(
  tx: Sql,
  org: string,
  { id, body, expectedVersion }: { id: string; body: EmployeeBody; expectedVersion: number },
) {
  const old = await one<Employee>(
    tx,
    'SELECT * FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [org, id],
  );
  ensure(old, 'not_found', 404);
  ensure(old.version === expectedVersion, 'version_conflict');
  if (old.role === 'admin' && !old.blocked && (body.role !== 'admin' || body.blocked)) {
    await ensureAnotherAdminRemains(tx, org, id);
  }
  await tx.query('UPDATE staff_sessions SET revoked=true WHERE employee_id=$1', [id]);
  return one(
    tx,
    `UPDATE employees SET name=$3,role=$4,blocked=$5,version=version+1
     WHERE org_id=$1 AND id=$2 RETURNING *`,
    [org, id, body.name, body.role, body.blocked],
  );
}

async function ensureAnotherAdminRemains(tx: Sql, org: string, employeeId: string) {
  const others = await one(
    tx,
    `SELECT count(*)::int AS n FROM employees
     WHERE org_id=$1 AND role='admin' AND NOT blocked AND id<>$2`,
    [org, employeeId],
  );
  ensure(Number(others?.n) > 0, 'last_admin');
}
