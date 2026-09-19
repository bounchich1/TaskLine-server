import type { Ctx } from '../../shared/context.js';
import { encrypt, hash } from '../../shared/crypto.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import { emit, enqueue } from '../../shared/events.js';
import type { ClientInput, InputAttachment } from '../../shared/types/client-input.js';
import type { Client, Message, Ticket } from '../../shared/types/entities.js';
import { snapshotActiveDictionaries } from '../dictionaries/index.js';
import { addMessage } from '../messages/index.js';
import { queueBotMessage } from '../outbox/index.js';
import { acceptRatingInput } from '../ratings/index.js';

const MAX_TEXT_LENGTH = 16000;
const MAX_ATTACHMENTS = 10;

export interface ClientContent {
  client: Client;
  input: ClientInput;
  receivedAt: string;
}

/**
 * A consenting client wrote to support. The message is a rating when their ticket awaits one;
 * otherwise it is appended to the open ticket, or starts a new ticket (queued for AI triage).
 */
export async function handleClientContent(
  tx: Sql,
  ctx: Ctx,
  { client, input, receivedAt }: ClientContent,
): Promise<void> {
  const openTicket = await one<Ticket>(
    tx,
    "SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 AND status<>'closed' FOR UPDATE",
    [ctx.org, client.id],
  );
  if (openTicket?.status === 'awaiting_rating') {
    await acceptRatingInput(tx, ctx, { client, ticket: openTicket, input, receivedAt });
    return;
  }
  const text = input.text?.trim() ?? '';
  const attachments = input.attachments ?? [];
  const rejection = rejectionFor(text, attachments);
  if (rejection) {
    await queueBotMessage(tx, ctx, {
      client,
      template: rejection.template,
      key: `${rejection.keyPrefix}:${input.sourceKey}`,
    });
    return;
  }
  const ticket = openTicket ?? (await createTicket(tx, ctx, client, { text, attachments }));
  const message = await addMessage(tx, ctx, ticket, {
    author: 'client',
    authorId: null,
    text,
    providerRef: input.messageId ?? null,
    state: 'received',
    timestamp: input.timestamp,
  });
  await storeAttachments(tx, ctx, { ticket, message, attachments });
  if (openTicket) {
    await emit(tx, ctx.org, {
      type: 'message.from_client',
      ticketId: ticket.id,
      payload: { message_id: message.id },
      employeeId: ticket.assignee_id,
    });
  } else {
    await announceNewTicket(tx, ctx, { client, ticket, message });
  }
}

function rejectionFor(
  text: string,
  attachments: InputAttachment[],
): { template: string; keyPrefix: string } | undefined {
  if (text.length > MAX_TEXT_LENGTH) {
    return { template: 'input_too_long', keyPrefix: 'toolong' };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { template: 'attachment_rejected', keyPrefix: 'toomany' };
  }
  if (!text && !attachments.length) {
    return { template: 'unsupported_input', keyPrefix: 'unsupported' };
  }
  return undefined;
}

async function createTicket(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  { text, attachments }: { text: string; attachments: InputAttachment[] },
): Promise<Ticket> {
  const aiEnabled = ctx.config.AI_ENABLED;
  return requireOne<Ticket>(
    tx,
    `INSERT INTO tickets(org_id,client_id,description,consent_version,consent_revision,ai_status,review_required)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      ctx.org,
      client.id,
      text || `Вложение: ${attachments.map((file) => file.filename).join(', ')}`,
      client.consent_version,
      client.consent_revision,
      aiEnabled ? 'pending' : 'failed',
      !aiEnabled,
    ],
  );
}

/** Records the client's files; each is downloaded and scanned by a background job. */
async function storeAttachments(
  tx: Sql,
  ctx: Ctx,
  {
    ticket,
    message,
    attachments,
  }: { ticket: Ticket; message: Message; attachments: InputAttachment[] },
): Promise<void> {
  for (const file of attachments) {
    const attachment = await requireOne<{ id: string }>(
      tx,
      `INSERT INTO attachments(org_id,ticket_id,message_id,filename,kind,source_ref,status)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        ctx.org,
        ticket.id,
        message.id,
        file.filename.slice(0, 200),
        file.kind,
        encrypt(file, ctx.config.ENCRYPTION_KEY),
        'pending',
      ],
    );
    await enqueue(tx, ctx.org, {
      key: `file:${attachment.id}`,
      kind: 'file',
      refId: attachment.id,
    });
  }
}

async function announceNewTicket(
  tx: Sql,
  ctx: Ctx,
  { client, ticket, message }: { client: Client; ticket: Ticket; message: Message },
): Promise<void> {
  await queueBotMessage(tx, ctx, {
    client,
    template: 'ticket_created',
    key: `created:${ticket.id}`,
    ticket,
  });
  const dictionaries = await snapshotActiveDictionaries(tx, ctx.org);
  if (ctx.config.AI_ENABLED) {
    await enqueue(tx, ctx.org, {
      key: `triage:${ticket.id}`,
      kind: 'triage',
      refId: ticket.id,
      payload: {
        message_id: message.id,
        revision: 1,
        lifecycle: ticket.lifecycle,
        consent_revision: client.consent_revision,
        dictionaries,
        dictionary_version: hash(JSON.stringify(dictionaries)),
        field_revisions: { tag: 0, urgency: 0, complexity: 0 },
      },
    });
  }
  // `ticket.version` already includes the bump from appending the first message.
  await emit(tx, ctx.org, {
    type: 'ticket.created',
    ticketId: ticket.id,
    payload: { version: ticket.version },
  });
}
