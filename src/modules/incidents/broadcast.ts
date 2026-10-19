import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';
import type { Client, Job, Ticket } from '../../shared/types/entities.js';
import { addMessage } from '../messages/index.js';

import { closeForIncident, hasWorkInFlight } from './close-ticket.js';
import type { Incident } from './incident.js';

const BATCH = 50;
const PER_RUN = 1000;
const RETRY_AFTER_SECONDS = 5;
const FORCE_CLOSE_AFTER_MS = 30 * 60000;

type IncidentUpdate = {
    id: string;
    incident_id: string;
    kind: string;
    text: string;
    author_id: string | null;
    broadcast: boolean;
    finished_at: string | null;
    created_at: string;
} & Record<string, unknown>;

type Outcome = 'sent' | 'skipped' | 'gone';

interface TicketStep {
    update: IncidentUpdate;
    incident: Incident;
    ticketId: string;
    force: boolean;
}

const deliveryKey = (update: { id: string; incident_id: string }, ticketId: string) =>
    `incident:${update.incident_id}:${update.id}:${ticketId}`;

async function lockLinkedTicket(tx: Sql, ctx: Ctx, step: TicketStep) {
    const ref = await one<{ client_id: string }>(tx, 'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2', [
        ctx.org,
        step.ticketId,
    ]);

    if (!ref) {
        return undefined;
    }

    const client = await one<Client>(tx, 'SELECT * FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);

    const ticket = await one<Ticket>(
        tx,
        `SELECT t.* FROM tickets t JOIN incident_tickets it ON it.ticket_id=t.id AND it.incident_id=$2
     WHERE t.id=$1 AND t.status IN('open','in_progress') FOR UPDATE OF t`,
        [step.ticketId, step.incident.id],
    );

    return client && ticket ? { client, ticket } : undefined;
}

async function sendToTicket(tx: Sql, ctx: Ctx, step: TicketStep): Promise<Outcome> {
    const target = await lockLinkedTicket(tx, ctx, step);
    const { update, incident } = step;

    if (target?.client.consent_state !== 'granted') {
        return 'gone';
    }

    const { client, ticket } = target;
    const resolving = update.kind === 'resolved';

    if (resolving && !step.force && (await hasWorkInFlight(tx, target))) {
        return 'skipped';
    }

    if (update.text) {
        const message = await addMessage(tx, ctx, ticket, {
            author: 'staff',
            authorId: update.author_id,
            text: update.text,
            providerRef: null,
            state: 'queued',
        });

        await tx.query(
            `INSERT INTO deliveries(org_id,client_id,ticket_id,message_id,logical_key,kind,body,staff_id)
         VALUES($1,$2,$3,$4,$5,'incident',$6,$7) ON CONFLICT DO NOTHING`,
            [
                ctx.org,
                client.id,
                ticket.id,
                message.id,
                deliveryKey(update, ticket.id),
                JSON.stringify({ text: update.text }),
                update.author_id,
            ],
        );

        await emit(tx, ctx.org, {
            type: 'message.from_agent',
            ticketId: ticket.id,
            payload: { incident_id: incident.id },
        });
    }

    if (resolving && update.author_id) {
        await closeForIncident(tx, ctx, { client, ticket, incident, authorId: update.author_id, note: update.text });
    }

    return 'sent';
}

export class IncidentBroadcast {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async run(job: Job): Promise<boolean> {
        const update = await one<IncidentUpdate>(this.db, 'SELECT * FROM incident_updates WHERE org_id=$1 AND id=$2', [
            this.ctx.org,
            job.ref_id,
        ]);

        const incident =
            update && (await one<Incident>(this.db, 'SELECT * FROM incidents WHERE id=$1', [update.incident_id]));

        if (!update || !incident || update.finished_at) {
            return true;
        }

        const force = Date.now() - new Date(job.created_at).getTime() > FORCE_CLOSE_AFTER_MS;
        const { done, waiting } = await this.processBatches({ update, incident, force });

        if (!done) {
            return false;
        }

        if (waiting > 0) {
            throw Object.assign(new AppError('incident_waiting_delivery', 409), {
                retryAfterSeconds: RETRY_AFTER_SECONDS,
            });
        }

        await this.finish(update);

        return true;
    }

    private async processBatches({
        update,
        incident,
        force,
    }: Omit<TicketStep, 'ticketId'>): Promise<{ done: boolean; waiting: number }> {
        const passed: string[] = [];
        let waiting = 0;
        let processed = 0;

        while (processed < PER_RUN) {
            const { rows } = await this.db.query<{ id: string }>(
                `SELECT t.id FROM incident_tickets it JOIN tickets t ON t.id=it.ticket_id
         WHERE it.incident_id=$1 AND t.status IN('open','in_progress') AND NOT t.id=ANY($3::uuid[])
           AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.logical_key='incident:'||$1||':'||$2||':'||t.id)
         ORDER BY it.linked_at,t.id LIMIT ${BATCH}`,
                [incident.id, update.id, passed],
            );

            for (const { id } of rows) {
                const outcome = await this.db.tx(async (tx) =>
                    sendToTicket(tx, this.ctx, { update, incident, ticketId: id, force }),
                );

                if (outcome !== 'sent') {
                    passed.push(id);
                    waiting += outcome === 'skipped' ? 1 : 0;
                }
            }

            processed += rows.length;

            if (rows.length < BATCH) {
                return { done: true, waiting };
            }
        }

        return { done: false, waiting: 0 };
    }

    private async finish(update: IncidentUpdate): Promise<void> {
        await this.db.tx(async (tx) => {
            await tx.query(
                `UPDATE incident_updates SET finished_at=now(),recipients=(SELECT count(*) FROM deliveries
           WHERE org_id=$2 AND kind='incident' AND logical_key LIKE 'incident:'||$3||':'||$1||':%')
         WHERE id=$1`,
                [update.id, this.ctx.org, update.incident_id],
            );

            await emit(tx, this.ctx.org, {
                type: 'incident.changed',
                ticketId: null,
                payload: { incident_id: update.incident_id },
            });
        });
    }
}
