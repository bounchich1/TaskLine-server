import { can } from '../../../../shared/access.js';
import type { Ctx } from '../../../../shared/context.js';
import { one, type Sql } from '../../../../shared/db.js';
import { ensure } from '../../../../shared/errors.js';
import { findActiveEmployee } from '../../../../shared/staff.js';
import { formatTicketNumber } from '../../../../shared/ticket-number.js';
import type { Ticket } from '../../../../shared/types/entities.js';
import { invalidateLearning } from '../../../learning/index.js';
import { addMessage } from '../../../messages/index.js';
import { cancelCycleDeliveries, queueBotMessage } from '../../../outbox/index.js';
import type { TicketCommand, TicketCommandHandler } from '../command-context.js';

export const reopen: TicketCommandHandler = async (tx, ctx, command) => {
    const { actor, client, ticket, body } = command;

    ensure(['awaiting_rating', 'closed'].includes(ticket.status), 'already_open');
    ensure(typeof body.reason === 'string' && body.reason.trim().length > 0, 'reason_required', 422);
    await ensureConversationSlotFree(tx, command);

    if (ticket.current_cycle_id) {
        await cancelCycleDeliveries(tx, ticket.current_cycle_id);
    }

    await invalidateLearning(tx, ctx, ticket.id, 'reopened');
    const assigneeId = await resolveAssignee(tx, ctx, command);

    await tx.query(
        `UPDATE tickets SET status='in_progress',assignee_id=$2,closed_at=NULL,closed_by=NULL,
       current_cycle_id=NULL,lifecycle=lifecycle+1,suggestion_stale=true
     WHERE id=$1`,
        [ticket.id, assigneeId],
    );

    await addMessage(tx, ctx, ticket, {
        author: 'system',
        authorId: actor.id,
        text: `Переоткрыто: ${body.reason}`,
        providerRef: null,
        state: 'internal',
    });

    await queueBotMessage(tx, ctx, {
        client,
        template: 'ticket_reopened',
        key: `reopened:${ticket.id}:${ticket.lifecycle + 1}`,
        ticket,
    });
};

async function ensureConversationSlotFree(tx: Sql, { client, ticket }: TicketCommand): Promise<void> {
    const conflict = await one<Ticket>(tx, "SELECT * FROM tickets WHERE client_id=$1 AND id<>$2 AND status<>'closed'", [
        client.id,
        ticket.id,
    ]);

    ensure(
        !conflict,
        'conversation_slot_conflict',
        409,
        `У клиента уже есть обращение №${formatTicketNumber(conflict?.ticket_number ?? '')}.`,
    );
}

async function resolveAssignee(tx: Sql, ctx: Ctx, { actor, body }: TicketCommand): Promise<string> {
    const assigneeId = typeof body.employee_id === 'string' ? body.employee_id : actor.id;

    ensure(assigneeId === actor.id || can(actor, 'tickets.reopen_any'), 'forbidden', 403);
    ensure(await findActiveEmployee(tx, ctx.org, assigneeId), 'invalid_employee', 422);

    return assigneeId;
}
