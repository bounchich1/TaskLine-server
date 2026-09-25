import { Readable } from 'node:stream';

import { mediaHosts } from '../../shared/config.js';
import { ticketHasValidConsent } from '../../shared/consent.js';
import { decrypt } from '../../shared/crypto.js';
import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { mediaFetch } from '../../shared/network.js';
import { maxTrustedRoots } from '../../shared/tls.js';
import type { InputAttachment } from '../../shared/types/client-input.js';

import type { Attachment, FileDeps } from './attachment.js';
import { sizeLimitFor } from './content-policy.js';
import { storeStream } from './store-stream.js';

export async function downloadInbound(deps: FileDeps, id: string): Promise<void> {
  const { db, ctx } = deps;
  const file = await one<Attachment>(db, 'SELECT * FROM attachments WHERE org_id=$1 AND id=$2', [
    ctx.org,
    id,
  ]);
  if (file?.status !== 'pending') {
    return;
  }
  if (!(await ticketHasValidConsent(db, file.ticket_id))) {
    await db.query("UPDATE attachments SET status='canceled',source_ref=NULL WHERE id=$1", [id]);
    return;
  }
  const source = decrypt<InputAttachment>(String(file.source_ref), ctx.config.ENCRYPTION_KEY);
  if (!source.url) {
    await db.query("UPDATE attachments SET status='unavailable' WHERE id=$1", [id]);
    return;
  }
  const media = await mediaFetch(
    source.url,
    mediaHosts(ctx.config),
    {},
    maxTrustedRoots(ctx.config),
  );
  try {
    ensure(media.response.ok && media.response.body, 'media_unavailable', 503);
    const size = Number(media.response.headers.get('content-length'));
    ensure(!size || size <= sizeLimitFor(file.kind), 'file_too_large', 422);
    await storeStream(deps, file, Readable.fromWeb(media.response.body as never));
  } finally {
    await media.close();
  }
}
