import { z } from 'zod';

import { one, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { emit } from '../../shared/events.js';

export const presenceBody = z.object({ presence: z.enum(['online', 'break', 'offline']) }).strict();

export type Presence = z.infer<typeof presenceBody>['presence'];

const CONNECTION_GRACE = "interval '2 minutes'";

async function logPresence(tx: Sql, org: string, employeeId: string, presence: Presence): Promise<void> {
    await tx.query('INSERT INTO presence_log(org_id,employee_id,presence) VALUES($1,$2,$3)', [
        org,
        employeeId,
        presence,
    ]);

    await emit(tx, org, { type: 'presence.changed', ticketId: null, payload: { employee_id: employeeId, presence } });
}

export async function setPresence(db: Database, org: string, employeeId: string, presence: Presence) {
    return db.tx(async (tx) => {
        const current = await one<{ presence: Presence }>(
            tx,
            'SELECT presence FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked FOR UPDATE',
            [org, employeeId],
        );

        ensure(current, 'not_found', 404);

        if (current.presence !== presence) {
            await tx.query(
                'UPDATE employees SET presence=$3,presence_at=now(),presence_seen_at=now() WHERE org_id=$1 AND id=$2',
                [org, employeeId, presence],
            );

            await logPresence(tx, org, employeeId, presence);
        } else {
            await tx.query('UPDATE employees SET presence_seen_at=now() WHERE org_id=$1 AND id=$2', [org, employeeId]);
        }

        return one(
            tx,
            `SELECT e.presence,e.presence_at,
         (SELECT count(*)::int FROM tickets t WHERE t.org_id=e.org_id AND t.assignee_id=e.id AND t.status='in_progress')
           AS active
       FROM employees e WHERE e.org_id=$1 AND e.id=$2`,
            [org, employeeId],
        );
    });
}

export async function touchPresence(db: Sql, org: string, employeeId: string): Promise<void> {
    await db.query("UPDATE employees SET presence_seen_at=now() WHERE org_id=$1 AND id=$2 AND presence<>'offline'", [
        org,
        employeeId,
    ]);
}

export async function expirePresence(db: Database, org: string): Promise<number> {
    return db.tx(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
            `UPDATE employees SET presence='offline',presence_at=now()
       WHERE org_id=$1 AND presence<>'offline'
         AND (blocked OR coalesce(presence_seen_at,presence_at,'-infinity')<now()-${CONNECTION_GRACE})
       RETURNING id`,
            [org],
        );

        for (const { id } of rows) {
            await logPresence(tx, org, id, 'offline');
        }

        return rows.length;
    });
}
