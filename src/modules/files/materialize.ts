import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { one } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import type { Attachment, FileDeps } from './attachment.js';
import { safeFilename } from './content-policy.js';
import { createTempFile } from './temp-file.js';

export interface MaterializedFile {
    path: string;
    kind: string;
    filename: string;
    mime: string;
    cleanup: () => Promise<void>;
}

export async function materialize({ db, ctx, storage }: FileDeps, id: string): Promise<MaterializedFile> {
    const file = await one<Attachment>(db, "SELECT * FROM attachments WHERE org_id=$1 AND id=$2 AND status='clean'", [
        ctx.org,
        id,
    ]);

    ensure(file?.object_key, 'attachment_not_ready', 422);
    const temp = await createTempFile('max-outbound-');

    try {
        await pipeline(await storage.read(file.object_key), createWriteStream(temp.path, { mode: 0o600 }));
    } catch (error) {
        await temp.cleanup();
        throw error;
    }

    return {
        path: temp.path,
        kind: file.kind,
        filename: safeFilename(file.filename),
        mime: file.mime ?? 'application/octet-stream',
        cleanup: temp.cleanup,
    };
}
