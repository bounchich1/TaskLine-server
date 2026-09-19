import { hash, token } from '../../shared/crypto.js';
import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Session } from '../../shared/types/session.js';

import type { Attachment, FileDeps } from './attachment.js';
import { safeFilename } from './content-policy.js';

const GRANT_LIFETIME_MS = 60000;

/** A clean attachment of a sent message, for download. */
export async function findSentAttachment({ db, ctx }: FileDeps, id: string): Promise<Attachment> {
  const row = await one<Attachment>(
    db,
    `SELECT a.* FROM attachments a JOIN tickets t ON t.id=a.ticket_id AND t.org_id=a.org_id
     WHERE a.org_id=$1 AND a.id=$2 AND a.status='clean' AND a.message_id IS NOT NULL`,
    [ctx.org, id],
  );
  ensure(row, 'not_found', 404);
  return row;
}

/**
 * A one-minute download link that needs no Authorization header, for downloads the browser
 * performs itself. It stops working with the session and with any change to the employee.
 */
export async function grantDownload(
  deps: FileDeps,
  { attachmentId, session }: { attachmentId: string; session: Session },
) {
  const { db, ctx } = deps;
  const attachment = await findSentAttachment(deps, attachmentId);
  const grant = token();
  await db.query(
    `INSERT INTO download_grants(hash,org_id,attachment_id,employee_id,session_hash)
     VALUES($1,$2,$3,$4,$5)`,
    [hash(grant), ctx.org, attachment.id, session.employee.id, session.hash],
  );
  return {
    url: `${ctx.config.PUBLIC_URL}/download/${grant}`,
    filename: safeFilename(attachment.filename),
    expires_at: new Date(Date.now() + GRANT_LIFETIME_MS).toISOString(),
  };
}

/** The attachment behind a live grant, if its session and employee are still valid. */
export async function redeemDownloadGrant(deps: FileDeps, grant: string): Promise<Attachment> {
  const { db, ctx } = deps;
  const record = await one<{ attachment_id: string }>(
    db,
    `SELECT g.attachment_id FROM download_grants g
     JOIN employees e ON e.id=g.employee_id AND e.org_id=g.org_id
     JOIN staff_sessions s ON s.hash=g.session_hash
     WHERE g.hash=$1 AND g.org_id=$2 AND g.expires_at>now() AND NOT e.blocked AND NOT s.revoked
     AND s.employee_version=e.version AND s.expires_at>now()`,
    [hash(grant), ctx.org],
  );
  ensure(record, 'not_found', 404);
  return findSentAttachment(deps, record.attachment_id);
}

/** Always a download (never rendered inline), with an RFC 5987 UTF-8 filename. */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(filename))}`;
}
