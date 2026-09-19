import type { Ctx } from '../../../shared/context.js';
import { hash } from '../../../shared/crypto.js';
import { one, type Sql } from '../../../shared/db.js';
import { audit, emit } from '../../../shared/events.js';
import type { TriageResult } from '../../../shared/types/ai.js';
import type { Job, Message, Row, Ticket } from '../../../shared/types/entities.js';
import { findActiveDictionaryLabel } from '../../dictionaries/index.js';
import { eligibleJob } from '../gateway/job-eligibility.js';
import { TRIAGE_SKILL } from '../skills.js';

import type { TriageOutcome } from './converse.js';

const FIELDS = ['tag', 'urgency', 'complexity'] as const;
const DEFAULT_CODES = { tag: 'undefined', urgency: 'medium', complexity: 'medium' };

/**
 * Stores the suggestion on the ticket (locking client, then ticket) if the job is still
 * eligible. Classification fields staff changed since triage started are left alone. If the
 * client edited the first message meanwhile, the suggestion is marked stale instead.
 */
export async function applyTriage(
  tx: Sql,
  ctx: Ctx,
  { job, messageId, outcome }: { job: Job; messageId: string; outcome: TriageOutcome },
): Promise<void> {
  const ticket = await lockTicket(tx, ctx, job);
  if (!ticket || !(await eligibleJob(tx, ctx.org, job))) {
    return;
  }
  const current = await one<Message>(tx, 'SELECT * FROM messages WHERE id=$1', [messageId]);
  if (current?.revision !== job.payload.revision) {
    await tx.query(
      `UPDATE tickets SET ai_status='failed',suggestion_stale=true,review_required=true
       WHERE id=$1`,
      [ticket.id],
    );
    return;
  }
  const { result, failure } = outcome;
  const codesActive = await applyClassification(tx, ctx, { job, ticket, result });
  const success = outcome.success && codesActive;
  await tx.query(
    'UPDATE tickets SET ai_status=$2,suggestion=$3,review_required=$4,version=version+1 WHERE id=$1',
    [
      ticket.id,
      success ? 'done' : 'failed',
      JSON.stringify(result),
      !success || result.needs_review,
    ],
  );
  await audit(tx, ctx.org, null, 'ai.triage', ticket.id, {
    success,
    reason: success ? null : failure,
    skill_hash: hash(TRIAGE_SKILL),
  });
  await emit(tx, ctx.org, 'ticket.classified', ticket.id);
}

async function lockTicket(tx: Sql, ctx: Ctx, job: Job): Promise<Ticket | undefined> {
  const ref = await one(tx, 'SELECT client_id FROM tickets WHERE id=$1', [job.ref_id]);
  if (!ref) {
    return undefined;
  }
  await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);
  return one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1 AND org_id=$2 FOR UPDATE', [
    job.ref_id,
    ctx.org,
  ]);
}

/**
 * Replaces codes that are no longer active with defaults (returns false if any was), and
 * writes each field whose revision still matches the one triage started from.
 */
async function applyClassification(
  tx: Sql,
  ctx: Ctx,
  { job, ticket, result }: { job: Job; ticket: Ticket; result: TriageResult },
): Promise<boolean> {
  let allActive = true;
  const startRevisions = job.payload.field_revisions as Row;
  for (const field of FIELDS) {
    const active = await findActiveDictionaryLabel(tx, ctx.org, field, result.tags[field]);
    if (!active) {
      result.tags[field] = DEFAULT_CODES[field];
      allActive = false;
    }
    if (ticket[`${field}_revision`] === Number(startRevisions[field])) {
      await tx.query(
        `UPDATE tickets SET ${field}=$2,
         classification_labels=jsonb_set(classification_labels,ARRAY[$3],$4::jsonb) WHERE id=$1`,
        [ticket.id, result.tags[field], field, JSON.stringify(active ?? {})],
      );
    }
  }
  return allActive;
}
