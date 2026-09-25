import { decrypt } from '../../../shared/crypto.js';
import type { InputAttachment } from '../../../shared/types/client-input.js';
import type { CliCommand } from '../cli-command.js';

export const mediaHostsCommand: CliCommand = async ({ db, config }) => {
    const { rows } = await db.query<{ source_ref: string }>(
        `SELECT source_ref FROM attachments
     WHERE org_id=$1 AND source_ref IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
        [config.ORG_ID],
    );

    const hosts = new Set(
        rows.flatMap(({ source_ref: sourceRef }) => {
            const { url } = decrypt<InputAttachment>(sourceRef, config.ENCRYPTION_KEY);

            return url ? [new URL(url).hostname] : [];
        }),
    );

    return hosts.size
        ? `Hosts of attachments waiting for download: ${[...hosts].join(',')}`
        : 'No attachments are waiting for download.';
};
