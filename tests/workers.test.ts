import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { JobRunner } from '../src/app/workers/job-runner.js';
import type { Model } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import { AppError } from '../src/shared/errors.js';
import type { Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
  context = await fixture();
});

afterEach(async () => {
  await context.db.close();
});

const failingModel = (error: Error): Model => ({ complete: () => Promise.reject(error) });

async function jobOf(kind: string): Promise<Row> {
  const job = await one(context.db, 'SELECT * FROM jobs WHERE kind=$1', [kind]);
  return job!;
}

async function closedTicketLearningJob(): Promise<Row> {
  await context.create();
  await context.command('assign');
  await context.command('close');
  return jobOf('learning');
}

it('fails a job of an unknown kind immediately', async () => {
  const job = await one(
    context.db,
    `INSERT INTO jobs(org_id,logical_key,kind,ref_id,payload) VALUES($1,$2,'bogus',$3,'{}')
     RETURNING id`,
    [context.c.ORG_ID, `bogus:${randomUUID()}`, randomUUID()],
  );
  await new JobRunner(context.db, context.c).run(String(job?.id));
  const stored = await one(context.db, 'SELECT state,reason FROM jobs WHERE id=$1', [job?.id]);
  expect(stored).toMatchObject({ state: 'failed', reason: 'unsupported_job_kind' });
});

it('defers a triage job while the model is busy, without counting a retry', async () => {
  await context.create();
  const job = await jobOf('triage');
  const busy = failingModel(new AppError('ai_busy', 429));
  await new JobRunner(context.db, context.c, busy).run(String(job.id));
  const stored = await one(context.db, 'SELECT state,reason,payload FROM jobs WHERE id=$1', [
    job.id,
  ]);
  expect(stored).toMatchObject({ state: 'pending', reason: 'ai_busy' });
  expect((stored?.payload as Row).retry_count).toBe(0);
});

it('marks learning for review when the model outcome is uncertain', async () => {
  const job = await closedTicketLearningJob();
  const uncertain = failingModel(new AppError('ai_uncertain', 409));
  await new JobRunner(context.db, context.c, uncertain).run(String(job.id));
  const stored = await one(context.db, 'SELECT state FROM jobs WHERE id=$1', [job.id]);
  expect(stored?.state).toBe('unknown');
  const closure = await one(context.db, 'SELECT learning_status FROM closures');
  expect(closure?.learning_status).toBe('needs_review');
});

it('gives up on learning after six failed attempts', async () => {
  const job = await closedTicketLearningJob();
  await context.db.query(
    `UPDATE jobs SET payload=jsonb_set(payload,'{retry_count}','5') WHERE id=$1`,
    [job.id],
  );
  await new JobRunner(context.db, context.c, failingModel(new Error('down'))).run(String(job.id));
  const stored = await one(context.db, 'SELECT state,reason FROM jobs WHERE id=$1', [job.id]);
  expect(stored).toMatchObject({ state: 'failed', reason: 'worker_error' });
  const closure = await one(context.db, 'SELECT learning_status FROM closures');
  expect(closure?.learning_status).toBe('failed');
});

it('fails triage for review after repeated worker errors', async () => {
  await context.create();
  const job = await jobOf('triage');
  await context.db.query(
    `UPDATE jobs SET payload=jsonb_set(payload - 'field_revisions','{retry_count}','5')
     WHERE id=$1`,
    [job.id],
  );
  await new JobRunner(context.db, context.c, failingModel(new Error('down'))).run(String(job.id));
  const ticket = await context.ticket();
  expect(ticket).toMatchObject({ ai_status: 'failed', review_required: true });
});

it('cancels a job that is no longer eligible', async () => {
  const job = await closedTicketLearningJob();
  await context.command('reopen', { reason: 'Вернулось' });
  await new JobRunner(context.db, context.c, failingModel(new Error('unused'))).run(String(job.id));
  const stored = await one(context.db, 'SELECT state FROM jobs WHERE id=$1', [job.id]);
  expect(stored?.state).toBe('canceled');
});

it('expires overdue triage and recovers abandoned work during maintenance', async () => {
  const ticket = await context.create();
  await context.db.query("UPDATE tickets SET created_at=now()-interval '3 minutes' WHERE id=$1", [
    ticket.id,
  ]);
  await context.db.query(
    "UPDATE ai_permits SET state='running',started_at=now()-interval '4 minutes' WHERE slot=1",
  );
  await closedTicketLearningJob();
  await context.db.query(
    "UPDATE jobs SET state='running',claimed_at=now()-interval '6 minutes' WHERE kind='learning'",
  );
  await new JobRunner(context.db, context.c).maintenance();
  const expired = await one(context.db, 'SELECT ai_status FROM tickets WHERE id=$1', [ticket.id]);
  expect(expired?.ai_status).toBe('failed');
  const triage = await one(context.db, "SELECT state FROM jobs WHERE kind='triage' AND ref_id=$1", [
    ticket.id,
  ]);
  expect(triage?.state).toBe('canceled');
  const permit = await one(context.db, 'SELECT state FROM ai_permits WHERE slot=1');
  expect(permit?.state).toBe('uncertain');
  const learning = await one(context.db, "SELECT state,reason FROM jobs WHERE kind='learning'");
  expect(learning).toMatchObject({ state: 'pending', reason: 'worker_recovery' });
});
