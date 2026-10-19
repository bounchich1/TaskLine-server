import { z } from 'zod';

import type { Ctx } from '../../shared/context.js';
import { requireOne, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { enqueue } from '../../shared/events.js';
import { formatEta } from '../sla/index.js';

import { readIncidentSettings } from './incident-settings.js';
import { ensureStatus, lockIncident, type Incident } from './incident.js';
import { linkTickets } from './link.js';

const text = z.string().trim().max(2000);

export const messageBody = z.object({ text: text.min(1) }).strict();

export const etaBody = z
    .object({
        eta: z.iso.datetime({ offset: true }).nullable(),
        text: text.optional(),
        notify: z.boolean().default(true),
    })
    .strict();

export const resolveBody = z.object({ text: text.min(1), request_rating: z.boolean().optional() }).strict();
export const reopenBody = z.object({ text: text.optional() }).strict();

type UpdateKind = 'opened' | 'message' | 'eta' | 'resolved' | 'reopened' | 'dismissed';

export interface NewUpdate {
    incident: Incident;
    kind: UpdateKind;
    text: string;
    authorId: string;
    broadcast: boolean;
    eta?: string | null;
}

export async function addUpdate(tx: Sql, ctx: Ctx, update: NewUpdate): Promise<string> {
    const broadcast = update.broadcast && update.text.trim().length > 0;

    const row = await requireOne<{ id: string }>(
        tx,
        `INSERT INTO incident_updates(org_id,incident_id,kind,text,eta,author_id,broadcast)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.org, update.incident.id, update.kind, update.text, update.eta ?? null, update.authorId, broadcast],
    );

    if (broadcast || update.kind === 'resolved') {
        await enqueue(tx, ctx.org, { key: `incident-broadcast:${row.id}`, kind: 'incident_broadcast', refId: row.id });
    }

    return row.id;
}

interface Change<T> {
    id: string;
    expectedVersion?: number;
    body: T;
    actorId: string;
}

export async function postMessage(tx: Sql, ctx: Ctx, change: Change<z.infer<typeof messageBody>>) {
    const incident = await lockIncident(tx, ctx.org, change);

    ensureStatus(incident, ['open']);

    await addUpdate(tx, ctx, {
        incident,
        kind: 'message',
        text: change.body.text,
        authorId: change.actorId,
        broadcast: true,
    });

    return touch(tx, incident.id);
}

async function etaText(tx: Sql, org: string, eta: string | null): Promise<string> {
    if (!eta) {
        return 'Сроки восстановления уточняются. Сообщим, как только появится информация.';
    }

    const { timezone, now } = await requireOne<{ timezone: string; now: Date }>(
        tx,
        'SELECT timezone,now() AS now FROM organizations WHERE id=$1',
        [org],
    );

    return `Ожидаемое время восстановления — ${formatEta(new Date(eta), new Date(now), timezone)}.`;
}

export async function changeEta(tx: Sql, ctx: Ctx, change: Change<z.infer<typeof etaBody>>) {
    const incident = await lockIncident(tx, ctx.org, change);
    const { eta, notify } = change.body;

    ensureStatus(incident, ['open']);
    await tx.query('UPDATE incidents SET eta=$2 WHERE id=$1', [incident.id, eta]);
    const message = change.body.text?.length ? change.body.text : await etaText(tx, ctx.org, eta);

    await addUpdate(tx, ctx, {
        incident,
        kind: 'eta',
        text: message,
        authorId: change.actorId,
        broadcast: notify,
        eta,
    });

    return touch(tx, incident.id);
}

export async function resolveIncident(tx: Sql, ctx: Ctx, change: Change<z.infer<typeof resolveBody>>) {
    const incident = await lockIncident(tx, ctx.org, change);
    const { text: finalMessage, request_rating: rating } = change.body;

    ensureStatus(incident, ['open']);

    await tx.query(
        `UPDATE incidents SET status='resolved',resolved_at=now(),final_message=$2,
       request_rating=coalesce($3,request_rating) WHERE id=$1`,
        [incident.id, finalMessage, rating ?? null],
    );

    await addUpdate(tx, ctx, {
        incident,
        kind: 'resolved',
        text: finalMessage,
        authorId: change.actorId,
        broadcast: true,
    });

    return touch(tx, incident.id);
}

export async function reopenIncident(tx: Sql, ctx: Ctx, change: Change<z.infer<typeof reopenBody>>) {
    const incident = await lockIncident(tx, ctx.org, change);

    ensureStatus(incident, ['resolved']);

    ensure(
        !(await pendingResolution(tx, incident.id)),
        'incident_resolving',
        409,
        'Инцидент ещё закрывает обращения. Повторите через минуту.',
    );

    await tx.query("UPDATE incidents SET status='open',resolved_at=NULL WHERE id=$1", [incident.id]);
    const reopened = { ...incident, status: 'open' as const };

    await addUpdate(tx, ctx, {
        incident: reopened,
        kind: 'reopened',
        text: change.body.text ?? '',
        authorId: change.actorId,
        broadcast: Boolean(change.body.text),
    });

    await linkTickets(tx, ctx, {
        incident: reopened,
        ticketIds: await returningClientTickets(tx, ctx.org, incident.id),
        actorId: change.actorId,
    });

    return touch(tx, incident.id);
}

async function pendingResolution(tx: Sql, incidentId: string): Promise<boolean> {
    const { rows } = await tx.query(
        "SELECT id FROM incident_updates WHERE incident_id=$1 AND kind='resolved' AND finished_at IS NULL LIMIT 1",
        [incidentId],
    );

    return rows.length > 0;
}

async function returningClientTickets(tx: Sql, org: string, incidentId: string): Promise<string[]> {
    const { relink_hours: hours } = await readIncidentSettings(tx, org);

    const { rows } = await tx.query<{ id: string }>(
        `SELECT t.id FROM tickets t WHERE t.org_id=$1 AND t.status IN('open','in_progress')
       AND t.client_id IN(SELECT x.client_id FROM incident_tickets it JOIN tickets x ON x.id=it.ticket_id
         WHERE it.incident_id=$2 AND x.closed_at>now()-$3*interval '1 hour')
       AND NOT EXISTS(SELECT 1 FROM incident_tickets it WHERE it.ticket_id=t.id AND it.incident_id=$2)`,
        [org, incidentId, hours],
    );

    return rows.map((row) => row.id);
}

export async function touch(tx: Sql, id: string): Promise<Incident> {
    return requireOne<Incident>(tx, 'UPDATE incidents SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [
        id,
    ]);
}
