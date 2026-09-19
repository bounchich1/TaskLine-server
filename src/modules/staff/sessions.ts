import type { Config } from '../../shared/config.js';
import { hash, token } from '../../shared/crypto.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';
import type { Session } from '../../shared/types/session.js';

import { capabilities } from './capabilities.js';

const MAX_LOGINS_PER_LAUNCH = 5;

/**
 * Resolves a bearer token to a live session. Sessions die on logout, when the employee is
 * blocked or changed (version), at expiry, and after 30 minutes idle. Touches `last_seen_at`.
 */
export async function authenticate(
  db: Sql,
  org: string,
  rawToken: string | undefined,
): Promise<Session> {
  ensure(
    rawToken && rawToken.length <= 128,
    'unauthorized',
    401,
    'Сессия истекла. Откройте приложение заново.',
  );
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

/**
 * Starts a session for an active employee identified by a verified MAX launch. Only hashes of
 * the session and CSRF tokens are stored; the raw tokens are returned once.
 */
export async function issueSession(
  db: Database,
  config: Config,
  userId: string,
  launchHash: string,
) {
  return db.tx(async (tx) => {
    const employee = await one<Employee>(
      tx,
      'SELECT * FROM employees WHERE org_id=$1 AND max_user_id=$2 AND NOT blocked FOR UPDATE',
      [config.ORG_ID, userId],
    );
    ensure(employee, 'access_denied', 403, 'Доступ к службе поддержки не предоставлен.');
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
    await tx.query(
      "INSERT INTO audit(org_id,actor_id,action,object_id) VALUES($1,$2,'auth.login',$3)",
      [config.ORG_ID, employee.id, employee.id],
    );
    return {
      token: secret,
      csrf,
      employee,
      organization: { name: config.ORG_NAME, timezone: config.ORG_TIMEZONE },
      capabilities: capabilities(employee),
    };
  });
}

/** Logout: the session stops working immediately. */
export async function revokeSession(db: Sql, sessionHash: string): Promise<void> {
  await db.query('UPDATE staff_sessions SET revoked=true WHERE hash=$1', [sessionHash]);
}

/** Replaces the session and CSRF tokens of a live session; the old token stops working. */
export async function rotateSession(
  db: Database,
  sessionHash: string,
): Promise<{ token: string; csrf: string }> {
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

/** The signed-in employee, what they may do, and their organization (GET /v1/me). */
export async function describeSession(db: Sql, org: string, employee: Employee) {
  return {
    employee,
    capabilities: capabilities(employee),
    organization: await one(db, 'SELECT name,timezone FROM organizations WHERE id=$1', [org]),
  };
}
