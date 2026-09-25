import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { seed } from '../src/app/bootstrap/seed.js';
import { PreconsentExpiry } from '../src/modules/consent/index.js';
import { Inbox } from '../src/modules/inbox/index.js';
import { RatingTimers } from '../src/modules/ratings/index.js';
import { TicketCommands } from '../src/modules/tickets/index.js';
import { readConfig, type Config } from '../src/shared/config.js';
import { migrate, one, requireOne, type Database, type Sql } from '../src/shared/db.js';
import type { ClientInput } from '../src/shared/types/client-input.js';
import type { Client, Employee, Row, Ticket } from '../src/shared/types/entities.js';

import { traceSql, traceTransaction } from './support/sql-trace.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
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
    ...overrides,
  });
}
export function emptyMemoryDb(): Database {
  const pg = new PGlite();
  const adapt = (connection: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
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
    ...adapt(pg),
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
  return db;
}

async function memoryDb(): Promise<Database> {
  const db = emptyMemoryDb();
  await migrate(db);
  return db;
}
type LegacyCommandArgs = [
  actor: Employee,
  ticketId: string,
  name: string,
  body: Row,
  expectedVersion: number,
  idempotencyKey: string,
];

function domainAdapter(db: Database, config: Config) {
  const inbox = new Inbox(db, config);
  const commands = new TicketCommands(db, config);
  return {
    ingest: (input: ClientInput) => inbox.ingest(input),
    processClient: (clientId: string) => inbox.processClient(clientId),
    command: (
      ...[actor, ticketId, name, body, expectedVersion, idempotencyKey]: LegacyCommandArgs
    ) => commands.run({ actor, ticketId, name, body, expectedVersion, idempotencyKey }),
    timers: async () => {
      await new RatingTimers(db, config).run();
      await new PreconsentExpiry(db, config).run();
    },
  };
}

export async function fixture(existing?: Database, config = testConfig()) {
  const db = existing ?? (await memoryDb());
  await seed(db, config);
  const domain = domainAdapter(db, config);
  const staff = await requireOne<Employee>(
    db,
    `INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'1','Анна','support')
     RETURNING *`,
    [config.ORG_ID],
  );
  const admin = await requireOne<Employee>(
    db,
    `INSERT INTO employees(org_id,max_user_id,name,role) VALUES($1,'2','Руководитель','admin')
     RETURNING *`,
    [config.ORG_ID],
  );
  let seq = 0;
  const drain = async (clientId: string) => {
    let more: boolean;
    do {
      more = await domain.processClient(clientId);
    } while (more);
  };
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
    const client = await requireOne<Client>(
      db,
      'SELECT * FROM clients WHERE org_id=$1 AND max_user_id=$2',
      [config.ORG_ID, userId],
    );
    await drain(client.id);
    return client;
  };
  const accept = async (client: Client) => {
    const action = await requireOne(
      db,
      `SELECT nonce FROM callback_actions WHERE client_id=$1 AND action='accept'
       ORDER BY expires_at DESC LIMIT 1`,
      [client.id],
    );
    await domain.ingest({
      kind: 'callback',
      userId: client.max_user_id,
      chatId: client.chat_id,
      sourceKey: `cb-${++seq}-${randomUUID()}`,
      callbackPayload: String(action.nonce),
      callbackId: `cb-${seq}`,
    });
    await drain(client.id);
  };
  const findTicket = async (userId = '100') =>
    one<Ticket>(
      db,
      `SELECT t.* FROM tickets t JOIN clients c ON c.id=t.client_id
       WHERE t.org_id=$1 AND c.max_user_id=$2 ORDER BY t.created_at DESC LIMIT 1`,
      [config.ORG_ID, userId],
    );
  const ticket = async (userId = '100') => {
    const found = await findTicket(userId);
    if (!found) {
      throw new Error(`Client ${userId} has no ticket`);
    }
    return found;
  };
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
  return {
    db,
    c: config,
    domain,
    staff,
    admin,
    input,
    accept,
    findTicket,
    ticket,
    create,
    command,
  };
}
