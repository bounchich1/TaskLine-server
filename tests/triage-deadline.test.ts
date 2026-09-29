import { afterEach, beforeEach, expect, it } from 'vitest';

import type { ModelProvider } from '../src/modules/ai/gateway/model.js';
import { Gateway, Workflows } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import { AppError } from '../src/shared/errors.js';
import type { Job } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { recall, scripted, text, toolCall, validTriage } from './support/triage-replies.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
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

it('skips the recall tools and shortens the call when the triage deadline is near', async () => {
    const ticket = await context.create();

    await context.db.query("UPDATE tickets SET created_at=now()-interval '80 seconds' WHERE id=$1", [ticket.id]);
    const job = await claim('triage');
    const seen: { tools: unknown; timeoutMs: number }[] = [];

    const provider: ModelProvider = (request, options) => {
        seen.push({ tools: request.tools, timeoutMs: options.timeoutMs });

        return Promise.resolve(text(JSON.stringify({ ...validTriage(job), evidence_memory_ids: [] })));
    };

    await new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), recall).triage(job);

    expect((await context.ticket()).ai_status).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0].tools).toBeUndefined();
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(37000);
    const steps = await context.db.query('SELECT step_key FROM ai_calls');

    expect(steps.rows).toEqual([{ step_key: 'triage-0-late' }]);
});

it('retries a triage the provider rate-limited without replaying a mismatched step', async () => {
    const ticket = await context.create();
    const job = await claim('triage');
    const valid = text(JSON.stringify({ ...validTriage(job), evidence_memory_ids: [] }));
    const limited = Object.assign(new AppError('provider_busy', 503), { retryAfterSeconds: 5 });
    let calls = 0;

    const provider: ModelProvider = () => {
        calls++;

        if (calls === 1) {
            return Promise.resolve(toolCall('call-1', 'search_resolved_cases', { query: 'подключение' }));
        }

        return calls === 2 ? Promise.reject(limited) : Promise.resolve(valid);
    };

    const workflows = new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), recall);

    await expect(workflows.triage(job)).rejects.toMatchObject({ code: 'provider_busy' });
    expect(await one(context.db, "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'")).toEqual({ n: 0 });
    await context.db.query("UPDATE tickets SET created_at=now()-interval '80 seconds' WHERE id=$1", [ticket.id]);
    await workflows.triage(job);

    expect((await context.ticket()).ai_status).toBe('done');
    const steps = await context.db.query('SELECT step_key FROM ai_calls');

    expect(steps.rows.map((row) => row.step_key).sort()).toEqual(['triage-0', 'triage-0-late']);
});

it('skips the schema repair when too little time is left for it', async () => {
    const ticket = await context.create();

    await context.db.query("UPDATE tickets SET created_at=now()-interval '105 seconds' WHERE id=$1", [ticket.id]);
    const job = await claim('triage');
    const gateway = new Gateway(context.db, context.c, scripted([text('not json')]));

    await expect(new Workflows(context.db, context.c, gateway, recall).triage(job)).rejects.toBeInstanceOf(AppError);

    expect((await context.ticket()).ai_status).toBe('failed');
    const steps = await context.db.query('SELECT step_key FROM ai_calls');

    expect(steps.rows).toEqual([{ step_key: 'triage-0-late' }]);
});

it('does not call the model once the triage deadline is too close', async () => {
    const ticket = await context.create();

    await context.db.query("UPDATE tickets SET created_at=now()-interval '116 seconds' WHERE id=$1", [ticket.id]);
    const job = await claim('triage');
    const gateway = new Gateway(context.db, context.c, scripted([]));

    await expect(new Workflows(context.db, context.c, gateway, recall).triage(job)).rejects.toMatchObject({
        code: 'triage_deadline',
    });

    expect((await context.ticket()).ai_status).toBe('failed');
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM ai_calls'))!.n).toBe(0);
    expect((await one(context.db, "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'"))!.n).toBe(0);
});
