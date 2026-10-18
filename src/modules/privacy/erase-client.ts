import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { audit } from '../../shared/events.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { currentPolicyVersion } from '../business/index.js';
import { clearPreconsentBuffers } from '../consent/index.js';
import { cancelClientDeliveries } from '../outbox/index.js';

import { purgeTicketContent } from './purge-ticket.js';

export interface ErasureResult {
    client_id: string;
    tickets: number;
    already_erased: boolean;
}

export async function eraseClient(
    tx: Sql,
    ctx: Ctx,
    { clientId, actorId }: { clientId: string; actorId: string },
): Promise<ErasureResult> {
    const client = await one<Client>(tx, 'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE', [
        ctx.org,
        clientId,
    ]);

    ensure(client, 'not_found', 404);

    if (client.erased_at) {
        return { client_id: client.id, tickets: 0, already_erased: true };
    }

    await clearPreconsentBuffers(tx, client.id);
    await tx.query('DELETE FROM callback_actions WHERE client_id=$1', [client.id]);
    await cancelClientDeliveries(tx, client.id);

    await tx.query(
        `UPDATE inbox SET state='discarded',reason='client_erased',payload=NULL,processed_at=now()
     WHERE client_id=$1 AND state='pending'`,
        [client.id],
    );

    const tickets = await purgeClientTickets(tx, ctx, client.id);

    await forgetClient(tx, ctx, client);
    await audit(tx, ctx.org, { actor: actorId, action: 'client.erased', objectId: client.id, detail: { tickets } });

    return { client_id: client.id, tickets, already_erased: false };
}

async function purgeClientTickets(tx: Sql, ctx: Ctx, clientId: string): Promise<number> {
    const { rows } = await tx.query<Ticket>(
        'SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 ORDER BY created_at FOR UPDATE',
        [ctx.org, clientId],
    );

    for (const ticket of rows) {
        if (ticket.status !== 'closed') {
            await tx.query(
                `UPDATE tickets SET status='closed',closed_at=coalesce(closed_at,now()),lifecycle=lifecycle+1,
           ai_status=CASE WHEN ai_status='pending' THEN 'failed' ELSE ai_status END WHERE id=$1`,
                [ticket.id],
            );
        }

        await purgeTicketContent(tx, ctx, ticket.id, 'erasure');
    }

    return rows.length;
}

async function forgetClient(tx: Sql, ctx: Ctx, client: Client): Promise<void> {
    await tx.query(
        `UPDATE clients SET max_user_id='erased:'||id,chat_id='',consent_state='withdrawn',
       consent_revision=consent_revision+1,erased_at=now() WHERE id=$1`,
        [client.id],
    );

    await tx.query(
        `INSERT INTO deletion_tombstones(org_id,client_id,consent_revision)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [ctx.org, client.id, client.consent_revision],
    );

    await tx.query("INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'erase',$3)", [
        ctx.org,
        client.id,
        client.consent_version ?? (await currentPolicyVersion(tx, ctx)),
    ]);
}
