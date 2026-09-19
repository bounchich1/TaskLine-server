import { createHmac } from 'node:crypto';
import type { Config } from './config.js';
import type { Database, Sql } from './db.js';
import { one } from './db.js';
import { equal, hash, token } from './crypto.js';
import { ensure } from './errors.js';
import { decimalId, object, strictJson } from './json.js';
import type { Employee } from './types.js';

function form(raw: string): Map<string,string> {
  const result = new Map<string,string>();
  for (const part of raw.split('&')) {
    const index = part.indexOf('='); ensure(index >= 0,'invalid_launch',401);
    let key: string; let value: string;
    try { key = decodeURIComponent(part.slice(0,index).replaceAll('+',' ')); value = decodeURIComponent(part.slice(index+1).replaceAll('+',' ')); }
    catch { throw new Error('invalid_percent_encoding'); }
    ensure(!result.has(key),'invalid_launch',401); result.set(key,value);
  }
  return result;
}
export function verifyLaunch(raw: string, botToken: string, now = Date.now()): { userId: string; digest: string; startParam?: string } {
  ensure(Buffer.byteLength(raw) <= 16384 && raw.length > 0 && botToken.length > 0,'invalid_launch',401);
  let values = form(raw.startsWith('#') ? raw.slice(1) : raw);
  if (values.has('WebAppData')) values = form(values.get('WebAppData')!);
  const signature = values.get('hash') ?? ''; ensure(/^[a-fA-F0-9]{64}$/.test(signature),'invalid_launch',401);
  values.delete('hash');
  const canonical = [...values.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = createHmac('sha256','WebAppData').update(botToken).digest();
  const expected = createHmac('sha256',secret).update(canonical).digest('hex');
  ensure(equal(expected,signature.toLowerCase()),'invalid_launch',401);
  const dateText = values.get('auth_date') ?? ''; ensure(/^\d{10,11}$/.test(dateText),'invalid_launch',401);
  const date = Number(dateText)*1000; ensure(now-date <= 300000 && date-now <= 30000,'expired_launch',401,'Запуск устарел. Откройте приложение заново из MAX.');
  const user = object(strictJson(values.get('user') ?? '',true));
  return { userId: decimalId(user.id), digest: hash(canonical), startParam: values.get('start_param') };
}
export type Session = { employee: Employee; hash: string; csrfHash: string };
export async function authenticate(db: Sql, org: string, rawToken: string|undefined): Promise<Session> {
  ensure(rawToken && rawToken.length <= 128,'unauthorized',401,'Сессия истекла. Откройте приложение заново.');
  const sessionHash = hash(rawToken);
  const row = await one<Employee & {csrf_hash: string}>(db, `SELECT e.*,s.csrf_hash FROM staff_sessions s JOIN employees e ON e.id=s.employee_id AND e.org_id=s.org_id
    WHERE s.hash=$1 AND s.org_id=$2 AND NOT s.revoked AND NOT e.blocked AND s.employee_version=e.version
    AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'`,[sessionHash,org]);
  ensure(row,'unauthorized',401,'Сессия истекла. Откройте приложение заново.');
  await db.query('UPDATE staff_sessions SET last_seen_at=now() WHERE hash=$1',[sessionHash]);
  return {employee: row, hash: sessionHash, csrfHash: row.csrf_hash};
}
export async function issueSession(db: Database, c: Config, userId: string, launchHash: string) {
  return db.tx(async tx => {
    const employee = await one<Employee>(tx,'SELECT * FROM employees WHERE org_id=$1 AND max_user_id=$2 AND NOT blocked FOR UPDATE',[c.ORG_ID,userId]);
    ensure(employee,'access_denied',403,'Доступ к службе поддержки не предоставлен.');
    const recent = await one(tx,"SELECT count(*)::int AS n FROM staff_sessions WHERE launch_hash=$1 AND issued_at>now()-interval '5 minutes'",[launchHash]);
    ensure(Number(recent?.n) < 5,'launch_replay_limit',429,'Слишком много входов. Откройте приложение заново.');
    const secret = token(); const csrf = token();
    await tx.query('INSERT INTO staff_sessions(hash,org_id,employee_id,employee_version,csrf_hash,launch_hash) VALUES($1,$2,$3,$4,$5,$6)',[hash(secret),c.ORG_ID,employee.id,employee.version,hash(csrf),launchHash]);
    await tx.query("INSERT INTO audit(org_id,actor_id,action,object_id) VALUES($1,$2,'auth.login',$2)",[c.ORG_ID,employee.id]);
    return { token: secret, csrf, employee, organization: {name:c.ORG_NAME,timezone:c.ORG_TIMEZONE}, capabilities: capabilities(employee) };
  });
}
export function capabilities(e: Employee) {
  return {support: true, act_on_others: e.role !== 'support', admin: e.role === 'admin', operations: e.role !== 'support'};
}
