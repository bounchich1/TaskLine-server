import type { Sql } from '../../shared/db.js';

export async function adminDiagnostics(db: Sql, org: string) {
  const [jobs, deliveries, memory, permits] = await Promise.all([
    db.query(
      `SELECT id,kind,ref_id,state,attempts,reason,created_at,due_at FROM jobs
       WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [org],
    ),
    db.query(
      `SELECT id,ticket_id,message_id,kind,state,attempts,reason,created_at FROM deliveries
       WHERE org_id=$1 AND state NOT IN('delivered','canceled') ORDER BY created_at LIMIT 100`,
      [org],
    ),
    db.query(
      `SELECT id,ticket_id,closure_id,state,eligible,reason,created_at FROM memory_records
       WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [org],
    ),
    db.query('SELECT slot,state,started_at FROM ai_permits ORDER BY slot'),
  ]);
  return {
    jobs: jobs.rows,
    deliveries: deliveries.rows,
    memory: memory.rows,
    permits: permits.rows,
  };
}
