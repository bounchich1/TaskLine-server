import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { formatTicketNumber } from '../../shared/ticket-number.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { queueHistoryPage } from '../outbox/index.js';

const STATUS_LABELS: Record<Ticket['status'], string> = {
  open: 'Открыта',
  in_progress: 'В работе',
  awaiting_rating: 'Ожидает оценки',
  closed: 'Закрыта',
};

/** Replies to the client's history command with their 20 most recent tickets. */
export async function sendTicketHistory(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  sourceKey: string,
): Promise<void> {
  const tickets = (
    await tx.query<Ticket>(
      'SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 ORDER BY created_at DESC LIMIT 20',
      [ctx.org, client.id],
    )
  ).rows;
  const text = tickets.length
    ? tickets
        .map(
          (ticket) =>
            `№${formatTicketNumber(ticket.ticket_number)} — ${STATUS_LABELS[ticket.status]}`,
        )
        .join('\n')
    : 'У вас пока нет обращений.';
  await queueHistoryPage(tx, ctx, client, { sourceKey, text });
}
