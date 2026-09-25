import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import type { FileDeps } from './attachment.js';
import { publicAttachment } from './public-attachment.js';

export async function draftUploadStatus({ db, ctx }: FileDeps, { employeeId, id }: { employeeId: string; id: string }) {
    const row = await one(
        db,
        `SELECT * FROM attachments
     WHERE org_id=$1 AND id=$2 AND owner_id=$3 AND message_id IS NULL`,
        [ctx.org, id, employeeId],
    );

    ensure(row, 'not_found', 404);

    return publicAttachment(row);
}

export async function cancelDraftUpload(
    { db, ctx }: FileDeps,
    { employeeId, id }: { employeeId: string; id: string },
): Promise<void> {
    await db.query(
        `UPDATE attachments SET status='canceled'
     WHERE org_id=$1 AND id=$2 AND owner_id=$3 AND message_id IS NULL AND status<>'receiving'`,
        [ctx.org, id, employeeId],
    );
}
