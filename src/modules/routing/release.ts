import { one, type Sql } from '../../shared/db.js';
import { emit, recordTicketEvent } from '../../shared/events.js';

const CLEAR_OFFER = 'offered_to=NULL,offered_at=NULL,offer_due_at=NULL';

export interface Release {
    ticketId: string;
    employeeId: string;
    by: string | null;
    reason: 'released' | 'blocked' | 'shift_end' | 'team';
}

export async function releaseTicket(tx: Sql, org: string, release: Release): Promise<void> {
    await tx.query(
        `UPDATE tickets SET status='open',assignee_id=NULL,${CLEAR_OFFER},
       offer_skipped=CASE WHEN $3::uuid=ANY(offer_skipped) THEN offer_skipped ELSE array_append(offer_skipped,$3::uuid) END
     WHERE org_id=$1 AND id=$2`,
        [org, release.ticketId, release.employeeId],
    );

    await recordTicketEvent(tx, org, {
        ticketId: release.ticketId,
        employeeId: release.by,
        kind: 'released',
        detail: { from: release.employeeId, reason: release.reason },
    });
}

export async function clearOffer(tx: Sql, org: string, ticketId: string): Promise<void> {
    await tx.query(`UPDATE tickets SET ${CLEAR_OFFER},offer_skipped='{}' WHERE org_id=$1 AND id=$2`, [org, ticketId]);
}

async function lockTicket(
    tx: Sql,
    org: string,
    ticketId: string,
): Promise<{ status: string; assignee_id: string | null } | undefined> {
    const ref = await one<{ client_id: string }>(tx, 'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2', [
        org,
        ticketId,
    ]);

    if (!ref) {
        return undefined;
    }

    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);

    return one(tx, 'SELECT status,assignee_id FROM tickets WHERE id=$1 FOR UPDATE', [ticketId]);
}

export async function releaseEmployeeWork(
    tx: Sql,
    org: string,
    employeeId: string,
    by: string | null,
): Promise<number> {
    const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM tickets WHERE org_id=$1 AND (assignee_id=$2 AND status='in_progress' OR offered_to=$2)",
        [org, employeeId],
    );

    let released = 0;

    for (const { id } of rows) {
        const ticket = await lockTicket(tx, org, id);

        if (ticket?.status === 'in_progress' && ticket.assignee_id === employeeId) {
            await releaseTicket(tx, org, { ticketId: id, employeeId, by, reason: 'blocked' });
            released++;
        } else {
            await tx.query(`UPDATE tickets SET ${CLEAR_OFFER} WHERE id=$1 AND offered_to=$2`, [id, employeeId]);
        }

        await tx.query('UPDATE tickets SET version=version+1,updated_at=now() WHERE id=$1', [id]);
        await emit(tx, org, { type: 'ticket.updated', ticketId: id });
    }

    return released;
}

export async function withdrawOffers(tx: Sql, org: string, employeeId: string): Promise<void> {
    const { rows } = await tx.query<{ id: string }>(
        `UPDATE tickets SET ${CLEAR_OFFER},
       offer_skipped=CASE WHEN $2::uuid=ANY(offer_skipped) THEN offer_skipped ELSE array_append(offer_skipped,$2::uuid) END,
       version=version+1,updated_at=now()
     WHERE org_id=$1 AND offered_to=$2 RETURNING id`,
        [org, employeeId],
    );

    for (const { id } of rows) {
        await emit(tx, org, { type: 'ticket.updated', ticketId: id });
    }
}
