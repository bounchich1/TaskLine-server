import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { requireOne } from '../src/shared/db.js';
import type { Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin: StaffHeaders;
let support: StaffHeaders;

beforeEach(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);
    admin = (await staffLogin(app, context.c.APP_ORIGIN, '2')).headers;
    support = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers;
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

async function readConfig(): Promise<Row & { version: number; policies: Row[] }> {
    const response = await app.inject({ url: '/v1/admin/sla', headers: admin() });

    expect(response.statusCode).toBe(200);

    return response.json();
}

async function saveConfig(changes: Row) {
    const { version, ...current } = await readConfig();

    delete current.timezone;

    return app.inject({
        method: 'PUT',
        url: '/v1/admin/sla',
        headers: admin({ 'if-match': String(version) }),
        payload: { ...current, ...changes },
    });
}

it('serves the default calendar and policy matrix to admins only', async () => {
    const config = await readConfig();

    expect(config).toMatchObject({
        enabled: true,
        timezone: 'Asia/Krasnoyarsk',
        holidays: [],
        notify_max: false,
        client_eta: false,
        waiting_reminder_hours: 24,
        waiting_close_hours: 72,
    });

    expect((config.week as Row)['1']).toEqual([['09:00', '18:00']]);

    expect(config.policies).toContainEqual({
        urgency: 'critical',
        tag: '*',
        first_response_minutes: 15,
        resolution_minutes: 240,
    });

    expect((await app.inject({ url: '/v1/admin/sla', headers: support() })).statusCode).toBe(403);
});

it('saves the calendar, holidays and topic overrides', async () => {
    const saved = await saveConfig({
        week: {
            1: [
                ['09:00', '13:00'],
                ['14:00', '18:00'],
            ],
            2: [],
            3: [],
            4: [],
            5: [],
            6: [],
            7: [],
        },
        holidays: ['2026-11-04', '2026-11-04', '2026-01-01'],
        policies: [
            { urgency: 'medium', tag: '*', first_response_minutes: 60, resolution_minutes: 960 },
            { urgency: 'medium', tag: 'billing', first_response_minutes: 30, resolution_minutes: 120 },
        ],
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ holidays: ['2026-01-01', '2026-11-04'] });
    expect(saved.json<{ policies: Row[] }>().policies).toHaveLength(2);
});

it('rejects overlapping hours, duplicate policies and unknown dictionary codes', async () => {
    const overlapping = await saveConfig({
        week: {
            1: [
                ['09:00', '14:00'],
                ['13:00', '18:00'],
            ],
            2: [],
            3: [],
            4: [],
            5: [],
            6: [],
            7: [],
        },
    });

    expect(overlapping.json()).toMatchObject({ code: 'invalid_work_hours' });

    const closed = await saveConfig({ week: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] } });

    expect(closed.json()).toMatchObject({ code: 'invalid_work_hours' });

    const policy = { urgency: 'low', tag: '*', first_response_minutes: 10, resolution_minutes: 100 };

    expect((await saveConfig({ policies: [policy, policy] })).json()).toMatchObject({ code: 'duplicate_policy' });

    expect((await saveConfig({ policies: [{ ...policy, urgency: 'galactic' }] })).json()).toMatchObject({
        code: 'invalid_dictionary',
    });

    expect((await saveConfig({ waiting_reminder_hours: 80, waiting_close_hours: 72 })).json()).toMatchObject({
        code: 'invalid_waiting_timers',
    });
});

it('clears clocks of open tickets when switched off and restores them when switched on', async () => {
    await context.create();
    expect((await context.ticket()).first_response_due_at).not.toBeNull();

    expect((await saveConfig({ enabled: false })).statusCode).toBe(200);
    expect((await context.ticket()).first_response_due_at).toBeNull();

    expect((await saveConfig({ enabled: true })).statusCode).toBe(200);
    expect((await context.ticket()).first_response_due_at).not.toBeNull();
});

it('filters and sorts the queue by SLA risk', async () => {
    const calm = await context.create('Вопрос про тариф', '201');
    const urgent = await context.create('Нет интернета', '202');
    const none = await context.create('Просто спросить', '203');

    await context.db.query(
        `UPDATE tickets SET first_response_warn_at=now()-interval '5 minutes',first_response_due_at=now()+interval '5 minutes'
     WHERE id=$1`,
        [urgent.id],
    );

    await context.db.query(
        `UPDATE tickets SET sla_first_response_minutes=NULL,sla_resolution_minutes=NULL,first_response_warn_at=NULL,
       first_response_due_at=NULL,resolution_warn_at=NULL,resolution_due_at=NULL WHERE id=$1`,
        [none.id],
    );

    const atRisk = await app.inject({ url: '/v1/tickets?sla=at_risk', headers: support() });
    const { items, counts } = atRisk.json<{ items: Row[]; counts: Row }>();

    expect(items.map((item) => item.id)).toEqual([urgent.id]);
    expect(counts).toMatchObject({ at_risk: 1 });
    expect(items[0].sla_due_at).toBeTruthy();

    const sorted = await app.inject({ url: '/v1/tickets?sort=sla_risk', headers: support() });

    expect(sorted.json<{ items: Row[] }>().items.map((item) => item.id)).toEqual([urgent.id, calm.id, none.id]);
});

it('waits for the client over HTTP', async () => {
    await context.create();
    await context.command('assign');
    const ticket = await context.ticket();

    const waiting = await app.inject({
        method: 'POST',
        url: `/v1/tickets/${ticket.id}/wait`,
        headers: support({ 'if-match': String(ticket.version) }),
        payload: {},
    });

    expect(waiting.statusCode).toBe(200);
    expect(waiting.json<Row>().waiting_since).toBeTruthy();

    const listed = await requireOne(context.db, 'SELECT waiting_since FROM tickets WHERE id=$1', [ticket.id]);

    expect(listed.waiting_since).not.toBeNull();
});
