import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { MaxClient } from '../src/integrations/max/index.js';
import { DeliveryWorker } from '../src/modules/delivery/index.js';
import { one } from '../src/shared/db.js';
import type { Employee } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.db.close();
});
describe('consent-first routing', () => {
  it('buffers encrypted content, creates no staff/AI data, then promotes in order', async () => {
    const client = await context.input('Мой секрет до согласия');
    await context.input('Второе сообщение');
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM tickets'))!.n).toBe(0);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM jobs'))!.n).toBe(0);
    const buffer = await one(context.db, 'SELECT payload FROM preconsent_buffers LIMIT 1');
    expect(buffer!.payload).not.toContain('секрет');
    await context.accept(client);
    const ticket = await context.ticket();
    expect(ticket.ticket_number).toBe(1);
    expect(ticket.description).toBe('Мой секрет до согласия');
    expect(
      (
        await context.db.query("SELECT text FROM messages WHERE author_type='client' ORDER BY seq")
      ).rows.map((row) => row.text),
    ).toEqual(['Мой секрет до согласия', 'Второе сообщение']);
    expect(
      (await one(context.db, "SELECT count(*)::int AS n FROM jobs WHERE kind='triage'"))!.n,
    ).toBe(1);
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
    await context.domain.ingest(input);
    await context.domain.ingest(input);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM inbox'))!.n).toBe(1);
    const client = await one(context.db, 'SELECT * FROM clients');
    expect(String(client?.next_ingress)).toBe('1');
  });
  it('stale policy buttons do not grant new policy; decline removes buffers', async () => {
    const client = await context.input('test');
    await context.db.query("UPDATE callback_actions SET policy_version='old' WHERE client_id=$1", [
      client.id,
    ]);
    await context.accept(client);
    expect(await context.findTicket()).toBeUndefined();
    const action = await one(
      context.db,
      "SELECT nonce FROM callback_actions WHERE client_id=$1 AND action='decline' AND policy_version=$2 LIMIT 1",
      [client.id, context.c.POLICY_VERSION],
    );
    await context.domain.ingest({
      kind: 'callback',
      userId: '100',
      chatId: '100',
      sourceKey: 'decline',
      callbackId: 'decline',
      callbackPayload: String(action!.nonce),
    });
    await context.domain.processClient(client.id);
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM preconsent_buffers'))!.n).toBe(0);
    expect(await context.findTicket()).toBeUndefined();
  });
  it('withdrawal closes slot and invalidates learning without a rating', async () => {
    await context.create();
    await context.command('assign');
    await context.command('close');
    await context.input('/withdraw');
    const ticket = await context.ticket();
    expect(ticket.status).toBe('closed');
    expect((await one(context.db, 'SELECT invalidated FROM closures'))!.invalidated).toBe(true);
    expect((await one(context.db, "SELECT state FROM jobs WHERE kind='learning'"))!.state).toBe(
      'canceled',
    );
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM deletion_tombstones'))!.n).toBe(
      1,
    );
  });
});
describe('staff transitions and rating cycles', () => {
  it('replays commands and rejects same key with different payload', async () => {
    const ticket = await context.create();
    const key = randomUUID();
    const first = await context.domain.command(
      context.staff,
      ticket.id,
      'assign',
      {},
      ticket.version,
      key,
    );
    const second = await context.domain.command(
      context.staff,
      ticket.id,
      'assign',
      {},
      ticket.version,
      key,
    );
    expect(second.id).toBe(first.id);
    await expect(
      context.domain.command(
        context.staff,
        ticket.id,
        'assign',
        { other: true },
        ticket.version,
        key,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      context.domain.command(context.admin, ticket.id, 'assign', {}, ticket.version, randomUUID()),
    ).rejects.toMatchObject({ code: 'ticket_version_conflict' });
  });
  it('only assigned staff can reply; queued/unknown replies block closure', async () => {
    await context.create();
    await context.command('assign');
    const other = (await one<Employee>(
      context.db,
      "INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'3','Другой','support') RETURNING *",
      [context.c.ORG_ID],
    ))!;
    await expect(context.command('messages', { text: 'hello' }, other)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await context.command('messages', { text: 'Попробуйте перезапуск' });
    await expect(context.command('close')).rejects.toMatchObject({ code: 'delivery_pending' });
    await context.db.query("UPDATE deliveries SET state='unknown' WHERE kind='staff'");
    await expect(context.command('close')).rejects.toMatchObject({ code: 'delivery_pending' });
    const worker = new DeliveryWorker(context.db, context.c, new MaxClient(context.c));
    const message = await one(context.db, "SELECT id FROM messages WHERE author_type='staff'");
    await expect(worker.resolve(context.staff, String(message!.id), 'retry')).rejects.toMatchObject(
      {
        code: 'operator_evidence_required',
      },
    );
    await worker.resolve(
      context.admin,
      String(message!.id),
      'cancel',
      'Проверена доставка, разрешено закрыть без повтора',
    );
    await context.command('close');
    expect((await context.ticket()).status).toBe('awaiting_rating');
  });
  it('persists closure, rating, reopen history and one learning obligation per cycle', async () => {
    await context.create();
    await context.command('assign');
    await context.command('close');
    await context.input('оценка 10, спасибо');
    expect((await context.ticket()).status).toBe('closed');
    expect((await one(context.db, 'SELECT rating FROM closures'))!.rating).toBe(10);
    await context.command('reopen', { reason: 'Проблема вернулась' });
    await context.command('close');
    expect((await one(context.db, 'SELECT count(*)::int AS n FROM closures'))!.n).toBe(2);
    expect(
      (await one(context.db, "SELECT count(*)::int AS n FROM jobs WHERE kind='learning'"))!.n,
    ).toBe(2);
    expect((await one(context.db, 'SELECT rating FROM closures WHERE cycle_no=1'))!.rating).toBe(
      10,
    );
  });
  it('commands do not consume rating attempts; third invalid answer closes without rating', async () => {
    await context.create();
    await context.command('assign');
    await context.command('close');
    await context.input('/tickets');
    await context.input('7/10');
    await context.input('1.0');
    expect((await context.ticket()).status).toBe('awaiting_rating');
    await context.input('нет');
    expect((await context.ticket()).status).toBe('closed');
    expect((await one(context.db, 'SELECT rating,invalid_attempts FROM closures'))!).toMatchObject({
      rating: null,
      invalid_attempts: 3,
    });
    await context.input('7');
    expect((await context.ticket()).ticket_number).toBe(2);
  });
  it('a different slot prevents reopening an older ticket', async () => {
    const old = await context.create();
    await context.command('assign');
    await context.command('close');
    await context.input('9');
    await context.input('Новая проблема');
    const version = Number(
      (await one(context.db, 'SELECT version FROM tickets WHERE id=$1', [old.id]))!.version,
    );
    await expect(
      context.domain.command(
        context.staff,
        old.id,
        'reopen',
        { reason: 'test' },
        version,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'conversation_slot_conflict' });
  });
  it('expiry suppresses obsolete reminder and respects already-received rating', async () => {
    await context.create();
    await context.command('assign');
    await context.command('close');
    await context.db.query(
      "UPDATE closures SET expires_at=now()-interval '1 minute',reminder_at=now()-interval '2 days'",
    );
    await context.domain.timers();
    expect((await context.ticket()).status).toBe('closed');
    expect(
      (await one(
        context.db,
        "SELECT count(*)::int AS n FROM deliveries WHERE kind='rating_reminder'",
      ))!.n,
    ).toBe(0);
  });
  it('close fails while earlier ingress awaits routing', async () => {
    await context.create();
    await context.command('assign');
    await context.domain.ingest({
      kind: 'message',
      userId: '100',
      chatId: '100',
      messageId: 'pending',
      sourceKey: 'pending',
      text: 'Ещё вопрос',
    });
    await expect(context.command('close')).rejects.toMatchObject({ code: 'input_pending' });
  });
});
