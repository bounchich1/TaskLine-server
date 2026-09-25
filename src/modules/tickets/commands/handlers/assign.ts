import { ensure } from '../../../../shared/errors.js';
import type { TicketCommandHandler } from '../command-context.js';

export const assign: TicketCommandHandler = async (tx, _ctx, { actor, ticket }) => {
    ensure(ticket.status === 'open', 'already_assigned');

    await tx.query(
        "UPDATE tickets SET status='in_progress',assignee_id=$2,taken_at=coalesce(taken_at,now()) WHERE id=$1",
        [ticket.id, actor.id],
    );
};
