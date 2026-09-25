import type { Ctx } from '../../shared/context.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { audit, emit } from '../../shared/events.js';
import { canActOnTicket } from '../../shared/staff.js';
import type { Employee, Ticket } from '../../shared/types/entities.js';

import type { Delivery } from './delivery.js';

export interface ResolveRequest {
    employee: Employee;
    messageId: string;
    action: 'cancel' | 'retry';
    evidence?: string;
}

export async function resolveDelivery(tx: Sql, ctx: Ctx, request: ResolveRequest): Promise<{ state: string }> {
    const target = await lockForResolve(tx, ctx, request);

    assertResolvable(target, request);
    const { delivery, ticket, actor } = target;
    const { messageId, action, evidence } = request;
    const state = action === 'retry' ? 'queued' : 'canceled';

    await tx.query('UPDATE deliveries SET state=$2,due_at=now(),reason=NULL WHERE id=$1', [delivery.id, state]);
    await tx.query('UPDATE messages SET delivery_state=$2 WHERE id=$1', [messageId, state]);

    await audit(tx, ctx.org, {
        actor: actor.id,
        action: `delivery.${action}`,
        objectId: delivery.id,
        detail: {
            previous: delivery.state,
            evidence: evidence ?? null,
        },
    });

    await emit(tx, ctx.org, {
        type: 'delivery.changed',
        ticketId: ticket.id,
        payload: { message_id: messageId, state },
    });

    return { state };
}

interface ResolveTarget {
    delivery: Delivery;
    ticket: Ticket;
    actor: Employee;
}

async function lockForResolve(tx: Sql, ctx: Ctx, { employee, messageId }: ResolveRequest): Promise<ResolveTarget> {
    const ref = await one<Delivery>(tx, 'SELECT * FROM deliveries WHERE org_id=$1 AND message_id=$2', [
        ctx.org,
        messageId,
    ]);

    ensure(ref, 'not_found', 404);
    await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [ref.client_id]);

    const ticket = await one<Ticket>(tx, 'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE', [
        ctx.org,
        ref.ticket_id,
    ]);

    ensure(ticket, 'not_found', 404);

    const actor = await one<Employee>(tx, 'SELECT * FROM employees WHERE id=$1 AND org_id=$2 AND NOT blocked', [
        employee.id,
        ctx.org,
    ]);

    ensure(actor?.version === employee.version, 'forbidden', 403);
    ensure(canActOnTicket(actor, ticket), 'forbidden', 403);
    const delivery = await requireOne<Delivery>(tx, 'SELECT * FROM deliveries WHERE id=$1 FOR UPDATE', [ref.id]);

    return { delivery, ticket, actor };
}

function assertResolvable({ delivery, ticket, actor }: ResolveTarget, { action, evidence }: ResolveRequest): void {
    ensure(delivery.state !== 'sending' && delivery.state !== 'delivered', 'delivery_not_resolvable');

    if (delivery.state === 'unknown') {
        ensure(
            actor.role !== 'support' && typeof evidence === 'string' && evidence.trim().length >= 10,
            'operator_evidence_required',
            409,
            'Неизвестный результат: требуется проверка руководителем и подтверждение риска дубликата.',
        );
    }

    if (action === 'retry') {
        ensure(ticket.status === 'in_progress' && ['failed', 'unknown'].includes(delivery.state), 'retry_not_allowed');
    } else {
        ensure(['queued', 'retry_wait', 'failed', 'unknown'].includes(delivery.state), 'cancel_not_allowed');
    }
}
