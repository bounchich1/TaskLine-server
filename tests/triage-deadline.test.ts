import { afterEach, beforeEach, expect, it } from 'vitest';

import type { ModelProvider } from '../src/modules/ai/gateway/model.js';
import { Gateway, Workflows } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import { AppError } from '../src/shared/errors.js';
import type { Job } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { recall, scripted, text, validTriage } from './support/triage-replies.js';

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

it('gives the model call no more than the time left before the triage deadline', async () => {
    const ticket = await context.create();

    await context.db.query("UPDATE tickets SET created_at=now()-interval '80 seconds' WHERE id=$1", [ticket.id]);
    const job = await claim('triage');
    const timeouts: number[] = [];

    const provider: ModelProvider = (_request, options) => {
        timeouts.push(options.timeoutMs);

        return Promise.resolve(text(JSON.stringify(validTriage(job))));
    };

    await new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), recall).triage(job);

    expect((await context.ticket()).ai_status).toBe('done');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(37000);
});

it('skips the schema repair when too little time is left for it', async () => {
    const ticket = await context.create();

    await context.db.query("UPDATE tickets SET created_at=now()-interval '105 seconds' WHERE id=$1", [ticket.id]);
    const job = await claim('triage');
    const gateway = new Gateway(context.db, context.c, scripted([text('not json')]));

    await expect(new Workflows(context.db, context.c, gateway, recall).triage(job)).rejects.toBeInstanceOf(AppError);

    expect((await context.ticket()).ai_status).toBe('failed');
    const steps = await context.db.query('SELECT step_key FROM ai_calls');

    expect(steps.rows).toEqual([{ step_key: 'triage' }]);
});

it('retries a triage call the provider rate-limited', async () => {
    await context.create();
    const job = await claim('triage');
    const valid = text(JSON.stringify(validTriage(job)));
    const limited = Object.assign(new AppError('provider_busy', 503), { retryAfterSeconds: 5 });
    let calls = 0;

    const provider: ModelProvider = () => {
        calls++;

        return calls === 1 ? Promise.reject(limited) : Promise.resolve(valid);
    };

    const workflows = new Workflows(context.db, context.c, new Gateway(context.db, context.c, provider), recall);

    await expect(workflows.triage(job)).rejects.toMatchObject({ code: 'provider_busy' });
    expect(await one(context.db, "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'")).toEqual({ n: 0 });
    await workflows.triage(job);

    expect((await context.ticket()).ai_status).toBe('done');
    const steps = await context.db.query('SELECT step_key FROM ai_calls');

    expect(steps.rows).toEqual([{ step_key: 'triage' }]);
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
