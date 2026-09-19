import type { Sql } from '../../shared/db.js';

// Two deliberately different variants: they cancel different sets and in a different order.

/** Cancels the unsent prompts of a rating cycle (the conversation shows them as cancelled). */
export async function cancelCycleDeliveries(tx: Sql, cycleId: string): Promise<void> {
  await tx.query(
    `UPDATE messages SET delivery_state='canceled'
     WHERE id IN (SELECT message_id FROM deliveries WHERE cycle_id=$1 AND state IN ('queued','retry_wait'))`,
    [cycleId],
  );
  await tx.query(
    "UPDATE deliveries SET state='canceled' WHERE cycle_id=$1 AND state IN ('queued','retry_wait')",
    [cycleId],
  );
}

/** Cancels everything still queued for a client (consent withdrawn). */
export async function cancelClientDeliveries(tx: Sql, clientId: string): Promise<void> {
  await tx.query(
    "UPDATE deliveries SET state='canceled' WHERE client_id=$1 AND state IN ('queued','retry_wait')",
    [clientId],
  );
  await tx.query(
    `UPDATE messages SET delivery_state='canceled'
     WHERE id IN(SELECT message_id FROM deliveries WHERE client_id=$1 AND state='canceled')`,
    [clientId],
  );
}
