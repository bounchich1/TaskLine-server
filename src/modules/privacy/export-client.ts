import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Row } from '../../shared/types/entities.js';

const CLIENT_TICKETS = 'SELECT id FROM tickets WHERE org_id=$1 AND client_id=$2';

const TICKETS = `SELECT t.id,lpad(t.ticket_number::text,greatest(6,length(t.ticket_number::text)),'0') AS number,
   t.status,t.tag,t.urgency,t.created_at,t.closed_at,t.purged_at,t.purge_reason,
   (SELECT c.rating FROM closures c WHERE c.ticket_id=t.id ORDER BY c.cycle_no DESC LIMIT 1) AS rating
 FROM tickets t WHERE t.org_id=$1 AND t.client_id=$2 ORDER BY t.created_at`;

const MESSAGES = `SELECT id,ticket_id,author_type,text,deleted,revision,created_at FROM messages
 WHERE ticket_id IN(${CLIENT_TICKETS}) AND author_type<>'system' AND visibility='client' ORDER BY ticket_id,seq`;

const FILES = `SELECT message_id,filename,kind,bytes FROM attachments
 WHERE ticket_id IN(${CLIENT_TICKETS}) AND message_id IS NOT NULL`;

const CONSENTS = `SELECT action,policy_version,created_at FROM consent_events
 WHERE org_id=$1 AND client_id=$2 ORDER BY created_at`;

export async function exportClient(db: Sql, ctx: Ctx, clientId: string) {
    const client = await one(
        db,
        `SELECT max_user_id,consent_state,consent_version,consent_at,created_at,erased_at
     FROM clients WHERE org_id=$1 AND id=$2`,
        [ctx.org, clientId],
    );

    ensure(client, 'not_found', 404);
    const params = [ctx.org, clientId];
    const organization = await one(db, 'SELECT name FROM organizations WHERE id=$1', [ctx.org]);
    const consents = await db.query(CONSENTS, params);
    const tickets = await db.query(TICKETS, params);
    const messages = await db.query(MESSAGES, params);
    const files = await db.query(FILES, params);

    const messagesOf = (ticketId: unknown) =>
        messages.rows
            .filter((message) => message.ticket_id === ticketId)
            .map((message) => ({
                author: message.author_type,
                text: message.text,
                deleted: message.deleted,
                edited: Number(message.revision) > 1,
                created_at: message.created_at,
                attachments: files.rows
                    .filter((file) => file.message_id === message.id)
                    .map((file) => without(file, 'message_id')),
            }));

    return {
        generated_at: new Date().toISOString(),
        organization: organization?.name ?? null,
        client,
        consent_events: consents.rows,
        tickets: tickets.rows.map((ticket) => ({ ...without(ticket, 'id'), messages: messagesOf(ticket.id) })),
    };
}

function without(row: Row, key: string): Row {
    return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}
