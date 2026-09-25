import { one, type Sql } from '../../../shared/db.js';
import type { Job } from '../../../shared/types/entities.js';

export async function eligibleJob(tx: Sql, org: string, job: Job): Promise<boolean> {
    if (job.kind === 'triage') {
        return !!(await one(
            tx,
            `SELECT t.id FROM tickets t JOIN clients c ON c.id=t.client_id
      WHERE t.id=$1 AND t.org_id=$2 AND t.status IN('open','in_progress') AND t.lifecycle=$3
      AND c.consent_state='granted' AND c.consent_revision=$4
      AND t.consent_revision=c.consent_revision AND t.ai_status='pending'
      AND t.created_at>now()-interval '120 seconds'`,
            [job.ref_id, org, job.payload.lifecycle, job.payload.consent_revision],
        ));
    }

    if (job.kind === 'learning') {
        return !!(await one(
            tx,
            `SELECT cl.id FROM closures cl JOIN tickets t ON t.id=cl.ticket_id
      JOIN clients c ON c.id=t.client_id
      WHERE cl.id=$1 AND cl.org_id=$2 AND NOT cl.invalidated AND cl.lifecycle=t.lifecycle
      AND t.current_cycle_id=cl.id AND c.consent_state='granted' AND c.consent_revision=$3
      AND t.consent_revision=c.consent_revision`,
            [job.ref_id, org, job.payload.consent_revision],
        ));
    }

    return false;
}
