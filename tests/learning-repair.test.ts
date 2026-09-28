import { afterEach, beforeEach, expect, it } from 'vitest';

import { JobRunner } from '../src/app/workers/job-runner.js';
import { Gateway, Workflows, type ModelRequest } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import type { Job, Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
});

afterEach(async () => {
    await context.db.close();
});

const noRecall = { search: () => Promise.resolve([]), expand: () => Promise.resolve([]) };

async function claim(kind: string) {
    return (await one<Job>(
        context.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind=$1 RETURNING *",
        [kind],
    ))!;
}

async function closedConversation(): Promise<{ client: string; staff: string }> {
    await context.create();
    await context.command('assign');
    await context.command('messages', { text: 'Перезапустите соединение' });
    await context.db.query("UPDATE deliveries SET state='delivered'");
    await context.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
    await context.input('Спасибо, теперь всё работает');
    await context.command('close');
    const entries = (await context.db.query('SELECT id,author_type FROM messages ORDER BY seq')).rows;

    return {
        client: String(entries.filter((message) => message.author_type === 'client').at(-1)!.id),
        staff: String(entries.find((message) => message.author_type === 'staff')!.id),
    };
}

function memorizing(attempts: Row[], requests: ModelRequest[], acknowledgement?: string): Gateway {
    return new Gateway(context.db, context.c, (request) => {
        if (!request.forceTool) {
            const receipt = JSON.stringify(request.mock).includes('tool_receipt_id');
            const content = receipt && acknowledgement !== undefined ? acknowledgement : JSON.stringify(request.mock);

            return Promise.resolve({ content, toolCalls: [], usage: {} });
        }

        requests.push(structuredClone(request));
        const call = { id: 'tool-1', name: 'memorize_ticket_resolution', arguments: JSON.stringify(attempts.shift()) };

        return Promise.resolve({ content: null, toolCalls: [call], usage: {} });
    });
}

async function memorySteps(): Promise<string[]> {
    const steps = await context.db.query(
        "SELECT step_key FROM ai_calls WHERE step_key LIKE 'memorize%' ORDER BY step_key",
    );

    return steps.rows.map((row) => String(row.step_key));
}

it('accepts a loose memorize call without a repair: fills constants, infers the outcome, drops extras', async () => {
    const { client, staff } = await closedConversation();

    const loose = {
        problem_summary: 'Сбой подключения',
        solution_summary: 'Перезапустить соединение',
        steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [staff, staff], note: 'x' }],
        observed_result: 'Клиент подтвердил восстановление',
        evidence_message_ids: [client, staff, client],
        cautions: [''],
        category: 'network',
    };

    const workflow = new Workflows(context.db, context.c, memorizing([loose], []), noRecall);
    const job = await claim('learning');

    expect(await workflow.learning(job)).toBe(false);
    expect(await workflow.learning(job)).toBe(true);
    const record = (await one(context.db, 'SELECT content,eligible FROM memory_records'))!;

    expect(record.content).toEqual({
        schema_version: '1.0',
        problem_summary: 'Сбой подключения',
        solution_summary: 'Перезапустить соединение',
        outcome: 'resolved',
        steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [staff] }],
        observed_result: 'Клиент подтвердил восстановление',
        evidence_message_ids: [client, staff],
        applicability: [],
        cautions: [],
        uncertainties: [],
    });

    expect(record.eligible).toBe(true);
    expect(await memorySteps()).toEqual(['memorize']);
});

it('repairs one rejected memorize call, telling the model which fields failed', async () => {
    const { client, staff } = await closedConversation();

    const resolution = {
        schema_version: '1.0',
        problem_summary: 'Сбой подключения',
        solution_summary: 'Перезапустить соединение',
        outcome: 'resolved',
        steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [staff] }],
        observed_result: 'Клиент подтвердил восстановление',
        evidence_message_ids: [client, staff],
        applicability: [],
        cautions: [],
        uncertainties: [],
    };

    const requests: ModelRequest[] = [];
    const attempts = [{ ...resolution, steps: [{ action: 'Перезапуск', evidence_message_ids: [] }] }, resolution];
    const workflow = new Workflows(context.db, context.c, memorizing(attempts, requests), noRecall);
    const job = await claim('learning');

    expect(await workflow.learning(job)).toBe(false);
    expect(await workflow.learning(job)).toBe(true);
    expect(await memorySteps()).toEqual(['memorize', 'memorize-repair']);
    const feedback = JSON.parse(String(requests[1]?.messages.at(-1)?.content)) as Row;

    expect(feedback).toMatchObject({ error: 'invalid_memory_schema' });
    expect(feedback.detail).toContain('/steps/0/evidence_message_ids');
    expect((await one(context.db, 'SELECT eligible FROM memory_records'))!.eligible).toBe(true);
});

it('keeps the schema errors of a failed learning job for diagnostics', async () => {
    const { staff } = await closedConversation();
    const broken = { problem_summary: 'Сбой', steps: [{ action: 'Перезапуск', evidence_message_ids: [staff] }] };
    const runner = new JobRunner(context.db, context.c, memorizing([broken, broken], []));
    const job = (await one<Job>(context.db, "SELECT * FROM jobs WHERE kind='learning'"))!;

    await runner.run(job.id);
    await runner.run(job.id);
    const stored = (await one<Job>(context.db, 'SELECT * FROM jobs WHERE id=$1', [job.id]))!;

    expect(stored).toMatchObject({ state: 'failed', reason: 'invalid_memory_schema' });
    expect(String(stored.payload.error_detail)).toContain('evidence_message_ids');
});

it('finishes learning when the model garbles the receipt acknowledgement', async () => {
    const { client, staff } = await closedConversation();

    const resolution = {
        problem_summary: 'Сбой подключения',
        solution_summary: 'Перезапустить соединение',
        steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [staff] }],
        observed_result: 'Клиент подтвердил восстановление',
        evidence_message_ids: [client, staff],
    };

    const gateway = memorizing([resolution], [], 'Готово, решение сохранено.');
    const workflow = new Workflows(context.db, context.c, gateway, noRecall);
    const job = await claim('learning');

    expect(await workflow.learning(job)).toBe(false);
    expect(await workflow.learning(job)).toBe(true);
    const saved = await context.db.query("SELECT step_key FROM ai_checkpoints WHERE step_key='completion'");

    expect(saved.rows).toHaveLength(1);
});
