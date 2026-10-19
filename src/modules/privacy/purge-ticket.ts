import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import { emit, enqueue } from '../../shared/events.js';
import { invalidateLearning } from '../learning/index.js';
import { refreshTicketFacts } from '../reports/index.js';

export type PurgeReason = 'retention' | 'erasure';

const PURGED_DESCRIPTION: Record<PurgeReason, string> = {
    retention: 'Данные удалены по истечении срока хранения',
    erasure: 'Данные удалены по запросу клиента',
};

const REMOVED_FILENAME = 'файл удалён';

const TICKET_JOBS = 'SELECT id FROM jobs WHERE ref_id=$1 OR ref_id IN(SELECT id FROM closures WHERE ticket_id=$1)';

export async function purgeTicketContent(tx: Sql, ctx: Ctx, ticketId: string, reason: PurgeReason): Promise<void> {
    await refreshTicketFacts(tx, ctx.org, [ticketId]);

    await tx.query(
        `UPDATE tickets SET description=$3,suggestion=NULL,suggestion_stale=false,purged_at=now(),purge_reason=$4,
       version=version+1,updated_at=now() WHERE org_id=$1 AND id=$2`,
        [ctx.org, ticketId, PURGED_DESCRIPTION[reason], reason],
    );

    await tx.query('DELETE FROM message_revisions WHERE message_id IN(SELECT id FROM messages WHERE ticket_id=$1)', [
        ticketId,
    ]);

    await tx.query("UPDATE messages SET text='',deleted=true WHERE ticket_id=$1", [ticketId]);
    await tx.query("UPDATE closures SET snapshot=NULL,snapshot_hash=NULL,note='' WHERE ticket_id=$1", [ticketId]);
    await tx.query("UPDATE notifications SET payload=payload-'comment' WHERE ticket_id=$1", [ticketId]);

    await tx.query(
        `UPDATE deliveries SET body='{}'::jsonb
     WHERE ticket_id=$1 AND state NOT IN('queued','sending','retry_wait','unknown')`,
        [ticketId],
    );

    await tx.query(`UPDATE ai_calls SET response=NULL WHERE job_id IN(${TICKET_JOBS})`, [ticketId]);
    await tx.query(`DELETE FROM ai_checkpoints WHERE job_id IN(${TICKET_JOBS})`, [ticketId]);
    await invalidateLearning(tx, ctx, ticketId, reason);
    await tx.query("UPDATE memory_records SET content='{}'::jsonb WHERE ticket_id=$1 AND state='deleted'", [ticketId]);
    await purgeAttachments(tx, ctx, ticketId);
    await emit(tx, ctx.org, { type: 'ticket.purged', ticketId });
}

async function purgeAttachments(tx: Sql, ctx: Ctx, ticketId: string): Promise<void> {
    const { rows } = await tx.query<{ id: string; object_key: string | null }>(
        `UPDATE attachments SET filename=$2,extraction=NULL,extraction_status='unsupported',
       status=CASE WHEN status='uploading' THEN status ELSE 'unavailable' END
     WHERE ticket_id=$1 RETURNING id,object_key`,
        [ticketId, REMOVED_FILENAME],
    );

    for (const attachment of rows.filter((row) => row.object_key)) {
        await enqueue(tx, ctx.org, {
            key: `attachment-purge:${attachment.id}`,
            kind: 'attachment_purge',
            refId: attachment.id,
        });
    }
}
