import type { Employee } from '../../shared/types/entities.js';

/** What the mini-app may show an employee; the server enforces the same rules per request. */
export function capabilities(employee: Employee) {
  return {
    support: true,
    act_on_others: employee.role !== 'support',
    admin: employee.role === 'admin',
    operations: employee.role !== 'support',
  };
}
