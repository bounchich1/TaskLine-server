import { randomUUID } from 'node:crypto';

import { beforeEach, afterEach, it, expect } from 'vitest';

import { fixture } from './helpers.js';
import { buildApi } from '../src/api.js';
import { one } from '../src/shared/db.js';
let f: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let headers: Record<string, string>;
beforeEach(async () => {
  f = await fixture();
  app = await buildApi(f.db, f.c);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { origin: f.c.APP_ORIGIN },
    payload: { user_id: '1' },
  });
  expect(login.statusCode).toBe(200);
  const auth = login.json();
  headers = {
    origin: f.c.APP_ORIGIN,
    authorization: `Bearer ${auth.token}`,
    'x-csrf-token': auth.csrf,
    'idempotency-key': randomUUID(),
  };
});
afterEach(async () => {
  await app.close();
  await f.db.close();
});
it('rejects unknown staff, forged launch data and cross-origin mutations', async () => {
  expect((await app.inject({ url: '/v1/tickets' })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/dev',
        headers: { origin: f.c.APP_ORIGIN },
        payload: { user_id: '999' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/max',
        headers: { origin: f.c.APP_ORIGIN },
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
  const ticket = await f.create();
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
        headers: { ...headers, 'if-match': String(claim.json().version) },
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
  expect(
    (await app.inject({ method: 'DELETE', url: `/v1/tickets/${ticket.id}`, headers })).statusCode,
  ).toBe(404);
});
it('blocked staff lose existing sessions and download authorization', async () => {
  await f.db.query('UPDATE employees SET blocked=true,version=version+1 WHERE id=$1', [f.staff.id]);
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
  expect((await app.inject({ method: 'POST', url: '/webhooks/max', payload })).statusCode).toBe(
    401,
  );
  const request = {
    method: 'POST' as const,
    url: '/webhooks/max',
    headers: { 'x-max-bot-api-secret': f.c.MAX_WEBHOOK_SECRET },
    payload,
  };
  expect((await app.inject(request)).statusCode).toBe(200);
  expect((await app.inject(request)).statusCode).toBe(200);
  expect((await one(f.db, 'SELECT count(*)::int AS n FROM inbox'))!.n).toBe(1);
  expect((await one(f.db, 'SELECT count(*)::int AS n FROM tickets'))!.n).toBe(0);
});
it('paginates deterministic queue, searches and denies admin access to support', async () => {
  await f.create('Ошибка подключения', '100');
  await f.create('Не печатается документ', '101');
  await f.create('Ошибка входа', '102');
  const first = await app.inject({ url: '/v1/tickets?limit=2', headers });
  expect(first.statusCode).toBe(200);
  expect(first.json().items).toHaveLength(2);
  expect(first.json().counts.open).toBe(3);
  const second = await app.inject({
    url: `/v1/tickets?limit=2&cursor=${first.json().next_cursor}`,
    headers,
  });
  expect(second.json().items).toHaveLength(1);
  const search = await app.inject({ url: '/v1/tickets?q=000001', headers });
  expect(search.json().items[0].number).toBe('000001');
  expect((await app.inject({ url: '/v1/admin/employees', headers })).statusCode).toBe(403);
});
