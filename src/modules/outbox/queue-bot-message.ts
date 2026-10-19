import { menuKeyboard } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { formatTicketNumber } from '../../shared/ticket-number.js';
import type { Client, Row, Ticket } from '../../shared/types/entities.js';
import { readBotSettings, type MenuLabels } from '../business/index.js';
import { addMessage } from '../messages/index.js';
import { render } from '../templates/index.js';

const MENU_TEMPLATES = new Set([
    'consent_accepted',
    'ticket_created',
    'ticket_created_eta',
    'outside_hours',
    'ticket_reopened',
    'incident_known',
    'incident_closed',
    'auto_closed',
    'rating_accepted',
    'rating_attempts_exhausted',
    'rating_expired',
    'help',
]);

export interface BotMessage {
    client: Client;
    template: string;
    key: string;
    ticket?: Ticket;
    cycleId?: string;
    extra?: Row;
    values?: Record<string, string>;
}

export async function queueBotMessage(tx: Sql, ctx: Ctx, bot: BotMessage): Promise<void> {
    const { client, template, key, ticket, cycleId, extra = {}, values = {} } = bot;

    if (await one(tx, 'SELECT id FROM deliveries WHERE logical_key=$1', [key])) {
        return;
    }

    const settings = await readBotSettings(tx, ctx);

    const text = await render(tx, ctx.org, template, {
        ticket_number: ticket ? formatTicketNumber(ticket.ticket_number) : '',
        policy_url: settings.policyUrl,
        alternative_contact: settings.alternativeContact,
        menu_tickets: settings.menu.tickets,
        menu_help: settings.menu.help,
        menu_withdraw: settings.menu.withdraw,
        ...values,
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
            JSON.stringify({ text, ...withMenu(template, settings.menu), ...extra }),
        ],
    );
}

function withMenu(template: string, labels: MenuLabels): Row {
    return MENU_TEMPLATES.has(template) ? { attachments: [menuKeyboard(labels)] } : {};
}
