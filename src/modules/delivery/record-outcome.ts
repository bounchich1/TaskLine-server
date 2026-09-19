import { emit } from '../../shared/events.js';

import type { ClaimedDelivery } from './claim.js';
import type { DeliveryDeps } from './delivery.js';
import type { SendOutcome } from './send.js';

/**
 * Stores the send result unless the delivery changed hands meanwhile (a newer generation, or
 * the stale-send sweep marked it unknown), and mirrors it onto the chat message.
 */
export async function recordOutcome(
  { db, ctx }: DeliveryDeps,
  { delivery, client }: ClaimedDelivery,
  outcome: SendOutcome,
): Promise<void> {
  const { state, ref, reason, retryAfter } = outcome;
  await db.tx(async (tx) => {
    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client.id]);
    const updated = await tx.query(
      `UPDATE deliveries SET state=$3,provider_ref=$4,reason=$5,due_at=now()+($6*interval '1 second')
       WHERE id=$1 AND generation=$2 AND state='sending' RETURNING id`,
      [delivery.id, delivery.generation, state, ref, reason, retryAfter],
    );
    if (!updated.rows.length) {
      return;
    }
    if (delivery.message_id) {
      await tx.query(
        'UPDATE messages SET delivery_state=$2,provider_ref=coalesce($3,provider_ref) WHERE id=$1',
        [delivery.message_id, state, ref],
      );
    }
    if (delivery.ticket_id) {
      await emit(tx, ctx.org, 'delivery.changed', delivery.ticket_id, {
        message_id: delivery.message_id,
        state,
      });
    }
  });
}
