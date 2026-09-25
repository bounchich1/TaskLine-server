import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ensure } from '../../shared/errors.js';
import { enqueue } from '../../shared/events.js';

import type { Attachment, FileDeps } from './attachment.js';
import { sizeLimitFor } from './content-policy.js';
import { createTempFile } from './temp-file.js';

export async function storeStream(
  { db, ctx, storage }: FileDeps,
  file: Attachment,
  stream: Readable,
  isTruncated: () => boolean = () => false,
): Promise<void> {
  const temp = await createTempFile('max-file-');
  const limit = sizeLimitFor(file.kind);
  let bytes = 0;
  const digest = createHash('sha256');
  try {
    await pipeline(
      stream,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          digest.update(chunk);
          if (bytes > limit) {
            callback(new Error('file_too_large'));
          } else {
            callback(null, chunk);
          }
        },
      }),
      createWriteStream(temp.path, { mode: 0o600 }),
    );
    ensure(bytes > 0 && !isTruncated(), 'invalid_file', 422);
    const key = `${ctx.org}/${file.id}`;
    await storage.put(key, temp.path, 'application/octet-stream');
    await db.tx(async (tx) => {
      const changed = await tx.query(
        `UPDATE attachments SET object_key=$2,bytes=$3,sha256=$4,status='quarantined'
         WHERE id=$1 AND status IN('receiving','pending') RETURNING id`,
        [file.id, key, bytes, digest.digest('hex')],
      );
      if (changed.rows.length) {
        await enqueue(tx, ctx.org, { key: `scan:${file.id}`, kind: 'scan', refId: file.id });
      }
    });
  } finally {
    await temp.cleanup();
  }
}
