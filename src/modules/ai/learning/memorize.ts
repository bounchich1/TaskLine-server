import type { Ctx } from '../../../shared/context.js';
import { encrypt, hash } from '../../../shared/crypto.js';
import { one, requireOne, type Database, type Sql } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { audit, emit, enqueue } from '../../../shared/events.js';
import type { Resolution } from '../../../shared/types/ai.js';
import type { Job, Row, Ticket } from '../../../shared/types/entities.js';
import { parseResolution, resolutionSchema } from '../contracts/contracts.js';
import { redact } from '../contracts/redact.js';
import { eligibleJob } from '../gateway/job-eligibility.js';
import { functionTool, type Model, type ModelReply } from '../gateway/model.js';
import { LEARNING_SKILL } from '../skills.js';

import { insertCheckpoint } from './checkpoints.js';
import { confirmedResolution } from './confirmed-resolution.js';
import type { Snapshot } from './snapshot.js';

const MEMORIZE_TOOL = 'memorize_ticket_resolution';

export interface Memorization {
  job: Job;
  snapshot: Snapshot;
  evidence: unknown;
  chunkCount: number;
}

type ToolCall = ModelReply['toolCalls'][number];

export async function memorize(
  { db, ctx, model }: { db: Database; ctx: Ctx; model: Model },
  memorization: Memorization,
): Promise<void> {
  const { snapshot } = memorization;
  const allIds = snapshot.entries.map((entry) => entry.id);
  const call = await askForResolution(model, ctx, memorization);
  let resolution = parseResolution(call.arguments, allIds);
  const sanitized = redact(JSON.stringify(resolution));
  const containsSecrets = sanitized !== JSON.stringify(resolution);
  if (containsSecrets) {
    resolution = parseResolution(sanitized, allIds);
  }
  const confirmed =
    confirmedResolution(resolution, snapshot.entries) &&
    snapshot.missing.length === 0 &&
    !containsSecrets;
  await db.tx(async (tx) => {
    await storeResolution(tx, ctx, { ...memorization, call, resolution, confirmed });
  });
}

async function askForResolution(
  model: Model,
  ctx: Ctx,
  { job, snapshot, evidence, chunkCount }: Memorization,
): Promise<ToolCall> {
  const allIds = snapshot.entries.map((entry) => entry.id);
  const budget = ctx.config.AI_INPUT_CHARS;
  const input = {
    evidence,
    coverage: {
      all_message_count: allIds.length,
      manifest_hash: hash(JSON.stringify(allIds)),
      all_chunks: chunkCount,
      missing_attachments: snapshot.missing,
    },
    note: snapshot.cycle.note ?? '',
  };
  ensure(JSON.stringify(input).length <= budget, 'learning_budget_exceeded');
  const answer = await model.complete(job, 'memorize', {
    messages: [
      { role: 'system', content: LEARNING_SKILL },
      { role: 'user', content: JSON.stringify(input) },
    ],
    tools: [
      functionTool(
        MEMORIZE_TOOL,
        'Store a resolution with host-injected provenance.',
        resolutionSchema,
      ),
    ],
    forceTool: MEMORIZE_TOOL,
    mock: insufficientEvidence(allIds, snapshot.missing),
  });
  ensure(
    answer.toolCalls.length === 1 && answer.toolCalls[0].name === MEMORIZE_TOOL,
    'memory_tool_required',
    422,
  );
  return answer.toolCalls[0];
}

function insufficientEvidence(allIds: string[], missing: string[]): Resolution {
  return {
    schema_version: '1.0',
    problem_summary: 'Недостаточно проверенных данных для вывода о решении.',
    solution_summary: null,
    outcome: 'insufficient_evidence',
    steps: [],
    observed_result: null,
    evidence_message_ids: [allIds[0]],
    applicability: [],
    cautions: [],
    uncertainties: [
      'Требуется проверка сотрудником',
      ...(missing.length ? ['Есть вложения без полного извлечения текста'] : []),
    ],
  };
}

async function storeResolution(
  tx: Sql,
  ctx: Ctx,
  stored: Memorization & { call: ToolCall; resolution: Resolution; confirmed: boolean },
): Promise<void> {
  const { job, snapshot, call, confirmed, chunkCount } = stored;
  const { cycle, entries, missing } = snapshot;
  const allIds = entries.map((entry) => entry.id);
  const ticket = await requireOne<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1', [
    cycle.ticket_id,
  ]);
  await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ticket.client_id]);
  await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticket.id]);
  ensure(await eligibleJob(tx, ctx.org, job), 'job_ineligible');
  const record = await insertRecord(tx, ctx, stored, ticket);
  await insertCheckpoint(tx, {
    jobId: job.id,
    stepKey: 'memorize-call',
    output: encrypt({ call_id: call.id, arguments: call.arguments }, ctx.config.ENCRYPTION_KEY),
    inputHash: hash(call.arguments),
    coveredIds: allIds,
  });
  await enqueue(tx, ctx.org, {
    key: `memory:${String(record.id)}`,
    kind: 'memory',
    refId: String(record.id),
  });
  await tx.query(
    `UPDATE closures SET learning_status='persistence_pending',coverage=coverage||$2::jsonb
     WHERE id=$1`,
    [
      cycle.id,
      JSON.stringify({
        consumed_messages: allIds,
        complete_text_coverage: true,
        expected_chunks: chunkCount,
        evidence_grade: evidenceGrade(confirmed, missing),
      }),
    ],
  );
  await audit(tx, ctx.org, {
    actor: null,
    action: 'memory.tool.accepted',
    objectId: String(record.id),
    detail: {
      receipt_id: record.receipt_id,
      skill_hash: hash(LEARNING_SKILL),
      eligible: confirmed,
    },
  });
  await emit(tx, ctx.org, {
    type: 'learning.changed',
    ticketId: ticket.id,
    payload: { state: 'persistence_pending' },
  });
}

async function insertRecord(
  tx: Sql,
  ctx: Ctx,
  {
    snapshot,
    resolution,
    confirmed,
  }: { snapshot: Snapshot; resolution: Resolution; confirmed: boolean },
  ticket: Ticket,
): Promise<Row> {
  const { cycle, entries } = snapshot;
  const sourceKey = hash(`${ctx.org}|${cycle.id}|${hash(JSON.stringify(entries))}|1`);
  const contentHash = hash(JSON.stringify(resolution));
  const inserted = await one(
    tx,
    `INSERT INTO memory_records(org_id,ticket_id,closure_id,source_key,content_hash,content,eligible)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
    [ctx.org, ticket.id, cycle.id, sourceKey, contentHash, JSON.stringify(resolution), confirmed],
  );
  const record =
    inserted ?? (await one(tx, 'SELECT * FROM memory_records WHERE source_key=$1', [sourceKey]));
  ensure(record?.content_hash === contentHash, 'memory_content_conflict');
  return record;
}

function evidenceGrade(confirmed: boolean, missing: string[]): string {
  if (confirmed) {
    return 'client_confirmed';
  }
  return missing.length ? 'incomplete' : 'inferred';
}
