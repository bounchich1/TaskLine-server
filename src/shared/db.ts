import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { serverFile } from './paths.js';
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface Database extends Sql {
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class Postgres implements Database {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      statement_timeout: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }
  async tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const connection = await this.pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await fn(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        if (attempt >= 2 || !['40001', '40P01'].includes((error as { code?: string }).code ?? '')) {
          throw error;
        }
      } finally {
        connection.release();
      }
    }
  }
  async close() {
    await this.pool.end();
  }
}
export async function one<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Sql,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}
export async function migrate(db: Database) {
  const migration = await readFile(serverFile('migrations/001_initial.sql'), 'utf8');
  await db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7136001)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    if (!(await one(tx, 'SELECT version FROM schema_migrations WHERE version=1'))) {
      await tx.query(migration);
      await tx.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
  });
}
