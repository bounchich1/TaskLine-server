import { one, requireOne, type Sql } from '../../../../shared/db.js';
import { ensure } from '../../../../shared/errors.js';
import { enqueue } from '../../../../shared/events.js';
import type { Client, Closure, Ticket } from '../../../../shared/types/entities.js';
import { queueBotMessage } from '../../../outbox/index.js';
import { requireOwner, type TicketCommandHandler } from '../command-context.js';

/**
 * Close a ticket in work: opens a rating cycle (the client is asked for a 1–10 rating) and queues
 * learning from the resolution. Refused while replies or client input are still in flight.
 */
export const close: TicketCommandHandler = async (tx, ctx, command) => {
  const { actor, client, ticket, body } = command;
  requireOwner(command);
  ensure(ticket.status === 'in_progress', 'ticket_closed');
  await ensureNothingInFlight(tx, { client, ticket });
  const cycle = await requireOne<Closure>(
    tx,
    `INSERT INTO closures(org_id,ticket_id,cycle_no,lifecycle,cutoff_seq,closed_by,note)
     SELECT $1,$2,coalesce(max(cycle_no),0)+1,$3,$4,$5,$6 FROM closures WHERE ticket_id=$2
     RETURNING *`,
    [ctx.org, ticket.id, ticket.lifecycle, ticket.last_message_seq, actor.id, body.note ?? ''],
  );
  await tx.query(
    "UPDATE tickets SET status='awaiting_rating',closed_at=now(),closed_by=$2,current_cycle_id=$3 WHERE id=$1",
    [ticket.id, actor.id, cycle.id],
  );
  await queueBotMessage(tx, ctx, {
    client,
    template: 'ticket_closed',
    key: `closed:${cycle.id}`,
    ticket,
    cycleId: cycle.id,
  });
  await enqueue(tx, ctx.org, {
    key: `learning:${cycle.id}`,
    kind: 'learning',
    refId: cycle.id,
    payload: {
      lifecycle: ticket.lifecycle,
      consent_revision: client.consent_revision,
    },
  });
};

async function ensureNothingInFlight(
  tx: Sql,
  { client, ticket }: { client: Client; ticket: Ticket },
): Promise<void> {
  const pendingReply = await one(
    tx,
    `SELECT id FROM deliveries
     WHERE ticket_id=$1 AND kind='staff' AND state IN('queued','retry_wait','sending','unknown') LIMIT 1`,
    [ticket.id],
  );
  ensure(
    !pendingReply,
    'delivery_pending',
    409,
    'Дождитесь доставки ответов или отмените отправку.',
  );
  const pendingInput = await one(
    tx,
    "SELECT id FROM inbox WHERE client_id=$1 AND state='pending' LIMIT 1",
    [client.id],
  );
  ensure(
    !pendingInput,
    'input_pending',
    409,
    'Обрабатывается новое сообщение клиента. Повторите закрытие.',
  );
}
