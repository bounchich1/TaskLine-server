import { afterEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { NotificationAlerts } from '../src/modules/notifications/index.js';
import { requireOne } from '../src/shared/db.js';
import type { Employee, Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';
import { staffLogin } from './support/http-client.js';

type Context = Awaited<ReturnType<typeof fixture>>;
type Api = Awaited<ReturnType<typeof buildApi>>;

interface ListedNotification {
    id: string;
    type: string;
    read_at: string | null;
    payload: Row;
    preview: string | null;
    actor_name: string | null;
    ticket: { number: string; status: string; description: string; assignee_name: string | null } | null;
}

let context: Context;
let app: Api;

async function start(overrides: NodeJS.ProcessEnv = {}) {
    context = await fixture(undefined, testConfig(overrides));
    app = await buildApi(context.db, context.c);
}

afterEach(async () => {
    await app.close();
    await context.db.close();
});

async function list(userId: string): Promise<ListedNotification[]> {
    const { headers } = await staffLogin(app, context.c.APP_ORIGIN, userId);
    const response = await app.inject({ url: '/v1/notifications', headers: headers() });

    expect(response.statusCode).toBe(200);

    return response.json<{ items: ListedNotification[] }>().items;
}

async function saveSettings(userId: string, body: Row) {
    const { headers } = await staffLogin(app, context.c.APP_ORIGIN, userId);

    return app.inject({ method: 'PUT', url: '/v1/notifications/settings', headers: headers(), payload: body });
}

async function addSupport(name: string, maxUserId: string): Promise<Employee> {
    return requireOne<Employee>(
        context.db,
        `INSERT INTO employees(org_id,max_user_id,name,role,activated_at) VALUES($1,$2,$3,'support',now()) RETURNING *`,
        [context.c.ORG_ID, maxUserId, name],
    );
}

async function typesFor(employee: Employee): Promise<string[]> {
    const { rows } = await context.db.query<{ type: string }>(
        'SELECT type FROM notifications WHERE employee_id=$1 ORDER BY cursor',
        [employee.id],
    );

    return rows.map((row) => row.type);
}

it('lists notifications with the ticket, the client message and who transferred it', async () => {
    await start();
    await context.create('Нет интернета с утра');
    await context.command('assign', {}, context.admin);
    await context.input('Роутер мигает красным');
    await context.command('transfer', { employee_id: context.staff.id, comment: 'Посмотри' }, context.admin);

    const adminItems = await list('2');
    const message = adminItems.find((item) => item.type === 'message.from_client');

    expect(message).toMatchObject({
        preview: 'Роутер мигает красным',
        ticket: { description: 'Нет интернета с утра', status: 'in_progress', assignee_name: 'Анна' },
    });

    const transfer = (await list('1')).find((item) => item.type === 'ticket.transferred');

    expect(transfer).toMatchObject({
        actor_name: 'Руководитель',
        payload: { comment: 'Посмотри' },
        ticket: { number: expect.stringMatching(/^\d{6}$/) as string },
    });
});

it('marks every notification of a ticket read at once', async () => {
    await start();
    const ticket = await context.create();

    await context.command('assign');
    await context.input('Ещё одно сообщение');
    expect((await list('1')).filter((item) => !item.read_at)).toHaveLength(2);

    const { headers } = await staffLogin(app, context.c.APP_ORIGIN, '1');

    const read = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: headers(),
        payload: { ticket_id: ticket.id },
    });

    expect(read.json()).toEqual({ read: 2 });
    expect((await list('1')).filter((item) => !item.read_at)).toEqual([]);
    expect((await list('2')).filter((item) => !item.read_at)).toHaveLength(1);
});

it('skips new tickets for employees who turned them off', async () => {
    await start();
    expect((await saveSettings('1', { new_tickets: 'off', topics: [], max_alerts: false })).statusCode).toBe(200);
    await context.create();

    expect(await typesFor(context.staff)).toEqual([]);
    expect(await typesFor(context.admin)).toEqual(['ticket.created']);
});

it('notifies topic subscribers once the ticket gets one of their topics', async () => {
    await start({ AI_ENABLED: 'false' });
    const problems = await addSupport('Борис', '3');
    const unsorted = await addSupport('Вера', '4');

    await saveSettings('1', { new_tickets: 'topics', topics: ['payment'], max_alerts: false });
    await saveSettings('3', { new_tickets: 'topics', topics: ['problem'], max_alerts: false });
    await saveSettings('4', { new_tickets: 'topics', topics: ['undefined'], max_alerts: false });
    await context.create();

    expect(await typesFor(context.staff)).toEqual([]);
    expect(await typesFor(unsorted)).toEqual(['ticket.created']);

    await context.command('classification', { tag: 'payment', revisions: { tag: 0 } }, context.admin);
    await context.command('classification', { tag: 'undefined', revisions: { tag: 1 } }, context.admin);
    await context.command('classification', { tag: 'payment', revisions: { tag: 2 } }, context.admin);

    expect(await typesFor(context.staff)).toEqual(['ticket.created']);
    expect(await typesFor(problems)).toEqual([]);
    expect(await typesFor(unsorted)).toEqual(['ticket.created']);

    const [item] = await list('1');

    expect(item.payload).toEqual({ topic: true });
});

it('validates notification settings', async () => {
    await start();

    expect((await saveSettings('1', { new_tickets: 'topics', topics: [], max_alerts: false })).json()).toMatchObject({
        code: 'topics_required',
    });

    expect(
        (await saveSettings('1', { new_tickets: 'topics', topics: ['no_such_topic'], max_alerts: false })).json(),
    ).toMatchObject({ code: 'unknown_topic' });

    await saveSettings('1', { new_tickets: 'off', topics: ['payment'], max_alerts: true });
    const { headers } = await staffLogin(app, context.c.APP_ORIGIN, '1');

    expect((await app.inject({ url: '/v1/notifications/settings', headers: headers() })).json()).toEqual({
        new_tickets: 'off',
        topics: [],
        max_alerts: true,
    });
});

it('duplicates notifications to MAX for employees who asked for it', async () => {
    await start();
    await saveSettings('1', { new_tickets: 'all', topics: [], max_alerts: true });
    const ticket = await context.create();

    const { rows: jobs } = await context.db.query<{ ref_id: string }>(
        "SELECT ref_id FROM jobs WHERE kind='notification_alert'",
    );

    expect(jobs).toHaveLength(1);
    const sent: { userId: string; text: string }[] = [];

    const alerts = new NotificationAlerts(context.db, context.c.ORG_ID, {
        sendToUser: (userId, text) => {
            sent.push({ userId, text });

            return Promise.resolve();
        },
    });

    await alerts.send(jobs[0].ref_id);
    expect(sent).toEqual([{ userId: '1', text: expect.stringMatching(/^Новое обращение №\d{6}$/) as string }]);

    await context.db.query('UPDATE notifications SET read_at=now() WHERE ticket_id=$1', [ticket.id]);
    await alerts.send(jobs[0].ref_id);
    expect(sent).toHaveLength(1);
});
