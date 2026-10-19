import { ensure } from '../../../../shared/errors.js';
import { emit } from '../../../../shared/events.js';
import { addMessage } from '../../../messages/index.js';
import type { TicketCommandHandler } from '../command-context.js';

const MAX_NOTE_LENGTH = 4000;

export const note: TicketCommandHandler = async (tx, ctx, command) => {
    const { actor, ticket, body } = command;

    ensure(!ticket.purged_at, 'ticket_purged', 409, 'Данные обращения удалены.');
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    ensure(text.length > 0 && text.length <= MAX_NOTE_LENGTH, 'invalid_message', 422);
    const requested = [...new Set((body.mention_ids ?? []) as string[])].filter((id) => id !== actor.id);

    const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM employees WHERE org_id=$1 AND id=ANY($2::uuid[]) AND NOT blocked',
        [ctx.org, requested],
    );

    const mentions = rows.map((row) => row.id);

    ensure(mentions.length === requested.length, 'invalid_employee', 422, 'Упомянутый сотрудник не найден.');

    const message = await addMessage(tx, ctx, ticket, {
        author: 'staff',
        authorId: actor.id,
        text,
        providerRef: null,
        state: 'internal',
        visibility: 'internal',
        learnable: body.learnable === true,
        mentions,
    });

    if (mentions.length) {
        await emit(tx, ctx.org, {
            type: 'note.mention',
            ticketId: ticket.id,
            payload: { from: actor.id, message_id: message.id },
            employeeIds: mentions,
        });
    }
};
