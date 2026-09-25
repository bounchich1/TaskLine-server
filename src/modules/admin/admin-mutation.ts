import { claimCommandKey, saveCommandResponse } from '../../shared/command-keys.js';
import { hash } from '../../shared/crypto.js';
import type { Database, Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { audit, emit } from '../../shared/events.js';
import { findActiveEmployee } from '../../shared/staff.js';
import type { Employee, Row } from '../../shared/types/entities.js';

export interface AdminMutation {
  actor: Employee;
  route: string;
  body: Row;
  expectedVersion: number;
  idempotencyKey: string;
}

export async function runAdminMutation(
  db: Database,
  org: string,
  mutation: AdminMutation,
  apply: (tx: Sql) => Promise<unknown>,
): Promise<unknown> {
  const { actor, route, body, expectedVersion: expected, idempotencyKey: key } = mutation;
  ensure(actor.role === 'admin', 'forbidden', 403);
  ensure(key.length >= 8 && key.length <= 128, 'idempotency_required', 422);
  return db.tx(async (tx) => {
    await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [org]);
    const active = await findActiveEmployee(tx, org, actor.id);
    ensure(active?.role === 'admin' && active.version === actor.version, 'forbidden', 403);
    const commandKey = { principal: actor.id, route, key };
    const claim = await claimCommandKey(tx, commandKey, hash(JSON.stringify({ expected, body })));
    if (claim.response) {
      return claim.response;
    }
    const result = await apply(tx);
    await audit(tx, org, {
      actor: actor.id,
      action: route,
      objectId: auditObjectId(body, org),
      detail: body,
    });
    await emit(tx, org, { type: 'admin.changed', ticketId: null, payload: { route } });
    await saveCommandResponse(tx, commandKey, result);
    return result;
  });
}

function auditObjectId(body: Row, org: string): string {
  const id = body.id ?? body.code;
  return typeof id === 'string' ? id : org;
}
