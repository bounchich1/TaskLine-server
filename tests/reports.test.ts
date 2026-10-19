import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { refreshFacts } from '../src/modules/reports/index.js';
import { requireOne } from '../src/shared/db.js';
import type { Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin: StaffHeaders;
let support: StaffHeaders;

const today = () => new Date().toISOString().slice(0, 10);
const period = () => `from=${today()}&to=${today()}`;

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

async function deliverAll(): Promise<void> {
    await context.db.query("UPDATE deliveries SET state='delivered' WHERE kind='staff'");

    await context.db.query(
        "UPDATE messages SET delivery_state='delivered' WHERE author_type='staff' AND visibility='client'",
    );
}

async function workedTicket(rating: number, userId = '100') {
    const created = await context.create('Не работает интернет', userId);

    await context.db.query(`UPDATE tickets SET ai_status='done',suggestion=$2 WHERE id=$1`, [
        created.id,
        JSON.stringify({
            schema_version: '1.1',
            tags: { tag: created.tag, urgency: created.urgency, complexity: 'high' },
            needs_review: false,
            missing_information: [],
            evidence_memory_ids: ['m1', 'm2'],
            confidence: 0.8,
            tip: { summary: 'Перезагрузить', steps: [{ text: 'Шаг', case_refs: ['m1'] }], cautions: [] },
            customer_reply: 'Перезагрузите роутер и проверьте кабель',
        }),
    ]);

    await context.command('assign', {}, context.staff, userId);

    await context.command(
        'messages',
        { text: 'Перезагрузите роутер и проверьте кабель, пожалуйста', draft_origin: 'ai' },
        context.staff,
        userId,
    );

    await deliverAll();
    await context.command('close', {}, context.staff, userId);
    const ticket = await context.ticket(userId);

    await context.db.query("UPDATE closures SET rating=$2,rated_at=now(),finished_reason='rated' WHERE ticket_id=$1", [
        ticket.id,
        rating,
    ]);

    return ticket;
}

async function report(name: string, headers = admin) {
    const response = await app.inject({ url: `/v1/reports/${name}?${period()}`, headers: headers() });

    expect(response.statusCode).toBe(200);

    return response.json<Row>();
}

it('rolls a worked ticket up into one facts row per lifecycle', async () => {
    const ticket = await workedTicket(9);

    await refreshFacts(context.db, context.c.ORG_ID, 0);

    const facts = await requireOne(context.db, 'SELECT * FROM ticket_facts WHERE ticket_id=$1', [ticket.id]);

    expect(facts).toMatchObject({
        lifecycle: 1,
        assignee_id: context.staff.id,
        rating: 9,
        rating_requested: true,
        staff_replies: 1,
        ai_draft_replies: 1,
        draft_used: true,
        ai_classified: true,
        ai_tag_kept: true,
        ai_complexity_kept: false,
        sources_cited: 1,
        recall_hits: 2,
        tip_shown: true,
    });

    expect(facts.first_response_at).not.toBeNull();
    expect(facts.closed_at).not.toBeNull();
    expect(Number(facts.draft_edit_ratio)).toBeCloseTo(1 / 6, 2);
});

it('adds a lifecycle on reopen and marks the earlier one reopened', async () => {
    const ticket = await workedTicket(5);

    await context.command('reopen', { reason: 'Снова не работает' }, context.staff);
    await refreshFacts(context.db, context.c.ORG_ID, 0);

    const { rows } = await context.db.query(
        `SELECT lifecycle,reopened_at IS NOT NULL AS reopened,closed_at IS NOT NULL AS closed FROM ticket_facts
     WHERE ticket_id=$1 ORDER BY lifecycle`,
        [ticket.id],
    );

    expect(rows).toEqual([
        { lifecycle: 1, reopened: true, closed: true },
        { lifecycle: 2, reopened: false, closed: false },
    ]);
});

it('serves overview, team, topics, ai and quality reports to supervisors and admins only', async () => {
    await workedTicket(9);
    await workedTicket(3, '101');

    const overview = await report('overview');
    const current = overview.current as Row;

    expect(overview.period).toMatchObject({ from: today(), to: today() });
    expect(current).toMatchObject({ created: 2, closed: 2, open_end: 0, rated: 2, promoters: 0.5, detractors: 0.5 });
    expect(current.csat).toBe(6);
    expect(current.reopen_rate).toBe(0);
    expect((overview.trend as Row[]).at(-1)).toMatchObject({ day: today(), created: 2, closed: 2 });

    const team = await report('team');
    const anna = (team.items as Row[]).find((row) => row.employee_id === context.staff.id);

    expect(anna).toMatchObject({ taken: 2, closed: 2, responded: 2, ai_draft_share: 1, response_p50: null });

    const topics = await report('topics');

    expect((topics.items as Row[]).find((row) => row.created === 2)).toBeTruthy();

    const ai = await report('ai');

    expect(ai.accuracy).toMatchObject({ classified: 2, tag: 1, complexity: 0 });
    expect(ai.grounding).toMatchObject({ tipped: 2, share: 1 });
    expect(ai.drafts).toMatchObject({ replies: 2, ai_share: 1 });

    const quality = await report('quality');

    expect(quality.items).toEqual([expect.objectContaining({ rating: 3, assignee_name: 'Анна' })]);

    const forbidden = await app.inject({ url: `/v1/reports/overview?${period()}`, headers: support() });

    expect(forbidden.statusCode).toBe(403);

    expect(
        (await app.inject({ url: '/v1/reports/overview?from=2026-02-01&to=2026-01-01', headers: admin() })).statusCode,
    ).toBe(422);
});

it('exports reports as CSV and XLSX, also through a download grant', async () => {
    await workedTicket(8);

    const csv = await app.inject({ url: `/v1/reports/team/export?format=csv&${period()}`, headers: admin() });

    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.startsWith('﻿Сотрудник;Взято;Закрыто')).toBe(true);
    expect(csv.body).toContain('Анна;1;1');

    const xlsx = await app.inject({ url: `/v1/reports/overview/export?format=xlsx&${period()}`, headers: admin() });

    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const grant = await app.inject({
        method: 'POST',
        url: '/v1/reports/quality/export-grant',
        headers: admin(),
        payload: { format: 'csv', from: today(), to: today() },
    });

    expect(grant.statusCode).toBe(200);
    const { url } = grant.json<{ url: string }>();
    const download = await app.inject({ url: new URL(url).pathname });

    expect(download.statusCode).toBe(200);
    expect(download.body).toContain('Обращение;Тема;Сотрудник;Оценка;Закрыто');
    expect((await app.inject({ url: '/download/report/' + 'x'.repeat(40) })).statusCode).toBe(404);
});

it('logs draft inserts and tip views once per few minutes', async () => {
    const ticket = await context.create();

    for (const kind of ['tip_viewed', 'tip_viewed', 'draft_inserted']) {
        const response = await app.inject({
            method: 'POST',
            url: `/v1/tickets/${ticket.id}/events`,
            headers: support(),
            payload: { kind },
        });

        expect(response.statusCode).toBe(202);
    }

    const { rows } = await context.db.query(
        "SELECT kind FROM ticket_events WHERE ticket_id=$1 AND kind IN('tip_viewed','draft_inserted') ORDER BY id",
        [ticket.id],
    );

    expect(rows.map((row) => row.kind)).toEqual(['tip_viewed', 'draft_inserted']);

    const invalid = await app.inject({
        method: 'POST',
        url: `/v1/tickets/${ticket.id}/events`,
        headers: support(),
        payload: { kind: 'hack' },
    });

    expect(invalid.statusCode).toBe(422);
});
