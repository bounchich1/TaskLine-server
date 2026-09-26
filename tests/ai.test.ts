import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { beforeEach, afterEach, it, expect } from 'vitest';

import { callOpenAi } from '../src/modules/ai/gateway/openai-provider.js';
import { Gateway, Memory, Workflows, type MemoryTransport } from '../src/modules/ai/index.js';
import { hash } from '../src/shared/crypto.js';
import { one } from '../src/shared/db.js';
import type { Resolution } from '../src/shared/types/ai.js';
import type { Job, Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
});

afterEach(async () => {
    await context.db.close();
});

async function claim(kind: string) {
    return (await one<Job>(
        context.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind=$1 RETURNING *",
        [kind],
    ))!;
}

const noRecall = { search: () => Promise.resolve([]), expand: () => Promise.resolve([]) };

class FakeMemory implements MemoryTransport {
    records = new Map<string, Row>();
    calls = 0;
    unknown = false;
    remember(content: string, project: string) {
        const memory = { id: `mem_${++this.calls}`, content, project };

        this.records.set(memory.id, memory);

        return this.unknown ? Promise.reject(new Error('timeout_after_commit')) : Promise.resolve(memory);
    }

    get(id: string) {
        return Promise.resolve(this.records.get(id) ?? null);
    }

    search(query: string) {
        const matches = [...this.records.values()].filter(
            (stored) => String(stored.content).includes(query) || query === 'подключение',
        );

        return Promise.resolve(matches.map((stored) => String(stored.id)));
    }

    list() {
        return Promise.resolve([...this.records.values()]);
    }

    forget(id: string) {
        this.records.delete(id);

        return Promise.resolve();
    }
}

it('applies triage once without overwriting a manual field', async () => {
    const ticket = await context.create();

    await context.command('classification', { urgency: 'high', revisions: { urgency: 0 } });
    const job = await claim('triage');
    const workflow = new Workflows(context.db, context.c, new Gateway(context.db, context.c), noRecall);

    await workflow.triage(job);
    const result = await context.ticket();

    expect(result.urgency).toBe('high');
    expect(result.ai_status).toBe('done');
    expect(result.suggestion?.suggested_solution).toBeNull();
    await workflow.triage(job);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM ai_calls'))!.n).toBe(1);

    expect(
        (await one(context.db, "SELECT count(*)::int AS n FROM deliveries WHERE kind='staff' AND ticket_id=$1", [
            ticket.id,
        ]))!.n,
    ).toBe(0);
});

it('retains uncertain permits and refuses duplicate provider dispatch', async () => {
    await context.create();
    const job = await claim('triage');
    let calls = 0;

    const gateway = new Gateway(context.db, context.c, () => {
        calls++;

        return Promise.reject(new Error('remote_timeout'));
    });

    const request = { messages: [{ role: 'user' as const, content: 'test' }] };

    await expect(gateway.complete(job, 'step', request)).rejects.toThrow();

    await expect(gateway.complete(job, 'step', request)).rejects.toMatchObject({
        code: 'ai_uncertain',
    });

    expect(calls).toBe(1);
    expect((await one(context.db, "SELECT count(*)::int AS n FROM ai_permits WHERE state='uncertain'"))!.n).toBe(1);
});

it('frees the permit when the provider answered unusably but keeps it on an unknown outcome', async () => {
    await context.create();
    const job = await claim('triage');
    let answer = { status: 200, body: 'not json' };

    const server = createServer((_request, response) => {
        response.writeHead(answer.status, { 'Content-Type': 'application/json' });
        response.end(answer.body);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const config = {
        ...context.c,
        AI_API_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
        AI_API_KEY: 'test-key',
        AI_MODEL: 'test-model',
    };

    const gateway = new Gateway(context.db, context.c, (request, timeoutMs) => callOpenAi(config, request, timeoutMs));
    const request = { messages: [{ role: 'user' as const, content: 'test' }] };
    const states = async () => (await context.db.query('SELECT state FROM ai_permits WHERE state<>$1', ['free'])).rows;

    try {
        await expect(gateway.complete(job, 'garbled', request)).rejects.toMatchObject({ code: 'provider_bad_reply' });
        expect(await states()).toEqual([]);

        expect((await one(context.db, "SELECT state,reason FROM ai_calls WHERE step_key='garbled'"))!).toMatchObject({
            state: 'failed',
            reason: 'provider_rejected',
        });

        answer = { status: 502, body: '{}' };
        await expect(gateway.complete(job, 'outage', request)).rejects.toThrow('provider_unknown');
        expect(await states()).toEqual([{ state: 'uncertain' }]);
    } finally {
        server.close();
    }
});

it('requires a real memory tool call, verifies persistence and removes reopened cases from recall', async () => {
    await context.create();
    await context.command('assign');
    await context.command('messages', { text: 'Перезапустите соединение' });
    await context.db.query("UPDATE deliveries SET state='delivered'");
    await context.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
    await context.input('Спасибо, теперь всё работает');
    await context.command('close');
    const entries = (await context.db.query('SELECT id,author_type FROM messages ORDER BY seq')).rows;
    const client = entries.filter((message) => message.author_type === 'client').at(-1)!;
    const staff = entries.find((message) => message.author_type === 'staff')!;

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
    const memory = new Memory(context.db, context.c, upstream);

    const toolCall = {
        id: 'tool-1',
        name: 'memorize_ticket_resolution',
        arguments: JSON.stringify(resolution),
    };

    const gateway = new Gateway(context.db, context.c, (request) =>
        Promise.resolve(
            request.forceTool
                ? { content: null, toolCalls: [toolCall], usage: {} }
                : { content: JSON.stringify(request.mock), toolCalls: [], usage: {} },
        ),
    );

    const job = await claim('learning');
    const workflow = new Workflows(context.db, context.c, gateway, memory);

    expect(await workflow.learning(job)).toBe(false);
    expect(await workflow.learning(job)).toBe(true);
    const record = (await one(context.db, 'SELECT * FROM memory_records'))!;

    expect(record.eligible).toBe(true);
    expect(record.receipt_id).toBeTruthy();
    await memory.persist(String(record.id));
    expect((await one(context.db, 'SELECT state FROM memory_records'))!.state).toBe('persisted');
    expect(await memory.search('подключение')).toHaveLength(1);
    const afterRestart = new Memory(context.db, context.c, upstream);

    expect(await afterRestart.search('подключение')).toHaveLength(1);
    await context.command('reopen', { reason: 'Вернулось' });
    expect(await afterRestart.search('подключение')).toHaveLength(0);
    await afterRestart.remove(String(record.id));
    expect(upstream.records.size).toBe(0);
});

it('does not repeat an unknown upstream memory write; reconciles its exact marker', async () => {
    const ticket = await context.create();

    await context.command('assign');
    await context.command('close');
    const cycle = await one(context.db, 'SELECT id FROM closures');

    const content = {
        problem_summary: 'подключение',
        solution_summary: null,
        outcome: 'insufficient_evidence',
        applicability: [],
        cautions: [],
    };

    const record = await one(
        context.db,
        `INSERT INTO memory_records(org_id,ticket_id,closure_id,source_key,content_hash,content)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
            context.c.ORG_ID,
            ticket.id,
            cycle!.id,
            hash('source'),
            hash(JSON.stringify(content)),
            JSON.stringify(content),
        ],
    );

    const upstream = new FakeMemory();

    upstream.unknown = true;
    const memory = new Memory(context.db, context.c, upstream);

    await expect(memory.persist(String(record!.id))).rejects.toThrow();

    await expect(memory.persist(String(record!.id))).rejects.toMatchObject({
        code: 'memory_write_unknown',
    });

    expect(upstream.calls).toBe(1);
    await memory.reconcile(String(record!.id));
    expect(upstream.calls).toBe(1);
    expect((await one(context.db, 'SELECT state FROM memory_records'))!.state).toBe('persisted');
});

it('rejects invented memorization prose without a tool receipt', async () => {
    await context.create();
    await context.command('assign');
    await context.command('close');
    const job = await claim('learning');

    const model = new Gateway(context.db, context.c, () =>
        Promise.resolve({ content: 'I memorized it', toolCalls: [], usage: {} }),
    );

    await expect(new Workflows(context.db, context.c, model, noRecall).learning(job)).rejects.toMatchObject({
        code: 'memory_tool_required',
    });

    expect((await one(context.db, 'SELECT count(*)::int AS n FROM memory_records'))!.n).toBe(0);
});
