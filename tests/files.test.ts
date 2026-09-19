import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/api.js';
import { DeliveryWorker } from '../src/delivery.js';
import { MaxClient } from '../src/integrations/max/index.js';
import { Files } from '../src/modules/files/index.js';
import { one } from '../src/shared/db.js';
import { JobRunner } from '../src/workers.js';

import { fixture, testConfig } from './helpers.js';

// End-to-end attachment pipeline through public entry points only: HTTP upload, the scan job,
// and sending a staff reply with the attachment through the delivery worker.

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let storagePath: string;
let session: { token: string; csrf: string };

beforeEach(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'files-test-'));
  context = await fixture(undefined, { ...testConfig(), STORAGE_PATH: storagePath });
  app = await buildApi(context.db, context.c);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { origin: context.c.APP_ORIGIN },
    payload: { user_id: '1' },
  });
  session = login.json();
});

afterEach(async () => {
  await app.close();
  await context.db.close();
  await rm(storagePath, { recursive: true, force: true });
});

function headers(extra: Record<string, string> = {}) {
  return {
    origin: context.c.APP_ORIGIN,
    authorization: `Bearer ${session.token}`,
    'x-csrf-token': session.csrf,
    'idempotency-key': randomUUID(),
    ...extra,
  };
}

async function upload(ticketId: string, file: { name: string; kind: string; content: string }) {
  const prepared = await app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: headers(),
    payload: { ticket_id: ticketId, filename: file.name, kind: file.kind },
  });
  expect(prepared.statusCode).toBe(200);
  const { id } = prepared.json<{ id: string }>();
  const boundary = `----test${randomUUID()}`;
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n${file.content}\r\n--${boundary}--\r\n`;
  const received = await app.inject({
    method: 'PUT',
    url: `/v1/uploads/${id}/content`,
    headers: headers({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
    payload: body,
  });
  expect(received.json()).toMatchObject({ id, status: 'quarantined' });
  return id;
}

async function runScanJob(attachmentId: string) {
  const job = await one(context.db, "SELECT id FROM jobs WHERE kind='scan' AND ref_id=$1", [
    attachmentId,
  ]);
  await new JobRunner(context.db, context.c).run(String(job?.id));
}

async function staffDeliveryState() {
  const delivery = await one(context.db, "SELECT state FROM deliveries WHERE kind='staff'");
  return delivery?.state;
}

async function status(attachmentId: string) {
  const complete = await app.inject({
    method: 'POST',
    url: `/v1/uploads/${attachmentId}/complete`,
    headers: headers(),
    payload: {},
  });
  return complete.json<{ status: string }>().status;
}

it('scans an upload clean and sends it with a staff reply', async () => {
  const ticket = await context.create();
  await context.command('assign');
  const id = await upload(ticket.id, { name: 'note.txt', kind: 'file', content: 'hello world' });
  await runScanJob(id);
  expect(await status(id)).toBe('clean');
  await context.command('messages', { text: 'См. файл', attachment_ids: [id] });
  const worker = new DeliveryWorker(
    context.db,
    context.c,
    new MaxClient(context.c),
    new Files(context.db, context.c),
  );
  // Drain the client's queue in order (bot messages, then the reply with the file). The worker
  // keeps sends to one client at least 550 ms apart, so wait between attempts.
  for (let attempt = 0; attempt < 10 && (await staffDeliveryState()) !== 'delivered'; attempt++) {
    await worker.deliver(ticket.client_id);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  expect(await staffDeliveryState()).toBe('delivered');
});

it('rejects content that does not match the declared kind, and infected files', async () => {
  const ticket = await context.create();
  await context.command('assign');
  const fakeImage = await upload(ticket.id, { name: 'photo.png', kind: 'image', content: 'text' });
  await runScanJob(fakeImage);
  expect(await status(fakeImage)).toBe('rejected');
  // The mock scanner flags this marker. Deliberately not the full EICAR test string: real
  // antivirus (e.g. Windows Defender) would quarantine the temp file mid-upload.
  const marker = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
  const infected = await upload(ticket.id, { name: 'virus.txt', kind: 'file', content: marker });
  await runScanJob(infected);
  expect(await status(infected)).toBe('infected');
});
