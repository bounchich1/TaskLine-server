import { can } from '../../shared/access.js';
import type { Ctx } from '../../shared/context.js';
import { hash, token } from '../../shared/crypto.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

const GRANT_LIFETIME_MS = 60000;

export function exportFilename(clientId: string): string {
    return `client-data-${clientId.slice(0, 8)}.json`;
}

export async function grantExport(db: Sql, ctx: Ctx, { clientId, session }: { clientId: string; session: Session }) {
    const client = await one(db, 'SELECT id FROM clients WHERE org_id=$1 AND id=$2', [ctx.org, clientId]);

    ensure(client, 'not_found', 404);
    const grant = token();

    await db.query(
        `INSERT INTO export_grants(hash,org_id,client_id,employee_id,session_hash)
     VALUES($1,$2,$3,$4,$5)`,
        [hash(grant), ctx.org, clientId, session.employee.id, session.hash],
    );

    return {
        url: `${ctx.config.PUBLIC_URL}/download/export/${grant}`,
        filename: exportFilename(clientId),
        expires_at: new Date(Date.now() + GRANT_LIFETIME_MS).toISOString(),
    };
}

export async function redeemExportGrant(db: Sql, ctx: Ctx, grant: string) {
    const record = await one<{ client_id: string; employee_id: string; role: Employee['role'] }>(
        db,
        `SELECT g.client_id,g.employee_id,e.role FROM export_grants g
     JOIN employees e ON e.id=g.employee_id AND e.org_id=g.org_id
     JOIN staff_sessions s ON s.hash=g.session_hash
     WHERE g.hash=$1 AND g.org_id=$2 AND g.expires_at>now() AND NOT e.blocked AND NOT s.revoked
     AND s.employee_version=e.version AND s.expires_at>now()`,
        [hash(grant), ctx.org],
    );

    ensure(record && can(record, 'clients.privacy'), 'not_found', 404);

    return { clientId: record.client_id, employeeId: record.employee_id };
}
