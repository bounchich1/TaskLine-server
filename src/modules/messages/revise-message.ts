import type { Ctx } from '../../shared/context.js';
import { encrypt } from '../../shared/crypto.js';
import { one, type Sql } from '../../shared/db.js';
import { audit, emit, enqueue } from '../../shared/events.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client, Message } from '../../shared/types/entities.js';
import { invalidateLearning } from '../learning/index.js';

export async function reviseClientMessage(tx: Sql, ctx: Ctx, client: Client, input: ClientInput): Promise<void> {
    if (client.consent_state !== 'granted') {
        return;
    }

    const message = await one<Message>(
        tx,
        `SELECT m.* FROM messages m JOIN tickets t ON t.id=m.ticket_id
     WHERE m.org_id=$1 AND t.client_id=$2 AND m.provider_ref=$3 AND m.author_type='client'
     FOR UPDATE OF m`,
        [ctx.org, client.id, input.messageId],
    );

    if (!message) {
        await deferRevision(tx, ctx, client, input);

        return;
    }

    const deleted = input.kind === 'delete';

    await tx.query(
        `INSERT INTO message_revisions(message_id,revision,encrypted_previous,source_key,deleted)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
            message.id,
            message.revision,
            encrypt({ text: message.text }, ctx.config.ENCRYPTION_KEY),
            input.sourceKey,
            deleted,
        ],
    );

    await tx.query('UPDATE messages SET text=$2,revision=revision+1,deleted=$3 WHERE id=$1', [
        message.id,
        deleted ? '' : (input.text ?? '').slice(0, 16000),
        deleted,
    ]);

    await tx.query(
        `UPDATE tickets SET suggestion_stale=true,version=version+1,
       description=CASE WHEN $2=1 THEN $3 ELSE description END
     WHERE id=$1`,
        [message.ticket_id, message.seq, deleted ? 'Сообщение удалено клиентом' : (input.text ?? '')],
    );

    await invalidateLearning(tx, ctx, message.ticket_id, 'message_changed');

    await emit(tx, ctx.org, {
        type: 'message.changed',
        ticketId: message.ticket_id,
        payload: { message_id: message.id },
    });
}

async function deferRevision(tx: Sql, ctx: Ctx, client: Client, input: ClientInput) {
    await audit(tx, ctx.org, {
        actor: null,
        action: 'message.deferred_revision',
        objectId: client.id,
        detail: {
            provider_ref: input.messageId,
            source_key: input.sourceKey,
        },
    });

    await enqueue(tx, ctx.org, {
        key: `revision:${input.sourceKey}`,
        kind: 'message_revision',
        refId: client.id,
        payload: {
            input: encrypt(input, ctx.config.ENCRYPTION_KEY),
        },
    });
}
