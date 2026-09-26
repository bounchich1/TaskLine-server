import { canOnTicket, type TicketAction } from '../../../shared/access.js';
import { claimCommandKey } from '../../../shared/command-keys.js';
import type { Config } from '../../../shared/config.js';
import { createCtx, type Ctx } from '../../../shared/context.js';
import { hash } from '../../../shared/crypto.js';
import type { Database } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { findActiveEmployee } from '../../../shared/staff.js';
import type { Employee, Row, Ticket } from '../../../shared/types/entities.js';

import type { TicketCommandHandler } from './command-context.js';
import { finishCommand } from './finish-command.js';
import { assign } from './handlers/assign.js';
import { classify } from './handlers/classification.js';
import { close } from './handlers/close.js';
import { reopen } from './handlers/reopen.js';
import { reply } from './handlers/reply.js';
import { transfer } from './handlers/transfer.js';
import { lockCommandTarget } from './lock-target.js';

interface CommandDefinition {
    action: TicketAction;
    handle: TicketCommandHandler;
    event: string;
}

const COMMANDS = new Map<string, CommandDefinition>([
    ['assign', { action: 'take', handle: assign, event: 'ticket.assigned' }],
    ['classification', { action: 'classify', handle: classify, event: 'ticket.classified' }],
    ['transfer', { action: 'transfer', handle: transfer, event: 'ticket.updated' }],
    ['messages', { action: 'reply', handle: reply, event: 'message.from_agent' }],
    ['close', { action: 'close', handle: close, event: 'ticket.closed' }],
    ['reopen', { action: 'reopen', handle: reopen, event: 'ticket.reopened' }],
]);

export interface TicketCommandRequest {
    actor: Employee;
    ticketId: string;
    name: string;
    body: Row;
    expectedVersion: number;
    idempotencyKey: string;
}

export class TicketCommands {
    private readonly ctx: Ctx;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.ctx = createCtx(config);
    }

    async run(request: TicketCommandRequest): Promise<Ticket> {
        const { ticketId, name, body, expectedVersion, idempotencyKey: key } = request;

        ensure(key.length >= 8 && key.length <= 128, 'idempotency_required', 422);
        const requestHash = hash(JSON.stringify({ body, expected: expectedVersion }));
        const commandKey = { principal: request.actor.id, route: `${ticketId}:${name}`, key };

        return this.db.tx(async (tx) => {
            const claim = await claimCommandKey(tx, commandKey, requestHash);
            const actor = await findActiveEmployee(tx, this.ctx.org, request.actor.id);

            ensure(actor?.version === request.actor.version, 'access_denied', 403);

            if (claim.response) {
                return claim.response as Ticket;
            }

            const { client, ticket } = await lockCommandTarget(tx, this.ctx, ticketId, expectedVersion);
            const definition = COMMANDS.get(name);

            ensure(definition, 'unknown_command', 404);
            ensure(canOnTicket(actor, ticket, definition.action), 'forbidden', 403, 'Недостаточно прав для действия.');
            const command = { actor, client, ticket, body };

            await definition.handle(tx, this.ctx, command);

            return finishCommand(tx, this.ctx, { name, event: definition.event, command, commandKey });
        });
    }
}
