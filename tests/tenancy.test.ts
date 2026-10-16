import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { Gateway } from '../src/modules/ai/index.js';
import { waitForSendSlot } from '../src/modules/delivery/send-rate.js';
import { TicketQueries } from '../src/modules/tickets/index.js';
import { one, requireOne } from '../src/shared/db.js';
import type { Job, Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';

let first: Awaited<ReturnType<typeof fixture>>;
let second: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    first = await fixture();
    second = await fixture(first.db, testConfig());
});

afterEach(async () => {
    await first.db.close();
});

it('numbers tickets per organization from 1', async () => {
    const ours = await first.create('Нет интернета', '100');
    const theirs = await second.create('Нет интернета', '100');

    expect(ours.ticket_number).toBe(1);
    expect(theirs.ticket_number).toBe(1);

    const sequences = await first.db.query<{ ticket_sequence: string }>(
        'SELECT ticket_sequence FROM organizations WHERE id = ANY($1) ORDER BY created_at',
        [[first.c.ORG_ID, second.c.ORG_ID]],
    );

    expect(sequences.rows.map((row) => row.ticket_sequence)).toEqual([
        'ticket_number_seq',
        `ticket_number_seq_${second.c.ORG_ID.replaceAll('-', '')}`,
    ]);
});

it('keeps numbering past 999999 with full-width numbers and search', async () => {
    await first.db.query("SELECT setval('ticket_number_seq', 999999)");
    const ticket = await first.create('Медленный интернет', '100');
    const queries = new TicketQueries(first.db, first.c.ORG_ID);

    expect(ticket.ticket_number).toBe(1_000_000);
    expect(((await queries.ticket(ticket.id)) as Row).number).toBe('1000000');

    const found = (await queries.list({ tab: 'open', q: '№1000000', sort: 'urgency', limit: 30 })) as {
        items: Row[];
    };

    expect(found.items.map((item) => item.id)).toEqual([ticket.id]);
});

it('starts a dedicated sequence after the tickets an organization already has', async () => {
    const org = randomUUID();

    await first.create('Первое', '100');
    await first.db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'Филиал','Europe/Moscow')", [org]);

    await first.db.query(
        `INSERT INTO clients(org_id,max_user_id,chat_id,consent_state,consent_version)
     VALUES($1,'500','500','granted','test-1')`,
        [org],
    );

    await first.db.query(
        `INSERT INTO tickets(org_id,client_id,ticket_number,description,consent_version,consent_revision,status)
     SELECT $1,id,41,'old','test-1',0,'closed' FROM clients WHERE org_id=$1`,
        [org],
    );

    const branch = await fixture(first.db, testConfig({ ORG_ID: org }));
    const ticket = await branch.create('Новое', '501');

    expect(ticket.ticket_number).toBe(42);
});

it('enforces the per-organization AI quota inside the global cap', async () => {
    await first.create();

    const job = (await one<Job>(
        first.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind='triage' AND org_id=$1 RETURNING *",
        [first.c.ORG_ID],
    ))!;

    const gateway = new Gateway(first.db, first.c, () => Promise.reject(new Error('remote_timeout')));
    const request = { messages: [{ role: 'user' as const, content: 'test' }] };

    await first.db.query('UPDATE organizations SET ai_quota=1 WHERE id=$1', [first.c.ORG_ID]);

    await first.db.query("UPDATE ai_permits SET state='running',holder=$2,org_id=$1,started_at=now() WHERE slot=15", [
        first.c.ORG_ID,
        randomUUID(),
    ]);

    await expect(gateway.complete(job, 'step', request)).rejects.toMatchObject({ code: 'ai_busy' });

    await first.db.query('UPDATE organizations SET ai_quota=2 WHERE id=$1', [first.c.ORG_ID]);
    await expect(gateway.complete(job, 'step', request)).rejects.toThrow();

    const taken = await requireOne(first.db, "SELECT org_id FROM ai_permits WHERE state='uncertain'");

    expect(taken.org_id).toBe(first.c.ORG_ID);
});

it('paces outbound sends per organization', async () => {
    await waitForSendSlot(first.db, first.c.ORG_ID);
    await waitForSendSlot(first.db, second.c.ORG_ID);

    const { rows } = await first.db.query('SELECT org_id FROM max_send_pacing ORDER BY org_id');

    expect(rows).toHaveLength(2);
});
