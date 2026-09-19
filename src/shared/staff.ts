import { one, type Sql } from './db.js';
import type { Employee, Ticket } from './types/entities.js';

// Staff authorization primitives shared by every module that acts on behalf of an employee.
// Callers keep their own error codes and messages, which differ by context.

export async function findActiveEmployee(
  tx: Sql,
  org: string,
  employeeId: unknown,
): Promise<Employee | undefined> {
  return one<Employee>(tx, 'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked', [
    org,
    employeeId,
  ]);
}

/** Supervisors and admins act on any ticket; support staff only on tickets assigned to them. */
export function canActOnTicket(actor: Employee, ticket: Pick<Ticket, 'assignee_id'>): boolean {
  return ticket.assignee_id === actor.id || actor.role !== 'support';
}
