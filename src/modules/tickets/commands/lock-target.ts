import type { Ctx } from '../../../shared/context.js';
import { one, requireOne, type Sql } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import type { Client, Ticket } from '../../../shared/types/entities.js';

export async function lockCommandTarget(
  tx: Sql,
  ctx: Ctx,
  ticketId: string,
  expectedVersion: number,
): Promise<{ client: Client; ticket: Ticket }> {
  const ref = await one<{ client_id: string }>(
    tx,
    'SELECT client_id FROM tickets WHERE org_id=$1 AND id=$2',
    [ctx.org, ticketId],
  );
  ensure(ref, 'not_found', 404);
  const client = await requireOne<Client>(
    tx,
    'SELECT * FROM clients WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [ctx.org, ref.client_id],
  );
  const ticket = await requireOne<Ticket>(
    tx,
    'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE',
    [ctx.org, ticketId],
  );
  ensure(
    ticket.version === expectedVersion,
    'ticket_version_conflict',
    409,
    'Обращение изменилось. Обновите карточку.',
  );
  ensure(
    client.consent_state === 'granted' && client.consent_revision === ticket.consent_revision,
    'consent_required',
    409,
    'Согласие клиента недействительно.',
  );
  return { client, ticket };
}
