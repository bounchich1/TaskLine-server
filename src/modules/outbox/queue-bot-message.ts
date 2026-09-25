import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { formatTicketNumber } from '../../shared/ticket-number.js';
import type { Client, Row, Ticket } from '../../shared/types/entities.js';
import { addMessage } from '../messages/index.js';
import { render } from '../templates/index.js';

export interface BotMessage {
    client: Client;
    template: string;
    key: string;
    ticket?: Ticket;
    cycleId?: string;
    extra?: Row;
}

export async function queueBotMessage(tx: Sql, ctx: Ctx, bot: BotMessage): Promise<void> {
    const { client, template, key, ticket, cycleId, extra = {} } = bot;

    if (await one(tx, 'SELECT id FROM deliveries WHERE logical_key=$1', [key])) {
        return;
    }

    const text = await render(tx, ctx.org, template, {
        ticket_number: ticket ? formatTicketNumber(ticket.ticket_number) : '',
        policy_url: ctx.config.POLICY_URL,
        alternative_contact: ctx.config.ALTERNATIVE_CONTACT,
    });

    const message = ticket
        ? await addMessage(tx, ctx, ticket, {
              author: 'bot',
              authorId: null,
              text,
              providerRef: null,
              state: 'queued',
          })
        : undefined;

    await tx.query(
        `INSERT INTO deliveries(org_id,client_id,ticket_id,message_id,cycle_id,logical_key,kind,body)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
            ctx.org,
            client.id,
            ticket?.id ?? null,
            message?.id ?? null,
            cycleId ?? null,
            key,
            template,
            JSON.stringify({ text, ...extra }),
        ],
    );
}
