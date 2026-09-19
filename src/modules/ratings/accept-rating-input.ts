import type { Ctx } from '../../shared/context.js';
import { requireOne, type Sql } from '../../shared/db.js';
import { emit } from '../../shared/events.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client, Closure, Ticket } from '../../shared/types/entities.js';
import { cancelCycleDeliveries, queueBotMessage } from '../outbox/index.js';

import { finishRating } from './finish-rating.js';
import { parseRating } from './parse-rating.js';

const MAX_INVALID_ATTEMPTS = 3;

export interface RatingInput {
  client: Client;
  /** A ticket in `awaiting_rating`, locked by the caller. */
  ticket: Ticket;
  input: ClientInput;
  receivedAt: string;
}

/** Interprets a client message sent while their ticket awaits a 1–10 rating. */
export async function acceptRatingInput(tx: Sql, ctx: Ctx, rating: RatingInput): Promise<void> {
  const { client, ticket, input } = rating;
  const cycle = await requireOne<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
    ticket.current_cycle_id,
  ]);
  if (new Date(rating.receivedAt).getTime() > new Date(cycle.expires_at).getTime()) {
    await finishRating(tx, ctx, { client, ticket, cycle, reason: 'expired', key: input.sourceKey });
    return;
  }
  const value = parseRating(input.text ?? '');
  if (value !== null && !input.attachments?.length) {
    await recordRating(tx, ctx, { client, ticket, cycle }, value);
    return;
  }
  await tx.query('UPDATE closures SET invalid_attempts=invalid_attempts+1 WHERE id=$1', [cycle.id]);
  if (cycle.invalid_attempts + 1 >= MAX_INVALID_ATTEMPTS) {
    await finishRating(tx, ctx, {
      client,
      ticket,
      cycle,
      reason: 'attempts_exhausted',
      key: input.sourceKey,
    });
  } else {
    await queueBotMessage(tx, ctx, {
      client,
      template: 'rating_invalid',
      key: `invalid:${input.sourceKey}`,
      ticket,
      cycleId: cycle.id,
    });
  }
}

async function recordRating(
  tx: Sql,
  ctx: Ctx,
  { client, ticket, cycle }: { client: Client; ticket: Ticket; cycle: Closure },
  value: number,
): Promise<void> {
  await tx.query(
    "UPDATE closures SET rating=$2,rated_at=now(),finished_reason='rated' WHERE id=$1 AND rating IS NULL",
    [cycle.id, value],
  );
  await tx.query("UPDATE tickets SET status='closed',version=version+1 WHERE id=$1", [ticket.id]);
  await cancelCycleDeliveries(tx, cycle.id);
  await queueBotMessage(tx, ctx, {
    client,
    template: 'rating_accepted',
    key: `rated:${cycle.id}`,
    ticket,
  });
  await emit(tx, ctx.org, {
    type: 'rating.received',
    ticketId: ticket.id,
    payload: { value },
    employeeId: String(cycle.closed_by),
  });
}
