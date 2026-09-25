import { PreconsentExpiry } from '../../modules/consent/index.js';
import { RatingTimers } from '../../modules/ratings/index.js';
import type { Ctx } from '../../shared/context.js';
import type { Database, Sql } from '../../shared/db.js';
import { emit } from '../../shared/events.js';

export async function runMaintenance(db: Database, ctx: Ctx): Promise<void> {
  await new RatingTimers(db, ctx.config).run();
  await new PreconsentExpiry(db, ctx.config).run();
  await db.tx(async (tx) => {
    await expireOverdueTriage(tx, ctx);
    await recoverAbandonedWork(tx, ctx);
    await pruneExpiredRows(tx);
  });
}

async function expireOverdueTriage(tx: Sql, ctx: Ctx): Promise<void> {
  const { rows: expired } = await tx.query<{ id: string }>(
    `UPDATE tickets SET ai_status='failed',review_required=true,version=version+1
     WHERE org_id=$1 AND ai_status='pending' AND created_at<=now()-interval '120 seconds' RETURNING id`,
    [ctx.org],
  );
  for (const ticket of expired) {
    await tx.query(
      `UPDATE jobs SET state='canceled',reason='triage_deadline'
       WHERE kind='triage' AND ref_id=$1 AND state IN('pending','running')`,
      [ticket.id],
    );
    await emit(tx, ctx.org, { type: 'ticket.classified', ticketId: ticket.id });
  }
}

async function recoverAbandonedWork(tx: Sql, ctx: Ctx): Promise<void> {
  await tx.query(
    "UPDATE ai_permits SET state='uncertain' WHERE state='running' AND started_at<now()-interval '3 minutes'",
  );
  await tx.query(
    `UPDATE ai_calls SET state='uncertain',reason='gateway_lost'
     WHERE state='running' AND started_at<now()-interval '3 minutes'`,
  );
  await tx.query(
    `UPDATE jobs SET state='pending',due_at=now(),reason='worker_recovery'
     WHERE org_id=$1 AND state='running' AND claimed_at<now()-interval '5 minutes'`,
    [ctx.org],
  );
}

async function pruneExpiredRows(tx: Sql): Promise<void> {
  await tx.query("DELETE FROM download_grants WHERE expires_at<now()-interval '1 hour'");
  await tx.query("DELETE FROM callback_actions WHERE expires_at<now()-interval '1 day'");
  await tx.query("DELETE FROM staff_sessions WHERE expires_at<now()-interval '1 day'");
  await tx.query("DELETE FROM command_keys WHERE created_at<now()-interval '7 days'");
  await tx.query("DELETE FROM ui_events WHERE created_at<now()-interval '7 days'");
  await tx.query(
    "UPDATE memory_records SET eligible=false,reason='expired' WHERE expires_at<now() AND eligible",
  );
}
