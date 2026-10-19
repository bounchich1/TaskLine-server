import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import { audit, emit } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';
import { stopSla } from '../sla/index.js';

const BATCH = 100;

const DUE_CONDITION = `t.waiting_since IS NOT NULL AND t.status='in_progress' AND (
    (s.waiting_close_hours>0 AND t.waiting_since<=now()-s.waiting_close_hours*interval '1 hour')
    OR (s.waiting_reminder_hours>0 AND NOT t.waiting_reminded
      AND t.waiting_since<=now()-s.waiting_reminder_hours*interval '1 hour'))`;

interface WaitingTicket {
    client: Client;
    ticket: Ticket;
}

export class WaitingTimers {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async run(): Promise<void> {
        const { rows } = await this.db.query<{ id: string; client_id: string }>(
            `SELECT t.id,t.client_id FROM tickets t JOIN sla_settings s ON s.org_id=t.org_id
       WHERE t.org_id=$1 AND ${DUE_CONDITION} ORDER BY t.waiting_since LIMIT ${BATCH}`,
            [this.ctx.org],
        );

        for (const row of rows) {
            await this.db.tx(async (tx) => processWaiting(tx, this.ctx, row));
        }
    }
}

async function processWaiting(tx: Sql, ctx: Ctx, { id, client_id: clientId }: { id: string; client_id: string }) {
    const client = await requireOne<Client>(tx, 'SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId]);

    const ticket = await one<Ticket & { close_due: boolean }>(
        tx,
        `SELECT t.*,(s.waiting_close_hours>0 AND t.waiting_since<=now()-s.waiting_close_hours*interval '1 hour')
         AS close_due
     FROM tickets t JOIN sla_settings s ON s.org_id=t.org_id WHERE t.id=$1 AND ${DUE_CONDITION} FOR UPDATE OF t`,
        [id],
    );

    if (!ticket) {
        return;
    }

    if (ticket.close_due) {
        await autoClose(tx, ctx, { client, ticket });

        return;
    }

    await tx.query('UPDATE tickets SET waiting_reminded=true WHERE id=$1', [ticket.id]);

    await queueBotMessage(tx, ctx, {
        client,
        template: 'waiting_reminder',
        key: `waiting-reminder:${ticket.id}:${new Date(ticket.waiting_since ?? 0).getTime()}`,
        ticket,
    });
}

async function hasWorkInFlight(tx: Sql, { client, ticket }: WaitingTicket): Promise<boolean> {
    const pending = await one(
        tx,
        `SELECT 1 AS busy WHERE EXISTS(SELECT 1 FROM deliveries WHERE ticket_id=$1 AND kind='staff'
       AND state IN('queued','retry_wait','sending','unknown'))
       OR EXISTS(SELECT 1 FROM inbox WHERE client_id=$2 AND state='pending')`,
        [ticket.id, client.id],
    );

    return Boolean(pending);
}

async function autoClose(tx: Sql, ctx: Ctx, { client, ticket }: WaitingTicket): Promise<void> {
    if (await hasWorkInFlight(tx, { client, ticket })) {
        return;
    }

    const cycle = await requireOne<{ id: string }>(
        tx,
        `INSERT INTO closures(org_id,ticket_id,cycle_no,lifecycle,cutoff_seq,closed_by,reason,reminder_created,
       finished_reason,learning_status,assignee_id)
     SELECT $1,$2,coalesce(max(cycle_no),0)+1,$3,$4,$5,'auto',true,'auto_closed','suppressed',$5
     FROM closures WHERE ticket_id=$2 RETURNING id`,
        [ctx.org, ticket.id, ticket.lifecycle, ticket.last_message_seq, ticket.assignee_id],
    );

    await stopSla(tx, ticket.id);

    await tx.query(
        `UPDATE tickets SET status='closed',closed_at=now(),closed_by=assignee_id,current_cycle_id=$2,
       version=version+1,updated_at=now() WHERE id=$1`,
        [ticket.id, cycle.id],
    );

    await queueBotMessage(tx, ctx, {
        client,
        template: 'auto_closed',
        key: `auto-closed:${cycle.id}`,
        ticket,
        cycleId: cycle.id,
    });

    await audit(tx, ctx.org, { actor: null, action: 'ticket.auto_close', objectId: ticket.id });

    await emit(tx, ctx.org, {
        type: 'ticket.auto_closed',
        ticketId: ticket.id,
        employeeId: ticket.assignee_id,
    });
}
