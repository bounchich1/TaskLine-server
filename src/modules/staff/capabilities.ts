import type { Employee } from '../../shared/types/entities.js';

export function capabilities(employee: Employee) {
  return {
    support: true,
    act_on_others: employee.role !== 'support',
    admin: employee.role === 'admin',
    operations: employee.role !== 'support',
  };
}
