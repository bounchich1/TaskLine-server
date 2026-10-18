import { requireOne, type Sql } from './db.js';

export interface AuditEntry {
    actor: string | null;
    action: string;
    objectId: string;
    detail?: unknown;
}

export async function audit(tx: Sql, org: string, entry: AuditEntry): Promise<void> {
    const { actor, action, objectId, detail = {} } = entry;

    await tx.query('INSERT INTO audit(org_id,actor_id,action,object_id,detail) VALUES($1,$2,$3,$4,$5)', [
        org,
        actor,
        action,
        objectId,
        JSON.stringify(detail),
    ]);
}

export interface UiEvent {
    type: string;
    ticketId: string | null;
    payload?: unknown;
    employeeId?: string | null;
    employeeIds?: readonly string[];
    alerts?: boolean;
}

interface Fanout {
    cursor: unknown;
    type: string;
    ticketId: string | null;
    payload: string;
    recipients?: readonly string[];
}

const TOPIC_EVENTS = new Set(['ticket.created', 'ticket.classified']);

const TOPIC_SUBSCRIBERS = `INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id,payload)
  SELECT t.org_id,s.employee_id,$2,'ticket.created',t.id,'{"topic":true}'::jsonb
  FROM tickets t
  JOIN notification_settings s ON s.org_id=t.org_id AND s.new_tickets='topics' AND t.tag=ANY(s.topics)
  JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id AND NOT e.blocked
  WHERE t.org_id=$1 AND t.id=$3 AND t.status='open' AND t.assignee_id IS NULL AND t.ai_status<>'pending'
    AND NOT EXISTS(SELECT 1 FROM notifications n
      WHERE n.employee_id=s.employee_id AND n.ticket_id=t.id AND n.type='ticket.created')
  ON CONFLICT DO NOTHING RETURNING id`;

async function notify(tx: Sql, org: string, fanout: Fanout): Promise<string[]> {
    const { cursor, type, ticketId, payload, recipients } = fanout;
    const ids: string[] = [];

    const insert = async (sql: string, values: unknown[]) => {
        const { rows } = await tx.query<{ id: string }>(sql, values);

        ids.push(...rows.map((row) => row.id));
    };

    if (recipients) {
        await insert(
            `INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id,payload)
       SELECT $1,id,$2,$3,$4,$5 FROM employees WHERE org_id=$1 AND id=ANY($6::uuid[])
       ON CONFLICT DO NOTHING RETURNING id`,
            [org, cursor, type, ticketId, payload, recipients],
        );
    } else if (type === 'ticket.created') {
        await insert(
            `INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id,payload)
       SELECT e.org_id,e.id,$2,$3,$4,$5 FROM employees e
       LEFT JOIN notification_settings s ON s.org_id=e.org_id AND s.employee_id=e.id
       WHERE e.org_id=$1 AND NOT e.blocked AND coalesce(s.new_tickets,'all')='all'
       ON CONFLICT DO NOTHING RETURNING id`,
            [org, cursor, type, ticketId, payload],
        );
    }

    if (ticketId && TOPIC_EVENTS.has(type)) {
        await insert(TOPIC_SUBSCRIBERS, [org, cursor, ticketId]);
    }

    return ids;
}

async function enqueueAlerts(tx: Sql, org: string, notificationIds: string[]): Promise<void> {
    if (!notificationIds.length) {
        return;
    }

    await tx.query(
        `INSERT INTO jobs(org_id,logical_key,kind,ref_id)
     SELECT n.org_id,'notification-alert:'||n.id,'notification_alert',n.id FROM notifications n
     JOIN notification_settings s ON s.org_id=n.org_id AND s.employee_id=n.employee_id AND s.max_alerts
     JOIN employees e ON e.org_id=n.org_id AND e.id=n.employee_id AND NOT e.blocked AND e.activated_at IS NOT NULL
     WHERE n.org_id=$1 AND n.id=ANY($2::uuid[])
     ON CONFLICT DO NOTHING`,
        [org, notificationIds],
    );
}

export async function emit(tx: Sql, org: string, event: UiEvent): Promise<void> {
    const { type, ticketId, payload = {}, employeeId, employeeIds, alerts = true } = event;

    const { cursor } = await requireOne(tx, 'UPDATE organizations SET cursor=cursor+1 WHERE id=$1 RETURNING cursor', [
        org,
    ]);

    await tx.query('INSERT INTO ui_events(org_id,cursor,type,ticket_id,payload) VALUES($1,$2,$3,$4,$5)', [
        org,
        cursor,
        type,
        ticketId,
        JSON.stringify(payload),
    ]);

    const recipients = employeeIds ?? (employeeId ? [employeeId] : undefined);
    const notified = await notify(tx, org, { cursor, type, ticketId, payload: JSON.stringify(payload), recipients });

    if (alerts) {
        await enqueueAlerts(tx, org, notified);
    }
}

export interface BackgroundJob {
    key: string;
    kind: string;
    refId: string;
    payload?: unknown;
}

export async function enqueue(tx: Sql, org: string, job: BackgroundJob): Promise<void> {
    const { key, kind, refId, payload = {} } = job;

    await tx.query(
        `INSERT INTO jobs(org_id,logical_key,kind,ref_id,payload) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,
        [org, key, kind, refId, JSON.stringify(payload)],
    );
}
