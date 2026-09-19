import { saveCommandResponse, type CommandKey } from '../../../shared/command-keys.js';
import type { Ctx } from '../../../shared/context.js';
import { requireOne, type Sql } from '../../../shared/db.js';
import { audit, emit } from '../../../shared/events.js';
import type { Row, Ticket } from '../../../shared/types/entities.js';

import type { TicketCommand } from './command-context.js';

export interface FinishedCommand {
  name: string;
  /** UI event announcing the result. */
  event: string;
  command: TicketCommand;
  commandKey: CommandKey;
}

/**
 * Common tail of every command: bump the ticket version, audit, notify the UI and store the
 * response for idempotent replays. Returns the updated ticket.
 */
export async function finishCommand(
  tx: Sql,
  ctx: Ctx,
  { name, event, command, commandKey }: FinishedCommand,
): Promise<Ticket> {
  const { actor, ticket } = command;
  const result = await requireOne<Ticket>(
    tx,
    'UPDATE tickets SET version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
    [ticket.id],
  );
  await audit(
    tx,
    ctx.org,
    actor.id,
    `ticket.${name}`,
    ticket.id,
    auditDetail(name, command, result),
  );
  await emit(tx, ctx.org, event, ticket.id, { version: result.version });
  await saveCommandResponse(tx, commandKey, result);
  return result;
}

function auditDetail(name: string, { ticket, body }: TicketCommand, result: Ticket): Row {
  if (name === 'classification') {
    // `ticket` is the state loaded before the command ran.
    return {
      before: { tag: ticket.tag, urgency: ticket.urgency, complexity: ticket.complexity },
      after: body,
    };
  }
  return { version: result.version };
}
