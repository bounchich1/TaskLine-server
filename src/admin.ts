import { z } from 'zod';
import { one, type Database, type Sql } from './db.js';
import { ensure } from './errors.js';
import { hash } from './crypto.js';
import { audit, emit } from './events.js';
import { templates, validateTemplate } from './templates.js';
import type { Employee, Row } from './types.js';

export const employeeBody = z
  .object({
    max_user_id: z.string().regex(/^\d{1,20}$/),
    name: z.string().min(1).max(120),
    role: z.enum(['support', 'supervisor', 'admin']),
    blocked: z.boolean().default(false),
  })
  .strict();
export const dictionaryBody = z
  .object({
    dimension: z.enum(['tag', 'urgency', 'complexity']),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(120),
    rank: z.number().int().min(0).max(100),
    active: z.boolean(),
  })
  .strict();
export class Admin {
  constructor(
    readonly db: Database,
    readonly org: string,
  ) {}
  async mutate(
    actor: Employee,
    route: string,
    key: string,
    expected: number,
    body: Row,
    fn: (tx: Sql) => Promise<unknown>,
  ) {
    ensure(actor.role === 'admin', 'forbidden', 403);
    ensure(key.length >= 8 && key.length <= 128, 'idempotency_required', 422);
    return this.db.tx(async (tx) => {
      // Organization-first admin lock serializes last-admin and dictionary publications.
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [this.org]);
      const active = await one<Employee>(
        tx,
        'SELECT * FROM employees WHERE org_id=$1 AND id=$2 AND NOT blocked',
        [this.org, actor.id],
      );
      ensure(active?.role === 'admin' && active.version === actor.version, 'forbidden', 403);
      const digest = hash(JSON.stringify({ expected, body }));
      await tx.query(
        'INSERT INTO command_keys(principal,route,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [actor.id, route, key, digest],
      );
      const prior = (await one(
        tx,
        'SELECT * FROM command_keys WHERE principal=$1 AND route=$2 AND key=$3 FOR UPDATE',
        [actor.id, route, key],
      ))!;
      ensure(prior.request_hash === digest, 'idempotency_conflict');
      if (prior.response) return prior.response;
      const result = await fn(tx);
      await audit(tx, this.org, actor.id, route, String(body.id ?? body.code ?? this.org), body);
      await emit(tx, this.org, 'admin.changed', null, { route });
      await tx.query(
        'UPDATE command_keys SET response=$4 WHERE principal=$1 AND route=$2 AND key=$3',
        [actor.id, route, key, JSON.stringify(result)],
      );
      return result;
    });
  }
  async employee(
    actor: Employee,
    id: string | undefined,
    raw: unknown,
    expected: number,
    key: string,
  ) {
    const body = employeeBody.parse(raw);
    return this.mutate(
      actor,
      `admin.employee:${id ?? body.max_user_id}`,
      key,
      expected,
      body,
      async (tx) => {
        if (!id)
          return one(
            tx,
            'INSERT INTO employees(org_id,max_user_id,name,role,blocked) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [this.org, body.max_user_id, body.name, body.role, body.blocked],
          );
        const old = await one<Employee>(
          tx,
          'SELECT * FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE',
          [this.org, id],
        );
        ensure(old, 'not_found', 404);
        ensure(old.version === expected, 'version_conflict');
        if (old.role === 'admin' && !old.blocked && (body.role !== 'admin' || body.blocked)) {
          const others = await one(
            tx,
            "SELECT count(*)::int AS n FROM employees WHERE org_id=$1 AND role='admin' AND NOT blocked AND id<>$2",
            [this.org, id],
          );
          ensure(Number(others!.n) > 0, 'last_admin');
        }
        await tx.query('UPDATE staff_sessions SET revoked=true WHERE employee_id=$1', [id]);
        return one(
          tx,
          'UPDATE employees SET name=$3,role=$4,blocked=$5,version=version+1 WHERE org_id=$1 AND id=$2 RETURNING *',
          [this.org, id, body.name, body.role, body.blocked],
        );
      },
    );
  }
  async dictionary(actor: Employee, raw: unknown, expected: number, key: string) {
    const body = dictionaryBody.parse(raw);
    return this.mutate(
      actor,
      `admin.dictionary:${body.dimension}:${body.code}`,
      key,
      expected,
      body,
      async (tx) => {
        ensure(
          body.active ||
            !(
              (body.dimension === 'tag' && body.code === 'undefined') ||
              (body.dimension !== 'tag' && body.code === 'medium')
            ),
          'protected_default',
          422,
        );
        const old = await one(
          tx,
          'SELECT * FROM dictionaries WHERE org_id=$1 AND dimension=$2 AND code=$3 FOR UPDATE',
          [this.org, body.dimension, body.code],
        );
        ensure(old ? old.version === expected : expected === 0, 'version_conflict');
        // Freeze the historical label before changing the live dictionary.
        if (old)
          await tx.query(
            `UPDATE tickets SET classification_labels=jsonb_set(classification_labels,ARRAY[$2],$4::jsonb) WHERE org_id=$1 AND ${body.dimension}=$3 AND NOT classification_labels ? $2`,
            [
              this.org,
              body.dimension,
              body.code,
              JSON.stringify({ label: old.label, version: old.version }),
            ],
          );
        return one(
          tx,
          'INSERT INTO dictionaries(org_id,dimension,code,label,rank,active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,dimension,code) DO UPDATE SET label=$4,rank=$5,active=$6,version=dictionaries.version+1 RETURNING *',
          [this.org, body.dimension, body.code, body.label, body.rank, body.active],
        );
      },
    );
  }
  async template(actor: Employee, code: string, raw: unknown, expected: number, key: string) {
    const body = z
      .object({ body: z.string().max(3000) })
      .strict()
      .parse(raw);
    validateTemplate(body.body);
    ensure(code in templates, 'unknown_template', 422);
    return this.mutate(actor, `admin.template:${code}`, key, expected, body, async (tx) => {
      const row = await one(
        tx,
        'UPDATE templates SET body=$3,version=version+1 WHERE org_id=$1 AND code=$2 AND version=$4 RETURNING *',
        [this.org, code, body.body, expected],
      );
      ensure(row, 'version_conflict');
      return row;
    });
  }
  async settings(actor: Employee, raw: unknown, expected: number, key: string) {
    const body = z
      .object({ name: z.string().min(1).max(120), timezone: z.string().min(1).max(80) })
      .strict()
      .parse(raw);
    try {
      new Intl.DateTimeFormat('ru', { timeZone: body.timezone });
    } catch {
      ensure(false, 'invalid_timezone', 422);
    }
    return this.mutate(actor, 'admin.settings', key, expected, body, async (tx) => {
      const row = await one(
        tx,
        'UPDATE organizations SET name=$2,timezone=$3,version=version+1 WHERE id=$1 AND version=$4 RETURNING name,timezone,version',
        [this.org, body.name, body.timezone, expected],
      );
      ensure(row, 'version_conflict');
      return row;
    });
  }
}
