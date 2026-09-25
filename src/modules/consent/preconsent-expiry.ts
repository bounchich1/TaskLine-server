import { randomUUID } from 'node:crypto';

import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, type Database, type Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

export class PreconsentExpiry {
  private readonly ctx: Ctx;

  constructor(
    private readonly db: Database,
    config: Config,
  ) {
    this.ctx = createCtx(config);
  }

  async run(): Promise<void> {
    const expired = (
      await this.db.query<{ client_id: string }>(
        'SELECT DISTINCT client_id FROM preconsent_buffers WHERE expires_at<=now() LIMIT 100',
      )
    ).rows;
    for (const item of expired) {
      await this.db.tx((tx) => expireClientBuffers(tx, this.ctx, item.client_id));
    }
  }
}

async function expireClientBuffers(tx: Sql, ctx: Ctx, clientId: string): Promise<void> {
  const client = await one<Client>(
    tx,
    'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [ctx.org, clientId],
  );
  if (!client) {
    return;
  }
  const removed = await tx.query(
    'DELETE FROM preconsent_buffers WHERE client_id=$1 AND expires_at<=now() RETURNING id',
    [client.id],
  );
  if (removed.rows.length) {
    await queueBotMessage(tx, ctx, {
      client,
      template: 'buffer_expired',
      key: `buffer-expired:${randomUUID()}`,
    });
  }
}
