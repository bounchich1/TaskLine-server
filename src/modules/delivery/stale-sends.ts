import { emit } from '../../shared/events.js';

import type { DeliveryDeps } from './delivery.js';

/**
 * Sends stuck in `sending` for 5 minutes belong to a worker that died mid-send. Whether MAX got
 * the message is unknown, so they are never retried automatically; staff resolve them manually.
 */
export async function markStaleSendsUnknown({ db, ctx }: DeliveryDeps): Promise<void> {
  await db.tx(async (tx) => {
    const { rows } = await tx.query<{ message_id: string | null; ticket_id: string | null }>(
      `UPDATE deliveries SET state='unknown',reason='worker_lost' WHERE org_id=$1 AND state='sending'
       AND started_at<now()-interval '5 minutes' RETURNING message_id,ticket_id`,
      [ctx.org],
    );
    for (const row of rows) {
      if (row.message_id) {
        await tx.query("UPDATE messages SET delivery_state='unknown' WHERE id=$1", [
          row.message_id,
        ]);
      }
      if (row.ticket_id) {
        await emit(tx, ctx.org, {
          type: 'delivery.changed',
          ticketId: row.ticket_id,
          payload: { state: 'unknown' },
        });
      }
    }
  });
}
