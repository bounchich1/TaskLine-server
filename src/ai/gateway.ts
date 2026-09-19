import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { fetch } from 'undici';
import { z } from 'zod';
import { one, type Database, type Sql } from '../db.js';
import type { Config } from '../config.js';
import type { Job, Row } from '../types.js';
import { decrypt, encrypt, equal, hash } from '../crypto.js';
import { AppError, ensure } from '../errors.js';
import { boundedText } from '../network.js';
import { object, strictJson } from '../json.js';

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Row[];
};
export type ModelRequest = {
  messages: ModelMessage[];
  tools?: Row[];
  forceTool?: string;
  json?: boolean;
  mock?: Row;
};
export type ModelReply = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: Row;
  providerRef?: string;
};
export interface Model {
  complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply>;
}

export async function eligibleJob(tx: Sql, org: string, job: Job): Promise<boolean> {
  if (job.kind === 'triage') {
    return !!(await one(
      tx,
      `SELECT t.id FROM tickets t JOIN clients c ON c.id=t.client_id
      WHERE t.id=$1 AND t.org_id=$2 AND t.status IN('open','in_progress') AND t.lifecycle=$3 AND c.consent_state='granted'
      AND c.consent_revision=$4 AND t.consent_revision=c.consent_revision AND t.ai_status='pending'
      AND t.created_at>now()-interval '120 seconds'`,
      [job.ref_id, org, job.payload.lifecycle, job.payload.consent_revision],
    ));
  }
  if (job.kind === 'learning')
    return !!(await one(
      tx,
      `SELECT cl.id FROM closures cl JOIN tickets t ON t.id=cl.ticket_id JOIN clients c ON c.id=t.client_id
    WHERE cl.id=$1 AND cl.org_id=$2 AND NOT cl.invalidated AND cl.lifecycle=t.lifecycle AND t.current_cycle_id=cl.id
    AND c.consent_state='granted' AND c.consent_revision=$3 AND t.consent_revision=c.consent_revision`,
      [job.ref_id, org, job.payload.consent_revision],
    ));
  return false;
}

export class Gateway implements Model {
  constructor(
    readonly db: Database,
    readonly c: Config,
    readonly provider?: (request: ModelRequest, timeout: number) => Promise<ModelReply>,
  ) {}
  async complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply> {
    const digest = hash(JSON.stringify(request));
    const callId = randomUUID();
    const admission = await this.db.tx(async (tx) => {
      const current = await one<Job>(
        tx,
        'SELECT * FROM jobs WHERE id=$1 AND org_id=$2 FOR UPDATE',
        [job.id, this.c.ORG_ID],
      );
      ensure(
        current && current.state === 'running' && current.generation === job.generation,
        'job_stale',
      );
      ensure(await eligibleJob(tx, this.c.ORG_ID, current), 'job_ineligible');
      const old = await one(tx, 'SELECT * FROM ai_calls WHERE job_id=$1 AND step_key=$2', [
        job.id,
        step,
      ]);
      if (old) {
        ensure(old.input_hash === digest, 'ai_input_changed');
        if (old.state === 'completed' && old.response)
          return { cached: decrypt<ModelReply>(String(old.response), this.c.ENCRYPTION_KEY) };
        throw new AppError(
          old.state === 'failed' ? 'ai_rejected' : 'ai_uncertain',
          409,
          'Вызов модели требует проверки.',
          true,
        );
      }
      const settings = await one(tx, 'SELECT cap FROM ai_settings WHERE id=1 FOR UPDATE');
      ensure(settings, 'ai_not_initialized', 503);
      // Count every occupied slot, including uncertain slots above a reduced cap.
      const occupied = await one(
        tx,
        "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'",
      );
      ensure(Number(occupied!.n) < Number(settings!.cap), 'ai_busy', 429, 'Модель занята.');
      const permit = await one(
        tx,
        "SELECT * FROM ai_permits WHERE state='free' AND slot<=$1 ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1",
        [settings!.cap],
      );
      ensure(permit, 'ai_busy', 429);
      const generation = Number(permit.generation) + 1;
      await tx.query(
        "UPDATE ai_permits SET state='running',holder=$2,generation=$3,started_at=now() WHERE slot=$1",
        [permit.slot, callId, generation],
      );
      await tx.query(
        'INSERT INTO ai_calls(id,org_id,job_id,step_key,input_hash,permit,generation) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [callId, this.c.ORG_ID, job.id, step, digest, permit.slot, generation],
      );
      return { slot: Number(permit.slot), generation };
    });
    if ('cached' in admission) return admission.cached!;
    // Crash after admission intentionally retains the slot. A clock-based lease never releases remote work.
    let completed = false;
    try {
      const current = await one<Job>(this.db, 'SELECT * FROM jobs WHERE id=$1', [job.id]);
      if (
        !current ||
        current.state !== 'running' ||
        current.generation !== job.generation ||
        !(await eligibleJob(this.db, this.c.ORG_ID, current))
      ) {
        completed = true;
        throw new AppError('job_ineligible');
      }
      const timeout =
        (job.kind === 'triage'
          ? this.c.AI_TRIAGE_TIMEOUT_SECONDS
          : this.c.AI_LEARNING_TIMEOUT_SECONDS) * 1000;
      const response = this.provider
        ? await this.provider(request, timeout)
        : this.c.AI_MODE === 'mock'
          ? mockModel(request)
          : await this.live(request, timeout);
      completed = true;
      await this.db.tx(async (tx) => {
        await tx.query(
          "UPDATE ai_calls SET state='completed',response=$2,usage=$3,finished_at=now() WHERE id=$1 AND state='running'",
          [callId, encrypt(response, this.c.ENCRYPTION_KEY), JSON.stringify(response.usage)],
        );
        await tx.query(
          "UPDATE ai_permits SET state='free',holder=NULL,started_at=NULL,provider_ref=NULL WHERE slot=$1 AND holder=$2 AND generation=$3",
          [admission.slot, callId, admission.generation],
        );
      });
      return response;
    } catch (error) {
      const known = completed || (error instanceof AppError && error.code === 'provider_rejected');
      await this.db.tx(async (tx) => {
        await tx.query(
          "UPDATE ai_calls SET state=$2,reason=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1 AND state='running'",
          [
            callId,
            known ? 'failed' : 'uncertain',
            known ? 'provider_rejected' : 'remote_outcome_unknown',
          ],
        );
        await tx.query(
          `UPDATE ai_permits SET state=$4,holder=CASE WHEN $4='free' THEN NULL ELSE holder END WHERE slot=$1 AND holder=$2 AND generation=$3`,
          [admission.slot, callId, admission.generation, known ? 'free' : 'uncertain'],
        );
      });
      throw error;
    }
  }
  private async live(request: ModelRequest, timeout: number): Promise<ModelReply> {
    ensure(this.c.AI_API_KEY && this.c.AI_MODEL, 'provider_rejected', 503);
    const body: Row = {
      model: this.c.AI_MODEL,
      messages: request.messages,
      max_completion_tokens: 6000,
      store: false,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.parallel_tool_calls = false;
      body.tool_choice = request.forceTool
        ? { type: 'function', function: { name: request.forceTool } }
        : 'auto';
    }
    if (request.json) body.response_format = { type: 'json_object' };
    const response = await fetch(this.c.AI_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.c.AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      throw new AppError('provider_rejected', 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('provider_unknown');
    }
    const result = object(strictJson(await boundedText(response, 128 * 1024), false, 128 * 1024));
    const choice = object((result.choices as unknown[])?.[0]);
    const message = object(choice.message);
    ensure(['stop', 'tool_calls'].includes(String(choice.finish_reason)), 'provider_rejected', 503);
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((raw) => {
      const call = object(raw);
      const fn = object(call.function);
      return { id: String(call.id), name: String(fn.name), arguments: String(fn.arguments) };
    });
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: calls,
      usage: object(result.usage ?? {}),
      providerRef: response.headers.get('x-request-id') ?? undefined,
    };
  }
}
function mockModel(request: ModelRequest): ModelReply {
  const result = request.mock ?? { mock: true };
  return request.forceTool
    ? {
        content: null,
        toolCalls: [
          {
            id: `mock-${randomUUID()}`,
            name: request.forceTool,
            arguments: JSON.stringify(result),
          },
        ],
        usage: { mock: true },
      }
    : { content: JSON.stringify(result), toolCalls: [], usage: { mock: true } };
}
export class GatewayClient implements Model {
  constructor(readonly c: Config) {}
  async complete(job: Job, step: string, request: ModelRequest): Promise<ModelReply> {
    const response = await fetch(`${this.c.GATEWAY_URL}/execute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.c.GATEWAY_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job_id: job.id, generation: job.generation, step, request }),
      signal: AbortSignal.timeout(150000),
      redirect: 'error',
    });
    const data = object(strictJson(await boundedText(response, 128 * 1024), false, 128 * 1024));
    if (!response.ok)
      throw new AppError(
        String(data.code ?? 'gateway_unavailable'),
        response.status,
        'Модель временно недоступна.',
        true,
      );
    return data as ModelReply;
  }
}
export async function buildGateway(db: Database, c: Config) {
  const app = Fastify({ bodyLimit: 512 * 1024, logger: false });
  const gateway = new Gateway(db, c);
  app.get('/health', async () => ({
    status: 'ok',
    permits: (await db.query('SELECT slot,state FROM ai_permits ORDER BY slot')).rows,
  }));
  app.post('/execute', async (request, reply) => {
    if (!equal(request.headers.authorization ?? '', `Bearer ${c.GATEWAY_SECRET}`))
      return reply.code(401).send({ code: 'unauthorized' });
    try {
      const body = z
        .object({
          job_id: z.uuid(),
          generation: z.number().int().positive(),
          step: z.string().min(1).max(128),
          request: z
            .object({
              messages: z
                .array(
                  z
                    .object({
                      role: z.enum(['system', 'user', 'assistant', 'tool']),
                      content: z.string().max(200000).nullable(),
                      tool_call_id: z.string().optional(),
                      tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
                    })
                    .strict(),
                )
                .max(12),
              tools: z.array(z.record(z.string(), z.unknown())).max(2).optional(),
              forceTool: z.enum(['memorize_ticket_resolution']).optional(),
              json: z.boolean().optional(),
              mock: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
        })
        .strict()
        .parse(request.body);
      const job = await one<Job>(db, 'SELECT * FROM jobs WHERE id=$1 AND org_id=$2', [
        body.job_id,
        c.ORG_ID,
      ]);
      ensure(job, 'not_found', 404);
      ensure(job.generation === body.generation, 'job_stale');
      return await gateway.complete(job, body.step, body.request);
    } catch (error) {
      return reply
        .code(error instanceof AppError ? error.status : 503)
        .send({ code: error instanceof AppError ? error.code : 'gateway_unavailable' });
    }
  });
  return app;
}
