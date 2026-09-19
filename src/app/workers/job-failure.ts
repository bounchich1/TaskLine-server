import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';
import type { Job } from '../../shared/types/entities.js';

const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_SECONDS = 1800;
const DISABLED_RETRY_SECONDS = 60;

/** Waiting for capacity or configuration: retried without counting an attempt. */
const DEFERRED_CODES = [
  'ai_busy',
  'memory_writer_busy',
  'snapshot_waiting_files',
  'memory_disabled',
  'ai_disabled',
  'gateway_unavailable',
];
/** A remote side effect may have happened: never retried automatically. */
const UNCERTAIN_CODES = ['ai_uncertain', 'memory_write_unknown', 'memory_still_unknown'];
/** The job no longer applies (consent, reopen, newer generation). */
const SUPPRESSED_CODES = ['job_ineligible', 'job_stale'];
const DISABLED_CODES = ['memory_disabled', 'ai_disabled'];
/** Closure learning status for a learning job that ended without success. */
const LEARNING_STATUS = { canceled: 'suppressed', unknown: 'needs_review', failed: 'failed' };

export interface JobFailure {
  code: string;
  state: 'canceled' | 'unknown' | 'failed' | 'pending';
  retries: number;
  delaySeconds: number;
}

/** Decides what happens to a job whose run threw. Validation errors (422) fail at once. */
export function classifyJobFailure(error: unknown, previousRetries: number): JobFailure {
  const code = error instanceof AppError ? error.code : 'worker_error';
  const deferred = DEFERRED_CODES.includes(code);
  const retries = previousRetries + (deferred ? 0 : 1);
  const rejected = error instanceof AppError && error.status === 422;
  const delaySeconds = DISABLED_CODES.includes(code)
    ? DISABLED_RETRY_SECONDS
    : Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.min(retries + 1, 10));
  return {
    code,
    state: failureState(code, { deferred, retries, rejected }),
    retries,
    delaySeconds,
  };
}

function failureState(
  code: string,
  { deferred, retries, rejected }: { deferred: boolean; retries: number; rejected: boolean },
): JobFailure['state'] {
  if (SUPPRESSED_CODES.includes(code)) {
    return 'canceled';
  }
  if (UNCERTAIN_CODES.includes(code)) {
    return 'unknown';
  }
  if (!deferred && (retries >= MAX_ATTEMPTS || rejected)) {
    return 'failed';
  }
  return 'pending';
}

/**
 * Stores the failure (unless the job was reclaimed meanwhile) and surfaces final failures:
 * learning status on the closure, and "AI failed, review needed" on a triaged ticket.
 */
export async function recordJobFailure(
  tx: Sql,
  ctx: Ctx,
  { job, failure }: { job: Job; failure: JobFailure },
): Promise<void> {
  const { code, state, retries, delaySeconds } = failure;
  const updated = await tx.query(
    `UPDATE jobs SET state=$3,reason=$4,payload=jsonb_set(payload,'{retry_count}',$5::jsonb),
     due_at=now()+($6*interval '1 second')
     WHERE id=$1 AND generation=$2 AND state='running' RETURNING id`,
    [job.id, job.generation, state, code, JSON.stringify(retries), delaySeconds],
  );
  if (!updated.rows.length) {
    return;
  }
  if (job.kind === 'learning' && state !== 'pending') {
    await tx.query('UPDATE closures SET learning_status=$2 WHERE id=$1 AND NOT invalidated', [
      job.ref_id,
      LEARNING_STATUS[state],
    ]);
  }
  if (job.kind === 'triage' && state === 'failed') {
    await tx.query(
      "UPDATE tickets SET ai_status='failed',review_required=true WHERE id=$1 AND ai_status='pending'",
      [job.ref_id],
    );
    await emit(tx, ctx.org, { type: 'ticket.classified', ticketId: job.ref_id });
  }
}
