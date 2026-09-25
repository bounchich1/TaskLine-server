import type { Ctx } from '../../../shared/context.js';
import { decrypt } from '../../../shared/crypto.js';
import { one, requireOne, type Sql } from '../../../shared/db.js';
import { AppError, ensure } from '../../../shared/errors.js';
import type { Job, Row } from '../../../shared/types/entities.js';

import { eligibleJob } from './job-eligibility.js';
import type { ModelReply } from './model.js';

export interface CallRequest {
  job: Job;
  step: string;
  digest: string;
  callId: string;
}

export interface Permit {
  slot: number;
  generation: number;
}

export type Admission = { cached: ModelReply } | Permit;

export async function admitCall(tx: Sql, ctx: Ctx, call: CallRequest): Promise<Admission> {
  const { job, step } = call;
  const current = await one<Job>(tx, 'SELECT * FROM jobs WHERE id=$1 AND org_id=$2 FOR UPDATE', [
    job.id,
    ctx.org,
  ]);
  ensure(current?.state === 'running' && current.generation === job.generation, 'job_stale');
  ensure(await eligibleJob(tx, ctx.org, current), 'job_ineligible');
  const previous = await one(tx, 'SELECT * FROM ai_calls WHERE job_id=$1 AND step_key=$2', [
    job.id,
    step,
  ]);
  if (previous) {
    return { cached: replayPrevious(previous, call.digest, ctx.config.ENCRYPTION_KEY) };
  }
  return takePermit(tx, ctx, call);
}

function replayPrevious(previous: Row, digest: string, encryptionKey: string): ModelReply {
  ensure(previous.input_hash === digest, 'ai_input_changed');
  if (previous.state === 'completed' && previous.response) {
    return decrypt<ModelReply>(previous.response as string, encryptionKey);
  }
  throw new AppError(
    previous.state === 'failed' ? 'ai_rejected' : 'ai_uncertain',
    409,
    'Вызов модели требует проверки.',
    true,
  );
}

async function takePermit(tx: Sql, ctx: Ctx, call: CallRequest): Promise<Permit> {
  const settings = await one(tx, 'SELECT cap FROM ai_settings WHERE id=1 FOR UPDATE');
  ensure(settings, 'ai_not_initialized', 503);
  const occupied = await requireOne(
    tx,
    "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'",
  );
  ensure(Number(occupied.n) < Number(settings.cap), 'ai_busy', 429, 'Модель занята.');
  const permit = await one(
    tx,
    `SELECT * FROM ai_permits WHERE state='free' AND slot<=$1 ORDER BY slot
     FOR UPDATE SKIP LOCKED LIMIT 1`,
    [settings.cap],
  );
  ensure(permit, 'ai_busy', 429);
  const generation = Number(permit.generation) + 1;
  await tx.query(
    "UPDATE ai_permits SET state='running',holder=$2,generation=$3,started_at=now() WHERE slot=$1",
    [permit.slot, call.callId, generation],
  );
  await tx.query(
    `INSERT INTO ai_calls(id,org_id,job_id,step_key,input_hash,permit,generation)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [call.callId, ctx.org, call.job.id, call.step, call.digest, permit.slot, generation],
  );
  return { slot: Number(permit.slot), generation };
}
