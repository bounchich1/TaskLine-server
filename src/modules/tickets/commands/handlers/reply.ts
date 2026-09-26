import type { Ctx } from '../../../../shared/context.js';
import { type Sql, one } from '../../../../shared/db.js';
import { ensure } from '../../../../shared/errors.js';
import type { Employee, Ticket } from '../../../../shared/types/entities.js';
import { addMessage } from '../../../messages/index.js';
import { queueStaffReply } from '../../../outbox/index.js';
import type { TicketCommandHandler } from '../command-context.js';

const MAX_REPLY_LENGTH = 4000;
const MAX_REPLY_ATTACHMENTS = 10;

export const reply: TicketCommandHandler = async (tx, ctx, command) => {
    const { actor, client, ticket, body } = command;

    ensure(ticket.status === 'in_progress', 'ticket_closed');
    const text = ((body.text as string | undefined) ?? '').trim();
    const ids = (body.attachment_ids ?? []) as string[];

    ensure(text.length <= MAX_REPLY_LENGTH && (text.length > 0 || ids.length > 0), 'invalid_message', 422);
    ensure(ids.length <= MAX_REPLY_ATTACHMENTS && new Set(ids).size === ids.length, 'invalid_attachments', 422);
    await lockReadyUploads(tx, ctx, { ids, ticket, actor });

    const message = await addMessage(tx, ctx, ticket, {
        author: 'staff',
        authorId: actor.id,
        text,
        providerRef: null,
        state: 'queued',
    });

    for (const id of ids) {
        await tx.query('UPDATE attachments SET message_id=$2 WHERE id=$1', [id, message.id]);
    }

    await queueStaffReply(tx, ctx, { client, ticket, message, actor, text, attachmentIds: ids });
};

async function lockReadyUploads(
    tx: Sql,
    ctx: Ctx,
    { ids, ticket, actor }: { ids: string[]; ticket: Ticket; actor: Employee },
): Promise<void> {
    for (const id of ids) {
        const upload = await one(
            tx,
            `SELECT * FROM attachments
       WHERE org_id=$1 AND id=$2 AND ticket_id=$3 AND owner_id=$4 AND message_id IS NULL
         AND status='clean' AND expires_at>now()
       FOR UPDATE`,
            [ctx.org, id, ticket.id, actor.id],
        );

        ensure(upload, 'attachment_not_ready', 422);
    }
}
