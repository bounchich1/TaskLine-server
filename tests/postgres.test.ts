import { randomUUID } from 'node:crypto';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { Gateway } from '../src/modules/ai/index.js';
import { Postgres, migrate, one } from '../src/shared/db.js';
import type { Client, Job } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';
describe.runIf(process.env.RUN_POSTGRES_TESTS === '1')('real PostgreSQL concurrency', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const config = testConfig();
  const control = new Postgres(config.DATABASE_URL);
  const url = new URL(config.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Postgres(url.toString());
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    await control.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    context = await fixture(db, config);
  });
  afterAll(async () => {
    await db.close();
    if (!/^test_[a-f0-9]{32}$/.test(schema)) {
      throw new Error('Unsafe test schema');
    }
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.close();
  });
  it('serializes competing first inputs into one ticket and allocates no duplicate numbers', async () => {
    const client = (await one<Client>(
      db,
      `INSERT INTO clients(org_id,max_user_id,chat_id,consent_state,consent_version,consent_revision)
       VALUES($1,'777','777','granted',$2,1) RETURNING *`,
      [config.ORG_ID, config.POLICY_VERSION],
    ))!;
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        context.domain.ingest({
          kind: 'message',
          userId: '777',
          chatId: '777',
          messageId: `race-${i}`,
          sourceKey: `race-${i}`,
          text: `Проблема ${i}`,
        }),
      ),
    );
    await Promise.all(Array.from({ length: 60 }, () => context.domain.processClient(client.id)));
    expect(
      (await one(db, 'SELECT count(*)::int AS n FROM tickets WHERE client_id=$1', [client.id]))!.n,
    ).toBe(1);
    expect(
      (await one(
        db,
        `SELECT count(*)::int AS n FROM messages m JOIN tickets t ON t.id=m.ticket_id
         WHERE t.client_id=$1 AND m.author_type='client'`,
        [client.id],
      ))!.n,
    ).toBe(60);
    const events = (await db.query('SELECT cursor::text FROM ui_events ORDER BY cursor')).rows;
    expect(new Set(events.map((event) => event.cursor)).size).toBe(events.length);
  });
  it('keeps 1000 mixed requests under each global cap across three gateway instances', async () => {
    const triageTicket = await context.create('Тест параллелизма', '801');
    const closureTicket = await context.create('Тест обучения', '802');
    await context.command('assign', {}, context.staff, '802');
    await context.command('close', {}, context.staff, '802');
    const cycle = await one(db, 'SELECT id FROM closures WHERE ticket_id=$1', [closureTicket.id]);
    for (const cap of [10, 15]) {
      await db.query('UPDATE ai_settings SET cap=$1', [cap]);
      let active = 0;
      let max = 0;
      let calls = 0;
      const gateways = Array.from(
        { length: 3 },
        () =>
          new Gateway(db, config, async () => {
            active++;
            calls++;
            max = Math.max(max, active);
            await new Promise((resolve) => setTimeout(resolve, 3));
            active--;
            return { content: '{}', toolCalls: [], usage: {} };
          }),
      );
      const jobs = (
        await db.query<Job>(
          `INSERT INTO jobs(org_id,logical_key,kind,ref_id,payload,state,generation)
        SELECT $1,$2||i::text,CASE WHEN i%5=0 THEN 'learning' ELSE 'triage' END,CASE WHEN i%5=0 THEN $3::uuid ELSE $4::uuid END,
        '{"lifecycle":1,"consent_revision":1}'::jsonb,'running',1 FROM generate_series(1,1000) i RETURNING *`,
          [config.ORG_ID, `load-${cap}-`, cycle!.id, triageTicket.id],
        )
      ).rows;
      let cursor = 0;
      await Promise.all(
        Array.from({ length: 30 }, async (_, index) => {
          while (cursor < jobs.length) {
            await completeWhenAdmitted(gateways[index % 3], jobs[cursor++]);
          }
        }),
      );
      expect(calls).toBe(1000);
      expect(max).toBeLessThanOrEqual(cap);
      expect(max).toBeGreaterThan(1);
      expect(active).toBe(0);
      expect(
        (await one(db, "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'"))!.n,
      ).toBe(0);
    }
  }, 120000);
});

async function completeWhenAdmitted(gateway: Gateway, job: Job): Promise<void> {
  for (;;) {
    try {
      await gateway.complete(job, 'load', { messages: [{ role: 'user', content: 'test' }] });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ai_busy') {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}
