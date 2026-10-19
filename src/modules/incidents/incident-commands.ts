import { z } from 'zod';

import { can, canOnTicket } from '../../shared/access.js';
import type { Ctx } from '../../shared/context.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';

import { ensureStatus, lockIncident, type Incident } from './incident.js';
import { linkTickets, unlinkTicket } from './link.js';
import { normalizeText } from './terms.js';
import { addUpdate, touch } from './updates.js';

const terms = z
    .array(z.string().trim().min(3).max(60))
    .max(20)
    .transform((items) => [
        ...new Map(items.map((item) => [normalizeText(item), item.replaceAll(/\s+/g, ' ')])).values(),
    ]);

const editable = {
    title: z.string().trim().min(1).max(120),
    public_message: z.string().trim().max(2000),
    match_terms: terms,
    request_rating: z.boolean(),
};

export const createBody = z
    .object({
        suggestion_id: z.uuid().optional(),
        tag: z.string().min(1).max(64),
        title: editable.title,
        public_message: editable.public_message.default(''),
        match_terms: terms.default([]),
        request_rating: editable.request_rating.default(false),
        eta: z.iso.datetime({ offset: true }).nullable().default(null),
        ticket_ids: z.array(z.uuid()).max(1000).default([]),
        notify: z.boolean().default(true),
    })
    .strict();

export const patchBody = z.object(editable).partial().strict();
export const linkBody = z.object({ ticket_ids: z.array(z.uuid()).min(1).max(1000) }).strict();

type CreateBody = z.infer<typeof createBody>;

async function ensureTopic(tx: Sql, org: string, tag: string): Promise<void> {
    const topic = await one(tx, "SELECT code FROM dictionaries WHERE org_id=$1 AND dimension='tag' AND code=$2", [
        org,
        tag,
    ]);

    ensure(topic, 'invalid_tag', 422, 'Тема не найдена.');
}

async function openSuggestion(tx: Sql, ctx: Ctx, { body, actor }: { body: CreateBody; actor: Employee }) {
    const suggestion = await lockIncident(tx, ctx.org, { id: body.suggestion_id ?? '' });

    ensureStatus(suggestion, ['suggested']);

    return requireOne<Incident>(
        tx,
        `UPDATE incidents SET status='open',title=$2,tag=$3,public_message=$4,match_terms=$5,request_rating=$6,eta=$7,
       created_by=$8,opened_at=now() WHERE id=$1 RETURNING *`,
        [
            suggestion.id,
            body.title,
            body.tag,
            body.public_message,
            body.match_terms,
            body.request_rating,
            body.eta,
            actor.id,
        ],
    );
}

async function insertIncident(tx: Sql, ctx: Ctx, { body, actor }: { body: CreateBody; actor: Employee }) {
    return requireOne<Incident>(
        tx,
        `INSERT INTO incidents(org_id,status,title,tag,public_message,match_terms,request_rating,eta,created_by,opened_at)
     VALUES($1,'open',$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
        [ctx.org, body.title, body.tag, body.public_message, body.match_terms, body.request_rating, body.eta, actor.id],
    );
}

export async function createIncident(tx: Sql, ctx: Ctx, { body, actor }: { body: CreateBody; actor: Employee }) {
    await ensureTopic(tx, ctx.org, body.tag);

    const incident = body.suggestion_id
        ? await openSuggestion(tx, ctx, { body, actor })
        : await insertIncident(tx, ctx, { body, actor });

    const result = await linkTickets(tx, ctx, { incident, ticketIds: body.ticket_ids, actorId: actor.id });

    await addUpdate(tx, ctx, {
        incident,
        kind: 'opened',
        text: body.public_message,
        authorId: actor.id,
        broadcast: body.notify,
        eta: body.eta,
    });

    return { incident: await touch(tx, incident.id), ...result };
}

export async function patchIncident(
    tx: Sql,
    ctx: Ctx,
    { id, expectedVersion, body }: { id: string; expectedVersion: number; body: z.infer<typeof patchBody> },
) {
    const incident = await lockIncident(tx, ctx.org, { id, expectedVersion });

    ensureStatus(incident, ['suggested', 'open', 'resolved']);

    await tx.query(
        `UPDATE incidents SET title=coalesce($2,title),public_message=coalesce($3,public_message),
       match_terms=coalesce($4,match_terms),request_rating=coalesce($5,request_rating) WHERE id=$1`,
        [id, body.title ?? null, body.public_message ?? null, body.match_terms ?? null, body.request_rating ?? null],
    );

    return touch(tx, id);
}

export async function dismissIncident(
    tx: Sql,
    ctx: Ctx,
    { id, expectedVersion, actorId }: { id: string; expectedVersion: number; actorId: string },
) {
    const incident = await lockIncident(tx, ctx.org, { id, expectedVersion });

    ensureStatus(incident, ['suggested']);
    await tx.query("UPDATE incidents SET status='dismissed',dismissed_at=now() WHERE id=$1", [id]);
    await addUpdate(tx, ctx, { incident, kind: 'dismissed', text: '', authorId: actorId, broadcast: false });

    return touch(tx, id);
}

export async function linkToIncident(
    tx: Sql,
    ctx: Ctx,
    { id, ticketIds, actorId }: { id: string; ticketIds: string[]; actorId: string },
) {
    const incident = await lockIncident(tx, ctx.org, { id });

    ensureStatus(incident, ['open']);
    const result = await linkTickets(tx, ctx, { incident, ticketIds, actorId });

    return { incident: await touch(tx, id), ...result };
}

export async function unlinkFromIncident(
    tx: Sql,
    ctx: Ctx,
    { id, ticketId, actor }: { id: string; ticketId: string; actor: Employee },
) {
    const incident = await lockIncident(tx, ctx.org, { id });

    const ticket = await one<{ assignee_id: string | null }>(
        tx,
        'SELECT assignee_id FROM tickets WHERE org_id=$1 AND id=$2',
        [ctx.org, ticketId],
    );

    ensure(ticket, 'not_found', 404, 'Обращение не найдено.');

    ensure(
        can(actor, 'incidents.manage') || canOnTicket(actor, ticket, 'classify'),
        'forbidden',
        403,
        'Отвязать можно только своё обращение.',
    );

    await unlinkTicket(tx, ctx, { incident, ticketId });

    return { incident: await touch(tx, id) };
}
