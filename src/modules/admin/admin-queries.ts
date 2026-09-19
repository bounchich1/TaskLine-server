import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

// Read side of the admin console, plus the operations "retry job" action.

/** Unlike the staff directory, includes MAX identifiers for account management. */
export async function listAllEmployees(db: Sql, org: string) {
  const result = await db.query('SELECT * FROM employees WHERE org_id=$1 ORDER BY name', [org]);
  return { items: result.rows };
}

export async function listTemplates(db: Sql, org: string) {
  const result = await db.query(
    'SELECT code,body,version FROM templates WHERE org_id=$1 ORDER BY code',
    [org],
  );
  return { items: result.rows };
}

export async function readSettings(db: Sql, org: string) {
  return one(db, 'SELECT name,timezone,version FROM organizations WHERE id=$1', [org]);
}

export async function recentAudit(db: Sql, org: string) {
  const result = await db.query(
    'SELECT * FROM audit WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',
    [org],
  );
  return { items: result.rows };
}

/** Requeues a failed job; only kinds that are safe to repeat (no AI calls, no client sends). */
export async function retryFailedJob(db: Sql, org: string, jobId: string): Promise<void> {
  const result = await db.query(
    `UPDATE jobs SET state='pending',due_at=now() WHERE org_id=$1 AND id=$2 AND state='failed'
     AND kind IN('file','scan','memory_delete','message_revision') RETURNING id`,
    [org, jobId],
  );
  ensure(result.rows.length, 'retry_not_allowed');
}
