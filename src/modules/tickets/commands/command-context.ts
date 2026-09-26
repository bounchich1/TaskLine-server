import type { Ctx } from '../../../shared/context.js';
import type { Sql } from '../../../shared/db.js';
import type { Client, Employee, Row, Ticket } from '../../../shared/types/entities.js';

export interface TicketCommand {
    actor: Employee;
    client: Client;
    ticket: Ticket;
    body: Row;
}

export type TicketCommandHandler = (tx: Sql, ctx: Ctx, command: TicketCommand) => Promise<void>;
