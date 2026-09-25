import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { audit, emit } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { invalidateLearning } from '../learning/index.js';
import { cancelClientDeliveries, queueBotMessage } from '../outbox/index.js';

import { clearPreconsentBuffers } from './preconsent-buffers.js';

export async function withdrawConsent(tx: Sql, ctx: Ctx, client: Client, key: string): Promise<void> {
    if (client.consent_state !== 'withdrawn') {
        await recordWithdrawal(tx, ctx, client);
    }

    await clearPreconsentBuffers(tx, client.id);
    await tx.query('DELETE FROM callback_actions WHERE client_id=$1', [client.id]);
    await cancelClientDeliveries(tx, client.id);

    const tickets = (
        await tx.query<Ticket>('SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 FOR UPDATE', [
            ctx.org,
            client.id,
        ])
    ).rows;

    for (const ticket of tickets) {
        await tx.query(
            `UPDATE tickets SET status='closed',closed_at=coalesce(closed_at,now()),version=version+1,
         lifecycle=lifecycle+1,suggestion=NULL,
         ai_status=CASE WHEN ai_status='pending' THEN 'failed' ELSE ai_status END
       WHERE id=$1`,
            [ticket.id],
        );

        await invalidateLearning(tx, ctx, ticket.id, 'withdrawn');
        await emit(tx, ctx.org, { type: 'consent.withdrawn', ticketId: ticket.id });
    }

    await queueBotMessage(tx, ctx, {
        client,
        template: 'consent_withdrawn',
        key: `withdrawn:${key}`,
    });

    await audit(tx, ctx.org, { actor: null, action: 'consent.withdrawn', objectId: client.id });
}

async function recordWithdrawal(tx: Sql, ctx: Ctx, client: Client): Promise<void> {
    await tx.query("UPDATE clients SET consent_state='withdrawn',consent_revision=consent_revision+1 WHERE id=$1", [
        client.id,
    ]);

    await tx.query(
        `INSERT INTO deletion_tombstones(org_id,client_id,consent_revision)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [ctx.org, client.id, client.consent_revision],
    );

    await tx.query("INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'withdraw',$3)", [
        ctx.org,
        client.id,
        client.consent_version ?? ctx.config.POLICY_VERSION,
    ]);
}
