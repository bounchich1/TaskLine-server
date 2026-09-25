import { saveCommandResponse, type CommandKey } from '../../../shared/command-keys.js';
import type { Ctx } from '../../../shared/context.js';
import { requireOne, type Sql } from '../../../shared/db.js';
import { audit, emit } from '../../../shared/events.js';
import type { Row, Ticket } from '../../../shared/types/entities.js';

import type { TicketCommand } from './command-context.js';

export interface FinishedCommand {
    name: string;
    event: string;
    command: TicketCommand;
    commandKey: CommandKey;
}

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

    await audit(tx, ctx.org, {
        actor: actor.id,
        action: `ticket.${name}`,
        objectId: ticket.id,
        detail: auditDetail(name, command, result),
    });

    await emit(tx, ctx.org, {
        type: event,
        ticketId: ticket.id,
        payload: { version: result.version },
    });

    await saveCommandResponse(tx, commandKey, result);

    return result;
}

function auditDetail(name: string, { ticket, body }: TicketCommand, result: Ticket): Row {
    if (name === 'classification') {
        return {
            before: { tag: ticket.tag, urgency: ticket.urgency, complexity: ticket.complexity },
            after: body,
        };
    }

    return { version: result.version };
}
