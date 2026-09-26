import type { Employee, Ticket } from './types/entities.js';

export const ROLES = ['support', 'supervisor', 'admin'] as const;

export type Role = (typeof ROLES)[number];

const PERMISSIONS = [
    'tickets.view',
    'tickets.work',
    'tickets.classify_any',
    'tickets.reply_any',
    'tickets.transfer_any',
    'tickets.close_any',
    'tickets.reopen_any',
    'deliveries.resolve_unknown',
    'operations.view',
    'operations.retry',
    'employees.manage',
    'organization.configure',
    'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SUPPORT: readonly Permission[] = ['tickets.view', 'tickets.work'];

const SUPERVISOR: readonly Permission[] = [
    ...SUPPORT,
    'tickets.classify_any',
    'tickets.reply_any',
    'tickets.transfer_any',
    'tickets.close_any',
    'tickets.reopen_any',
    'deliveries.resolve_unknown',
    'operations.view',
    'operations.retry',
];

const ADMIN: readonly Permission[] = [...SUPERVISOR, 'employees.manage', 'organization.configure', 'audit.view'];

const ROLE_PERMISSIONS = new Map<string, ReadonlySet<Permission>>([
    ['support', new Set(SUPPORT)],
    ['supervisor', new Set(SUPERVISOR)],
    ['admin', new Set(ADMIN)],
]);

type Actor = Pick<Employee, 'id' | 'role'>;

export function can(actor: Pick<Employee, 'role'>, permission: Permission): boolean {
    return ROLE_PERMISSIONS.get(actor.role)?.has(permission) ?? false;
}

export function permissionsOf(role: string): Permission[] {
    return PERMISSIONS.filter((permission) => ROLE_PERMISSIONS.get(role)?.has(permission));
}

export function roleRank(role: string): number {
    return ROLES.indexOf(role as Role);
}

export type TicketAction = 'take' | 'classify' | 'reply' | 'transfer' | 'close' | 'reopen';

const ON_OTHERS_TICKET: Record<Exclude<TicketAction, 'take'>, Permission> = {
    classify: 'tickets.classify_any',
    reply: 'tickets.reply_any',
    transfer: 'tickets.transfer_any',
    close: 'tickets.close_any',
    reopen: 'tickets.reopen_any',
};

export function canOnTicket(actor: Actor, ticket: Pick<Ticket, 'assignee_id'>, action: TicketAction): boolean {
    if (!can(actor, 'tickets.work')) {
        return false;
    }

    if (action === 'take') {
        return true;
    }

    const own = ticket.assignee_id === actor.id || (action === 'classify' && ticket.assignee_id === null);

    return own || can(actor, ON_OTHERS_TICKET[action]);
}
