import type { Sql } from '../../shared/db.js';
import type { Row } from '../../shared/types/entities.js';
import { ticketSummaries } from '../tickets/index.js';

const LIST_LIMIT = 200;

interface NotificationRow extends Row {
    ticket_id: string | null;
}

export async function listNotifications(db: Sql, org: string, employeeId: string) {
    const { rows } = await db.query<NotificationRow>(
        `SELECT n.id,n.type,n.ticket_id,n.read_at,n.created_at,n.payload,
       CASE WHEN n.type='message.from_client' AND NOT m.deleted THEN nullif(m.text,'') END AS preview,
       a.name AS actor_name
     FROM notifications n
     LEFT JOIN messages m ON m.org_id=n.org_id AND m.id=(n.payload->>'message_id')::uuid
     LEFT JOIN employees a ON a.org_id=n.org_id AND a.id=(n.payload->>'from')::uuid
     WHERE n.org_id=$1 AND n.employee_id=$2 ORDER BY n.created_at DESC,n.cursor DESC LIMIT ${LIST_LIMIT}`,
        [org, employeeId],
    );

    const ids = [...new Set(rows.flatMap((row) => (row.ticket_id ? [row.ticket_id] : [])))];
    const tickets = new Map((await ticketSummaries(db, org, ids)).map((ticket) => [String(ticket.id), ticket]));

    return { items: rows.map((row) => ({ ...row, ticket: tickets.get(row.ticket_id ?? '') ?? null })) };
}

export async function markNotificationRead(
    db: Sql,
    org: string,
    { employeeId, notificationId }: { employeeId: string; notificationId: string },
): Promise<void> {
    await db.query(
        `UPDATE notifications SET read_at=coalesce(read_at,now())
     WHERE org_id=$1 AND employee_id=$2 AND id=$3`,
        [org, employeeId, notificationId],
    );
}

export async function markTicketNotificationsRead(
    db: Sql,
    org: string,
    { employeeId, ticketId }: { employeeId: string; ticketId: string },
): Promise<number> {
    const { rowCount } = await db.query(
        `UPDATE notifications SET read_at=now()
     WHERE org_id=$1 AND employee_id=$2 AND ticket_id=$3 AND read_at IS NULL`,
        [org, employeeId, ticketId],
    );

    return rowCount ?? 0;
}
