import type { Ctx } from '../../shared/context.js';
import { requireOne, type Sql } from '../../shared/db.js';
import { emit } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';
import { formatEta } from '../sla/index.js';

import type { Incident } from './incident.js';
import { insertLink, type IncidentMatch } from './link.js';
import { DEFAULT_ACK } from './terms.js';

async function incidentAck(tx: Sql, org: string, incident: Incident): Promise<string> {
    const base = incident.public_message.trim() || DEFAULT_ACK;

    if (!incident.eta) {
        return base;
    }

    const { timezone, now } = await requireOne<{ timezone: string; now: Date }>(
        tx,
        'SELECT timezone,now() AS now FROM organizations WHERE id=$1',
        [org],
    );

    const eta = new Date(incident.eta);

    return eta > new Date(now)
        ? `${base} Ожидаемое время восстановления — ${formatEta(eta, new Date(now), timezone)}.`
        : base;
}

export interface NewIncidentTicket {
    client: Client;
    ticket: Ticket;
    match: IncidentMatch;
}

export async function attachNewTicket(tx: Sql, ctx: Ctx, { client, ticket, match }: NewIncidentTicket): Promise<void> {
    const { incident, reply } = match;

    await insertLink(tx, { incident, ticket, actorId: null, auto: true });

    await tx.query("UPDATE tickets SET tag=$2,ai_status='skipped',review_required=false WHERE id=$1", [
        ticket.id,
        incident.tag,
    ]);

    if (reply) {
        await queueBotMessage(tx, ctx, {
            client,
            template: 'incident_known',
            key: `created:${ticket.id}`,
            ticket,
            values: { incident_message: await incidentAck(tx, ctx.org, incident) },
        });
    }

    await emit(tx, ctx.org, {
        type: 'incident.linked',
        ticketId: ticket.id,
        payload: { incident_id: incident.id, auto: true },
    });
}
