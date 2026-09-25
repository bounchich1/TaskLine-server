import { one, type Sql } from './db.js';
import type { Employee, Ticket } from './types/entities.js';

export async function findActiveEmployee(tx: Sql, org: string, employeeId: unknown): Promise<Employee | undefined> {
    return one<Employee>(tx, 'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked', [org, employeeId]);
}

export function canActOnTicket(actor: Employee, ticket: Pick<Ticket, 'assignee_id'>): boolean {
    return ticket.assignee_id === actor.id || actor.role !== 'support';
}
