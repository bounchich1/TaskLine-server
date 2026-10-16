import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MaxClient } from '../src/integrations/max/index.js';
import { DeliveryWorker } from '../src/modules/delivery/index.js';
import { SlaTimers } from '../src/modules/sla/index.js';
import { WaitingTimers } from '../src/modules/tickets/index.js';
import { one, requireOne } from '../src/shared/db.js';
import type { Row, Ticket } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;

const ALWAYS_OPEN = JSON.stringify(
    Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [String(day), [['00:00', '24:00']]])),
);

beforeEach(async () => {
    context = await fixture();
    await context.db.query('UPDATE sla_settings SET week=$2 WHERE org_id=$1', [context.c.ORG_ID, ALWAYS_OPEN]);
});

afterEach(async () => {
    await context.db.close();
});

const timers = async () => {
    await new SlaTimers(context.db, context.c).run();
};

const minutesBetween = (from: unknown, to: unknown) =>
    Math.round((new Date(String(to)).getTime() - new Date(String(from)).getTime()) / 60000);

async function notifications(type: string): Promise<string[]> {
    const { rows } = await context.db.query<{ name: string }>(
        `SELECT e.name FROM notifications n JOIN employees e ON e.id=n.employee_id WHERE n.type=$1 ORDER BY e.name`,
        [type],
    );

    return rows.map((row) => row.name);
}

async function deliverStaffReply(clientId: string): Promise<void> {
    await context.db.query("UPDATE deliveries SET state='delivered' WHERE kind<>'staff'");
    await new DeliveryWorker(context.db, context.c, new MaxClient(context.c)).deliver(clientId);
}

async function moveClock(ticketId: string, column: 'first_response' | 'resolution', minutesAgo: [number, number]) {
    await context.db.query(
        `UPDATE tickets SET ${column}_warn_at=now()-$2*interval '1 minute',${column}_due_at=now()-$3*interval '1 minute',
       sla_next_check_at=now() WHERE id=$1`,
        [ticketId, ...minutesAgo],
    );
}

describe('clocks', () => {
    it('starts both clocks from the policy when a ticket is created', async () => {
        const ticket = await context.create();

        expect(ticket).toMatchObject({ sla_first_response_minutes: 60, sla_resolution_minutes: 960 });
        expect(minutesBetween(ticket.created_at, ticket.first_response_due_at)).toBe(60);
        expect(minutesBetween(ticket.created_at, ticket.first_response_warn_at)).toBe(45);
        expect(minutesBetween(ticket.created_at, ticket.resolution_due_at)).toBe(960);
        expect(ticket.resolution_started_at).toEqual(ticket.created_at);

        const greeting = await one(context.db, "SELECT kind FROM deliveries WHERE kind LIKE 'ticket_created%'");

        expect(greeting!.kind).toBe('ticket_created');
    });

    it('recomputes targets when the urgency changes', async () => {
        const created = await context.create();
        const ticket = await context.command('classification', { urgency: 'critical', revisions: { urgency: 0 } });

        expect(ticket).toMatchObject({ sla_first_response_minutes: 15, sla_resolution_minutes: 240 });
        expect(minutesBetween(created.created_at, ticket.first_response_due_at)).toBe(15);
    });

    it('stops the first-response clock only when a staff reply is delivered', async () => {
        await context.create();
        await context.command('assign');
        await context.command('messages', { text: 'Перезагрузите роутер' });
        expect((await context.ticket()).first_responded_at).toBeNull();

        await deliverStaffReply((await context.ticket()).client_id);
        expect((await context.ticket()).first_responded_at).not.toBeNull();
    });

    it('records a late first response as a breach', async () => {
        const created = await context.create();

        await context.command('assign');
        await moveClock(created.id, 'first_response', [30, 10]);
        await context.command('messages', { text: 'Извините за ожидание' });
        await deliverStaffReply(created.client_id);
        expect((await context.ticket()).sla_breached).toEqual(['first_response']);
    });

    it('client ETA greeting names the deadline when switched on', async () => {
        await context.db.query('UPDATE sla_settings SET client_eta=true WHERE org_id=$1', [context.c.ORG_ID]);
        await context.create();

        const greeting = await requireOne<{ kind: string; body: Row }>(
            context.db,
            "SELECT kind,body FROM deliveries WHERE kind LIKE 'ticket_created%'",
        );

        expect(greeting.kind).toBe('ticket_created_eta');
        expect(String(greeting.body.text)).toMatch(/^Обращение №000001 создано\. Ответим (сегодня|завтра) до \d/);
    });

    it('tells a client writing on a holiday when to expect the answer', async () => {
        await context.db.query(
            `UPDATE sla_settings SET client_eta=true,week=$2,holidays=ARRAY[
           (now() AT TIME ZONE 'Asia/Krasnoyarsk')::date,(now() AT TIME ZONE 'Asia/Krasnoyarsk')::date+1]
         WHERE org_id=$1`,
            [context.c.ORG_ID, ALWAYS_OPEN.replaceAll('00:00', '09:00').replaceAll('24:00', '18:00')],
        );

        await context.create();

        const greeting = await requireOne<{ kind: string; body: Row }>(
            context.db,
            "SELECT kind,body FROM deliveries WHERE kind IN('ticket_created','ticket_created_eta','outside_hours')",
        );

        expect(greeting.kind).toBe('outside_hours');
        expect(String(greeting.body.text)).toMatch(/Сейчас мы не работаем — ответим \d{1,2} [а-я]+ до 10:00\.$/);
    });
});

describe('escalation ladder', () => {
    it('warns everyone who can take an unassigned ticket, then escalates', async () => {
        const supervisor = await requireOne(
            context.db,
            `INSERT INTO employees(org_id,max_user_id,name,role,activated_at)
       VALUES($1,'7','Борис','supervisor',now()) RETURNING id`,
            [context.c.ORG_ID],
        );

        const ticket = await context.create();

        await moveClock(ticket.id, 'first_response', [1, -10]);
        await timers();
        expect(await notifications('sla.response_warning')).toEqual(['Анна', 'Борис']);
        expect((await context.ticket()).first_response_stage).toBe(1);

        await moveClock(ticket.id, 'first_response', [20, 5]);
        await timers();
        expect(await notifications('sla.response_breached')).toEqual(['Борис']);
        expect((await context.ticket()).sla_breached).toEqual(['first_response']);

        await moveClock(ticket.id, 'first_response', [80, 65]);
        await timers();
        expect(await notifications('sla.response_escalated')).toEqual(['Руководитель']);
        expect((await context.ticket()).first_response_stage).toBe(3);
        expect(supervisor.id).toBeTruthy();
    });

    it('notifies the assignee and falls back to admins without supervisors', async () => {
        const ticket = await context.create();

        await context.command('assign');
        await moveClock(ticket.id, 'resolution', [30, -10]);
        await timers();
        expect(await notifications('sla.resolution_warning')).toEqual(['Анна']);

        await moveClock(ticket.id, 'resolution', [30, 1]);
        await timers();
        expect(await notifications('sla.resolution_breached')).toEqual(['Анна', 'Руководитель']);
    });

    it('jumps straight to the reached stage after downtime and duplicates alerts to MAX when enabled', async () => {
        await context.db.query('UPDATE sla_settings SET notify_max=true WHERE org_id=$1', [context.c.ORG_ID]);
        const ticket = await context.create();

        await moveClock(ticket.id, 'first_response', [50, 30]);
        await timers();
        expect(await notifications('sla.response_warning')).toEqual([]);
        expect(await notifications('sla.response_breached')).toEqual(['Руководитель']);

        const alert = await requireOne<{ payload: Row }>(
            context.db,
            "SELECT payload FROM jobs WHERE kind='staff_alert'",
        );

        expect(alert.payload).toMatchObject({ user_id: '2' });
        expect(String(alert.payload.text)).toContain('№000001: первый ответ просрочен');
    });

    it('ignores closed tickets and disabled SLA', async () => {
        const ticket = await context.create();

        await context.db.query('UPDATE sla_settings SET enabled=false WHERE org_id=$1', [context.c.ORG_ID]);
        await moveClock(ticket.id, 'first_response', [50, 30]);
        await timers();
        expect(await notifications('sla.response_breached')).toEqual([]);
        expect((await context.ticket()).sla_next_check_at).toBeNull();
    });
});

describe('waiting for the client', () => {
    async function waitingTicket(): Promise<Ticket> {
        await context.create();
        await context.command('assign');
        await context.db.query("UPDATE deliveries SET state='delivered'");

        return context.command('wait');
    }

    it('pauses the resolution clock until the client writes', async () => {
        const ticket = await waitingTicket();

        expect(ticket.waiting_since).not.toBeNull();
        await expect(context.command('wait')).rejects.toMatchObject({ code: 'already_waiting' });

        await context.db.query("UPDATE tickets SET waiting_since=now()-interval '2 hours' WHERE id=$1", [ticket.id]);
        await context.input('Всё ещё не работает');
        const resumed = await context.ticket();

        expect(resumed.waiting_since).toBeNull();
        expect(resumed.sla_paused_seconds).toBeGreaterThanOrEqual(7199);
        expect(minutesBetween(ticket.resolution_due_at, resumed.resolution_due_at)).toBe(120);
    });

    it('can be lifted by staff', async () => {
        await waitingTicket();
        const resumed = await context.command('resume');

        expect(resumed.waiting_since).toBeNull();
        await expect(context.command('resume')).rejects.toMatchObject({ code: 'not_waiting' });
    });

    it('reminds once, then closes the ticket without a rating', async () => {
        const ticket = await waitingTicket();
        const waiting = new WaitingTimers(context.db, context.c);

        await context.db.query("UPDATE tickets SET waiting_since=now()-interval '25 hours' WHERE id=$1", [ticket.id]);
        await waiting.run();
        await waiting.run();

        expect(
            (await one(context.db, "SELECT count(*)::int AS n FROM deliveries WHERE kind='waiting_reminder'"))!.n,
        ).toBe(1);

        await context.db.query("UPDATE tickets SET waiting_since=now()-interval '73 hours' WHERE id=$1", [ticket.id]);
        await waiting.run();
        const closed = await context.ticket();

        expect(closed).toMatchObject({ status: 'closed', waiting_since: null, sla_next_check_at: null });

        expect(await one(context.db, 'SELECT finished_reason,learning_status,rating FROM closures')).toEqual({
            finished_reason: 'auto_closed',
            learning_status: 'suppressed',
            rating: null,
        });

        expect((await one(context.db, "SELECT count(*)::int AS n FROM deliveries WHERE kind='auto_closed'"))!.n).toBe(
            1,
        );

        expect(await notifications('ticket.auto_closed')).toEqual(['Анна']);
    });

    it('does not auto-close while a reply is still being delivered', async () => {
        const ticket = await waitingTicket();

        await context.command('messages', { text: 'Ещё один вопрос' });
        await context.db.query("UPDATE tickets SET waiting_since=now()-interval '73 hours' WHERE id=$1", [ticket.id]);
        await new WaitingTimers(context.db, context.c).run();
        expect((await context.ticket()).status).toBe('in_progress');
    });
});

describe('closing and reopening', () => {
    it('stops on close and starts a new resolution cycle on reopen', async () => {
        const ticket = await context.create();

        await context.command('assign');
        await moveClock(ticket.id, 'resolution', [30, 5]);
        await context.command('close');
        expect(await context.ticket()).toMatchObject({ sla_next_check_at: null, sla_breached: ['resolution'] });

        await context.input('8');
        await context.db.query('UPDATE tickets SET resolution_stage=2 WHERE id=$1', [ticket.id]);
        const reopened = await context.command('reopen', { reason: 'Снова не работает' });

        expect(reopened.resolution_stage).toBe(0);
        expect(minutesBetween(reopened.resolution_started_at, reopened.resolution_due_at)).toBe(960);
        expect(reopened.first_response_due_at).toEqual(ticket.first_response_due_at);
    });
});
