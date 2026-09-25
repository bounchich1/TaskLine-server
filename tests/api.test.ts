import { beforeEach, afterEach, it, expect } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { one } from '../src/shared/db.js';

import { fixture } from './helpers.js';
import { staffLogin } from './support/http-client.js';

type TicketPage = {
    items: { number: string }[];
    counts: Record<string, number>;
    next_cursor: string | null;
};

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let headers: Record<string, string>;

beforeEach(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);
    headers = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers();
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

it('rejects unknown staff, forged launch data and cross-origin mutations', async () => {
    expect((await app.inject({ url: '/v1/tickets' })).statusCode).toBe(401);

    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/v1/auth/dev',
                headers: { origin: context.c.APP_ORIGIN },
                payload: { user_id: '999' },
            })
        ).statusCode,
    ).toBe(403);

    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/v1/auth/max',
                headers: { origin: context.c.APP_ORIGIN },
                payload: { init_data: 'auth_date=100&hash=invalid' },
            })
        ).statusCode,
    ).toBe(401);

    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/v1/auth/logout',
                headers: { ...headers, origin: 'https://evil.invalid' },
                payload: {},
            })
        ).statusCode,
    ).toBe(403);

    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/v1/auth/logout',
                headers: { ...headers, 'x-csrf-token': 'bad' },
                payload: {},
            })
        ).statusCode,
    ).toBe(403);
});

it('enforces command shape, If-Match, idempotency and absent forbidden routes', async () => {
    const ticket = await context.create();

    const claim = await app.inject({
        method: 'POST',
        url: `/v1/tickets/${ticket.id}/assign`,
        headers: { ...headers, 'if-match': String(ticket.version) },
        payload: {},
    });

    expect(claim.statusCode).toBe(200);

    const repeat = await app.inject({
        method: 'POST',
        url: `/v1/tickets/${ticket.id}/assign`,
        headers: { ...headers, 'if-match': String(ticket.version) },
        payload: {},
    });

    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual(claim.json());

    expect(
        (
            await app.inject({
                method: 'POST',
                url: `/v1/tickets/${ticket.id}/messages`,
                headers: { ...headers, 'if-match': String(claim.json<{ version: number }>().version) },
                payload: { text: 'test', rating: 10 },
            })
        ).statusCode,
    ).toBe(422);

    expect(
        (
            await app.inject({
                method: 'POST',
                url: '/v1/tickets',
                headers,
                payload: { description: 'manual' },
            })
        ).statusCode,
    ).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/v1/tickets/${ticket.id}`, headers })).statusCode).toBe(404);
});

it('blocked staff lose existing sessions and download authorization', async () => {
    await context.db.query('UPDATE employees SET blocked=true,version=version+1 WHERE id=$1', [context.staff.id]);
    expect((await app.inject({ url: '/v1/me', headers })).statusCode).toBe(401);

    expect(
        (
            await app.inject({
                url: '/v1/attachments/00000000-0000-4000-8000-000000000000/download',
                headers,
            })
        ).statusCode,
    ).toBe(401);
});

it('webhook ACK follows durable commit and secret verification', async () => {
    const payload = {
        update_type: 'message_created',
        message: {
            sender: { user_id: 100 },
            recipient: { chat_id: 100, chat_type: 'dialog' },
            body: { mid: 'webhook-m1', text: 'Привет' },
        },
    };

    expect((await app.inject({ method: 'POST', url: '/webhooks/max', payload })).statusCode).toBe(401);

    const request = {
        method: 'POST' as const,
        url: '/webhooks/max',
        headers: { 'x-max-bot-api-secret': context.c.MAX_WEBHOOK_SECRET },
        payload,
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM inbox'))!.n).toBe(1);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM tickets'))!.n).toBe(0);
});

it('paginates deterministic queue, searches and denies admin access to support', async () => {
    await context.create('Ошибка подключения', '100');
    await context.create('Не печатается документ', '101');
    await context.create('Ошибка входа', '102');
    const first = await app.inject({ url: '/v1/tickets?limit=2', headers });

    expect(first.statusCode).toBe(200);
    const page = first.json<TicketPage>();

    expect(page.items).toHaveLength(2);
    expect(page.counts.open).toBe(3);

    const second = await app.inject({
        url: `/v1/tickets?limit=2&cursor=${String(page.next_cursor)}`,
        headers,
    });

    expect(second.json<TicketPage>().items).toHaveLength(1);
    const search = await app.inject({ url: '/v1/tickets?q=000001', headers });

    expect(search.json<TicketPage>().items[0]?.number).toBe('000001');
    expect((await app.inject({ url: '/v1/admin/employees', headers })).statusCode).toBe(403);
});
