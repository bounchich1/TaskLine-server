import { z } from 'zod';

import type { Config } from '../../shared/config.js';
import { hash } from '../../shared/crypto.js';
import { one, type Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { Employee, Row, Ticket } from '../../shared/types/entities.js';

import { TicketCommands } from './commands/ticket-commands.js';

const uuid = z.uuid();
const ids = z.array(uuid).min(1).max(50);
const code = z.string().max(64).optional();
const DEFAULT_COMMENT = 'Назначено руководителем';

export const bulkBody = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('assign'),
            ids,
            employee_id: uuid,
            comment: z.string().trim().max(2000).optional(),
        })
        .strict(),
    z.object({ action: z.literal('team'), ids, team_id: uuid.nullable() }).strict(),
    z.object({ action: z.literal('classify'), ids, tag: code, urgency: code, complexity: code }).strict(),
    z.object({ action: z.literal('close'), ids, text: z.string().trim().max(4000).optional() }).strict(),
]);

export type BulkBody = z.infer<typeof bulkBody>;

interface PlannedCommand {
    name: string;
    body: Row;
}

function classification(body: Extract<BulkBody, { action: 'classify' }>, ticket: Ticket): PlannedCommand {
    const fields = Object.fromEntries(
        (['tag', 'urgency', 'complexity'] as const).flatMap((field) => (body[field] ? [[field, body[field]]] : [])),
    );

    return {
        name: 'classification',
        body: {
            ...fields,
            revisions: {
                tag: ticket.tag_revision,
                urgency: ticket.urgency_revision,
                complexity: ticket.complexity_revision,
            },
        },
    };
}

function plan(body: BulkBody, ticket: Ticket): PlannedCommand | null {
    switch (body.action) {
        case 'assign':
            if (ticket.status === 'in_progress') {
                return ticket.assignee_id === body.employee_id
                    ? null
                    : {
                          name: 'transfer',
                          body: {
                              employee_id: body.employee_id,
                              comment: body.comment?.length ? body.comment : DEFAULT_COMMENT,
                          },
                      };
            }

            return { name: 'assign', body: { employee_id: body.employee_id } };
        case 'team':
            return { name: 'team', body: { team_id: body.team_id, release: true } };
        case 'classify':
            return classification(body, ticket);
        case 'close':
            return body.text
                ? { name: 'messages', body: { text: body.text, close_after: true } }
                : { name: 'close', body: {} };
    }
}

export class TicketBulk {
    private readonly commands: TicketCommands;
    private readonly org: string;

    constructor(
        private readonly db: Database,
        config: Config,
    ) {
        this.commands = new TicketCommands(db, config);
        this.org = config.ORG_ID;
    }

    async run(actor: Employee, body: BulkBody, key: string) {
        const results = [];

        for (const id of new Set(body.ids)) {
            results.push(await this.runOne(actor, { body, id, key }));
        }

        return { results };
    }

    private async runOne(actor: Employee, { body, id, key }: { body: BulkBody; id: string; key: string }) {
        const ticket = await one<Ticket>(this.db, 'SELECT * FROM tickets WHERE org_id=$1 AND id=$2', [this.org, id]);

        if (!ticket) {
            return { id, ok: false, code: 'not_found', message: 'Обращение не найдено.' };
        }

        const command = plan(body, ticket);
        const number = ticket.ticket_number;

        if (!command) {
            return { id, number, ok: true };
        }

        try {
            await this.commands.run({
                actor,
                ticketId: id,
                name: command.name,
                body: command.body,
                expectedVersion: ticket.version,
                idempotencyKey: `bulk:${hash(`${key}:${id}`).slice(0, 48)}`,
            });

            return { id, number, ok: true };
        } catch (error) {
            if (error instanceof AppError) {
                return { id, number, ok: false, code: error.code, message: error.message };
            }

            throw error;
        }
    }
}
