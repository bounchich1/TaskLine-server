import type { Ctx } from '../../shared/context.js';
import { decrypt } from '../../shared/crypto.js';
import { one, type Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client, Job } from '../../shared/types/entities.js';

import { reviseClientMessage } from './revise-message.js';

export async function applyDeferredRevision(db: Database, ctx: Ctx, job: Job): Promise<void> {
    const input = decrypt<ClientInput>(job.payload.input as string, ctx.config.ENCRYPTION_KEY);

    const original = await one(db, 'SELECT id FROM messages WHERE org_id=$1 AND provider_ref=$2', [
        ctx.org,
        input.messageId,
    ]);

    if (!original) {
        throw new AppError('original_not_received', 503);
    }

    await db.tx(async (tx) => {
        const client = await one<Client>(tx, 'SELECT * FROM clients WHERE id=$1 AND org_id=$2 FOR UPDATE', [
            job.ref_id,
            ctx.org,
        ]);

        if (client) {
            await reviseClientMessage(tx, ctx, client, input);
        }
    });
}
