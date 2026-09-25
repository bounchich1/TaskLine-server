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
}

export async function emit(tx: Sql, org: string, event: UiEvent): Promise<void> {
    const { type, ticketId, payload = {}, employeeId } = event;

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

    if (employeeId) {
        await tx.query(
            `INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
            [org, employeeId, cursor, type, ticketId],
        );
    } else if (type === 'ticket.created') {
        await tx.query(
            `INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id)
       SELECT org_id,id,$2,$3,$4 FROM employees WHERE org_id=$1 AND NOT blocked
       ON CONFLICT DO NOTHING`,
            [org, cursor, type, ticketId],
        );
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
