import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import type { FileDeps } from './attachment.js';
import { publicAttachment } from './public-attachment.js';

// An upload is a draft until a reply claims it (message_id set). Only its owner sees it.

/** Scan progress of the employee's draft upload, polled by the mini-app. */
export async function draftUploadStatus(
  { db, ctx }: FileDeps,
  { employeeId, id }: { employeeId: string; id: string },
) {
  const row = await one(
    db,
    `SELECT * FROM attachments
     WHERE org_id=$1 AND id=$2 AND owner_id=$3 AND message_id IS NULL`,
    [ctx.org, id, employeeId],
  );
  ensure(row, 'not_found', 404);
  return publicAttachment(row);
}

/** Discards a draft; one still receiving bytes is left for the upload to finish or fail. */
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
