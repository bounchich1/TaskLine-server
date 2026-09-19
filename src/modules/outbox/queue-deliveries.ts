import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { Client, Employee, Message, Ticket } from '../../shared/types/entities.js';

/** Acknowledges a pressed inline button (MAX shows `notification` as a toast). */
export async function queueCallbackAnswer(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  answer: { sourceKey: string; callbackId: string | undefined; notification: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO deliveries(org_id,client_id,logical_key,kind,body)
     VALUES($1,$2,$3,'callback_answer',$4) ON CONFLICT DO NOTHING`,
    [
      ctx.org,
      client.id,
      `answer:${answer.sourceKey}`,
      JSON.stringify({ callback_id: answer.callbackId, notification: answer.notification }),
    ],
  );
}

/** Sends the client the list of their tickets (reply to the history command). */
export async function queueHistoryPage(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  page: { sourceKey: string; text: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO deliveries(org_id,client_id,logical_key,kind,body)
     VALUES($1,$2,$3,'history_page',$4) ON CONFLICT DO NOTHING`,
    [ctx.org, client.id, `history:${page.sourceKey}`, JSON.stringify({ text: page.text })],
  );
}

export interface StaffReply {
  client: Client;
  ticket: Ticket;
  message: Message;
  actor: Employee;
  text: string;
  attachmentIds: string[];
}

/**
 * Queues a staff reply. The sender's id and version are recorded so the delivery worker can
 * re-check their authorization right before sending.
 */
export async function queueStaffReply(tx: Sql, ctx: Ctx, reply: StaffReply): Promise<void> {
  const { client, ticket, message, actor } = reply;
  await tx.query(
    `INSERT INTO deliveries(org_id,client_id,ticket_id,message_id,logical_key,kind,body,staff_id,staff_version)
     VALUES($1,$2,$3,$4,$5,'staff',$6,$7,$8)`,
    [
      ctx.org,
      client.id,
      ticket.id,
      message.id,
      `staff:${message.id}`,
      JSON.stringify({ text: reply.text, attachment_ids: reply.attachmentIds }),
      actor.id,
      actor.version,
    ],
  );
}
