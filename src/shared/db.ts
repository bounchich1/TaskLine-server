import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

import { serverFile } from './paths.js';

export interface Sql {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
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

const MIGRATIONS = serverFile('migrations/');
const MIGRATION_NAME = /^(\d+)_[\w-]+\.sql$/;

interface Migration {
    version: number;
    file: URL;
}

async function listMigrations(directory: URL): Promise<Migration[]> {
    const migrations = (await readdir(directory)).flatMap((name) => {
        const match = MIGRATION_NAME.exec(name);

        return match ? [{ version: Number(match[1]), file: new URL(name, directory) }] : [];
    });

    migrations.sort((left, right) => left.version - right.version);
    const versions = new Set(migrations.map((migration) => migration.version));

    if (versions.size !== migrations.length) {
        throw new Error('Two migrations share a version number');
    }

    return migrations;
}

export async function latestMigration(directory = MIGRATIONS): Promise<number> {
    return (await listMigrations(directory)).at(-1)?.version ?? 0;
}

export async function schemaVersion(db: Sql): Promise<number> {
    const row = await one<{ version: number | null }>(db, 'SELECT max(version) AS version FROM schema_migrations');

    return row?.version ?? 0;
}

export async function migrate(db: Database, directory = MIGRATIONS): Promise<number[]> {
    const migrations = await listMigrations(directory);

    return db.tx(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(7136001)');
        await tx.query('SET LOCAL statement_timeout = 0');

        await tx.query(
            `CREATE TABLE IF NOT EXISTS schema_migrations
       (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );

        const { rows } = await tx.query<{ version: number }>('SELECT version FROM schema_migrations');
        const applied = new Set(rows.map((row) => row.version));
        const pending = migrations.filter((migration) => !applied.has(migration.version));

        for (const migration of pending) {
            await tx.query(await readFile(migration.file, 'utf8'));
            await tx.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
        }

        return pending.map((migration) => migration.version);
    });
}

export async function requireOne<T extends Record<string, unknown> = Record<string, unknown>>(
    db: Sql,
    sql: string,
    params: unknown[] = [],
): Promise<T> {
    const row = await one<T>(db, sql, params);

    if (!row) {
        throw new Error('Expected the query to return a row');
    }

    return row;
}
