import { z } from 'zod';

import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { audit } from '../../shared/events.js';

import { purgeTicketContent } from './purge-ticket.js';

export const retentionSchema = z
    .object({
        closed_ticket_days: z.number().int().min(30).max(3650).nullable(),
        audit_days: z.number().int().min(365).max(3650).nullable(),
    })
    .strict();

export type Retention = z.infer<typeof retentionSchema>;

const KEEP_FOREVER: Retention = { closed_ticket_days: null, audit_days: null };
const TICKETS_PER_RUN = 50;

export async function readRetention(db: Sql, org: string): Promise<Retention> {
    const row = await one(db, "SELECT settings->'retention' AS retention FROM organizations WHERE id=$1", [org]);
    const parsed = retentionSchema.safeParse(row?.retention);

    return parsed.success ? parsed.data : KEEP_FOREVER;
}

export async function applyRetention(tx: Sql, ctx: Ctx): Promise<number> {
    const retention = await readRetention(tx, ctx.org);
    const purged = retention.closed_ticket_days ? await purgeExpiredTickets(tx, ctx, retention.closed_ticket_days) : 0;

    if (retention.audit_days) {
        await tx.query("DELETE FROM audit WHERE org_id=$1 AND created_at<now()-$2*interval '1 day'", [
            ctx.org,
            retention.audit_days,
        ]);
    }

    return purged;
}

async function purgeExpiredTickets(tx: Sql, ctx: Ctx, days: number): Promise<number> {
    const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM tickets WHERE org_id=$1 AND status='closed' AND purged_at IS NULL
       AND closed_at<now()-$2*interval '1 day'
     ORDER BY closed_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [ctx.org, days, TICKETS_PER_RUN],
    );

    for (const { id } of rows) {
        await purgeTicketContent(tx, ctx, id, 'retention');
    }

    if (rows.length) {
        await audit(tx, ctx.org, {
            actor: null,
            action: 'retention.purged',
            objectId: ctx.org,
            detail: { tickets: rows.length, closed_ticket_days: days },
        });
    }

    return rows.length;
}
