import { ensure } from '../../../../shared/errors.js';
import { releaseTicket } from '../../../routing/index.js';
import type { TicketCommandHandler } from '../command-context.js';

export const release: TicketCommandHandler = async (tx, ctx, { actor, ticket }) => {
    ensure(
        ticket.status === 'in_progress' && ticket.assignee_id,
        'ticket_not_in_progress',
        409,
        'Обращение не в работе.',
    );

    await releaseTicket(tx, ctx.org, {
        ticketId: ticket.id,
        employeeId: ticket.assignee_id,
        by: actor.id,
        reason: 'released',
    });
};

export const setTeam: TicketCommandHandler = async (tx, ctx, { actor, ticket, body }) => {
    ensure(['open', 'in_progress'].includes(ticket.status), 'ticket_closed');
    const teamId = typeof body.team_id === 'string' ? body.team_id : null;

    if (teamId) {
        const { rows } = await tx.query('SELECT id FROM teams WHERE org_id=$1 AND id=$2 AND archived_at IS NULL', [
            ctx.org,
            teamId,
        ]);

        ensure(rows.length, 'invalid_team', 422, 'Команда не найдена.');
    }

    await tx.query(
        `UPDATE tickets SET team_id=$2,routed_at=now(),offered_to=NULL,offered_at=NULL,offer_due_at=NULL,
       offer_skipped='{}' WHERE id=$1`,
        [ticket.id, teamId],
    );

    if (body.release === true && ticket.status === 'in_progress' && ticket.assignee_id) {
        await releaseTicket(tx, ctx.org, {
            ticketId: ticket.id,
            employeeId: ticket.assignee_id,
            by: actor.id,
            reason: 'team',
        });
    }
};
