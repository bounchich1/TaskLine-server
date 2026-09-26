import type { Config } from '../../shared/config.js';
import { hash, token } from '../../shared/crypto.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { audit, emit } from '../../shared/events.js';
import { sessionProfile } from '../../shared/staff.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

const MAX_LOGINS_PER_LAUNCH = 5;
const LOGIN_EMPLOYEE_SQL = 'SELECT * FROM employees WHERE org_id=$1 AND max_user_id=$2 AND NOT blocked';

export async function authenticate(db: Sql, org: string, rawToken: string | undefined): Promise<Session> {
    ensure(rawToken && rawToken.length <= 128, 'unauthorized', 401, 'Сессия истекла. Откройте приложение заново.');
    const sessionHash = hash(rawToken);

    const row = await one<Employee & { csrf_hash: string }>(
        db,
        `SELECT e.*,s.csrf_hash FROM staff_sessions s JOIN employees e ON e.id=s.employee_id AND e.org_id=s.org_id
    WHERE s.hash=$1 AND s.org_id=$2 AND NOT s.revoked AND NOT e.blocked AND s.employee_version=e.version
    AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'`,
        [sessionHash, org],
    );

    ensure(row, 'unauthorized', 401, 'Сессия истекла. Откройте приложение заново.');
    await db.query('UPDATE staff_sessions SET last_seen_at=now() WHERE hash=$1', [sessionHash]);

    return { employee: row, hash: sessionHash, csrfHash: row.csrf_hash };
}

export async function issueSession(db: Database, config: Config, userId: string, launchHash: string) {
    return db.tx(async (tx) => {
        const employee = await lockLoginEmployee(tx, config.ORG_ID, userId);

        const recent = await one(
            tx,
            `SELECT count(*)::int AS n FROM staff_sessions
       WHERE launch_hash=$1 AND issued_at>now()-interval '5 minutes'`,
            [launchHash],
        );

        ensure(
            Number(recent?.n) < MAX_LOGINS_PER_LAUNCH,
            'launch_replay_limit',
            429,
            'Слишком много входов. Откройте приложение заново.',
        );

        const secret = token();
        const csrf = token();

        await tx.query(
            `INSERT INTO staff_sessions(hash,org_id,employee_id,employee_version,csrf_hash,launch_hash)
       VALUES($1,$2,$3,$4,$5,$6)`,
            [hash(secret), config.ORG_ID, employee.id, employee.version, hash(csrf), launchHash],
        );

        await audit(tx, config.ORG_ID, { actor: employee.id, action: 'auth.login', objectId: employee.id });

        return {
            token: secret,
            csrf,
            ...sessionProfile(employee),
            organization: { name: config.ORG_NAME, timezone: config.ORG_TIMEZONE },
        };
    });
}

async function lockLoginEmployee(tx: Sql, org: string, userId: string): Promise<Employee> {
    const pending = await one(tx, `${LOGIN_EMPLOYEE_SQL} AND activated_at IS NULL`, [org, userId]);

    if (pending) {
        await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [org]);
    }

    const employee = await one<Employee>(tx, `${LOGIN_EMPLOYEE_SQL} FOR UPDATE`, [org, userId]);

    ensure(employee, 'access_denied', 403, 'Доступ к службе поддержки не предоставлен.');

    return employee.activated_at === null ? activate(tx, org, employee) : employee;
}

async function activate(tx: Sql, org: string, employee: Employee): Promise<Employee> {
    const activated = await requireOne<Employee>(
        tx,
        'UPDATE employees SET activated_at=now() WHERE id=$1 AND activated_at IS NULL RETURNING *',
        [employee.id],
    );

    await audit(tx, org, { actor: employee.id, action: 'employee.activated', objectId: employee.id });
    await emit(tx, org, { type: 'admin.changed', ticketId: null, payload: { route: 'employee.activated' } });

    return activated;
}

export async function revokeSession(db: Sql, sessionHash: string): Promise<void> {
    await db.query('UPDATE staff_sessions SET revoked=true WHERE hash=$1', [sessionHash]);
}

export async function rotateSession(db: Database, sessionHash: string): Promise<{ token: string; csrf: string }> {
    const secret = token();
    const csrf = token();

    await db.tx(async (tx) => {
        const row = await tx.query(
            `UPDATE staff_sessions SET hash=$2,csrf_hash=$3,last_seen_at=now()
       WHERE hash=$1 AND NOT revoked AND expires_at>now() RETURNING hash`,
            [sessionHash, hash(secret), hash(csrf)],
        );

        ensure(row.rows.length, 'unauthorized', 401);
    });

    return { token: secret, csrf };
}

export async function describeSession(db: Sql, org: string, employee: Employee) {
    return {
        ...sessionProfile(employee),
        organization: await one(db, 'SELECT name,timezone FROM organizations WHERE id=$1', [org]),
    };
}
