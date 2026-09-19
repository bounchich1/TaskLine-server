import { TransportFailure, type MaxTransport } from '../../integrations/max/index.js';
import { one, type Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Row } from '../../shared/types/entities.js';
import type { Files } from '../files/index.js';

import type { ClaimedDelivery } from './claim.js';
import type { Delivery } from './delivery.js';

const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_RETRY_BACKOFF_SECONDS = 1800;
const MAX_RETRIED_ATTEMPTS = 6;

export interface SendDeps {
  db: Database;
  max: MaxTransport;
  files?: Files;
}

export interface SendOutcome {
  state: string;
  reason: string | null;
  /** MAX message id, when the send succeeded. */
  ref: string | null;
  retryAfter: number;
}

/** Body written by queueCallbackAnswer; `callback_id` is absent when the update carried none. */
type CallbackAnswerBody = Row & {
  callback_id?: string;
  notification: string;
};

/**
 * Performs the network side of a claimed delivery. Never throws: every failure, including a
 * missing file worker, becomes an outcome for recordOutcome.
 */
export async function sendDelivery(
  deps: SendDeps,
  { delivery, client }: ClaimedDelivery,
): Promise<SendOutcome> {
  try {
    if (delivery.kind === 'callback_answer') {
      const answer = delivery.body as CallbackAnswerBody;
      await deps.max.answer(String(answer.callback_id), answer.notification);
      return delivered(null);
    }
    const body = await withUploadedAttachments(deps, delivery.body);
    if (await wasCanceledMeanwhile(deps.db, delivery)) {
      return {
        state: 'canceled',
        reason: null,
        ref: null,
        retryAfter: DEFAULT_RETRY_AFTER_SECONDS,
      };
    }
    return delivered(await deps.max.send(client.chat_id, body));
  } catch (error) {
    return failureOutcome(error, delivery.attempts);
  }
}

function delivered(ref: string | null): SendOutcome {
  return { state: 'delivered', reason: null, ref, retryAfter: DEFAULT_RETRY_AFTER_SECONDS };
}

/** Replaces `attachment_ids` with MAX upload tokens for each file. */
async function withUploadedAttachments(deps: SendDeps, deliveryBody: Row): Promise<Row> {
  const { attachment_ids: attachmentIds, ...body } = deliveryBody;
  if (!Array.isArray(attachmentIds) || !attachmentIds.length) {
    return body;
  }
  ensure(deps.files, 'file_worker_unavailable', 503);
  const attachments: Row[] = [];
  body.attachments = attachments;
  for (const id of attachmentIds as string[]) {
    attachments.push(await uploadAttachment(deps.max, deps.files, id));
  }
  return body;
}

async function uploadAttachment(max: MaxTransport, files: Files, id: string): Promise<Row> {
  const file = await files.materialize(id);
  try {
    return await max.upload(file.kind, file.path, file.filename, file.mime);
  } finally {
    await file.cleanup();
  }
}

/** Rechecked after potentially slow media preparation, right before the customer send. */
async function wasCanceledMeanwhile(db: Database, delivery: Delivery): Promise<boolean> {
  const current = await one(
    db,
    `SELECT d.state,c.consent_state FROM deliveries d JOIN clients c ON c.id=d.client_id
     WHERE d.id=$1`,
    [delivery.id],
  );
  return (
    current?.state !== 'sending' ||
    (delivery.kind === 'staff' && current.consent_state !== 'granted')
  );
}

function failureOutcome(error: unknown, attempts: number): SendOutcome {
  const failure =
    error instanceof TransportFailure ? error : new TransportFailure('unknown', 'delivery_unknown');
  return {
    state: failureState(failure, attempts),
    reason: failure.reason,
    ref: null,
    retryAfter: Math.max(failure.retryAfter, Math.min(MAX_RETRY_BACKOFF_SECONDS, 2 ** attempts)),
  };
}

/** Retryable failures are retried with backoff up to the attempt limit, then give up. */
function failureState(failure: TransportFailure, attempts: number): string {
  if (failure.outcome !== 'retry') {
    return failure.outcome;
  }
  return attempts <= MAX_RETRIED_ATTEMPTS ? 'retry_wait' : 'failed';
}
