import { one, type Sql } from '../../shared/db.js';
import { emit } from '../../shared/events.js';

async function moveAttachment(
    tx: Sql,
    org: string,
    { id, from, to }: { id: string; from: string; to: string },
): Promise<void> {
    const file = await one<{ ticket_id: string }>(
        tx,
        'UPDATE attachments SET status=$4 WHERE org_id=$1 AND id=$2 AND status=$3 RETURNING ticket_id',
        [org, id, from, to],
    );

    if (file) {
        await emit(tx, org, {
            type: 'attachment.changed',
            ticketId: file.ticket_id,
            payload: { attachment_id: id, status: to },
        });
    }
}

export async function markDownloadFailed(tx: Sql, org: string, id: string): Promise<void> {
    await moveAttachment(tx, org, { id, from: 'pending', to: 'unavailable' });
}

export async function reopenDownload(tx: Sql, org: string, id: string): Promise<void> {
    await moveAttachment(tx, org, { id, from: 'unavailable', to: 'pending' });
}
