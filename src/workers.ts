import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { GatewayClient, type Model } from './ai/gateway.js';
import { Memory } from './ai/memory.js';
import { Workflows } from './ai/workflows.js';
import { DeliveryWorker } from './delivery.js';
import { Files } from './files.js';
import { MaxClient } from './integrations/max/index.js';
import { PreconsentExpiry } from './modules/consent/index.js';
import { Inbox } from './modules/inbox/index.js';
import { reviseClientMessage } from './modules/messages/index.js';
import { RatingTimers } from './modules/ratings/index.js';
import type { Config } from './shared/config.js';
import { createCtx } from './shared/context.js';
import { decrypt } from './shared/crypto.js';
import { one, type Database } from './shared/db.js';
import { AppError } from './shared/errors.js';
import { emit } from './shared/events.js';
import type { ClientInput } from './shared/types/client-input.js';
import type { Client, Job } from './shared/types/entities.js';

const queueFor = (kind: string) =>
  ['triage', 'learning'].includes(kind)
    ? 'ai-execution'
    : ['memory', 'memory_delete'].includes(kind)
      ? 'memory-io'
      : ['file', 'scan'].includes(kind)
        ? 'file-processing'
        : 'maintenance';
export class JobRunner {
  readonly inbox: Inbox;
  readonly files: Files;
  readonly memory: Memory;
  readonly workflows: Workflows;
  constructor(
    readonly db: Database,
    readonly c: Config,
    model: Model = new GatewayClient(c),
    memory?: Memory,
  ) {
    this.inbox = new Inbox(db, c);
    this.files = new Files(db, c);
    this.memory = memory ?? new Memory(db, c);
    this.workflows = new Workflows(db, c, model, this.memory);
  }
  async run(id: string) {
    const job = await this.db.tx(async (tx) =>
      one<Job>(
        tx,
        "UPDATE jobs SET state='running',generation=generation+1,claimed_at=now(),attempts=attempts+1 WHERE org_id=$1 AND id=$2 AND state='pending' AND due_at<=now() RETURNING *",
        [this.c.ORG_ID, id],
      ),
    );
    if (!job) {
      return;
    }
    let done = true;
    try {
      switch (job.kind) {
        case 'triage':
          await this.workflows.triage(job);
          break;
        case 'learning':
          done = await this.workflows.learning(job);
          break;
        case 'file':
          await this.files.downloadInbound(job.ref_id);
          break;
        case 'scan':
          await this.files.scan(job.ref_id);
          break;
        case 'memory':
          await this.memory.persist(job.ref_id);
          break;
        case 'memory_delete':
          await this.memory.remove(job.ref_id);
          break;
        case 'message_revision': {
          const input = decrypt<ClientInput>(String(job.payload.input), this.c.ENCRYPTION_KEY);
          const original = await one(
            this.db,
            'SELECT id FROM messages WHERE org_id=$1 AND provider_ref=$2',
            [this.c.ORG_ID, input.messageId],
          );
          if (!original) {
            throw new AppError('original_not_received', 503);
          }
          await this.db.tx(async (tx) => {
            const client = await one<Client>(
              tx,
              'SELECT * FROM clients WHERE id=$1 AND org_id=$2 FOR UPDATE',
              [job.ref_id, this.c.ORG_ID],
            );
            if (client) {
              await reviseClientMessage(tx, createCtx(this.c), client, input);
            }
          });
          break;
        }
        default:
          throw new AppError('unsupported_job_kind', 422);
      }
      await this.db.query(
        "UPDATE jobs SET state=$3,due_at=now(),completed_at=CASE WHEN $3='done' THEN now() ELSE NULL END,payload=payload-'retry_count',reason=NULL WHERE id=$1 AND generation=$2 AND state='running'",
        [job.id, job.generation, done ? 'done' : 'pending'],
      );
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'worker_error';
      const deferred = [
        'ai_busy',
        'memory_writer_busy',
        'snapshot_waiting_files',
        'memory_disabled',
        'ai_disabled',
        'gateway_unavailable',
      ].includes(code);
      const uncertain = ['ai_uncertain', 'memory_write_unknown', 'memory_still_unknown'].includes(
        code,
      );
      const suppressed = ['job_ineligible', 'job_stale'].includes(code);
      const count = Number(job.payload.retry_count ?? 0) + (deferred ? 0 : 1);
      const state = suppressed
        ? 'canceled'
        : uncertain
          ? 'unknown'
          : !deferred && (count >= 6 || (error instanceof AppError && error.status === 422))
            ? 'failed'
            : 'pending';
      const delay = ['memory_disabled', 'ai_disabled'].includes(code)
        ? 60
        : Math.min(1800, 2 ** Math.min(count + 1, 10));
      await this.db.tx(async (tx) => {
        const updated = await tx.query(
          "UPDATE jobs SET state=$3,reason=$4,payload=jsonb_set(payload,'{retry_count}',$5::jsonb),due_at=now()+($6*interval '1 second') WHERE id=$1 AND generation=$2 AND state='running' RETURNING id",
          [job.id, job.generation, state, code, JSON.stringify(count), delay],
        );
        if (!updated.rows.length) {
          return;
        }
        if (job.kind === 'learning' && ['failed', 'unknown', 'canceled'].includes(state)) {
          await tx.query('UPDATE closures SET learning_status=$2 WHERE id=$1 AND NOT invalidated', [
            job.ref_id,
            suppressed ? 'suppressed' : state === 'unknown' ? 'needs_review' : 'failed',
          ]);
        }
        if (job.kind === 'triage' && state === 'failed') {
          await tx.query(
            "UPDATE tickets SET ai_status='failed',review_required=true WHERE id=$1 AND ai_status='pending'",
            [job.ref_id],
          );
          await emit(tx, this.c.ORG_ID, 'ticket.classified', job.ref_id);
        }
      });
    }
  }
  async maintenance() {
    // Rating timers first, then pre-consent expiry.
    await new RatingTimers(this.db, this.c).run();
    await new PreconsentExpiry(this.db, this.c).run();
    await this.db.tx(async (tx) => {
      const expired = (
        await tx.query(
          "UPDATE tickets SET ai_status='failed',review_required=true,version=version+1 WHERE org_id=$1 AND ai_status='pending' AND created_at<=now()-interval '120 seconds' RETURNING id",
          [this.c.ORG_ID],
        )
      ).rows;
      for (const t of expired) {
        await tx.query(
          "UPDATE jobs SET state='canceled',reason='triage_deadline' WHERE kind='triage' AND ref_id=$1 AND state IN('pending','running')",
          [t.id],
        );
        await emit(tx, this.c.ORG_ID, 'ticket.classified', String(t.id));
      }
      // Pure workflow retry is separate from remote execution ownership. Calls retain their permits.
      await tx.query(
        "UPDATE ai_permits SET state='uncertain' WHERE state='running' AND started_at<now()-interval '3 minutes'",
      );
      await tx.query(
        "UPDATE ai_calls SET state='uncertain',reason='gateway_lost' WHERE state='running' AND started_at<now()-interval '3 minutes'",
      );
      await tx.query(
        "UPDATE jobs SET state='pending',due_at=now(),reason='worker_recovery' WHERE org_id=$1 AND state='running' AND claimed_at<now()-interval '5 minutes'",
        [this.c.ORG_ID],
      );
      await tx.query("DELETE FROM download_grants WHERE expires_at<now()-interval '1 hour'");
      await tx.query("DELETE FROM callback_actions WHERE expires_at<now()-interval '1 day'");
      await tx.query("DELETE FROM staff_sessions WHERE expires_at<now()-interval '1 day'");
      await tx.query("DELETE FROM command_keys WHERE created_at<now()-interval '7 days'");
      await tx.query("DELETE FROM ui_events WHERE created_at<now()-interval '7 days'");
      await tx.query(
        "UPDATE memory_records SET eligible=false,reason='expired' WHERE expires_at<now() AND eligible",
      );
    });
  }
}

export async function startWorkers(db: Database, c: Config) {
  const producer = new Redis(c.REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  const workerConnection = new Redis(c.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  producer.on('error', () => {});
  workerConnection.on('error', () => {});
  const names = ['ai-execution', 'memory-io', 'file-processing', 'maintenance'];
  const queues = new Map(names.map((name) => [name, new Queue(name, { connection: producer })]));
  const runner = new JobRunner(db, c);
  const delivery: DeliveryWorker = new DeliveryWorker(
    db,
    c,
    new MaxClient(c, async (): Promise<void> => delivery.rate()),
    runner.files,
  );
  let running = true;
  let ticks = 0;
  const workers = names.map((name) => {
    const worker = new Worker(name, async (job) => runner.run(String(job.data.id)), {
      connection: workerConnection,
      concurrency: name === 'ai-execution' ? 4 : name === 'memory-io' ? 1 : 2,
      lockDuration: 180000,
    });
    worker.on('error', () => {});
    return worker;
  });
  const loop = (async () => {
    while (running) {
      try {
        const clients = (
          await db.query<{ client_id: string }>(
            "SELECT DISTINCT client_id FROM inbox WHERE org_id=$1 AND state='pending' AND client_id IS NOT NULL LIMIT 50",
            [c.ORG_ID],
          )
        ).rows;
        for (const client of clients) {
          await runner.inbox.processClient(client.client_id);
        }
        const outgoing = (
          await db.query<{ client_id: string }>(
            "SELECT DISTINCT client_id FROM deliveries WHERE org_id=$1 AND state IN('queued','retry_wait') AND due_at<=now() LIMIT 20",
            [c.ORG_ID],
          )
        ).rows;
        await Promise.allSettled(outgoing.map((client) => delivery.deliver(client.client_id)));
        if (ticks++ % 20 === 0) {
          await runner.maintenance();
          await delivery.markStaleUnknown();
        }
        try {
          const cap = Number((await one(db, 'SELECT cap FROM ai_settings WHERE id=1'))!.cap);
          if ((await queues.get('ai-execution')!.getGlobalConcurrency()) !== cap) {
            await queues.get('ai-execution')!.setGlobalConcurrency(cap);
          }
          const due = (
            await db.query<Job>(
              "SELECT * FROM jobs WHERE org_id=$1 AND state='pending' AND due_at<=now() ORDER BY created_at LIMIT 200",
              [c.ORG_ID],
            )
          ).rows;
          const triage = due.filter((j) => j.kind === 'triage');
          const learning = due.filter((j) => j.kind === 'learning');
          const chosen: Job[] = [];
          while (chosen.length < 2 * cap && (triage.length || learning.length)) {
            if (
              learning.length &&
              Date.now() - new Date(learning[0].created_at).getTime() > 600000
            ) {
              chosen.push(learning.shift()!);
            }
            chosen.push(...triage.splice(0, 4));
            if (learning.length) {
              chosen.push(learning.shift()!);
            }
          }
          chosen.push(...due.filter((j) => !['triage', 'learning'].includes(j.kind)).slice(0, 40));
          for (const job of chosen) {
            await queues
              .get(queueFor(job.kind))!
              .add(
                job.kind,
                { id: job.id },
                { jobId: job.id, removeOnComplete: true, removeOnFail: true },
              );
            await db.query('UPDATE jobs SET published_at=now() WHERE id=$1', [job.id]);
          }
        } catch {
          /* Broker loss cannot discard accepted DB work; next sweep reconstructs queue. */
        }
      } catch {
        /* Health/diagnostic rows expose backlog; no content-bearing error logs. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return async () => {
    running = false;
    await loop;
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([...queues.values()].map((q) => q.close()));
    await producer.quit();
    await workerConnection.quit();
  };
}
