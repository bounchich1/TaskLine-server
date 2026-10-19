import { can } from '../../shared/access.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee, Ticket } from '../../shared/types/entities.js';

export async function assertMayTake(tx: Sql, org: string, ticket: Ticket, actor: Employee): Promise<void> {
    const teamId = ticket.team_id;

    if (!teamId || ticket.offered_to === actor.id || can(actor, 'tickets.transfer_any')) {
        return;
    }

    const team = await one<{ allow_self_take: boolean }>(
        tx,
        'SELECT allow_self_take FROM teams WHERE org_id=$1 AND id=$2 AND archived_at IS NULL',
        [org, teamId],
    );

    ensure(
        !team || team.allow_self_take,
        'self_take_disabled',
        403,
        'В этой команде обращения назначаются автоматически. Дождитесь предложения или обратитесь к руководителю.',
    );
}
