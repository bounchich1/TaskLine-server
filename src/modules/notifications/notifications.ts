import type { Sql } from '../../shared/db.js';

/** The employee's 100 most recent notifications, newest first. */
export async function listNotifications(db: Sql, org: string, employeeId: string) {
  const result = await db.query(
    `SELECT * FROM notifications WHERE org_id=$1 AND employee_id=$2
     ORDER BY created_at DESC LIMIT 100`,
    [org, employeeId],
  );
  return { items: result.rows };
}

/** Idempotent: the first read time is kept. */
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
