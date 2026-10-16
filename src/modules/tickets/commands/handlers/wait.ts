import { ensure } from '../../../../shared/errors.js';
import { pauseSla, resumeSla } from '../../../sla/index.js';
import type { TicketCommandHandler } from '../command-context.js';

export const wait: TicketCommandHandler = async (tx, _ctx, { ticket }) => {
    ensure(ticket.status === 'in_progress', 'ticket_closed');
    ensure(!ticket.waiting_since, 'already_waiting', 409, 'Обращение уже ждёт ответа клиента.');

    await pauseSla(tx, ticket.id);
};

export const resume: TicketCommandHandler = async (tx, ctx, { ticket }) => {
    ensure(ticket.status === 'in_progress', 'ticket_closed');
    ensure(ticket.waiting_since, 'not_waiting', 409, 'Обращение не ждёт ответа клиента.');

    await resumeSla(tx, ctx.org, ticket);
};
