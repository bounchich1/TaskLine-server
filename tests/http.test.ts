import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/api.js';
import { one } from '../src/shared/db.js';

import { fixture, testConfig } from './helpers.js';
import { staffLogin } from './support/http-client.js';

// HTTP routes, part 1: health, CORS, the staff session lifecycle, lookups and the SSE stream.

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let storagePath: string;

beforeEach(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'http-test-'));
  context = await fixture(undefined, { ...testConfig(), STORAGE_PATH: storagePath });
  app = await buildApi(context.db, context.c);
});

afterEach(async () => {
  await app.close();
  await context.db.close();
  await rm(storagePath, { recursive: true, force: true });
});

const login = async (userId: string) => staffLogin(app, context.c.APP_ORIGIN, userId);

it('serves health checks, the OpenAPI document and CORS preflight', async () => {
  expect((await app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });
  expect((await app.inject({ url: '/health/ready' })).json()).toEqual({ status: 'ready' });
  expect((await app.inject({ url: '/openapi.json' })).json()).toMatchObject({ openapi: '3.1.0' });
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/v1/tickets',
    headers: { origin: context.c.APP_ORIGIN },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(context.c.APP_ORIGIN);
  const foreign = await app.inject({
    method: 'OPTIONS',
    url: '/v1/tickets',
    headers: { origin: 'https://evil.invalid' },
  });
  expect(foreign.json()).toMatchObject({ code: 'origin_denied' });
  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { origin: context.c.APP_ORIGIN, 'content-type': 'application/json' },
    payload: '{',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json()).toMatchObject({ code: 'invalid_json' });
});

it('refreshes, describes and ends a staff session', async () => {
  const { headers, token } = await login('1');
  const refreshed = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    headers: headers(),
    payload: {},
  });
  expect(refreshed.headers['set-cookie']).toContain('support_session=');
  const rotated = refreshed.json<{ token: string; csrf: string }>();
  const stale = await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
  expect(stale.statusCode).toBe(401);
  const current = { authorization: `Bearer ${rotated.token}`, origin: context.c.APP_ORIGIN };
  const me = await app.inject({ url: '/v1/me', headers: current });
  expect(me.json()).toMatchObject({ employee: { name: 'Анна' }, capabilities: {} });
  const logout = await app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { ...current, 'x-csrf-token': rotated.csrf },
    payload: {},
  });
  expect(logout.json()).toEqual({ ok: true });
  expect((await app.inject({ url: '/v1/me', headers: current })).statusCode).toBe(401);
});

it('lists employees, dictionaries, counts and notifications, and marks one read', async () => {
  await context.create();
  const { headers } = await login('1');
  const employees = await app.inject({ url: '/v1/employees', headers: headers() });
  expect(employees.json<{ items: unknown[] }>().items).toHaveLength(2);
  const dictionaries = await app.inject({ url: '/v1/dictionaries', headers: headers() });
  expect(dictionaries.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
  const counts = await app.inject({ url: '/v1/tickets/counts', headers: headers() });
  expect(counts.statusCode).toBe(200);
  const notifications = await app.inject({ url: '/v1/notifications', headers: headers() });
  const [notification] = notifications.json<{ items: { id: string; type: string }[] }>().items;
  expect(notification.type).toBe('ticket.created');
  const read = await app.inject({
    method: 'POST',
    url: `/v1/notifications/${notification.id}/read`,
    headers: headers(),
    payload: {},
  });
  expect(read.json()).toEqual({ ok: true });
  const stored = await one(context.db, 'SELECT read_at FROM notifications WHERE id=$1', [
    notification.id,
  ]);
  expect(stored?.read_at).not.toBeNull();
});

it('streams UI events over SSE', async () => {
  await context.create();
  const { token } = await login('1');
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const abort = new AbortController();
  const response = await fetch(`${address}/v1/events`, {
    headers: { authorization: `Bearer ${token}`, origin: context.c.APP_ORIGIN },
    signal: abort.signal,
  });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('access-control-allow-origin')).toBe(context.c.APP_ORIGIN);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  while (!text.includes('event: change')) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    text += value;
  }
  abort.abort();
  expect(text).toMatch(/^event: ready\ndata: \{\}\n\nid: \d+\nevent: change\ndata: \{/);
});
