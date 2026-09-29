import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, it } from 'vitest';

import { MaxClient, TransportFailure } from '../src/integrations/max/index.js';

import { testConfig } from './helpers.js';

type Answer = { status: number; body: unknown };

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function maxServer(answers: Answer[]) {
    const paths: string[] = [];

    const server = createServer((request, response) => {
        request.resume();

        request.on('end', () => {
            paths.push(String(request.url));
            const answer = answers.shift() ?? { status: 500, body: {} };

            response.writeHead(answer.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(answer.body));
        });
    });

    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const config = testConfig({
        MAX_MODE: 'live',
        MAX_BOT_TOKEN: 'bot-token',
        MAX_API_URL: `http://127.0.0.1:${port}`,
    });

    return { client: new MaxClient(config), paths };
}

const notReady = { status: 400, body: { code: 'attachment.not.ready', message: 'not processed' } };
const sent = { status: 200, body: { message: { body: { mid: 'mid-1' } } } };
const attachment = { attachments: [{ type: 'image', payload: { token: 'photo' } }] };

it('waits for MAX to process an uploaded attachment before sending', async () => {
    const { client, paths } = await maxServer([notReady, sent]);

    await expect(client.send('77', attachment)).resolves.toBe('mid-1');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('/messages?chat_id=77');
});

it('rejects other client errors with the status and keeps not-ready retryable', async () => {
    const { client } = await maxServer([{ status: 400, body: { code: 'proto.payload' } }]);

    await expect(client.send('77', { text: 'hi' })).rejects.toMatchObject({
        outcome: 'failed',
        reason: 'max_rejected_400',
    });

    const busy = await maxServer([notReady, notReady, notReady, notReady, notReady]);
    const failure = await busy.client.send('77', attachment).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransportFailure);
    expect(failure).toMatchObject({ outcome: 'retry', reason: 'attachment_not_ready' });
    expect(busy.paths).toHaveLength(5);
}, 30000);
