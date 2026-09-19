import { type Sql, one } from './db.js';
export async function audit(
  tx: Sql,
  org: string,
  actor: string | null,
  action: string,
  objectId: string,
  detail: unknown = {},
) {
  await tx.query(
    'INSERT INTO audit(org_id,actor_id,action,object_id,detail) VALUES($1,$2,$3,$4,$5)',
    [org, actor, action, objectId, JSON.stringify(detail)],
  );
}
export async function emit(
  tx: Sql,
  org: string,
  type: string,
  ticket: string | null,
  payload: unknown = {},
  employeeId?: string | null,
) {
  // Updating the row holds its cursor lock through COMMIT; sequence allocation alone is unsafe for replay.
  const row = await one(
    tx,
    'UPDATE organizations SET cursor=cursor+1 WHERE id=$1 RETURNING cursor',
    [org],
  );
  await tx.query(
    'INSERT INTO ui_events(org_id,cursor,type,ticket_id,payload) VALUES($1,$2,$3,$4,$5)',
    [org, row!.cursor, type, ticket, JSON.stringify(payload)],
  );
  if (employeeId) {
    await tx.query(
      'INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [org, employeeId, row!.cursor, type, ticket],
    );
  } else if (type === 'ticket.created') {
    await tx.query(
      'INSERT INTO notifications(org_id,employee_id,cursor,type,ticket_id) SELECT org_id,id,$2,$3,$4 FROM employees WHERE org_id=$1 AND NOT blocked ON CONFLICT DO NOTHING',
      [org, row!.cursor, type, ticket],
    );
  }
}
export async function enqueue(
  tx: Sql,
  org: string,
  key: string,
  kind: string,
  ref: string,
  payload: unknown = {},
) {
  await tx.query(
    'INSERT INTO jobs(org_id,logical_key,kind,ref_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [org, key, kind, ref, JSON.stringify(payload)],
  );
}
