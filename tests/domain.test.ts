import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { one } from '../src/db.js';
import { DeliveryWorker } from '../src/delivery.js';
import { MaxClient, TransportFailure } from '../src/max/client.js';
import { Admin } from '../src/admin.js';
import type { Client, Employee } from '../src/types.js';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.db.close();
});
describe('consent-first routing', () => {
  it('buffers encrypted content, creates no staff/AI data, then promotes in order', async () => {
    const client = await f.input('Мой секрет до согласия');
    await f.input('Второе сообщение');
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM tickets'))!.n).toBe(0);
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM jobs'))!.n).toBe(0);
    const buffer = await one(f.db, 'SELECT payload FROM preconsent_buffers LIMIT 1');
    expect(buffer!.payload).not.toContain('секрет');
    await f.accept(client);
    const ticket = await f.ticket();
    expect(ticket.ticket_number).toBe(1);
    expect(ticket.description).toBe('Мой секрет до согласия');
    expect(
      (
        await f.db.query("SELECT text FROM messages WHERE author_type='client' ORDER BY seq")
      ).rows.map((r) => r.text),
    ).toEqual(['Мой секрет до согласия', 'Второе сообщение']);
    expect((await one(f.db, "SELECT count(*)::int AS n FROM jobs WHERE kind='triage'"))!.n).toBe(1);
  });
  it('deduplicates input before assigning another routing sequence', async () => {
    const input = {
      kind: 'message' as const,
      userId: '100',
      chatId: '100',
      messageId: 'same',
      sourceKey: 'same',
      text: 'test',
    };
    await f.domain.ingest(input);
    await f.domain.ingest(input);
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM inbox'))!.n).toBe(1);
    expect(String((await one<Client>(f.db, 'SELECT * FROM clients'))!.next_ingress)).toBe('1');
  });
  it('stale policy buttons do not grant new policy; decline removes buffers', async () => {
    const client = await f.input('test');
    await f.db.query("UPDATE callback_actions SET policy_version='old' WHERE client_id=$1", [
      client.id,
    ]);
    await f.accept(client);
    expect(await f.ticket()).toBeUndefined();
    const action = await one(
      f.db,
      "SELECT nonce FROM callback_actions WHERE client_id=$1 AND action='decline' AND policy_version=$2 LIMIT 1",
      [client.id, f.c.POLICY_VERSION],
    );
    await f.domain.ingest({
      kind: 'callback',
      userId: '100',
      chatId: '100',
      sourceKey: 'decline',
      callbackId: 'decline',
      callbackPayload: String(action!.nonce),
    });
    await f.domain.processClient(client.id);
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM preconsent_buffers'))!.n).toBe(0);
    expect(await f.ticket()).toBeUndefined();
  });
  it('withdrawal closes slot and invalidates learning without a rating', async () => {
    await f.create();
    await f.command('assign');
    await f.command('close');
    await f.input('/withdraw');
    const ticket = await f.ticket();
    expect(ticket.status).toBe('closed');
    expect((await one(f.db, 'SELECT invalidated FROM closures'))!.invalidated).toBe(true);
    expect((await one(f.db, "SELECT state FROM jobs WHERE kind='learning'"))!.state).toBe(
      'canceled',
    );
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM deletion_tombstones'))!.n).toBe(1);
  });
});
describe('staff transitions and rating cycles', () => {
  it('replays commands and rejects same key with different payload', async () => {
    const ticket = await f.create();
    const key = randomUUID();
    const first = await f.domain.command(f.staff, ticket.id, 'assign', {}, ticket.version, key);
    const second = await f.domain.command(f.staff, ticket.id, 'assign', {}, ticket.version, key);
    expect(second.id).toBe(first.id);
    await expect(
      f.domain.command(f.staff, ticket.id, 'assign', { other: true }, ticket.version, key),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      f.domain.command(f.admin, ticket.id, 'assign', {}, ticket.version, randomUUID()),
    ).rejects.toMatchObject({ code: 'ticket_version_conflict' });
  });
  it('only assigned staff can reply; queued/unknown replies block closure', async () => {
    await f.create();
    await f.command('assign');
    const other = (await one<Employee>(
      f.db,
      "INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'3','Другой','support') RETURNING *",
      [f.c.ORG_ID],
    ))!;
    await expect(f.command('messages', { text: 'hello' }, other)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await f.command('messages', { text: 'Попробуйте перезапуск' });
    await expect(f.command('close')).rejects.toMatchObject({ code: 'delivery_pending' });
    await f.db.query("UPDATE deliveries SET state='unknown' WHERE kind='staff'");
    await expect(f.command('close')).rejects.toMatchObject({ code: 'delivery_pending' });
    const worker = new DeliveryWorker(f.db, f.c, new MaxClient(f.c));
    const message = await one(f.db, "SELECT id FROM messages WHERE author_type='staff'");
    await expect(worker.resolve(f.staff, String(message!.id), 'retry')).rejects.toMatchObject({
      code: 'operator_evidence_required',
    });
    await worker.resolve(
      f.admin,
      String(message!.id),
      'cancel',
      'Проверена доставка, разрешено закрыть без повтора',
    );
    await f.command('close');
    expect((await f.ticket()).status).toBe('awaiting_rating');
  });
  it('persists closure, rating, reopen history and one learning obligation per cycle', async () => {
    await f.create();
    await f.command('assign');
    await f.command('close');
    await f.input('оценка 10, спасибо');
    expect((await f.ticket()).status).toBe('closed');
    expect((await one(f.db, 'SELECT rating FROM closures'))!.rating).toBe(10);
    await f.command('reopen', { reason: 'Проблема вернулась' });
    await f.command('close');
    expect((await one(f.db, 'SELECT count(*)::int AS n FROM closures'))!.n).toBe(2);
    expect((await one(f.db, "SELECT count(*)::int AS n FROM jobs WHERE kind='learning'"))!.n).toBe(
      2,
    );
    expect((await one(f.db, 'SELECT rating FROM closures WHERE cycle_no=1'))!.rating).toBe(10);
  });
  it('commands do not consume rating attempts; third invalid answer closes without rating', async () => {
    await f.create();
    await f.command('assign');
    await f.command('close');
    await f.input('/tickets');
    await f.input('7/10');
    await f.input('1.0');
    expect((await f.ticket()).status).toBe('awaiting_rating');
    await f.input('нет');
    expect((await f.ticket()).status).toBe('closed');
    expect((await one(f.db, 'SELECT rating,invalid_attempts FROM closures'))!).toMatchObject({
      rating: null,
      invalid_attempts: 3,
    });
    await f.input('7');
    expect((await f.ticket()).ticket_number).toBe(2);
  });
  it('a different slot prevents reopening an older ticket', async () => {
    const old = await f.create();
    await f.command('assign');
    await f.command('close');
    await f.input('9');
    await f.input('Новая проблема');
    const version = Number(
      (await one(f.db, 'SELECT version FROM tickets WHERE id=$1', [old.id]))!.version,
    );
    await expect(
      f.domain.command(f.staff, old.id, 'reopen', { reason: 'test' }, version, randomUUID()),
    ).rejects.toMatchObject({ code: 'conversation_slot_conflict' });
  });
  it('expiry suppresses obsolete reminder and respects already-received rating', async () => {
    await f.create();
    await f.command('assign');
    await f.command('close');
    await f.db.query(
      "UPDATE closures SET expires_at=now()-interval '1 minute',reminder_at=now()-interval '2 days'",
    );
    await f.domain.timers();
    expect((await f.ticket()).status).toBe('closed');
    expect(
      (await one(f.db, "SELECT count(*)::int AS n FROM deliveries WHERE kind='rating_reminder'"))!
        .n,
    ).toBe(0);
  });
  it('close fails while earlier ingress awaits routing', async () => {
    await f.create();
    await f.command('assign');
    await f.domain.ingest({
      kind: 'message',
      userId: '100',
      chatId: '100',
      messageId: 'pending',
      sourceKey: 'pending',
      text: 'Ещё вопрос',
    });
    await expect(f.command('close')).rejects.toMatchObject({ code: 'input_pending' });
  });
});
describe('delivery and admin safeguards', () => {
  it('unknown sends are not automatically retried or overtaken', async () => {
    await f.create();
    await f.command('assign');
    await f.command('messages', { text: 'Ответ' });
    await f.db.query("UPDATE deliveries SET state='delivered' WHERE kind<>'staff'");
    let calls = 0;
    const transport = {
      send: async () => {
        calls++;
        throw new TransportFailure('unknown', 'lost_response');
      },
      answer: async () => {},
      upload: async () => ({}),
    };
    const worker = new DeliveryWorker(f.db, f.c, transport);
    const client = await one<Client>(f.db, 'SELECT * FROM clients');
    await worker.deliver(client!.id);
    await worker.deliver(client!.id);
    expect(calls).toBe(1);
    expect((await one(f.db, "SELECT state FROM deliveries WHERE kind='staff'"))!.state).toBe(
      'unknown',
    );
  });
  it('protects last administrator and reserved dictionary defaults', async () => {
    const admin = new Admin(f.db, f.c.ORG_ID);
    await expect(
      admin.employee(
        f.admin,
        f.admin.id,
        { max_user_id: '2', name: 'Admin', role: 'support', blocked: false },
        f.admin.version,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'last_admin' });
    await expect(
      admin.dictionary(
        f.admin,
        { dimension: 'tag', code: 'undefined', label: 'Other', rank: 0, active: false },
        1,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'protected_default' });
  });
});
