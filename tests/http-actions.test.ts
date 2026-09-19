import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { one } from '../src/shared/db.js';
import { JobRunner } from '../src/workers.js';

import { fixture, testConfig } from './helpers.js';
import { staffLogin, uploadNote } from './support/http-client.js';

// HTTP routes, part 2: delivery resolution, uploads and downloads, the admin console and dev inbound.

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

it('accepts a staff reply and lets staff cancel it before delivery', async () => {
  const ticket = await context.create();
  await context.command('assign');
  const { headers } = await login('1');
  const current = await context.ticket();
  const reply = await app.inject({
    method: 'POST',
    url: `/v1/tickets/${ticket.id}/messages`,
    headers: headers({ 'if-match': `"${current.version}"` }),
    payload: { text: 'Проверяем' },
  });
  expect(reply.statusCode).toBe(202);
  const message = await one<{ id: string }>(
    context.db,
    "SELECT id FROM messages WHERE ticket_id=$1 AND author_type='staff'",
    [ticket.id],
  );
  const cancel = await app.inject({
    method: 'POST',
    url: `/v1/messages/${message?.id}/cancel`,
    headers: headers(),
    payload: {},
  });
  expect(cancel.json()).toEqual({ state: 'canceled' });
  const retry = await app.inject({
    method: 'POST',
    url: `/v1/messages/${message?.id}/retry`,
    headers: headers(),
    payload: {},
  });
  expect(retry.json()).toMatchObject({ code: 'retry_not_allowed' });
});

it('cancels an upload and serves a sent attachment directly and through a grant', async () => {
  const ticket = await context.create();
  await context.command('assign');
  const { headers } = await login('1');
  const abandoned = await uploadNote(app, headers, ticket.id);
  const canceled = await app.inject({
    method: 'DELETE',
    url: `/v1/uploads/${abandoned}`,
    headers: headers(),
  });
  expect(canceled.json()).toEqual({ ok: true });
  const id = await uploadNote(app, headers, ticket.id);
  const job = await one(context.db, "SELECT id FROM jobs WHERE kind='scan' AND ref_id=$1", [id]);
  await new JobRunner(context.db, context.c).run(String(job?.id));
  await context.command('messages', { text: 'Файл', attachment_ids: [id] });
  const direct = await app.inject({ url: `/v1/attachments/${id}/download`, headers: headers() });
  expect(direct.body).toBe('hello world');
  expect(direct.headers['content-disposition']).toBe("attachment; filename*=UTF-8''note.txt");
  const granted = await app.inject({
    method: 'POST',
    url: `/v1/attachments/${id}/download-grant`,
    headers: headers(),
    payload: {},
  });
  const { url, filename } = granted.json<{ url: string; filename: string }>();
  expect(filename).toBe('note.txt');
  const download = await app.inject({ url: new URL(url).pathname });
  expect(download.body).toBe('hello world');
  expect(download.headers['cache-control']).toBe('no-store');
});

it('serves the admin console to admins and operations to non-support staff', async () => {
  const support = await login('1');
  const forbidden = await app.inject({ url: '/v1/admin/diagnostics', headers: support.headers() });
  expect(forbidden.statusCode).toBe(403);
  const { headers } = await login('2');
  for (const path of ['employees', 'roles', 'audit', 'diagnostics']) {
    const response = await app.inject({ url: `/v1/admin/${path}`, headers: headers() });
    expect(response.statusCode).toBe(200);
  }
  const settings = await app.inject({ url: '/v1/admin/settings', headers: headers() });
  const { version } = settings.json<{ version: number }>();
  const saved = await app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: headers({ 'if-match': String(version) }),
    payload: { name: 'Поддержка', timezone: 'Europe/Moscow' },
  });
  expect(saved.json()).toMatchObject({ name: 'Поддержка', version: version + 1 });
  const templates = await app.inject({ url: '/v1/admin/templates', headers: headers() });
  const [template] = templates.json<{ items: { code: string; body: string; version: number }[] }>()
    .items;
  const updated = await app.inject({
    method: 'PUT',
    url: `/v1/admin/templates/${template.code}`,
    headers: headers({ 'if-match': String(template.version) }),
    payload: { body: template.body },
  });
  expect(updated.statusCode).toBe(200);
  const retry = await app.inject({
    method: 'POST',
    url: `/v1/admin/jobs/${randomUUID()}/retry`,
    headers: headers(),
    payload: {},
  });
  expect(retry.json()).toMatchObject({ code: 'retry_not_allowed' });
});

it('feeds dev inbound messages to the inbox for operations staff only', async () => {
  const payload = { user_id: '300', text: 'Привет', message_id: 'dev-1' };
  const support = await login('1');
  const denied = await app.inject({
    method: 'POST',
    url: '/v1/dev/inbound',
    headers: support.headers(),
    payload,
  });
  expect(denied.statusCode).toBe(403);
  const { headers } = await login('2');
  const accepted = await app.inject({
    method: 'POST',
    url: '/v1/dev/inbound',
    headers: headers(),
    payload,
  });
  expect(accepted.json()).toEqual({ ok: true });
  const inbound = await one(context.db, 'SELECT count(*)::int AS n FROM inbox WHERE org_id=$1', [
    context.c.ORG_ID,
  ]);
  expect(inbound?.n).toBe(1);
});
