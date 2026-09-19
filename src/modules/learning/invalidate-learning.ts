import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { enqueue } from '../../shared/events.js';

/**
 * A ticket's resolution may no longer be learned from (reopened, edited, consent withdrawn):
 * invalidate its closures, withdraw its memory records and cancel in-flight AI work for it.
 */
export async function invalidateLearning(
  tx: Sql,
  ctx: Ctx,
  ticketId: string,
  reason: string,
): Promise<void> {
  await tx.query(
    "UPDATE closures SET invalidated=true,learning_status='invalidated' WHERE ticket_id=$1",
    [ticketId],
  );
  const records = (
    await tx.query<{ id: string }>(
      'UPDATE memory_records SET eligible=false,reason=$2 WHERE ticket_id=$1 RETURNING id',
      [ticketId, reason],
    )
  ).rows;
  for (const record of records) {
    await enqueue(tx, ctx.org, {
      key: `memory-delete:${record.id}:${reason}`,
      kind: 'memory_delete',
      refId: record.id,
    });
  }
  await tx.query(
    `UPDATE jobs SET state='canceled',reason=$2
     WHERE (ref_id=$1 OR ref_id IN(SELECT id FROM closures WHERE ticket_id=$1))
       AND kind IN('triage','learning') AND state IN('pending','running')`,
    [ticketId, reason],
  );
}
