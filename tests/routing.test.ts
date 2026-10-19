import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { RoutingTimers } from '../src/modules/routing/index.js';
import { expirePresence } from '../src/modules/staff/index.js';
import { requireOne } from '../src/shared/db.js';
import type { Employee, Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin: StaffHeaders;
let support: StaffHeaders;
let colleague: Employee;

beforeEach(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);

    colleague = await requireOne<Employee>(
        context.db,
        `INSERT INTO employees(org_id,max_user_id,name,role,activated_at) VALUES($1,'3','Борис','support',now()) RETURNING *`,
        [context.c.ORG_ID],
    );

    admin = (await staffLogin(app, context.c.APP_ORIGIN, '2')).headers;
    support = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers;
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

const timers = async () => new RoutingTimers(context.db, context.c).run();

async function createTeam(body: Row): Promise<Row & { id: string; version: number }> {
    const response = await app.inject({ method: 'POST', url: '/v1/admin/teams', headers: admin(), payload: body });

    expect(response.statusCode).toBe(200);

    return response.json();
}

async function setRules(rules: Row[]) {
    const current = await app.inject({ url: '/v1/admin/routing-rules', headers: admin() });
    const { version } = current.json<{ version: number }>();

    return app.inject({
        method: 'PUT',
        url: '/v1/admin/routing-rules',
        headers: admin({ 'if-match': String(version) }),
        payload: { rules },
    });
}

async function goOnline(headers: StaffHeaders) {
    const response = await app.inject({
        method: 'PUT',
        url: '/v1/presence',
        headers: headers(),
        payload: { presence: 'online' },
    });

    expect(response.statusCode).toBe(200);
}

async function triaged(text = 'Не работает интернет', userId = '100') {
    const ticket = await context.create(text, userId);

    await context.db.query("UPDATE tickets SET ai_status='failed' WHERE id=$1", [ticket.id]);

    return ticket;
}

async function ticketRow(id: string) {
    return requireOne(context.db, 'SELECT * FROM tickets WHERE id=$1', [id]);
}

it('routes tickets by rules and offers them to online members by least load', async () => {
    const team = await createTeam({
        name: 'Первая линия',
        auto_assign: true,
        offer_timeout_seconds: 60,
        allow_self_take: false,
        members: [{ employee_id: context.staff.id }, { employee_id: colleague.id }],
    });

    expect((await setRules([{ team_id: team.id, match: { tag: [], urgency: [], complexity: [] } }])).statusCode).toBe(
        200,
    );

    const ticket = await triaged();

    await timers();
    expect(await ticketRow(ticket.id)).toMatchObject({ team_id: team.id, offered_to: null });

    await goOnline(support);
    await timers();
    expect((await ticketRow(ticket.id)).offered_to).toBe(context.staff.id);

    const offered = await requireOne(
        context.db,
        "SELECT count(*)::int AS n FROM notifications WHERE type='ticket.offered' AND employee_id=$1",
        [context.staff.id],
    );

    expect(offered.n).toBe(1);

    const borisHeaders = (await staffLogin(app, context.c.APP_ORIGIN, '3')).headers;

    await goOnline(borisHeaders);
    await context.db.query("UPDATE tickets SET offer_due_at=now()-interval '1 second' WHERE id=$1", [ticket.id]);
    await timers();

    const reoffered = await ticketRow(ticket.id);

    expect(reoffered.offered_to).toBe(colleague.id);
    expect(reoffered.offer_skipped).toEqual([context.staff.id]);

    await expect(context.command('assign', {}, context.staff)).rejects.toMatchObject({ code: 'self_take_disabled' });
    await context.command('assign', {}, colleague);

    expect(await ticketRow(ticket.id)).toMatchObject({
        status: 'in_progress',
        assignee_id: colleague.id,
        offered_to: null,
    });
});

it('releases a ticket back to the queue and moves it between teams', async () => {
    const team = await createTeam({ name: 'Биллинг' });
    const ticket = await triaged();

    await context.command('assign', {}, context.staff);
    await context.command('release', {}, context.staff);
    expect(await ticketRow(ticket.id)).toMatchObject({ status: 'open', assignee_id: null });

    await context.command('assign', {}, context.staff);
    await context.command('team', { team_id: team.id, release: true }, context.admin);
    expect(await ticketRow(ticket.id)).toMatchObject({ status: 'open', team_id: team.id, assignee_id: null });

    const list = await app.inject({ url: `/v1/tickets?team=${team.id}`, headers: support() });

    expect(list.json<{ items: Row[] }>().items.map((item) => item.team_name)).toEqual(['Биллинг']);
});

it('keeps notes internal and notifies mentioned colleagues in the app and in MAX', async () => {
    const ticket = await triaged();

    await context.command('assign', {}, context.staff);
    await context.command('notes', { text: '@Борис глянь договор', mention_ids: [colleague.id] }, context.staff);

    const note = await requireOne(context.db, "SELECT * FROM messages WHERE ticket_id=$1 AND author_type='staff'", [
        ticket.id,
    ]);

    expect(note).toMatchObject({ visibility: 'internal', delivery_state: 'internal', mentions: [colleague.id] });

    const deliveries = await requireOne(
        context.db,
        "SELECT count(*)::int AS n FROM deliveries WHERE ticket_id=$1 AND kind='staff'",
        [ticket.id],
    );

    expect(deliveries.n).toBe(0);

    const mention = await requireOne(
        context.db,
        "SELECT id FROM notifications WHERE type='note.mention' AND employee_id=$1",
        [colleague.id],
    );

    const alert = await requireOne(
        context.db,
        "SELECT count(*)::int AS n FROM jobs WHERE kind='notification_alert' AND ref_id=$1",
        [mention.id],
    );

    expect(alert.n).toBe(1);
});

it('asks before replying right after a colleague and records confirmed collisions', async () => {
    const ticket = await triaged();

    await context.command('assign', {}, context.staff);
    await context.command('messages', { text: 'Отвечаю как руководитель' }, context.admin);

    await expect(context.command('messages', { text: 'И я отвечаю' }, context.staff)).rejects.toMatchObject({
        code: 'reply_collision',
    });

    await context.command('messages', { text: 'И я отвечаю', confirm_collision: true }, context.staff);

    const events = await requireOne(
        context.db,
        "SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id=$1 AND kind='reply_collision'",
        [ticket.id],
    );

    expect(events.n).toBe(1);
});

it('applies macro actions, counts uses and keeps shared macros to admins', async () => {
    const shared = await app.inject({
        method: 'POST',
        url: '/v1/macros',
        headers: support(),
        payload: { title: 'Общий', body: 'Текст', shared: true },
    });

    expect(shared.statusCode).toBe(403);

    const created = await app.inject({
        method: 'POST',
        url: '/v1/macros',
        headers: support(),
        payload: { title: 'Перезагрузка', body: 'Перезагрузите роутер', actions: { urgency: 'low', close: true } },
    });

    expect(created.statusCode).toBe(200);
    const macro = created.json<{ id: string }>();
    const ticket = await triaged();

    await context.command('assign', {}, context.staff);
    await context.command('messages', { text: 'Перезагрузите роутер', macro_id: macro.id }, context.staff);

    expect(await ticketRow(ticket.id)).toMatchObject({ urgency: 'low', urgency_revision: 1 });

    const stored = await requireOne(context.db, 'SELECT uses FROM macros WHERE id=$1', [macro.id]);

    const job = await requireOne(context.db, "SELECT payload FROM jobs WHERE kind='deferred_close' AND ref_id=$1", [
        ticket.id,
    ]);

    const message = await requireOne(
        context.db,
        "SELECT draft_origin,macro_id FROM messages WHERE ticket_id=$1 AND author_type='staff'",
        [ticket.id],
    );

    expect(stored.uses).toBe(1);
    expect(job.payload).toMatchObject({ actor_id: context.staff.id });
    expect(message).toEqual({ draft_origin: 'macro', macro_id: macro.id });

    const list = await app.inject({
        url: '/v1/macros',
        headers: (await staffLogin(app, context.c.APP_ORIGIN, '3')).headers(),
    });

    expect(list.json<{ items: Row[] }>().items).toEqual([]);
});

it('runs bulk actions per ticket and reports each result', async () => {
    const first = await triaged('Нет связи', '100');
    const second = await triaged('Медленно', '101');
    const supervisor = await staffLogin(app, context.c.APP_ORIGIN, '2');

    const response = await app.inject({
        method: 'POST',
        url: '/v1/tickets/bulk',
        headers: supervisor.headers(),
        payload: { action: 'assign', ids: [first.id, second.id], employee_id: colleague.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ results: Row[] }>().results.map((result) => result.ok)).toEqual([true, true]);
    expect((await ticketRow(second.id)).assignee_id).toBe(colleague.id);

    const forbidden = await app.inject({
        method: 'POST',
        url: '/v1/tickets/bulk',
        headers: support(),
        payload: { action: 'classify', ids: [first.id], urgency: 'low' },
    });

    expect(forbidden.statusCode).toBe(403);
});

it('returns a blocked employee work to the queue and drops stale presence', async () => {
    const ticket = await triaged();

    await context.command('assign', {}, context.staff);
    await goOnline(support);

    const block = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/employees/${context.staff.id}`,
        headers: admin({ 'if-match': String(context.staff.version) }),
        payload: { blocked: true },
    });

    expect(block.statusCode).toBe(200);
    expect(await ticketRow(ticket.id)).toMatchObject({ status: 'open', assignee_id: null });

    await context.db.query(
        "UPDATE employees SET presence='online',presence_seen_at=now()-interval '5 minutes' WHERE id=$1",
        [colleague.id],
    );

    await expirePresence(context.db, context.c.ORG_ID);

    const presence = await requireOne(context.db, 'SELECT presence FROM employees WHERE id=$1', [colleague.id]);

    const log = await requireOne(
        context.db,
        "SELECT count(*)::int AS n FROM presence_log WHERE employee_id=$1 AND presence='offline'",
        [colleague.id],
    );

    expect(presence.presence).toBe('offline');
    expect(log.n).toBe(1);
});
