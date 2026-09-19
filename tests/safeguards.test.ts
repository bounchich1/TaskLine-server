import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TransportFailure } from '../src/integrations/max/index.js';
import { Admin } from '../src/modules/admin/index.js';
import { DeliveryWorker } from '../src/modules/delivery/index.js';
import { one } from '../src/shared/db.js';
import type { Client } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.db.close();
});

describe('delivery and admin safeguards', () => {
  it('unknown sends are not automatically retried or overtaken', async () => {
    await context.create();
    await context.command('assign');
    await context.command('messages', { text: 'Ответ' });
    await context.db.query("UPDATE deliveries SET state='delivered' WHERE kind<>'staff'");
    let calls = 0;
    const transport = {
      send: () => {
        calls++;
        return Promise.reject(new TransportFailure('unknown', 'lost_response'));
      },
      answer: () => Promise.resolve(),
      upload: () => Promise.resolve({}),
    };
    const worker = new DeliveryWorker(context.db, context.c, transport);
    const client = await one<Client>(context.db, 'SELECT * FROM clients');
    await worker.deliver(client!.id);
    await worker.deliver(client!.id);
    expect(calls).toBe(1);
    expect((await one(context.db, "SELECT state FROM deliveries WHERE kind='staff'"))!.state).toBe(
      'unknown',
    );
  });
  it('protects last administrator and reserved dictionary defaults', async () => {
    const admin = new Admin(context.db, context.c.ORG_ID);
    await expect(
      admin.employee({
        actor: context.admin,
        employeeId: context.admin.id,
        body: { max_user_id: '2', name: 'Admin', role: 'support', blocked: false },
        expectedVersion: context.admin.version,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'last_admin' });
    await expect(
      admin.dictionary({
        actor: context.admin,
        body: { dimension: 'tag', code: 'undefined', label: 'Other', rank: 0, active: false },
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'protected_default' });
  });
});
