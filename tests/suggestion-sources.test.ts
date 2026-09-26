import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { TicketQueries } from '../src/modules/tickets/index.js';
import { one, requireOne } from '../src/shared/db.js';
import { formatTicketNumber } from '../src/shared/ticket-number.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
});

afterEach(async () => {
    await context.db.close();
});

const queries = () => new TicketQueries(context.db, context.c.ORG_ID);

async function learnedSource() {
    await context.create('Скорость падает вечером');
    await context.command('assign');
    await context.command('messages', { text: 'Смените канал Wi-Fi на 5 ГГц' });
    await context.db.query("UPDATE deliveries SET state='delivered'");
    await context.db.query("UPDATE messages SET delivery_state='delivered' WHERE author_type='staff'");
    await context.input('Помогло, спасибо');
    await context.command('close');
    const source = await context.ticket();

    const staffMessage = await requireOne(
        context.db,
        "SELECT id FROM messages WHERE ticket_id=$1 AND author_type='staff'",
        [source.id],
    );

    const content = {
        problem_summary: 'Вечером падает скорость',
        solution_summary: 'Сменить канал Wi-Fi',
        steps: [{ action: 'Смена канала', evidence_message_ids: [staffMessage.id] }],
        evidence_message_ids: [staffMessage.id],
    };

    const record = await requireOne(
        context.db,
        `INSERT INTO memory_records(org_id,ticket_id,closure_id,source_key,content_hash,content,eligible,state)
     VALUES($1,$2,$3,$4,'hash',$5,true,'persisted') RETURNING id`,
        [context.c.ORG_ID, source.id, source.current_cycle_id, `test:${source.id}`, JSON.stringify(content)],
    );

    return { source, recordId: String(record.id), staffMessageId: String(staffMessage.id) };
}

async function citingTicket(memoryIds: string[]) {
    const ticket = await context.create('Интернет тормозит по вечерам', '200');

    await context.db.query('UPDATE tickets SET suggestion=$2 WHERE id=$1', [
        ticket.id,
        JSON.stringify({ schema_version: '1.1', evidence_memory_ids: memoryIds }),
    ]);

    return ticket;
}

const gone = (memoryId: string) => ({
    memory_id: memoryId,
    state: 'gone',
    ticket_id: null,
    number: null,
    problem: null,
    closed_at: null,
});

async function stateOf(ticketId: string) {
    return (await queries().ticket(ticketId)).suggestion_sources[0]?.state;
}

it('resolves cited sources to ticket numbers and hides unknown ones', async () => {
    const { source, recordId } = await learnedSource();
    const unknown = randomUUID();
    const ticket = await citingTicket([recordId, unknown, 'case-1']);

    const sources = (await queries().ticket(ticket.id)).suggestion_sources;

    expect(sources[0]?.closed_at).toBeTruthy();

    expect(sources).toEqual([
        {
            memory_id: recordId,
            state: 'ok',
            ticket_id: source.id,
            number: formatTicketNumber(source.ticket_number),
            problem: 'Вечером падает скорость',
            closed_at: sources[0]?.closed_at,
        },
        gone(unknown),
        gone('case-1'),
    ]);
});

it('opens the solution cycle with the evidence highlighted and audits the view', async () => {
    const { source, recordId, staffMessageId } = await learnedSource();
    const ticket = await citingTicket([recordId]);

    const excerpt = await queries().openSource({
        ticketId: ticket.id,
        memoryId: recordId,
        actorId: context.staff.id,
    });

    expect(excerpt.source).toMatchObject({
        state: 'ok',
        ticket_id: source.id,
        number: formatTicketNumber(source.ticket_number),
        cycle_no: 1,
        solution: 'Сменить канал Wi-Fi',
    });

    expect(excerpt.highlight).toEqual([staffMessageId]);
    expect(excerpt.messages.map((message) => message.id)).toContain(staffMessageId);

    const audit = await one(
        context.db,
        "SELECT actor_id,object_id,detail FROM audit WHERE action='ticket.source_opened'",
    );

    expect(audit).toMatchObject({
        actor_id: context.staff.id,
        object_id: source.id,
        detail: { from_ticket_id: ticket.id, memory_id: recordId },
    });
});

it('refuses sources that the ticket tip does not cite', async () => {
    const { recordId } = await learnedSource();
    const ticket = await citingTicket([]);

    await expect(
        queries().openSource({ ticketId: ticket.id, memoryId: recordId, actorId: context.staff.id }),
    ).rejects.toMatchObject({ code: 'source_not_found', status: 404 });
});

it('tracks changed, reopened and withdrawn sources on every read', async () => {
    const { source, recordId } = await learnedSource();
    const ticket = await citingTicket([recordId]);

    await context.db.query('UPDATE closures SET invalidated=true WHERE id=$1', [source.current_cycle_id]);
    expect(await stateOf(ticket.id)).toBe('outdated');

    await context.command('reopen', { reason: 'Снова медленно' });
    expect(await stateOf(ticket.id)).toBe('reopened');

    await context.db.query(
        "UPDATE clients SET consent_state='withdrawn',consent_revision=consent_revision+1 WHERE id=$1",
        [source.client_id],
    );

    expect((await queries().ticket(ticket.id)).suggestion_sources).toEqual([gone(recordId)]);

    await expect(
        queries().openSource({ ticketId: ticket.id, memoryId: recordId, actorId: context.staff.id }),
    ).rejects.toMatchObject({ code: 'source_unavailable', status: 410 });
});
