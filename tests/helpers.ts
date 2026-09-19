import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { readConfig, type Config } from '../src/config.js';
import { migrate, one, type Database, type Sql } from '../src/db.js';
import { Domain } from '../src/domain.js';
import { seed } from '../src/seed.js';
import type { Client, Employee, Ticket } from '../src/types.js';
import { traceSql, traceTransaction } from './support/sql-trace.js';

export function testConfig(): Config {
  return readConfig({
    ...process.env,
    NODE_ENV: 'test',
    ORG_ID: randomUUID(),
    AI_ENABLED: 'true',
    AI_MODE: 'mock',
    MEMORY_ENABLED: 'true',
    SCANNER_MODE: 'mock',
    MAX_MODE: 'mock',
    DEV_AUTH_ENABLED: 'true',
    ENCRYPTION_KEY: 'ab'.repeat(32),
    GATEWAY_SECRET: 'g'.repeat(40),
    MAX_WEBHOOK_SECRET: 'w'.repeat(40),
    AGENTMEMORY_SECRET: 'm'.repeat(40),
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused',
    POLICY_VERSION: 'test-1',
    POLICY_URL: 'https://example.invalid/privacy',
    ALTERNATIVE_CONTACT: 'Поддержка',
  });
}
export async function memoryDb(): Promise<Database> {
  const pg = new PGlite();
  const adapt = (connection: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      traceSql(sql, params);
      if (!params.length && sql.includes(';')) {
        const results = await connection.exec(sql);
        const result = results.at(-1);
        return { rows: (result?.rows ?? []) as T[], rowCount: result?.affectedRows ?? 0 };
      }
      const result = await connection.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
  });
  const db: Database = {
    query: adapt(pg).query,
    async tx<T>(fn: (sql: Sql) => Promise<T>) {
      traceTransaction('begin');
      try {
        return await pg.transaction(async (tx) => fn(adapt(tx)));
      } finally {
        traceTransaction('end');
      }
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
export async function fixture(db?: Database, c = testConfig()) {
  db = db ?? (await memoryDb());
  await seed(db, c);
  const domain = new Domain(db, c);
  const staff = (await one<Employee>(
    db,
    "INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'1','Анна','support') RETURNING *",
    [c.ORG_ID],
  ))!;
  const admin = (await one<Employee>(
    db,
    "INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'2','Руководитель','admin') RETURNING *",
    [c.ORG_ID],
  ))!;
  let seq = 0;
  const input = async (text: string, userId = '100') => {
    const key = `m-${randomUUID()}`;
    await domain.ingest({
      kind: 'message',
      userId,
      chatId: userId,
      messageId: key,
      sourceKey: key,
      text,
    });
    const client = (await one<Client>(
      db!,
      'SELECT * FROM clients WHERE org_id=$1 AND max_user_id=$2',
      [c.ORG_ID, userId],
    ))!;
    while (await domain.processClient(client.id)) {}
    return client;
  };
  const accept = async (client: Client) => {
    const action = (await one(
      db!,
      "SELECT nonce FROM callback_actions WHERE client_id=$1 AND action='accept' ORDER BY expires_at DESC LIMIT 1",
      [client.id],
    ))!;
    await domain.ingest({
      kind: 'callback',
      userId: client.max_user_id,
      chatId: client.chat_id,
      sourceKey: `cb-${++seq}-${randomUUID()}`,
      callbackPayload: String(action.nonce),
      callbackId: `cb-${seq}`,
    });
    while (await domain.processClient(client.id)) {}
  };
  const ticket = async (userId = '100') =>
    (await one<Ticket>(
      db!,
      'SELECT t.* FROM tickets t JOIN clients c ON c.id=t.client_id WHERE t.org_id=$1 AND c.max_user_id=$2 ORDER BY t.created_at DESC LIMIT 1',
      [c.ORG_ID, userId],
    ))!;
  const create = async (text = 'Не работает подключение', userId = '100') => {
    const client = await input(text, userId);
    await accept(client);
    return ticket(userId);
  };
  const command = async (
    name: string,
    body: Record<string, unknown> = {},
    actor = staff,
    userId = '100',
  ) => {
    const current = await ticket(userId);
    return domain.command(actor, current.id, name, body, current.version, randomUUID());
  };
  return { db, c, domain, staff, admin, input, accept, ticket, create, command };
}
