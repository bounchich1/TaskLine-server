import { afterEach, beforeEach, expect, it } from 'vitest';

import { Gateway, Workflows } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import type { Job } from '../src/shared/types/entities.js';

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

it('repairs one rejected memorize call and fills the constant schema version', async () => {
    await context.create();
    await context.command('assign');
    await context.command('messages', { text: 'Перезапустите соединение' });
    await context.db.query("UPDATE deliveries SET state='delivered'");
    await context.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
    await context.input('Спасибо, теперь всё работает');
    await context.command('close');
    const entries = (await context.db.query('SELECT id,author_type FROM messages ORDER BY seq')).rows;
    const client = String(entries.filter((message) => message.author_type === 'client').at(-1)!.id);
    const staff = String(entries.find((message) => message.author_type === 'staff')!.id);

    const resolution = {
        problem_summary: 'Сбой подключения',
        solution_summary: 'Перезапустить соединение',
        steps: [{ action: 'Перезапуск соединения', evidence_message_ids: [staff] }],
        observed_result: 'Клиент подтвердил восстановление',
        evidence_message_ids: [client, staff],
        applicability: [],
        cautions: [],
        uncertainties: [],
    };

    const attempts = [resolution, { ...resolution, outcome: 'resolved' }];

    const gateway = new Gateway(context.db, context.c, (request) => {
        if (!request.forceTool) {
            return Promise.resolve({ content: JSON.stringify(request.mock), toolCalls: [], usage: {} });
        }

        const call = { id: 'tool-1', name: 'memorize_ticket_resolution', arguments: JSON.stringify(attempts.shift()) };

        return Promise.resolve({ content: null, toolCalls: [call], usage: {} });
    });

    const job = await claim('learning');
    const workflow = new Workflows(context.db, context.c, gateway, noRecall);

    expect(await workflow.learning(job)).toBe(false);
    expect(await workflow.learning(job)).toBe(true);
    const record = (await one(context.db, 'SELECT content,eligible FROM memory_records'))!;

    expect(record.content).toMatchObject({ schema_version: '1.0', outcome: 'resolved' });
    expect(record.eligible).toBe(true);

    const steps = await context.db.query(
        "SELECT step_key FROM ai_calls WHERE step_key LIKE 'memorize%' ORDER BY step_key",
    );

    expect(steps.rows.map((row) => row.step_key)).toEqual(['memorize', 'memorize-repair']);
});
