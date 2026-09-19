import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { decrypt } from '../../shared/crypto.js';
import { one, type Database } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';

import { routeClientInput } from './dialog-router.js';
import { recordInput } from './record-input.js';

interface Receipt {
  [column: string]: unknown;
  id: string;
  payload: string;
  received_at: string;
}

/**
 * Inbound pipeline for client updates: record durably on receipt (webhook), then route each
 * client's inputs one at a time, in arrival order (worker loop).
 */
export class Inbox {
  private readonly ctx: Ctx;

  constructor(
    private readonly db: Database,
    config: Config,
  ) {
    this.ctx = createCtx(config);
  }

  async ingest(input: ClientInput): Promise<void> {
    await this.db.tx((tx) => recordInput(tx, this.ctx, input));
  }

  /** Routes the client's oldest pending input. Returns false when there was nothing to route. */
  async processClient(clientId: string): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const client = await one<Client>(
        tx,
        'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
        [this.ctx.org, clientId],
      );
      if (!client) {
        return false;
      }
      const receipt = await one<Receipt>(
        tx,
        `SELECT * FROM inbox WHERE org_id=$1 AND client_id=$2 AND state='pending'
         ORDER BY ingress_seq LIMIT 1 FOR UPDATE`,
        [this.ctx.org, client.id],
      );
      if (!receipt) {
        return false;
      }
      const input = decrypt<ClientInput>(receipt.payload, this.ctx.config.ENCRYPTION_KEY);
      await routeClientInput(tx, this.ctx, { client, input, receivedAt: receipt.received_at });
      await tx.query("UPDATE inbox SET state='done',payload=NULL,processed_at=now() WHERE id=$1", [
        receipt.id,
      ]);
      return true;
    });
  }
}
