import { can } from '../../../../shared/access.js';
import { ensure } from '../../../../shared/errors.js';
import { emit, recordTicketEvent } from '../../../../shared/events.js';
import { findActiveEmployee } from '../../../../shared/staff.js';
import { assertMayTake, clearOffer } from '../../../routing/index.js';
import type { TicketCommandHandler } from '../command-context.js';

export const assign: TicketCommandHandler = async (tx, ctx, command) => {
    const { actor, ticket, body } = command;

    ensure(ticket.status === 'open', 'already_assigned');
    const assigneeId = typeof body.employee_id === 'string' ? body.employee_id : actor.id;
    const delegated = assigneeId !== actor.id;

    if (delegated) {
        ensure(can(actor, 'tickets.transfer_any'), 'forbidden', 403, 'Назначать обращения другим может руководитель.');
        ensure(await findActiveEmployee(tx, ctx.org, assigneeId), 'invalid_employee', 422);
    } else {
        await assertMayTake(tx, ctx.org, ticket, actor);
    }

    const offered = ticket.offered_to === assigneeId;

    await tx.query(
        "UPDATE tickets SET status='in_progress',assignee_id=$2,taken_at=coalesce(taken_at,now()) WHERE id=$1",
        [ticket.id, assigneeId],
    );

    await clearOffer(tx, ctx.org, ticket.id);

    await recordTicketEvent(tx, ctx.org, {
        ticketId: ticket.id,
        employeeId: assigneeId,
        kind: 'assigned',
        detail: { by: actor.id, offered },
    });

    if (delegated) {
        await emit(tx, ctx.org, {
            type: 'ticket.transferred',
            ticketId: ticket.id,
            payload: { from: actor.id },
            employeeId: assigneeId,
        });
    }
};
