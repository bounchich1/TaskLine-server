import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildGateway } from '../src/app/gateway/build-gateway.js';
import type { ModelProvider } from '../src/modules/ai/gateway/model.js';
import { Gateway, GatewayClient, Workflows, type ModelRequest } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import type { Job, Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';
import { recall, recalled, scripted, text, validTriage } from './support/triage-replies.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture(undefined, { ...testConfig(), AI_INPUT_CHARS: 6000 });
});

afterEach(async () => {
    await context.db.close();
});

async function claim(kind: string): Promise<Job> {
    const job = await one<Job>(
        context.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind=$1 RETURNING *",
        [kind],
    );

    return job!;
}

it('hands the recalled cases to one model call and repairs an invalid answer once', async () => {
    await context.create();
    const job = await claim('triage');
    const requests: ModelRequest[] = [];
    const replies = [text('not json'), text(JSON.stringify(validTriage(job)))];

    const provider: ModelProvider = (request) => {
        requests.push(structuredClone(request));

        return Promise.resolve(replies.shift()!);
    };

    await new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), recall).triage(job);
    const ticket = await context.ticket();

    expect(ticket.ai_status).toBe('done');
    expect(ticket.suggestion).toMatchObject({ evidence_memory_ids: [recalled.id] });
    expect(requests[0]?.tools).toBeUndefined();
    const input = JSON.parse(String(requests[0]?.messages[1]?.content)) as Row;

    expect(input.resolved_cases).toEqual([recalled]);
    expect(input).not.toHaveProperty('memory_unavailable');
    const steps = await context.db.query('SELECT step_key FROM ai_calls ORDER BY step_key');

    expect(steps.rows.map((row) => row.step_key)).toEqual(['triage', 'triage-repair']);
});

it('triages without cases and says so when memory is unavailable', async () => {
    await context.create();
    const job = await claim('triage');
    const requests: ModelRequest[] = [];
    const down = { search: () => Promise.reject(new Error('memory down')), expand: () => Promise.resolve([]) };

    const provider: ModelProvider = (request) => {
        requests.push(request);

        return Promise.resolve(text(JSON.stringify({ ...validTriage(job), evidence_memory_ids: [] })));
    };

    await new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), down).triage(job);

    expect((await context.ticket()).ai_status).toBe('done');
    const input = JSON.parse(String(requests[0]?.messages[1]?.content)) as Row;

    expect(input).toMatchObject({ resolved_cases: [], memory_unavailable: true });
});

it('accepts a triage wrapped in a single-key envelope without a repair call', async () => {
    await context.create();
    const job = await claim('triage');
    const triage: Row = { ...validTriage(job), evidence_memory_ids: [] };

    const gateway = new Gateway(
        context.db,
        context.c,
        scripted([text(JSON.stringify({ answer: JSON.stringify(triage) }))]),
    );

    await new Workflows(context.db, context.c, gateway, recall).triage(job);
    const ticket = await context.ticket();

    expect(ticket.ai_status).toBe('done');
    expect(ticket.tag).toBe((triage.tags as Row).tag);
    expect(ticket.suggestion).toMatchObject({ customer_reply: 'Перезапустите, пожалуйста, роутер.' });
    const steps = await context.db.query('SELECT step_key FROM ai_calls ORDER BY step_key');

    expect(steps.rows.map((row) => row.step_key)).toEqual(['triage']);
});

it('trims a long tip, drops foreign case refs, scrubs case ids from the reply and flags dropped cautions', async () => {
    await context.create();
    const job = await claim('triage');
    const cautioned = { ...recalled, cautions: ['Не сбрасывать к заводским'] };
    const valid = validTriage(job);
    const step = (index: number) => ({ text: `Шаг ${index}`, case_refs: [recalled.id, 'case-forged'] });

    const triage = {
        ...valid,
        tip: { summary: 'Сбой подключения.', steps: [1, 2, 3, 4, 5, 6, 7].map(step), cautions: [] },
        customer_reply: `Перезапустите роутер (${recalled.id}).`,
        missing_information: ['Модель', 'Модель', 'Адрес', 'Время', 'Ошибка', 'Тариф'],
    };

    const provider = scripted([text(JSON.stringify(triage))]);

    const cautionedRecall = { search: () => Promise.resolve([cautioned]), expand: () => Promise.resolve([cautioned]) };

    await new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), cautionedRecall).triage(
        job,
    );

    const ticket = await context.ticket();
    const suggestion = ticket.suggestion as Row & { tip: { steps: { case_refs: string[] }[] } };

    expect(ticket.ai_status).toBe('done');
    expect(suggestion.tip.steps).toHaveLength(5);
    expect(suggestion.tip.steps[0]?.case_refs).toEqual([recalled.id]);
    expect(suggestion.customer_reply).toBe('Перезапустите роутер.');
    expect(suggestion.missing_information).toEqual(['Модель', 'Адрес', 'Время', 'Ошибка']);
    expect(suggestion.needs_review).toBe(true);
    expect(ticket.review_required).toBe(true);
});

it('falls back to a review-required suggestion and reports why when the model call fails', async () => {
    await context.create();
    const job = await claim('triage');
    const gateway = new Gateway(context.db, context.c, scripted([]));

    await expect(new Workflows(context.db, context.c, gateway, recall).triage(job)).rejects.toMatchObject({
        code: 'ai_failed',
    });

    const ticket = await context.ticket();

    expect(ticket.ai_status).toBe('failed');
    expect(ticket.review_required).toBe(true);
});

it('summarizes a long conversation in chunks, reduces the summaries, then memorizes', async () => {
    const long = 'Интернет пропадает каждые пять минут, роутер перезагружали. '.repeat(55);

    await context.create(long);
    await context.command('assign');

    for (let i = 0; i < 3; i++) {
        await context.input(long);
    }

    await context.command('close');
    const job = await claim('learning');
    const workflows = new Workflows(context.db, context.c, new Gateway(context.db, context.c), recall);
    let finished = false;

    for (let step = 0; step < 40 && !finished; step++) {
        finished = await workflows.learning(job);
    }

    expect(finished).toBe(true);
    const keys = await context.db.query('SELECT step_key FROM ai_checkpoints WHERE job_id=$1', [job.id]);
    const stepKeys = keys.rows.map((row) => String(row.step_key));

    expect(stepKeys).toContain('chunk-0');
    expect(stepKeys).toContain('reduce-0-0');
    expect(stepKeys).toContain('memorize-call');
    expect(stepKeys).toContain('completion');
});

it('serves model calls over HTTP to authorized workers only', async () => {
    await context.create();
    const job = await claim('triage');
    const gateway = await buildGateway(context.db, context.c);

    try {
        const health = await gateway.inject({ url: '/health' });

        expect(health.json<{ permits: unknown[] }>().permits.length).toBeGreaterThan(0);
        const anonymous = await gateway.inject({ method: 'POST', url: '/execute', payload: {} });

        expect(anonymous.statusCode).toBe(401);
        const address = await gateway.listen({ port: 0, host: '127.0.0.1' });
        const client = new GatewayClient({ ...context.c, GATEWAY_URL: address });
        const request = { messages: [{ role: 'user' as const, content: 'ping' }], mock: { ok: true } };
        const reply = await client.complete(job, 'probe', request);

        expect(reply.content).toBe('{"ok":true}');
        const stale = { ...job, generation: job.generation + 1 };

        await expect(client.complete(stale, 'probe-2', request)).rejects.toMatchObject({
            code: 'job_stale',
        });
    } finally {
        await gateway.close();
    }
});
