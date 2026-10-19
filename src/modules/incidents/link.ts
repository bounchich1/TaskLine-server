import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';

import type { Incident } from './incident.js';

const LINKABLE = new Set(['open', 'in_progress']);

interface LinkRequest {
    incident: Incident;
    ticketIds: string[];
    actorId: string | null;
}

export interface LinkResult {
    linked: string[];
    skipped: { id: string; reason: string }[];
}

async function lockTicket(tx: Sql, org: string, ticketId: string): Promise<Ticket | undefined> {
    const ref = await one<{ client_id: string }>(tx, 'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2', [
        org,
        ticketId,
    ]);

    if (!ref) {
        return undefined;
    }

    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);

    return one<Ticket>(tx, 'SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [ticketId]);
}

async function otherIncident(tx: Sql, ticketId: string, incidentId: string): Promise<string | undefined> {
    const row = await one<{ incident_id: string }>(
        tx,
        `SELECT it.incident_id FROM incident_tickets it JOIN incidents i ON i.id=it.incident_id
     WHERE it.ticket_id=$1 AND i.status='open' AND it.incident_id<>$2 LIMIT 1`,
        [ticketId, incidentId],
    );

    return row?.incident_id;
}

export async function insertLink(
    tx: Sql,
    { incident, ticket, actorId, auto }: { incident: Incident; ticket: Ticket; actorId: string | null; auto: boolean },
): Promise<void> {
    await tx.query(
        `INSERT INTO incident_tickets(org_id,incident_id,ticket_id,linked_by,auto) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,
        [incident.org_id, incident.id, ticket.id, actorId, auto],
    );

    await tx.query(
        `UPDATE tickets SET offered_to=NULL,offered_at=NULL,offer_due_at=NULL,routed_at=coalesce(routed_at,now()),
       version=version+1,updated_at=now() WHERE id=$1`,
        [ticket.id],
    );
}

export async function linkTickets(
    tx: Sql,
    ctx: Ctx,
    { incident, ticketIds, actorId }: LinkRequest,
): Promise<LinkResult> {
    const result: LinkResult = { linked: [], skipped: [] };

    for (const id of [...new Set(ticketIds)].sort()) {
        const ticket = await lockTicket(tx, ctx.org, id);

        if (!ticket || !LINKABLE.has(ticket.status)) {
            result.skipped.push({ id, reason: ticket ? 'ticket_closed' : 'not_found' });
            continue;
        }

        if (await otherIncident(tx, id, incident.id)) {
            result.skipped.push({ id, reason: 'other_incident' });
            continue;
        }

        await insertLink(tx, { incident, ticket, actorId, auto: false });
        await emit(tx, ctx.org, { type: 'incident.linked', ticketId: id, payload: { incident_id: incident.id } });
        result.linked.push(id);
    }

    return result;
}

export async function unlinkTicket(
    tx: Sql,
    ctx: Ctx,
    { incident, ticketId }: { incident: Incident; ticketId: string },
): Promise<Ticket> {
    const ticket = await lockTicket(tx, ctx.org, ticketId);

    ensure(ticket, 'not_found', 404, 'Обращение не найдено.');

    const removed = await tx.query(
        'DELETE FROM incident_tickets WHERE incident_id=$1 AND ticket_id=$2 RETURNING ticket_id',
        [incident.id, ticketId],
    );

    ensure(removed.rows.length, 'not_linked', 409, 'Обращение не связано с этим инцидентом.');

    await tx.query(
        `UPDATE deliveries SET state='canceled',reason='incident_unlinked'
     WHERE ticket_id=$1 AND kind='incident' AND state IN('queued','retry_wait')`,
        [ticketId],
    );

    await tx.query(
        `UPDATE tickets SET routed_at=CASE WHEN status='open' AND assignee_id IS NULL THEN NULL ELSE routed_at END,
       ai_status=CASE WHEN ai_status='skipped' THEN 'failed' ELSE ai_status END,
       review_required=review_required OR ai_status='skipped',version=version+1,updated_at=now()
     WHERE id=$1`,
        [ticketId],
    );

    await emit(tx, ctx.org, { type: 'incident.unlinked', ticketId, payload: { incident_id: incident.id } });

    return ticket;
}

export interface IncidentMatch {
    incident: Incident;
    reply: boolean;
}

const MATCH = `SELECT i.*,s.auto_link AS reply FROM incidents i JOIN incident_settings s ON s.org_id=i.org_id
  WHERE i.org_id=$1 AND i.status='open' AND (
    (s.auto_link AND (
      EXISTS(SELECT 1 FROM unnest(i.match_terms) term WHERE length(term)>=3 AND strpos($2,replace(lower(term),'ё','е'))>0)
      OR EXISTS(SELECT 1 FROM incident_tickets it JOIN tickets x ON x.id=it.ticket_id
        WHERE it.incident_id=i.id AND NOT it.auto AND similarity(lower(x.description),$2)>=0.45)))
    OR EXISTS(SELECT 1 FROM incident_tickets it JOIN tickets x ON x.id=it.ticket_id
      WHERE it.incident_id=i.id AND x.client_id=$3 AND x.closed_at>now()-s.relink_hours*interval '1 hour'))
  ORDER BY i.opened_at DESC NULLS LAST LIMIT 1`;

export async function matchIncident(
    tx: Sql,
    ctx: Ctx,
    { client, text }: { client: Client; text: string },
): Promise<IncidentMatch | undefined> {
    const normalized = text.toLowerCase().replaceAll('ё', 'е');
    const row = await one<Incident & { reply: boolean }>(tx, MATCH, [ctx.org, normalized, client.id]);

    if (!row) {
        return undefined;
    }

    const { reply, ...incident } = row;

    return { incident: incident, reply };
}
