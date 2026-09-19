import type { Ctx } from '../../../shared/context.js';
import { one, type Database } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { Job } from '../../../shared/types/entities.js';
import type { Model } from '../gateway/model.js';

import { CheckpointStore } from './checkpoints.js';
import { planChunks } from './chunks.js';
import { acknowledgeReceipt } from './completion.js';
import { gatherEvidence } from './evidence-reduction.js';
import { memorize } from './memorize.js';
import { takeSnapshot } from './snapshot.js';

const MAX_CHUNKS = 512;
/** Room left in the input budget for instructions and coverage metadata. */
const PROMPT_RESERVE = 5000;

export interface LearningDeps {
  db: Database;
  ctx: Ctx;
  model: Model;
}

/**
 * Learning from a closed ticket, one model step per invocation: the queue job is re-run until
 * this returns true, so long conversations yield between chunks for fair model admission.
 */
export async function runClosureLearning(deps: LearningDeps, job: Job): Promise<boolean> {
  const { db, ctx, model } = deps;
  if (!ctx.config.AI_ENABLED) {
    throw new AppError('ai_disabled', 503);
  }
  const snapshot = await db.tx(async (tx) => takeSnapshot(tx, ctx, job));
  const allIds = snapshot.entries.map((entry) => entry.id);
  ensure(allIds.length > 0, 'empty_snapshot');
  const checkpoints = new CheckpointStore(db, job, ctx.config.ENCRYPTION_KEY);
  const step = { model, job, checkpoints };
  const record = await one(db, 'SELECT * FROM memory_records WHERE org_id=$1 AND closure_id=$2', [
    ctx.org,
    snapshot.cycle.id,
  ]);
  if (record) {
    await acknowledgeReceipt(step, { record, coveredIds: allIds });
    return true;
  }
  const limit = ctx.config.AI_INPUT_CHARS - PROMPT_RESERVE;
  const chunks = planChunks(snapshot.entries, Math.max(2000, limit));
  ensure(chunks.length <= MAX_CHUNKS, 'learning_budget_exceeded');
  const progress = await gatherEvidence(step, { entries: snapshot.entries, chunks, limit });
  if (progress.ready) {
    await memorize(deps, { job, snapshot, evidence: progress.evidence, chunkCount: chunks.length });
  }
  return false;
}
