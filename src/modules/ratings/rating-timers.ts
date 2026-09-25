import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import { one, requireOne, type Database, type Sql } from '../../shared/db.js';
import type { Client, Closure, Ticket } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

import { finishRating } from './finish-rating.js';

interface DueCycle {
  client: Client;
  ticket: Ticket;
  cycle: Closure;
}

export class RatingTimers {
  private readonly ctx: Ctx;

  constructor(
    private readonly db: Database,
    config: Config,
  ) {
    this.ctx = createCtx(config);
  }

  async run(): Promise<void> {
    const due = (
      await this.db.query<{ client_id: string }>(
        `SELECT DISTINCT t.client_id FROM tickets t JOIN closures c ON c.id=t.current_cycle_id
      WHERE t.org_id=$1 AND t.status='awaiting_rating'
        AND (c.expires_at<=now() OR (c.reminder_at<=now() AND NOT c.reminder_created)) LIMIT 100`,
        [this.ctx.org],
      )
    ).rows;
    for (const item of due) {
      await this.db.tx((tx) => processDueCycle(tx, this.ctx, item.client_id));
    }
  }
}

async function processDueCycle(tx: Sql, ctx: Ctx, clientId: string): Promise<void> {
  const client = await requireOne<Client>(
    tx,
    'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [ctx.org, clientId],
  );
  const ticket = await one<Ticket>(
    tx,
    "SELECT * FROM tickets WHERE client_id=$1 AND status='awaiting_rating' FOR UPDATE",
    [client.id],
  );
  if (!ticket) {
    return;
  }
  const cycle = await requireOne<Closure>(tx, 'SELECT * FROM closures WHERE id=$1 FOR UPDATE', [
    ticket.current_cycle_id,
  ]);
  const times = await requireOne(tx, 'SELECT now() >= $1::timestamptz AS expired', [
    cycle.expires_at,
  ]);
  if (times.expired) {
    await expireCycle(tx, ctx, { client, ticket, cycle });
  } else if (!cycle.reminder_created) {
    await tx.query('UPDATE closures SET reminder_created=true WHERE id=$1', [cycle.id]);
    await queueBotMessage(tx, ctx, {
      client,
      template: 'rating_reminder',
      key: `reminder:${cycle.id}`,
      ticket,
      cycleId: cycle.id,
    });
  }
}

async function expireCycle(tx: Sql, ctx: Ctx, { client, ticket, cycle }: DueCycle): Promise<void> {
  const pendingInput = await one(
    tx,
    "SELECT id FROM inbox WHERE client_id=$1 AND state='pending' AND received_at<=$2 LIMIT 1",
    [client.id, cycle.expires_at],
  );
  if (pendingInput) {
    return;
  }
  const prompt = await one(
    tx,
    "SELECT state FROM deliveries WHERE cycle_id=$1 AND kind='ticket_closed'",
    [cycle.id],
  );
  await finishRating(tx, ctx, {
    client,
    ticket,
    cycle,
    reason: prompt?.state === 'delivered' ? 'expired' : 'notification_not_delivered',
    key: cycle.id,
  });
}
