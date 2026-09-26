import { one, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { audit } from '../../shared/events.js';
import { EMPLOYEE_STATUS_SQL } from '../../shared/staff.js';
import type { Employee } from '../../shared/types/entities.js';

export async function listAllEmployees(db: Sql, org: string) {
    const result = await db.query(
        `SELECT id,max_user_id,name,role,blocked,activated_at,version,created_at,${EMPLOYEE_STATUS_SQL}
     FROM employees WHERE org_id=$1 ORDER BY name`,
        [org],
    );

    return { items: result.rows };
}

export async function listTemplates(db: Sql, org: string) {
    const result = await db.query('SELECT code,body,version FROM templates WHERE org_id=$1 ORDER BY code', [org]);

    return { items: result.rows };
}

export async function readSettings(db: Sql, org: string) {
    return one(db, 'SELECT name,timezone,version FROM organizations WHERE id=$1', [org]);
}

export async function recentAudit(db: Sql, org: string) {
    const result = await db.query('SELECT * FROM audit WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100', [org]);

    return { items: result.rows };
}

export async function retryFailedJob(db: Database, org: string, { actor, jobId }: { actor: Employee; jobId: string }) {
    await db.tx(async (tx) => {
        const result = await tx.query(
            `UPDATE jobs SET state='pending',due_at=now() WHERE org_id=$1 AND id=$2 AND state='failed'
       AND kind IN('file','scan','memory_delete','message_revision') RETURNING id`,
            [org, jobId],
        );

        ensure(result.rows.length, 'retry_not_allowed');
        await audit(tx, org, { actor: actor.id, action: 'admin.job.retry', objectId: jobId });
    });
}
