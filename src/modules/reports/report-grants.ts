import { can } from '../../shared/access.js';
import type { Ctx } from '../../shared/context.js';
import { hash, token } from '../../shared/crypto.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

import type { PeriodInput } from './period.js';
import { exportFilename, type ExportFormat, type ReportName } from './reports.js';

const GRANT_LIFETIME_MS = 60000;

export interface ReportExport {
    name: ReportName;
    format: ExportFormat;
    period: PeriodInput;
}

export async function grantReportExport(db: Sql, ctx: Ctx, session: Session, request: ReportExport) {
    const grant = token();

    await db.query(
        `INSERT INTO report_grants(hash,org_id,employee_id,session_hash,report,format,period_from,period_to)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
            hash(grant),
            ctx.org,
            session.employee.id,
            session.hash,
            request.name,
            request.format,
            request.period.from,
            request.period.to,
        ],
    );

    return {
        url: `${ctx.config.PUBLIC_URL}/download/report/${grant}`,
        filename: exportFilename(request.name, request.format, request.period),
        expires_at: new Date(Date.now() + GRANT_LIFETIME_MS).toISOString(),
    };
}

interface GrantRow extends Record<string, unknown> {
    report: ReportName;
    format: ExportFormat;
    period_from: string;
    period_to: string;
    role: Employee['role'];
}

export async function redeemReportGrant(db: Sql, ctx: Ctx, grant: string): Promise<ReportExport> {
    const record = await one<GrantRow>(
        db,
        `SELECT g.report,g.format,to_char(g.period_from,'YYYY-MM-DD') AS period_from,
       to_char(g.period_to,'YYYY-MM-DD') AS period_to,e.role
     FROM report_grants g
     JOIN employees e ON e.id=g.employee_id AND e.org_id=g.org_id
     JOIN staff_sessions s ON s.hash=g.session_hash
     WHERE g.hash=$1 AND g.org_id=$2 AND g.expires_at>now() AND NOT e.blocked AND NOT s.revoked
       AND s.employee_version=e.version AND s.expires_at>now()`,
        [hash(grant), ctx.org],
    );

    ensure(record && can(record, 'reports.view'), 'not_found', 404);

    return { name: record.report, format: record.format, period: { from: record.period_from, to: record.period_to } };
}
