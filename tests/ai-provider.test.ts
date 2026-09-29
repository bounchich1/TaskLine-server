import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { callOpenAi } from '../src/modules/ai/gateway/openai-provider.js';
import { Gateway } from '../src/modules/ai/index.js';
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

async function claim(kind: string) {
    return (await one<Job>(
        context.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind=$1 RETURNING *",
        [kind],
    ))!;
}

type ProviderAnswer = { status: number; body: string; headers?: Record<string, string> } | 'hang';

async function providerServer() {
    const state: { answer: ProviderAnswer; bodies: Row[] } = { answer: { status: 200, body: 'not json' }, bodies: [] };

    const server = createServer((request, response) => {
        let raw = '';

        request.on('data', (chunk: Buffer) => {
            raw += chunk.toString();
        });

        request.on('end', () => {
            state.bodies.push(JSON.parse(raw) as Row);
            const { answer } = state;

            if (answer === 'hang') {
                return;
            }

            response.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
            response.end(answer.body);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const config = {
        ...context.c,
        AI_API_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
        AI_API_KEY: 'test-key',
        AI_MODEL: 'test-model',
    };

    const close = () => {
        server.closeAllConnections();
        server.close();
    };

    return { state, config, close };
}

const busyPermits = async () => (await context.db.query('SELECT state FROM ai_permits WHERE state<>$1', ['free'])).rows;

const callRow = async (step: string) => one(context.db, 'SELECT state,reason FROM ai_calls WHERE step_key=$1', [step]);

it('sends the per-kind limits and frees the permit whenever the provider settled the call', async () => {
    await context.create();
    const job = await claim('triage');
    const provider = await providerServer();
    const gatewayConfig = { ...context.c, AI_TRIAGE_REASONING_EFFORT: 'low' as const };

    const gateway = new Gateway(context.db, gatewayConfig, (request, options) =>
        callOpenAi(provider.config, request, options),
    );

    const request = { messages: [{ role: 'user' as const, content: 'test' }] };

    try {
        await expect(gateway.complete(job, 'garbled', request)).rejects.toMatchObject({ code: 'provider_bad_reply' });
        expect(await busyPermits()).toEqual([]);
        expect(await callRow('garbled')).toMatchObject({ state: 'failed', reason: 'provider_rejected' });

        expect(provider.state.bodies[0]).toMatchObject({
            max_completion_tokens: 3000,
            reasoning_effort: 'low',
            prompt_cache_key: job.id,
        });

        provider.state.answer = { status: 429, body: '{}', headers: { 'Retry-After': '30' } };

        await expect(gateway.complete(job, 'busy', request)).rejects.toMatchObject({
            code: 'provider_busy',
            retryAfterSeconds: 30,
        });

        provider.state.answer = { status: 502, body: '{}' };
        await expect(gateway.complete(job, 'outage', request)).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(await busyPermits()).toEqual([]);
        expect(await callRow('busy')).toBeUndefined();
        expect(await callRow('outage')).toBeUndefined();
    } finally {
        provider.close();
    }
});

it('keeps the permit when the provider outcome is unknown', async () => {
    await context.create();
    const job = await claim('triage');
    const provider = await providerServer();
    const gatewayConfig = { ...context.c, AI_TRIAGE_TIMEOUT_SECONDS: 1 };

    const gateway = new Gateway(context.db, gatewayConfig, (request, options) =>
        callOpenAi(provider.config, request, options),
    );

    const request = { messages: [{ role: 'user' as const, content: 'test' }] };

    try {
        provider.state.answer = { status: 504, body: '{}' };
        await expect(gateway.complete(job, 'gateway-timeout', request)).rejects.toThrow('provider_unknown');
        provider.state.answer = 'hang';
        await expect(gateway.complete(job, 'slow', request)).rejects.toMatchObject({ code: 'ai_timeout' });
        expect(await busyPermits()).toEqual([{ state: 'uncertain' }, { state: 'uncertain' }]);
        expect(await callRow('slow')).toMatchObject({ state: 'uncertain', reason: 'remote_outcome_unknown' });
    } finally {
        provider.close();
    }
});
