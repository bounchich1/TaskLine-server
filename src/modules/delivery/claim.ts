import { canOnTicket } from '../../shared/access.js';
import type { Ctx } from '../../shared/context.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { findActiveEmployee } from '../../shared/staff.js';
import type { Client, Ticket } from '../../shared/types/entities.js';

import type { Delivery } from './delivery.js';

export interface ClaimedDelivery {
    delivery: Delivery;
    client: Client;
}

export async function claimNextDelivery(tx: Sql, ctx: Ctx, clientId: string): Promise<ClaimedDelivery | null> {
    const client = await one<Client>(tx, 'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE', [
        ctx.org,
        clientId,
    ]);

    if (!client) {
        return null;
    }

    const head = await findDueHead(tx, ctx, client);

    if (!head) {
        return null;
    }

    if (!(await isStillAuthorized(tx, ctx, head, client))) {
        await cancelUnauthorized(tx, head);

        return null;
    }

    return { delivery: await markSending(tx, head, client), client };
}

async function findDueHead(tx: Sql, ctx: Ctx, client: Client): Promise<Delivery | undefined> {
    const head = await one<Delivery>(
        tx,
        `SELECT * FROM deliveries WHERE org_id=$1 AND client_id=$2
     AND state IN('queued','retry_wait','sending','unknown') ORDER BY chat_seq LIMIT 1 FOR UPDATE`,
        [ctx.org, client.id],
    );

    if (!head || head.state === 'sending' || head.state === 'unknown') {
        return undefined;
    }

    const due = await one(
        tx,
        `SELECT id FROM deliveries WHERE id=$1 AND due_at<=now()
     AND ($2::timestamptz IS NULL OR $2::timestamptz<=now()-interval '550 milliseconds')`,
        [head.id, client.last_send_at ?? null],
    );

    return due ? head : undefined;
}

async function isStillAuthorized(tx: Sql, ctx: Ctx, head: Delivery, client: Client): Promise<boolean> {
    let valid = true;

    if (head.kind === 'staff') {
        const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE org_id=$1 AND id=$2', [
            ctx.org,
            head.ticket_id,
        ]);

        const employee = await findActiveEmployee(tx, ctx.org, head.staff_id);

        valid =
            !!ticket &&
            !!employee &&
            ticket.status === 'in_progress' &&
            client.consent_state === 'granted' &&
            employee.version === head.staff_version &&
            canOnTicket(employee, ticket, 'reply');
    }

    if (head.cycle_id && valid) {
        valid = !!(await one(
            tx,
            `SELECT t.id FROM tickets t JOIN closures c ON c.id=t.current_cycle_id
       WHERE t.id=$1 AND c.id=$2 AND NOT c.invalidated AND t.status='awaiting_rating'
       AND c.expires_at>now()`,
            [head.ticket_id, head.cycle_id],
        ));
    }

    return valid;
}

async function cancelUnauthorized(tx: Sql, head: Delivery): Promise<void> {
    await tx.query("UPDATE deliveries SET state='canceled',reason='authorization_changed' WHERE id=$1", [head.id]);

    if (head.message_id) {
        await tx.query("UPDATE messages SET delivery_state='canceled' WHERE id=$1", [head.message_id]);
    }
}

async function markSending(tx: Sql, head: Delivery, client: Client): Promise<Delivery> {
    const delivery = await requireOne<Delivery>(
        tx,
        `UPDATE deliveries SET state='sending',attempts=attempts+1,generation=generation+1,
     started_at=now() WHERE id=$1 RETURNING *`,
        [head.id],
    );

    await tx.query('UPDATE clients SET last_send_at=now() WHERE id=$1', [client.id]);

    if (head.message_id) {
        await tx.query("UPDATE messages SET delivery_state='sending' WHERE id=$1", [head.message_id]);
    }

    return delivery;
}
