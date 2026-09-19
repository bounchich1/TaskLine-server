import { beforeEach, afterEach, it, expect } from 'vitest';

import { fixture } from './helpers.js';
import { Gateway } from '../src/ai/gateway.js';
import { Memory, type MemoryTransport } from '../src/ai/memory.js';
import { Workflows } from '../src/ai/workflows.js';
import { hash } from '../src/shared/crypto.js';
import { one } from '../src/shared/db.js';
import type { Resolution } from '../src/shared/types/ai.js';
import type { Job, Row } from '../src/shared/types/entities.js';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.db.close();
});
async function claim(kind: string) {
  return (await one<Job>(
    f.db,
    "UPDATE jobs SET state='running',generation=generation+1 WHERE kind=$1 RETURNING *",
    [kind],
  ))!;
}
class FakeMemory implements MemoryTransport {
  records = new Map<string, Row>();
  calls = 0;
  unknown = false;
  async remember(content: string, project: string) {
    const memory = { id: `mem_${++this.calls}`, content, project };
    this.records.set(memory.id, memory);
    if (this.unknown) {
      throw new Error('timeout_after_commit');
    }
    return memory;
  }
  async get(id: string) {
    return this.records.get(id) ?? null;
  }
  async search(query: string) {
    return [...this.records.values()]
      .filter((r) => String(r.content).includes(query) || query === 'подключение')
      .map((r) => String(r.id));
  }
  async list() {
    return [...this.records.values()];
  }
  async forget(id: string) {
    this.records.delete(id);
  }
}
it('applies triage once without overwriting a manual field', async () => {
  const ticket = await f.create();
  await f.command('classification', { urgency: 'high', revisions: { urgency: 0 } });
  const job = await claim('triage');
  const workflow = new Workflows(f.db, f.c, new Gateway(f.db, f.c), {
    search: async () => [],
    expand: async () => [],
  });
  await workflow.triage(job);
  const result = await f.ticket();
  expect(result.urgency).toBe('high');
  expect(result.ai_status).toBe('done');
  expect(result.suggestion?.suggested_solution).toBeNull();
  await workflow.triage(job);
  expect((await one(f.db, 'SELECT count(*)::int AS n FROM ai_calls'))!.n).toBe(1);
  expect(
    (await one(
      f.db,
      "SELECT count(*)::int AS n FROM deliveries WHERE kind='staff' AND ticket_id=$1",
      [ticket.id],
    ))!.n,
  ).toBe(0);
});
it('retains uncertain permits and refuses duplicate provider dispatch', async () => {
  await f.create();
  const job = await claim('triage');
  let calls = 0;
  const gateway = new Gateway(f.db, f.c, async () => {
    calls++;
    throw new Error('remote_timeout');
  });
  const request = { messages: [{ role: 'user' as const, content: 'test' }] };
  await expect(gateway.complete(job, 'step', request)).rejects.toThrow();
  await expect(gateway.complete(job, 'step', request)).rejects.toMatchObject({
    code: 'ai_uncertain',
  });
  expect(calls).toBe(1);
  expect(
    (await one(f.db, "SELECT count(*)::int AS n FROM ai_permits WHERE state='uncertain'"))!.n,
  ).toBe(1);
});
it('requires a real memory tool call, verifies persistence and removes reopened cases from recall', async () => {
  await f.create();
  await f.command('assign');
  await f.command('messages', { text: 'Перезапустите соединение' });
  await f.db.query("UPDATE deliveries SET state='delivered'");
  await f.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
  await f.input('Спасибо, теперь всё работает');
  await f.command('close');
  const entries = (await f.db.query('SELECT id,author_type FROM messages ORDER BY seq')).rows;
  const client = entries.filter((m) => m.author_type === 'client').at(-1)!;
  const staff = entries.find((m) => m.author_type === 'staff')!;
  const resolution: Resolution = {
    schema_version: '1.0',
    problem_summary: 'Сбой подключения',
    solution_summary: 'Перезапустить соединение',
    outcome: 'resolved',
    steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [String(staff.id)] }],
    observed_result: 'Клиент подтвердил восстановление',
    evidence_message_ids: [String(client.id), String(staff.id)],
    applicability: [],
    cautions: [],
    uncertainties: [],
  };
  const upstream = new FakeMemory();
  const memory = new Memory(f.db, f.c, upstream);
  const gateway = new Gateway(f.db, f.c, async (request) =>
    request.forceTool
      ? {
          content: null,
          toolCalls: [
            {
              id: 'tool-1',
              name: 'memorize_ticket_resolution',
              arguments: JSON.stringify(resolution),
            },
          ],
          usage: {},
        }
      : { content: JSON.stringify(request.mock), toolCalls: [], usage: {} },
  );
  const job = await claim('learning');
  const workflow = new Workflows(f.db, f.c, gateway, memory);
  expect(await workflow.learning(job)).toBe(false);
  expect(await workflow.learning(job)).toBe(true);
  const record = (await one(f.db, 'SELECT * FROM memory_records'))!;
  expect(record.eligible).toBe(true);
  expect(record.receipt_id).toBeTruthy();
  await memory.persist(String(record.id));
  expect((await one(f.db, 'SELECT state FROM memory_records'))!.state).toBe('persisted');
  expect(await memory.search('подключение')).toHaveLength(1);
  const afterRestart = new Memory(f.db, f.c, upstream);
  expect(await afterRestart.search('подключение')).toHaveLength(1);
  await f.command('reopen', { reason: 'Вернулось' });
  expect(await afterRestart.search('подключение')).toHaveLength(0);
  await afterRestart.remove(String(record.id));
  expect(upstream.records.size).toBe(0);
});
it('does not repeat an unknown upstream memory write; reconciles its exact marker', async () => {
  const t = await f.create();
  await f.command('assign');
  await f.command('close');
  const cycle = await one(f.db, 'SELECT id FROM closures');
  const content = {
    problem_summary: 'подключение',
    solution_summary: null,
    outcome: 'insufficient_evidence',
    applicability: [],
    cautions: [],
  };
  const record = await one(
    f.db,
    'INSERT INTO memory_records(org_id,ticket_id,closure_id,source_key,content_hash,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [
      f.c.ORG_ID,
      t.id,
      cycle!.id,
      hash('source'),
      hash(JSON.stringify(content)),
      JSON.stringify(content),
    ],
  );
  const upstream = new FakeMemory();
  upstream.unknown = true;
  const memory = new Memory(f.db, f.c, upstream);
  await expect(memory.persist(String(record!.id))).rejects.toThrow();
  await expect(memory.persist(String(record!.id))).rejects.toMatchObject({
    code: 'memory_write_unknown',
  });
  expect(upstream.calls).toBe(1);
  await memory.reconcile(String(record!.id));
  expect(upstream.calls).toBe(1);
  expect((await one(f.db, 'SELECT state FROM memory_records'))!.state).toBe('persisted');
});
it('rejects invented memorization prose without a tool receipt', async () => {
  await f.create();
  await f.command('assign');
  await f.command('close');
  const job = await claim('learning');
  const model = new Gateway(f.db, f.c, async () => ({
    content: 'I memorized it',
    toolCalls: [],
    usage: {},
  }));
  await expect(
    new Workflows(f.db, f.c, model, { search: async () => [], expand: async () => [] }).learning(
      job,
    ),
  ).rejects.toMatchObject({ code: 'memory_tool_required' });
  expect((await one(f.db, 'SELECT count(*)::int AS n FROM memory_records'))!.n).toBe(0);
});
