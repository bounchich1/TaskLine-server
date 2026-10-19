import type { Ctx } from '../../shared/context.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { emit, enqueue } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';
import { stopSla } from '../sla/index.js';

import type { Incident } from './incident.js';

export interface IncidentClosure {
    client: Client;
    ticket: Ticket;
    incident: Incident;
    authorId: string;
    note: string;
}

export async function hasWorkInFlight(tx: Sql, { client, ticket }: { client: Client; ticket: Ticket }) {
    const busy = await one(
        tx,
        `SELECT 1 AS busy WHERE EXISTS(SELECT 1 FROM deliveries WHERE ticket_id=$1 AND kind='staff'
       AND state IN('queued','retry_wait','sending','unknown'))
       OR EXISTS(SELECT 1 FROM inbox WHERE client_id=$2 AND state='pending')`,
        [ticket.id, client.id],
    );

    return Boolean(busy);
}

async function claimLearning(tx: Sql, incident: Incident, ticketId: string): Promise<boolean> {
    const claimed = await tx.query(
        'UPDATE incidents SET learning_ticket_id=$2 WHERE id=$1 AND learning_ticket_id IS NULL RETURNING id',
        [incident.id, ticketId],
    );

    return claimed.rows.length > 0;
}

export async function closeForIncident(tx: Sql, ctx: Ctx, closure: IncidentClosure): Promise<void> {
    const { client, ticket, incident, authorId, note } = closure;
    const rating = incident.request_rating;
    const learn = await claimLearning(tx, incident, ticket.id);

    const cycle = await requireOne<{ id: string }>(
        tx,
        `INSERT INTO closures(org_id,ticket_id,cycle_no,lifecycle,cutoff_seq,closed_by,reason,note,assignee_id,
       learning_status,finished_reason,reminder_created)
     SELECT $1,$2,coalesce(max(cycle_no),0)+1,$3,$4,$5,'incident',$6,$7,$8,$9,$10 FROM closures WHERE ticket_id=$2
     RETURNING id`,
        [
            ctx.org,
            ticket.id,
            ticket.lifecycle,
            ticket.last_message_seq,
            authorId,
            note,
            ticket.assignee_id,
            learn ? 'queued' : 'suppressed',
            rating ? null : 'incident',
            !rating,
        ],
    );

    await tx.query(
        `UPDATE tickets SET status=$2,closed_at=now(),closed_by=$3,current_cycle_id=$4,waiting_since=NULL,
       version=version+1,updated_at=now() WHERE id=$1`,
        [ticket.id, rating ? 'awaiting_rating' : 'closed', authorId, cycle.id],
    );

    await stopSla(tx, ticket.id);

    await queueBotMessage(tx, ctx, {
        client,
        template: rating ? 'ticket_closed' : 'incident_closed',
        key: `closed:${cycle.id}`,
        ticket,
        cycleId: rating ? cycle.id : undefined,
    });

    if (learn) {
        await enqueue(tx, ctx.org, {
            key: `learning:${cycle.id}`,
            kind: 'learning',
            refId: cycle.id,
            payload: { lifecycle: ticket.lifecycle, consent_revision: client.consent_revision },
        });
    }

    await emit(tx, ctx.org, {
        type: 'ticket.closed',
        ticketId: ticket.id,
        payload: { incident_id: incident.id },
        alerts: false,
    });
}
