import { PreconsentExpiry } from './modules/consent/index.js';
import { Inbox } from './modules/inbox/index.js';
import { reviseClientMessage } from './modules/messages/index.js';
import { RatingTimers } from './modules/ratings/index.js';
import { TicketCommands } from './modules/tickets/index.js';
import type { Config } from './shared/config.js';
import { createCtx } from './shared/context.js';
import type { Database, Sql } from './shared/db.js';
import type { ClientInput } from './shared/types/client-input.js';
import type { Client, Employee, Row } from './shared/types/entities.js';

export class Domain {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}

  async ingest(input: ClientInput): Promise<void> {
    await new Inbox(this.db, this.config).ingest(input);
  }

  async processClient(clientId: string): Promise<boolean> {
    return new Inbox(this.db, this.config).processClient(clientId);
  }

  async reviseMessage(tx: Sql, client: Client, input: ClientInput) {
    await reviseClientMessage(tx, createCtx(this.config), client, input);
  }

  async command(
    employee: Employee,
    ticketId: string,
    name: string,
    body: Row,
    expected: number,
    key: string,
  ) {
    return new TicketCommands(this.db, this.config).run({
      actor: employee,
      ticketId,
      name,
      body,
      expectedVersion: expected,
      idempotencyKey: key,
    });
  }

  async timers() {
    await new RatingTimers(this.db, this.config).run();
    await new PreconsentExpiry(this.db, this.config).run();
  }
}
