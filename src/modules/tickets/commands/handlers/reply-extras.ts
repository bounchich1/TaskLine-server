import { canOnTicket } from '../../../../shared/access.js';
import type { Ctx } from '../../../../shared/context.js';
import { one, type Sql } from '../../../../shared/db.js';
import { AppError, ensure } from '../../../../shared/errors.js';
import { enqueue, recordTicketEvent } from '../../../../shared/events.js';
import type { Message, Row } from '../../../../shared/types/entities.js';
import { useMacro, type Macro, type MacroActions } from '../../../macros/index.js';
import { pauseSla } from '../../../sla/index.js';
import type { TicketCommand } from '../command-context.js';
import { editRatio } from '../draft-ratio.js';

import { classify } from './classification.js';

const COLLISION_SECONDS = 60;

export async function assertNoCollision(tx: Sql, { actor, ticket, body }: TicketCommand): Promise<void> {
    const recent = await one<{ name: string }>(
        tx,
        `SELECT e.name FROM messages m JOIN employees e ON e.id=m.author_id
     WHERE m.ticket_id=$1 AND m.author_type='staff' AND m.visibility='client' AND m.author_id<>$2
       AND m.created_at>now()-$3*interval '1 second' ORDER BY m.seq DESC LIMIT 1`,
        [ticket.id, actor.id, COLLISION_SECONDS],
    );

    if (recent && body.confirm_collision !== true) {
        throw new AppError(
            'reply_collision',
            409,
            `${recent.name} ответил(а) клиенту меньше минуты назад. Отправить всё равно?`,
        );
    }
}

export async function recordCollision(tx: Sql, ctx: Ctx, { actor, ticket, body }: TicketCommand): Promise<void> {
    if (body.confirm_collision === true) {
        await recordTicketEvent(tx, ctx.org, { ticketId: ticket.id, employeeId: actor.id, kind: 'reply_collision' });
    }
}

export interface DraftInfo {
    draftOrigin: 'ai' | 'macro' | null;
    draftEditRatio: number | null;
    macro: Macro | null;
}

export async function draftInfo(tx: Sql, ctx: Ctx, command: TicketCommand, text: string): Promise<DraftInfo> {
    const { actor, ticket, body } = command;

    if (typeof body.macro_id === 'string') {
        const macro = await useMacro(tx, ctx.org, actor, body.macro_id);

        await recordTicketEvent(tx, ctx.org, {
            ticketId: ticket.id,
            employeeId: actor.id,
            kind: 'macro_used',
            detail: { macro_id: macro.id },
        });

        return { draftOrigin: 'macro', draftEditRatio: editRatio(macro.body, text), macro };
    }

    if (body.draft_origin !== 'ai') {
        return { draftOrigin: null, draftEditRatio: null, macro: null };
    }

    const reply = (ticket.suggestion as Row | null)?.customer_reply;

    return {
        draftOrigin: 'ai',
        draftEditRatio: typeof reply === 'string' ? editRatio(reply, text) : null,
        macro: null,
    };
}

async function applyClassification(tx: Sql, ctx: Ctx, command: TicketCommand, actions: MacroActions): Promise<void> {
    const { ticket } = command;

    const changes = Object.fromEntries(
        (['tag', 'urgency', 'complexity'] as const)
            .filter((field) => actions[field] && actions[field] !== ticket[field])
            .map((field) => [field, actions[field]]),
    );

    if (!Object.keys(changes).length || !canOnTicket(command.actor, ticket, 'classify')) {
        return;
    }

    const revisions = {
        tag: ticket.tag_revision,
        urgency: ticket.urgency_revision,
        complexity: ticket.complexity_revision,
    };

    await classify(tx, ctx, { ...command, body: { ...changes, revisions } });
}

export async function applyFollowUps(
    tx: Sql,
    ctx: Ctx,
    command: TicketCommand,
    follow: { message: Message; macro: Macro | null },
) {
    const { actor, ticket, body } = command;
    const actions = follow.macro?.actions ?? {};

    await applyClassification(tx, ctx, command, actions);

    if (actions.wait && !ticket.waiting_since) {
        await pauseSla(tx, ticket.id);
    }

    if (body.close_after === true || actions.close) {
        ensure(canOnTicket(actor, ticket, 'close'), 'forbidden', 403, 'Недостаточно прав, чтобы закрыть обращение.');

        await enqueue(tx, ctx.org, {
            key: `deferred-close:${follow.message.id}`,
            kind: 'deferred_close',
            refId: ticket.id,
            payload: { actor_id: actor.id, lifecycle: ticket.lifecycle, message_id: follow.message.id },
        });
    }
}
