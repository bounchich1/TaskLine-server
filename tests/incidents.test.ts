import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { JobRunner } from '../src/app/workers/job-runner.js';
import { IncidentDetector } from '../src/modules/incidents/index.js';
import { one, requireOne } from '../src/shared/db.js';
import type { Row, Ticket } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin: StaffHeaders;
let support: StaffHeaders;
let tag: string;

type IncidentRow = Row & { id: string; version: number; status: string; detection: Row | null };

beforeEach(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);
    admin = (await staffLogin(app, context.c.APP_ORIGIN, '2')).headers;
    support = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers;

    const topic = await requireOne<{ code: string }>(
        context.db,
        `SELECT code FROM dictionaries WHERE org_id=$1 AND dimension='tag' AND code<>'undefined'
     ORDER BY rank LIMIT 1`,
        [context.c.ORG_ID],
    );

    tag = topic.code;
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

async function outage(count: number, firstUser = 200): Promise<Ticket[]> {
    const tickets: Ticket[] = [];

    for (let index = 0; index < count; index++) {
        tickets.push(
            await context.create(`Нет интернета на ул. Ленина, весь дом без связи (${index})`, `${firstUser + index}`),
        );
    }

    await context.db.query("UPDATE tickets SET tag=$2,ai_status='done' WHERE org_id=$1", [context.c.ORG_ID, tag]);

    return tickets;
}

async function runBroadcasts(): Promise<void> {
    const { rows } = await context.db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE org_id=$1 AND kind='incident_broadcast' AND state='pending' ORDER BY created_at",
        [context.c.ORG_ID],
    );

    for (const job of rows) {
        await new JobRunner(context.db, context.c).run(job.id);
    }
}

async function openIncident(ticketIds: string[], extra: Row = {}): Promise<IncidentRow> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/incidents',
        headers: admin(),
        payload: {
            tag,
            title: 'Авария на ул. Ленина',
            public_message: 'Мы знаем об аварии.',
            ticket_ids: ticketIds,
            ...extra,
        },
    });

    expect(response.statusCode).toBe(200);

    return response.json<{ incident: IncidentRow }>().incident;
}

const count = async (sql: string, values: unknown[]) => Number((await requireOne(context.db, sql, values)).n);

describe('detection', () => {
    it('suggests an incident for a spike in one topic and notifies supervisors once', async () => {
        await outage(9);
        await new IncidentDetector(context.db, context.c).run();
        await new IncidentDetector(context.db, context.c).run();

        const list = await app.inject({ url: '/v1/incidents?status=suggested', headers: admin() });
        const [suggestion] = list.json<{ items: IncidentRow[] }>().items;

        expect(suggestion.status).toBe('suggested');
        expect(suggestion.detection?.count).toBe(9);
        expect(suggestion.detection?.terms).toEqual(expect.arrayContaining(['ул. Ленина']));
        expect(suggestion.title).toContain('ул. Ленина');

        expect(
            await count("SELECT count(*)::int AS n FROM notifications WHERE org_id=$1 AND type='incident.suggested'", [
                context.c.ORG_ID,
            ]),
        ).toBe(1);

        const detail = await app.inject({ url: `/v1/incidents/${suggestion.id}`, headers: admin() });

        expect(detail.json<{ candidates: Row[] }>().candidates).toHaveLength(9);
        expect((await app.inject({ url: '/v1/incidents', headers: support() })).statusCode).toBe(403);
    });

    it('stays quiet below the threshold and for an hour after a dismissal', async () => {
        await outage(5);
        await new IncidentDetector(context.db, context.c).run();
        expect(await count('SELECT count(*)::int AS n FROM incidents WHERE org_id=$1', [context.c.ORG_ID])).toBe(0);

        await outage(4, 300);
        await context.db.query('UPDATE incident_settings SET detected_at=NULL WHERE org_id=$1', [context.c.ORG_ID]);
        await new IncidentDetector(context.db, context.c).run();

        const suggestion = await requireOne<IncidentRow>(context.db, 'SELECT * FROM incidents WHERE org_id=$1', [
            context.c.ORG_ID,
        ]);

        const dismissed = await app.inject({
            method: 'POST',
            url: `/v1/incidents/${suggestion.id}/dismiss`,
            headers: admin({ 'if-match': String(suggestion.version) }),
        });

        expect(dismissed.json<IncidentRow>().status).toBe('dismissed');
        await context.db.query('UPDATE incident_settings SET detected_at=NULL WHERE org_id=$1', [context.c.ORG_ID]);
        await new IncidentDetector(context.db, context.c).run();
        expect(await count('SELECT count(*)::int AS n FROM incidents WHERE org_id=$1', [context.c.ORG_ID])).toBe(1);
    });

    it('does not count the tickets of a resolved incident as a new spike', async () => {
        const tickets = await outage(9);
        const incident = await openIncident(tickets.map((ticket) => ticket.id));

        await runBroadcasts();

        await app.inject({
            method: 'POST',
            url: `/v1/incidents/${incident.id}/resolve`,
            headers: admin({ 'if-match': String(incident.version) }),
            payload: { text: 'Связь восстановлена.' },
        });

        await runBroadcasts();
        await new IncidentDetector(context.db, context.c).run();
        expect(await count('SELECT count(*)::int AS n FROM incidents WHERE org_id=$1', [context.c.ORG_ID])).toBe(1);
    });
});

describe('incident lifecycle', () => {
    it('moves linked tickets out of the queue and broadcasts one reply to every client', async () => {
        const tickets = await outage(3);
        const incident = await openIncident(tickets.slice(0, 2).map((ticket) => ticket.id));

        const page = await app.inject({ url: '/v1/tickets?tab=open', headers: support() });
        const counts = page.json<{ counts: Row }>().counts;

        expect(counts).toMatchObject({ open: 1, incident: 2 });

        const linked = await app.inject({ url: `/v1/tickets?tab=incident`, headers: support() });
        const [first] = linked.json<{ items: Row[] }>().items;

        expect(first).toMatchObject({ incident_id: incident.id, incident_title: 'Авария на ул. Ленина' });

        await runBroadcasts();

        expect(
            await count("SELECT count(*)::int AS n FROM deliveries WHERE org_id=$1 AND kind='incident'", [
                context.c.ORG_ID,
            ]),
        ).toBe(2);

        await app.inject({
            method: 'POST',
            url: `/v1/incidents/${incident.id}/messages`,
            headers: admin(),
            payload: { text: 'Бригада на месте.' },
        });

        await runBroadcasts();
        await runBroadcasts();

        const detail = await app.inject({ url: `/v1/incidents/${incident.id}`, headers: admin() });

        expect(detail.json<{ messages_sent: number }>().messages_sent).toBe(4);
    });

    it('auto-links a matching new ticket, answers at once and skips triage', async () => {
        const tickets = await outage(2);

        const incident = await openIncident(
            tickets.map((ticket) => ticket.id),
            { match_terms: ['ленина'] },
        );

        const settings = await app.inject({ url: '/v1/incidents/settings', headers: admin() });
        const current = settings.json<Row & { version: number }>();

        const saved = await app.inject({
            method: 'PUT',
            url: '/v1/incidents/settings',
            headers: admin({ 'if-match': String(current.version) }),
            payload: { ...current, version: undefined, auto_link: true },
        });

        expect(saved.statusCode).toBe(200);

        const ticket = await context.create('Опять пропал интернет, Ленина 5', '400');
        const link = await one(context.db, 'SELECT auto FROM incident_tickets WHERE ticket_id=$1', [ticket.id]);
        const refreshed = await context.ticket('400');

        expect(link?.auto).toBe(true);
        expect(refreshed).toMatchObject({ tag: incident.tag, ai_status: 'skipped' });

        expect(await count("SELECT count(*)::int AS n FROM jobs WHERE kind='triage' AND ref_id=$1", [ticket.id])).toBe(
            0,
        );

        const reply = await requireOne(
            context.db,
            "SELECT body FROM deliveries WHERE ticket_id=$1 AND kind='incident_known'",
            [ticket.id],
        );

        expect((reply.body as { text: string }).text).toContain('Мы знаем об аварии.');
    });

    it('closes every linked ticket on resolve and learns from one of them', async () => {
        const tickets = await outage(3);
        const incident = await openIncident(tickets.map((ticket) => ticket.id));

        await runBroadcasts();

        const resolved = await app.inject({
            method: 'POST',
            url: `/v1/incidents/${incident.id}/resolve`,
            headers: admin({ 'if-match': String(incident.version) }),
            payload: { text: 'Связь восстановлена.' },
        });

        expect(resolved.json<IncidentRow>().status).toBe('resolved');
        await runBroadcasts();

        const { rows } = await context.db.query<{ status: string }>('SELECT status FROM tickets WHERE org_id=$1', [
            context.c.ORG_ID,
        ]);

        expect(rows.map((row) => row.status)).toEqual(['closed', 'closed', 'closed']);

        expect(
            await count("SELECT count(*)::int AS n FROM closures WHERE org_id=$1 AND reason='incident'", [
                context.c.ORG_ID,
            ]),
        ).toBe(3);

        expect(
            await count("SELECT count(*)::int AS n FROM jobs WHERE org_id=$1 AND kind='learning'", [context.c.ORG_ID]),
        ).toBe(1);

        expect(
            await count("SELECT count(*)::int AS n FROM deliveries WHERE org_id=$1 AND kind='incident_closed'", [
                context.c.ORG_ID,
            ]),
        ).toBe(3);
    });

    it('returns an unlinked ticket to the queue and cancels its pending broadcast', async () => {
        const [ticket] = await outage(1);
        const incident = await openIncident([ticket.id]);

        await runBroadcasts();

        const removed = await app.inject({
            method: 'DELETE',
            url: `/v1/incidents/${incident.id}/tickets/${ticket.id}`,
            headers: admin(),
        });

        expect(removed.statusCode).toBe(200);

        const delivery = await requireOne(
            context.db,
            "SELECT state FROM deliveries WHERE ticket_id=$1 AND kind='incident'",
            [ticket.id],
        );

        expect(delivery.state).toBe('canceled');

        const page = await app.inject({ url: '/v1/tickets?tab=open', headers: support() });

        expect(page.json<{ counts: Row }>().counts).toMatchObject({ open: 1, incident: 0 });
    });
});
