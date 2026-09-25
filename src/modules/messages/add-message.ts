import type { Ctx } from '../../shared/context.js';
import { requireOne, type Sql } from '../../shared/db.js';
import type { Message, Ticket } from '../../shared/types/entities.js';

export interface NewMessage {
  author: 'client' | 'staff' | 'bot' | 'system';
  authorId: string | null;
  text: string;
  providerRef: string | null;
  state: string;
  timestamp?: number;
}

export async function addMessage(
  tx: Sql,
  ctx: Ctx,
  ticket: Ticket,
  message: NewMessage,
): Promise<Message> {
  const row = await requireOne(
    tx,
    `UPDATE tickets SET last_message_seq=last_message_seq+1,updated_at=now(),version=version+1
     WHERE id=$1 RETURNING last_message_seq,version`,
    [ticket.id],
  );
  ticket.last_message_seq = Number(row.last_message_seq);
  ticket.version = Number(row.version);
  const { timestamp } = message;
  return requireOne<Message>(
    tx,
    `INSERT INTO messages(org_id,ticket_id,seq,author_type,author_id,text,provider_ref,delivery_state,provider_sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      ctx.org,
      ticket.id,
      ticket.last_message_seq,
      message.author,
      message.authorId,
      message.text,
      message.providerRef,
      message.state,
      timestamp && Number.isFinite(timestamp) ? new Date(timestamp) : null,
    ],
  );
}
