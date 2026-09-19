import { readFileSync } from 'node:fs';

import { z } from 'zod';

import {
  parseResolution,
  parseTriage,
  redact,
  resolutionSchema,
  triageSchema,
} from './contracts.js';
import { eligibleJob, type Model, type ModelMessage } from './gateway.js';
import type { Recall, CaseEvidence } from './memory.js';
import type { Config } from '../shared/config.js';
import { decrypt, encrypt, hash } from '../shared/crypto.js';
import { one, type Database } from '../shared/db.js';
import { ensure, AppError } from '../shared/errors.js';
import { audit, emit, enqueue } from '../shared/events.js';
import { object, strictJson } from '../shared/json.js';
import { serverFile } from '../shared/paths.js';
import type { Resolution, SnapshotEntry, TriageResult } from '../shared/types/ai.js';
import type { Closure, Job, Message, Row, Ticket } from '../shared/types/entities.js';

const triageSkill = readFileSync(serverFile('agent-skills/support-triage/SKILL.md'), 'utf8');
const learningSkill = readFileSync(
  serverFile('agent-skills/support-close-learning/SKILL.md'),
  'utf8',
);
const fallback = (version: string, id: string): TriageResult => ({
  schema_version: '1.0',
  dictionary_version: version,
  tags: { tag: 'undefined', urgency: 'medium', complexity: 'medium' },
  suggested_solution: null,
  evidence_message_ids: [id],
  evidence_memory_ids: [],
  missing_information: ['Необходима проверка сотрудником'],
  confidence: 0,
  needs_review: true,
});
const tool = (name: string, description: string, parameters: unknown): Row => ({
  type: 'function',
  function: { name, description, parameters },
});
const recallTools = [
  tool('search_resolved_cases', 'Search authorized resolved cases.', {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string', maxLength: 2000 } },
  }),
  tool('get_case_evidence', 'Expand IDs from the previous search only.', {
    type: 'object',
    additionalProperties: false,
    required: ['ids'],
    properties: { ids: { type: 'array', maxItems: 3, items: { type: 'string' } } },
  }),
];

export class Workflows {
  constructor(
    readonly db: Database,
    readonly c: Config,
    readonly model: Model,
    readonly memory: Recall,
  ) {}
  async triage(job: Job) {
    const message = await one<Message>(
      this.db,
      'SELECT * FROM messages WHERE org_id=$1 AND id=$2',
      [this.c.ORG_ID, job.payload.message_id],
    );
    if (!message || !(await eligibleJob(this.db, this.c.ORG_ID, job))) {
      return;
    }
    const attachments = (
      await this.db.query(
        'SELECT id,status,extraction,extraction_status FROM attachments WHERE message_id=$1 ORDER BY id',
        [message.id],
      )
    ).rows;
    const dictionaries = job.payload.dictionaries as Row[];
    const version = String(job.payload.dictionary_version);
    const input = {
      first_message: {
        id: message.id,
        text: redact(message.text),
        attachments: attachments.map((a) => ({
          ...a,
          extraction: typeof a.extraction === 'string' ? redact(a.extraction) : null,
        })),
      },
      dictionary_version: version,
      dictionaries,
    };
    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: `${triageSkill}\nOutput JSON schema:\n${JSON.stringify(triageSchema)}`,
      },
      { role: 'user', content: JSON.stringify(input) },
    ];
    let cases: CaseEvidence[] = [];
    let result = fallback(version, message.id);
    let success = false;
    let failure = 'ai_failed';
    let calls = 0;
    let searched = false;
    let expanded = false;
    try {
      for (let turn = 0; turn < 3; turn++) {
        const answer = await this.model.complete(job, `triage-${turn}`, {
          messages,
          tools: calls < 2 ? recallTools : undefined,
          json: true,
          mock: result as unknown as Row,
        });
        if (answer.toolCalls.length) {
          ensure(answer.toolCalls.length === 1 && calls < 2, 'ai_tool_budget', 422);
          calls++;
          const call = answer.toolCalls[0];
          const args = object(strictJson(call.arguments));
          let data: unknown;
          if (call.name === 'search_resolved_cases') {
            ensure(!searched, 'ai_tool_budget', 422);
            searched = true;
            const parsed = z
              .object({ query: z.string().min(1).max(2000) })
              .strict()
              .parse(args);
            try {
              cases = await this.memory.search(redact(parsed.query));
              data = { cases };
            } catch {
              data = { cases: [], unavailable: true };
            }
          } else if (call.name === 'get_case_evidence') {
            ensure(searched && !expanded, 'ai_tool_budget', 422);
            expanded = true;
            const parsed = z
              .object({ ids: z.array(z.string()).max(3) })
              .strict()
              .parse(args);
            ensure(
              parsed.ids.every((id) => cases.some((c) => c.id === id)),
              'forged_memory_evidence',
              422,
            );
            data = { cases: await this.memory.expand(parsed.ids) };
          } else {
            throw new AppError('forbidden_ai_tool', 422);
          }
          messages.push(
            {
              role: 'assistant',
              content: answer.content,
              tool_calls: [
                {
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
            { role: 'tool', tool_call_id: call.id, content: JSON.stringify(data) },
          );
          continue;
        }
        try {
          result = parseTriage(
            answer.content ?? '',
            version,
            dictionaries,
            [message.id],
            cases.map((c) => c.id),
          );
          success = true;
        } catch {
          messages.push(
            { role: 'assistant', content: answer.content?.slice(0, 32768) ?? '' },
            {
              role: 'user',
              content:
                'Invalid schema or evidence. Return one corrected JSON object using only the supplied dictionary and evidence. This is the only repair.',
            },
          );
          const repair = await this.model.complete(job, 'triage-repair', {
            messages,
            json: true,
            mock: result as unknown as Row,
          });
          result = parseTriage(
            repair.content ?? '',
            version,
            dictionaries,
            [message.id],
            cases.map((c) => c.id),
          );
          success = true;
        }
        break;
      }
    } catch (error) {
      if (error instanceof AppError && ['ai_busy', 'gateway_unavailable'].includes(error.code)) {
        throw error;
      }
      failure = error instanceof AppError ? error.code : 'ai_failed';
      result = fallback(version, message.id);
    }
    const stillEligibleMemory = await this.memory
      .expand(result.evidence_memory_ids)
      .catch(() => []);
    if (stillEligibleMemory.length !== result.evidence_memory_ids.length) {
      result = fallback(version, message.id);
      success = false;
      failure = 'stale_memory';
    }
    await this.db.tx(async (tx) => {
      const ref = await one(tx, 'SELECT client_id FROM tickets WHERE id=$1', [job.ref_id]);
      if (!ref) {
        return;
      }
      await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);
      const ticket = await one<Ticket>(
        tx,
        'SELECT * FROM tickets WHERE id=$1 AND org_id=$2 FOR UPDATE',
        [job.ref_id, this.c.ORG_ID],
      );
      if (!ticket) {
        return;
      }
      if (!(await eligibleJob(tx, this.c.ORG_ID, job))) {
        return;
      }
      const current = await one<Message>(tx, 'SELECT * FROM messages WHERE id=$1', [message.id]);
      if (current?.revision !== job.payload.revision) {
        await tx.query(
          "UPDATE tickets SET ai_status='failed',suggestion_stale=true,review_required=true WHERE id=$1",
          [ticket.id],
        );
        return;
      }
      for (const field of ['tag', 'urgency', 'complexity'] as const) {
        const active = await one(
          tx,
          'SELECT label,version FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 AND active',
          [this.c.ORG_ID, field, result.tags[field]],
        );
        if (!active) {
          result.tags[field] = field === 'tag' ? 'undefined' : 'medium';
          success = false;
        }
        if (ticket[`${field}_revision`] === Number((job.payload.field_revisions as Row)[field])) {
          await tx.query(
            `UPDATE tickets SET ${field}=$2,classification_labels=jsonb_set(classification_labels,ARRAY[$3],$4::jsonb) WHERE id=$1`,
            [ticket.id, result.tags[field], field, JSON.stringify(active ?? {})],
          );
        }
      }
      await tx.query(
        'UPDATE tickets SET ai_status=$2,suggestion=$3,review_required=$4,version=version+1 WHERE id=$1',
        [
          ticket.id,
          success ? 'done' : 'failed',
          JSON.stringify(result),
          !success || result.needs_review,
        ],
      );
      await audit(tx, this.c.ORG_ID, null, 'ai.triage', ticket.id, {
        success,
        reason: success ? null : failure,
        skill_hash: hash(triageSkill),
      });
      await emit(tx, this.c.ORG_ID, 'ticket.classified', ticket.id);
    });
  }

  async snapshot(
    job: Job,
  ): Promise<{ cycle: Closure; entries: SnapshotEntry[]; missing: string[] }> {
    return this.db.tx(async (tx) => {
      const initial = await one<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 AND org_id=$2', [
        job.ref_id,
        this.c.ORG_ID,
      ]);
      ensure(initial, 'not_found', 404);
      const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1', [
        initial.ticket_id,
      ]);
      ensure(ticket, 'not_found', 404);
      await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ticket.client_id]);
      await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticket.id]);
      const cycle = (await one<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
        initial.id,
      ]))!;
      ensure(await eligibleJob(tx, this.c.ORG_ID, job), 'job_ineligible');
      if (cycle.snapshot) {
        return {
          cycle,
          ...decrypt<{ entries: SnapshotEntry[]; missing: string[] }>(
            cycle.snapshot,
            this.c.ENCRYPTION_KEY,
          ),
        };
      }
      const messages = (
        await tx.query<Message>(
          'SELECT * FROM messages WHERE org_id=$1 AND ticket_id=$2 AND seq<=$3 ORDER BY seq',
          [this.c.ORG_ID, ticket.id, cycle.cutoff_seq],
        )
      ).rows;
      const files = (
        await tx.query(
          'SELECT id,message_id,status,extraction,extraction_status FROM attachments WHERE org_id=$1 AND ticket_id=$2 AND message_id IS NOT NULL',
          [this.c.ORG_ID, ticket.id],
        )
      ).rows;
      const pending = files.some((f) =>
        ['pending', 'quarantined', 'receiving'].includes(String(f.status)),
      );
      if (pending && Date.now() - new Date(cycle.closed_at).getTime() < 60000) {
        throw new AppError('snapshot_waiting_files', 429);
      }
      const revisions = (
        await tx.query(
          'SELECT r.* FROM message_revisions r JOIN messages m ON m.id=r.message_id WHERE m.ticket_id=$1 AND m.seq<=$2 ORDER BY m.seq,r.revision',
          [ticket.id, cycle.cutoff_seq],
        )
      ).rows;
      const entries: SnapshotEntry[] = messages.map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.author_type,
        text: redact(m.text),
        delivery: m.delivery_state,
        revision: m.revision,
        attachments: files
          .filter((f) => f.message_id === m.id)
          .map((f) => ({
            id: String(f.id),
            status: String(f.status),
            extraction: typeof f.extraction === 'string' ? redact(f.extraction) : null,
            coverage: String(f.extraction_status),
          })),
        revisions: revisions
          .filter((r) => r.message_id === m.id)
          .map((r) => ({
            revision: Number(r.revision),
            text: redact(
              decrypt<{ text: string }>(String(r.encrypted_previous), this.c.ENCRYPTION_KEY).text,
            ),
            deleted: !!r.deleted,
          })),
      }));
      const missing = entries.flatMap((e) =>
        e.attachments
          .filter((f) => f.status !== 'clean' || f.coverage !== 'complete')
          .map((f) => `${f.id}:${f.status}:${f.coverage}`),
      );
      const data = { entries, missing };
      await tx.query(
        "UPDATE closures SET snapshot=$2,snapshot_hash=$3,coverage=$4,learning_status='analyzing' WHERE id=$1",
        [
          cycle.id,
          encrypt(data, this.c.ENCRYPTION_KEY),
          hash(JSON.stringify(data)),
          JSON.stringify({
            expected_messages: entries.map((e) => e.id),
            message_count: entries.length,
            missing_attachments: missing,
            builder: '1.0',
          }),
        ],
      );
      return { cycle, entries, missing };
    });
  }

  /** One model step per queue job invocation, yielding between chunks for fair admission. */
  async learning(job: Job): Promise<boolean> {
    if (!this.c.AI_ENABLED) {
      throw new AppError('ai_disabled', 503);
    }
    const { cycle, entries, missing } = await this.snapshot(job);
    const allIds = entries.map((e) => e.id);
    ensure(allIds.length > 0, 'empty_snapshot');
    const existing = await one(
      this.db,
      'SELECT * FROM memory_records WHERE org_id=$1 AND closure_id=$2',
      [this.c.ORG_ID, cycle.id],
    );
    if (existing) {
      const receipt = {
        schema_version: '1.0',
        tool_receipt_id: String(existing.receipt_id),
        status: 'accepted_pending_persistence',
      };
      const call = await this.checkpoint(job, 'memorize-call');
      ensure(call, 'missing_tool_receipt');
      const response = await this.model.complete(job, 'learning-completion', {
        messages: [
          { role: 'system', content: learningSkill },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: call.call_id,
                type: 'function',
                function: { name: 'memorize_ticket_resolution', arguments: call.arguments },
              },
            ],
          },
          { role: 'tool', tool_call_id: String(call.call_id), content: JSON.stringify(receipt) },
        ],
        json: true,
        mock: receipt,
      });
      const result = z
        .object({
          schema_version: z.literal('1.0'),
          tool_receipt_id: z.literal(String(existing.receipt_id)),
          status: z.literal('accepted_pending_persistence'),
        })
        .strict()
        .parse(strictJson(response.content ?? ''));
      await this.saveCheckpoint(job, 'completion', result, allIds, hash(JSON.stringify(receipt)));
      return true;
    }
    const budget = this.c.AI_INPUT_CHARS;
    const chunks = planChunks(entries, Math.max(2000, budget - 5000));
    ensure(chunks.length <= 512, 'learning_budget_exceeded');
    let evidence: unknown = entries;
    if (JSON.stringify(entries).length > budget - 5000) {
      let summaries: Summary[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const key = `chunk-${i}`;
        const prior = await this.checkpoint(job, key);
        if (!prior) {
          await this.summarize(
            job,
            key,
            chunks[i],
            chunks[i].map((p) => p.id),
          );
          return false;
        }
        summaries.push(summarySchema.parse(prior));
      }
      let round = 0;
      while (JSON.stringify(summaries).length > budget - 5000) {
        const next: Summary[] = [];
        for (let i = 0; i < summaries.length; i += 2) {
          const group = summaries.slice(i, i + 2);
          const key = `reduce-${round}-${i / 2}`;
          const prior = await this.checkpoint(job, key);
          if (!prior) {
            await this.summarize(
              job,
              key,
              group,
              group.flatMap((g) => g.evidence_message_ids),
            );
            return false;
          }
          next.push(summarySchema.parse(prior));
        }
        summaries = next;
        round++;
        ensure(round < 20, 'learning_reduction_budget');
      }
      evidence = summaries;
    }
    const defaultResolution: Resolution = {
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
    const input = {
      evidence,
      coverage: {
        all_message_count: allIds.length,
        manifest_hash: hash(JSON.stringify(allIds)),
        all_chunks: chunks.length,
        missing_attachments: missing,
      },
      note: String(cycle.note ?? ''),
    };
    ensure(JSON.stringify(input).length <= budget, 'learning_budget_exceeded');
    const answer = await this.model.complete(job, 'memorize', {
      messages: [
        { role: 'system', content: learningSkill },
        { role: 'user', content: JSON.stringify(input) },
      ],
      tools: [
        tool(
          'memorize_ticket_resolution',
          'Store a resolution with host-injected provenance.',
          resolutionSchema,
        ),
      ],
      forceTool: 'memorize_ticket_resolution',
      mock: defaultResolution as unknown as Row,
    });
    ensure(
      answer.toolCalls.length === 1 && answer.toolCalls[0].name === 'memorize_ticket_resolution',
      'memory_tool_required',
      422,
    );
    const call = answer.toolCalls[0];
    let resolution = parseResolution(call.arguments, allIds);
    const sanitized = redact(JSON.stringify(resolution));
    let containsSecrets = sanitized !== JSON.stringify(resolution);
    if (containsSecrets) {
      resolution = parseResolution(sanitized, allIds);
    }
    const sourceKey = hash(`${this.c.ORG_ID}|${cycle.id}|${hash(JSON.stringify(entries))}|1`);
    const contentHash = hash(JSON.stringify(resolution));
    const confirmed =
      confirmedResolution(resolution, entries) && missing.length === 0 && !containsSecrets;
    await this.db.tx(async (tx) => {
      const ticket = (await one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1', [
        cycle.ticket_id,
      ]))!;
      await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ticket.client_id]);
      await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticket.id]);
      ensure(await eligibleJob(tx, this.c.ORG_ID, job), 'job_ineligible');
      const record = await one(
        tx,
        'INSERT INTO memory_records(org_id,ticket_id,closure_id,source_key,content_hash,content,eligible) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_key) DO NOTHING RETURNING *',
        [
          this.c.ORG_ID,
          ticket.id,
          cycle.id,
          sourceKey,
          contentHash,
          JSON.stringify(resolution),
          confirmed,
        ],
      );
      const stored =
        record ?? (await one(tx, 'SELECT * FROM memory_records WHERE source_key=$1', [sourceKey]));
      ensure(stored?.content_hash === contentHash, 'memory_content_conflict');
      await tx.query(
        'INSERT INTO ai_checkpoints(job_id,step_key,output,input_hash,covered_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          job.id,
          'memorize-call',
          encrypt({ call_id: call.id, arguments: call.arguments }, this.c.ENCRYPTION_KEY),
          hash(call.arguments),
          JSON.stringify(allIds),
        ],
      );
      await enqueue(tx, this.c.ORG_ID, `memory:${stored.id}`, 'memory', String(stored.id));
      await tx.query(
        "UPDATE closures SET learning_status='persistence_pending',coverage=coverage||$2::jsonb WHERE id=$1",
        [
          cycle.id,
          JSON.stringify({
            consumed_messages: allIds,
            complete_text_coverage: true,
            expected_chunks: chunks.length,
            evidence_grade: confirmed
              ? 'client_confirmed'
              : missing.length
                ? 'incomplete'
                : 'inferred',
          }),
        ],
      );
      await audit(tx, this.c.ORG_ID, null, 'memory.tool.accepted', String(stored.id), {
        receipt_id: stored.receipt_id,
        skill_hash: hash(learningSkill),
        eligible: confirmed,
      });
      await emit(tx, this.c.ORG_ID, 'learning.changed', ticket.id, {
        state: 'persistence_pending',
      });
    });
    return false;
  }
  private async checkpoint(job: Job, key: string): Promise<Row | undefined> {
    const row = await one(
      this.db,
      'SELECT output FROM ai_checkpoints WHERE job_id=$1 AND step_key=$2',
      [job.id, key],
    );
    return row ? decrypt<Row>(String(row.output), this.c.ENCRYPTION_KEY) : undefined;
  }
  private async saveCheckpoint(
    job: Job,
    key: string,
    value: unknown,
    ids: string[],
    digest: string,
  ) {
    await this.db.query(
      'INSERT INTO ai_checkpoints(job_id,step_key,output,input_hash,covered_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        job.id,
        key,
        encrypt(value, this.c.ENCRYPTION_KEY),
        digest,
        JSON.stringify([...new Set(ids)]),
      ],
    );
  }
  private async summarize(job: Job, key: string, input: unknown, ids: string[]) {
    const unique = [...new Set(ids)];
    const mock = {
      summary: 'Недостаточно данных для подтверждённого решения.',
      evidence_message_ids: unique,
    };
    const response = await this.model.complete(job, key, {
      messages: [
        {
          role: 'system',
          content: `${learningSkill}\nThis is a coverage-preserving extraction step, not final memorization. Return JSON {summary: string (max 2000 characters), evidence_message_ids: string[]}. Preserve attempts, results, contradictions and delivery status. Only reference supplied IDs. Do not claim successful resolution without evidence.`,
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
      json: true,
      mock,
    });
    const output = summarySchema.parse(strictJson(response.content ?? ''));
    ensure(
      output.evidence_message_ids.every((id) => unique.includes(id)),
      'forged_chunk_evidence',
      422,
    );
    // Coverage comes from assigned input, never from the model's choice of cited messages.
    await this.saveCheckpoint(job, key, output, unique, hash(JSON.stringify(input)));
  }
}
const summarySchema = z
  .object({
    summary: z.string().min(1).max(2000),
    evidence_message_ids: z.array(z.string()).max(20000),
  })
  .strict();
type Summary = z.infer<typeof summarySchema>;
type Part = { id: string; part: number; parts: number; data: string };
export function planChunks(entries: SnapshotEntry[], budget: number): Part[][] {
  const parts: Part[] = [];
  const size = Math.max(500, Math.floor(budget / 2) - 200);
  for (const entry of entries) {
    const data = JSON.stringify(entry);
    const count = Math.max(1, Math.ceil(data.length / size));
    for (let i = 0; i < count; i++) {
      parts.push({
        id: entry.id,
        part: i,
        parts: count,
        data: data.slice(i * size, (i + 1) * size),
      });
    }
  }
  const chunks: Part[][] = [];
  let current: Part[] = [];
  let used = 2;
  for (const part of parts) {
    const length = JSON.stringify(part).length + 1;
    if (current.length && used + length > budget) {
      chunks.push(current);
      current = [];
      used = 2;
    }
    current.push(part);
    used += length;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}
export function confirmedResolution(resolution: Resolution, entries: SnapshotEntry[]): boolean {
  if (resolution.outcome !== 'resolved') {
    return false;
  }
  const staff = entries.filter(
    (e) =>
      e.role === 'staff' &&
      e.delivery === 'delivered' &&
      resolution.steps.some((s) => s.evidence_message_ids.includes(e.id)),
  );
  return (
    staff.length > 0 &&
    entries.some(
      (e) =>
        e.role === 'client' &&
        resolution.evidence_message_ids.includes(e.id) &&
        staff.some((s) => s.seq < e.seq) &&
        /(?:теперь\s+(?:всё\s+)?работает|заработало|проблема\s+решена|ошибка\s+исчезла|всё\s+получилось)/i.test(
          e.text,
        ) &&
        !/(?:не\s+работает|не\s+решена|не\s+помог)/i.test(e.text),
    )
  );
}
