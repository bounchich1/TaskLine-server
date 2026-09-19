import type { Readable } from 'node:stream';

import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { canActOnTicket } from '../../shared/staff.js';
import type { Employee, Ticket } from '../../shared/types/entities.js';

import type { Attachment, FileDeps } from './attachment.js';
import { safeFilename } from './content-policy.js';
import { storeStream } from './store-stream.js';

// Staff attachments are uploaded in three steps: prepare a slot, upload the bytes, then poll
// until the scan marks it clean. Only then can it be attached to a reply.

export async function prepareUpload(
  { db, ctx }: FileDeps,
  employee: Employee,
  upload: { ticketId: string; filename: string; kind: string },
) {
  return db.tx(async (tx) => {
    const ticket = await one<Ticket>(
      tx,
      'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE',
      [ctx.org, upload.ticketId],
    );
    ensure(ticket, 'not_found', 404);
    ensure(ticket.status === 'in_progress' && canActOnTicket(employee, ticket), 'forbidden', 403);
    return one(
      tx,
      `INSERT INTO attachments(org_id,ticket_id,owner_id,filename,kind)
       VALUES($1,$2,$3,$4,$5) RETURNING id,status`,
      [ctx.org, upload.ticketId, employee.id, safeFilename(upload.filename), upload.kind],
    );
  });
}

export async function receiveUpload(
  deps: FileDeps,
  employee: Employee,
  upload: { id: string; stream: Readable; isTruncated?: () => boolean },
) {
  const { db, ctx } = deps;
  const { id } = upload;
  const file = await db.tx(async (tx) => {
    const slot = await one<Attachment>(
      tx,
      `SELECT * FROM attachments
       WHERE id=$1 AND org_id=$2 AND owner_id=$3 AND message_id IS NULL AND status='uploading'
         AND expires_at>now()
       FOR UPDATE`,
      [id, ctx.org, employee.id],
    );
    ensure(slot, 'invalid_upload', 409);
    await tx.query("UPDATE attachments SET status='receiving' WHERE id=$1", [id]);
    return slot;
  });
  try {
    await storeStream(deps, file, upload.stream, upload.isTruncated);
  } catch (error) {
    await db.query("UPDATE attachments SET status='failed' WHERE id=$1", [id]);
    throw error;
  }
  return { id, status: 'quarantined' };
}
