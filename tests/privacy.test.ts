import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { Files } from '../src/modules/files/index.js';
import { applyRetention } from '../src/modules/privacy/index.js';
import { createCtx } from '../src/shared/context.js';
import { one, requireOne } from '../src/shared/db.js';
import type { Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let storagePath: string;
let admin: StaffHeaders;

beforeEach(async () => {
    storagePath = await mkdtemp(join(tmpdir(), 'privacy-test-'));
    context = await fixture(undefined, { ...testConfig(), STORAGE_PATH: storagePath });
    app = await buildApi(context.db, context.c);
    admin = (await staffLogin(app, context.c.APP_ORIGIN, '2')).headers;
});

afterEach(async () => {
    await app.close();
    await context.db.close();
    await rm(storagePath, { recursive: true, force: true });
});

async function solvedTicket() {
    await context.create('Нет интернета, паспорт 4510 123456');
    await context.command('assign');
    await context.command('messages', { text: 'Перезагрузите роутер' });
    await context.db.query("UPDATE deliveries SET state='delivered'");
    await context.input('Спасибо, заработало');
    await context.command('close', { note: 'Помогла перезагрузка' });

    return context.ticket();
}

async function storedAttachment(ticketId: string) {
    const objectKey = `${randomUUID()}/${randomUUID()}`;

    await mkdir(join(storagePath, objectKey.split('/')[0]), { recursive: true });
    await writeFile(join(storagePath, objectKey), 'secret scan');

    const attachment = await requireOne(
        context.db,
        `INSERT INTO attachments(org_id,ticket_id,message_id,filename,kind,object_key,status)
     SELECT $1,$2,id,'passport.jpg','image',$3,'clean' FROM messages WHERE ticket_id=$2 ORDER BY seq LIMIT 1
     RETURNING id`,
        [context.c.ORG_ID, ticketId, objectKey],
    );

    return { id: String(attachment.id), objectKey };
}

const setRetention = (retention: Row) =>
    context.db.query("UPDATE organizations SET settings=jsonb_set(settings,'{retention}',$2::jsonb) WHERE id=$1", [
        context.c.ORG_ID,
        JSON.stringify(retention),
    ]);

it('purges closed tickets after the retention period, files included', async () => {
    const ticket = await solvedTicket();
    const file = await storedAttachment(ticket.id);
    const ctx = createCtx(context.c);

    await context.db.query("UPDATE tickets SET status='closed',closed_at=now()-interval '40 days' WHERE id=$1", [
        ticket.id,
    ]);

    expect(await context.db.tx((tx) => applyRetention(tx, ctx))).toBe(0);
    await setRetention({ closed_ticket_days: 30, audit_days: null });
    expect(await context.db.tx((tx) => applyRetention(tx, ctx))).toBe(1);

    const purged = await context.ticket();

    expect(purged.purged_at).not.toBeNull();
    expect(purged.description).toBe('Данные удалены по истечении срока хранения');

    const texts = await context.db.query('SELECT text,deleted FROM messages WHERE ticket_id=$1', [ticket.id]);

    expect(texts.rows.every((row) => row.text === '' && row.deleted)).toBe(true);

    expect(await one(context.db, 'SELECT note,snapshot FROM closures WHERE ticket_id=$1', [ticket.id])).toEqual({
        note: '',
        snapshot: null,
    });

    const job = await requireOne(context.db, "SELECT ref_id FROM jobs WHERE kind='attachment_purge'");

    expect(job.ref_id).toBe(file.id);
    await new Files(context.db, context.c).purge(file.id);
    await expect(stat(join(storagePath, file.objectKey))).rejects.toThrow();

    expect(await one(context.db, 'SELECT filename,object_key FROM attachments WHERE id=$1', [file.id])).toEqual({
        filename: 'файл удалён',
        object_key: null,
    });

    expect(await context.db.tx((tx) => applyRetention(tx, ctx))).toBe(0);
});

it('stores retention settings and refuses to reopen a purged ticket', async () => {
    const current = (await app.inject({ url: '/v1/admin/settings', headers: admin() })).json<Row>();

    expect(current.retention).toEqual({ closed_ticket_days: null, audit_days: null });

    const saved = await app.inject({
        method: 'PUT',
        url: '/v1/admin/settings',
        headers: admin({ 'if-match': String(current.version) }),
        payload: {
            name: 'Поддержка',
            timezone: 'Europe/Moscow',
            retention: { closed_ticket_days: 10, audit_days: null },
        },
    });

    expect(saved.statusCode).toBe(422);

    const valid = await app.inject({
        method: 'PUT',
        url: '/v1/admin/settings',
        headers: admin({ 'if-match': String(current.version) }),
        payload: {
            name: 'Поддержка',
            timezone: 'Europe/Moscow',
            retention: { closed_ticket_days: 365, audit_days: 730 },
        },
    });

    expect(valid.json<Row>().retention).toEqual({ closed_ticket_days: 365, audit_days: 730 });

    const ticket = await solvedTicket();

    await context.db.query("UPDATE tickets SET status='closed',purged_at=now() WHERE id=$1", [ticket.id]);

    await expect(context.command('reopen', { reason: 'Снова нет связи' })).rejects.toMatchObject({
        code: 'ticket_purged',
    });
});

it('exports client data to admins only, also through a download grant', async () => {
    const ticket = await solvedTicket();
    const url = `/v1/admin/clients/${ticket.client_id}/export`;
    const support = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers;

    expect((await app.inject({ url, headers: support() })).statusCode).toBe(403);

    const response = await app.inject({ url, headers: admin() });
    const data = response.json<{ client: Row; tickets: { number: string; messages: Row[] }[] }>();

    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="client-data-/);
    expect(data.client.max_user_id).toBe('100');
    expect(data.tickets[0].messages.map((message) => message.text)).toContain('Спасибо, заработало');

    const grant = await app.inject({ method: 'POST', url: `${url}-grant`, headers: admin(), payload: {} });
    const { url: grantUrl } = grant.json<{ url: string }>();
    const viaGrant = await app.inject({ url: new URL(grantUrl).pathname });

    expect(viaGrant.statusCode).toBe(200);
    expect(viaGrant.json<Row>().client).toEqual(data.client);
    expect((await app.inject({ url: '/download/export/' + 'x'.repeat(40) })).statusCode).toBe(404);

    const audits = await context.db.query("SELECT actor_id FROM audit WHERE action='client.exported'");

    expect(audits.rows).toHaveLength(2);
});

it('erases a client on request: closes, purges and forgets them', async () => {
    const solved = await solvedTicket();

    await context.db.query("UPDATE tickets SET status='closed' WHERE id=$1", [solved.id]);
    const open = await context.create('Снова пропал интернет');
    const url = `/v1/admin/clients/${open.client_id}/erase`;

    expect((await app.inject({ method: 'POST', url, headers: admin(), payload: {} })).statusCode).toBe(422);

    const erased = await app.inject({ method: 'POST', url, headers: admin(), payload: { confirm: true } });

    expect(erased.json()).toEqual({ client_id: open.client_id, tickets: 2, already_erased: false });

    const tickets = await context.db.query('SELECT status,purged_at,purge_reason FROM tickets WHERE client_id=$1', [
        open.client_id,
    ]);

    expect(tickets.rows.every((row) => row.status === 'closed' && row.purge_reason === 'erasure')).toBe(true);

    const client = await requireOne(context.db, 'SELECT max_user_id,chat_id,erased_at FROM clients WHERE id=$1', [
        open.client_id,
    ]);

    expect(client.max_user_id).toBe(`erased:${open.client_id}`);
    expect(client.chat_id).toBe('');

    const again = await app.inject({ method: 'POST', url, headers: admin(), payload: { confirm: true } });

    expect(again.json<Row>().already_erased).toBe(true);
    await context.input('Здравствуйте, это снова я');

    const clients = await context.db.query('SELECT max_user_id FROM clients WHERE org_id=$1 ORDER BY created_at', [
        context.c.ORG_ID,
    ]);

    expect(clients.rows.map((row) => row.max_user_id)).toEqual([`erased:${open.client_id}`, '100']);
});
