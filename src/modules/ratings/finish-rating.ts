import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { emit } from '../../shared/events.js';
import type { Client, Closure, Ticket } from '../../shared/types/entities.js';
import { cancelCycleDeliveries, queueBotMessage } from '../outbox/index.js';

export interface UnratedFinish {
  client: Client;
  ticket: Ticket;
  cycle: Closure;
  /** Why no rating was recorded, e.g. 'expired' or 'attempts_exhausted'. */
  reason: string;
  /** Source key used to derive the final bot message's logical key. */
  key: string;
}

/** Closes a ticket whose rating cycle ended without a valid rating. */
export async function finishRating(tx: Sql, ctx: Ctx, finish: UnratedFinish): Promise<void> {
  const { client, ticket, cycle, reason } = finish;
  await tx.query('UPDATE closures SET finished_reason=$2 WHERE id=$1', [cycle.id, reason]);
  await tx.query("UPDATE tickets SET status='closed',version=version+1 WHERE id=$1", [ticket.id]);
  await cancelCycleDeliveries(tx, cycle.id);
  await queueBotMessage(tx, ctx, {
    client,
    template: reason === 'attempts_exhausted' ? 'rating_attempts_exhausted' : 'rating_expired',
    key: `final:${finish.key}`,
    ticket,
  });
  await emit(tx, ctx.org, 'rating.expired', ticket.id, { reason });
}
