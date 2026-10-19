import { ensure } from '../../../../shared/errors.js';
import { emit, recordTicketEvent } from '../../../../shared/events.js';
import { findActiveEmployee } from '../../../../shared/staff.js';
import { addMessage } from '../../../messages/index.js';
import type { TicketCommandHandler } from '../command-context.js';

export const transfer: TicketCommandHandler = async (tx, ctx, command) => {
    const { actor, ticket, body } = command;

    ensure(ticket.status === 'in_progress', 'ticket_closed');
    const target = await findActiveEmployee(tx, ctx.org, body.employee_id);

    ensure(target, 'invalid_employee', 422);
    ensure(typeof body.comment === 'string' && body.comment.trim().length > 0, 'comment_required', 422);
    await tx.query('UPDATE tickets SET assignee_id=$2 WHERE id=$1', [ticket.id, target.id]);

    await recordTicketEvent(tx, ctx.org, {
        ticketId: ticket.id,
        employeeId: actor.id,
        kind: 'transferred',
        detail: { from: ticket.assignee_id, to: target.id },
    });

    await addMessage(tx, ctx, ticket, {
        author: 'system',
        authorId: actor.id,
        text: `Передано сотруднику ${target.name}. ${body.comment}`,
        providerRef: null,
        state: 'internal',
    });

    await emit(tx, ctx.org, {
        type: 'ticket.transferred',
        ticketId: ticket.id,
        payload: { from: actor.id, comment: body.comment.trim() },
        employeeId: target.id,
    });
};
