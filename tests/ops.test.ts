import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { alertText } from '../src/modules/staff/alert-relay.js';

import { fixture, testConfig } from './helpers.js';

const OPS_TOKEN = 'o'.repeat(40);

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;

beforeEach(async () => {
    context = await fixture(undefined, testConfig({ OPS_TOKEN }));
    app = await buildApi(context.db, context.c);
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

const bearer = { authorization: `Bearer ${OPS_TOKEN}` };

const alertmanager = {
    status: 'firing',
    alerts: [
        {
            status: 'firing',
            labels: { alertname: 'InboxBacklog', severity: 'critical' },
            annotations: { summary: 'Входящие не обрабатываются 5 минут' },
        },
        { status: 'resolved', labels: { alertname: 'BackupStale' }, annotations: {} },
    ],
};

it('exposes Prometheus metrics only with the ops token', async () => {
    await context.create('Нет интернета');

    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);

    const response = await app.inject({ url: '/metrics', headers: bearer });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(response.body).toContain('taskline_build_info{version="dev"} 1');
    expect(response.body).toContain('taskline_tickets_active{status="open"} 1');
    expect(response.body).toContain('# TYPE taskline_inbox_oldest_pending_seconds gauge');
    expect(response.body).toMatch(/^taskline_jobs\{kind="triage",state="pending"\} 1$/m);
});

it('relays Alertmanager notifications to active admins', async () => {
    expect((await app.inject({ method: 'POST', url: '/internal/alerts', payload: alertmanager })).statusCode).toBe(401);

    const response = await app.inject({
        method: 'POST',
        url: '/internal/alerts',
        headers: bearer,
        payload: alertmanager,
    });

    expect(response.json()).toEqual({ delivered: 1 });

    expect(alertText(alertmanager)).toBe(
        'Тревога · TaskLine\n• InboxBacklog — Входящие не обрабатываются 5 минут\n\nРешено · TaskLine\n• BackupStale',
    );
});

it('keeps ops routes off when no ops token is configured', async () => {
    const plain = await fixture(undefined, testConfig());
    const api = await buildApi(plain.db, plain.c);

    expect((await api.inject({ url: '/metrics', headers: bearer })).statusCode).toBe(404);
    await api.close();
    await plain.db.close();
});
