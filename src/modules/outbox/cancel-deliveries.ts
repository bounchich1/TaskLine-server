import type { Sql } from '../../shared/db.js';

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
