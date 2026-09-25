import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';
import { declineConsent, sendConsentPrompt } from '../consent/index.js';
import { queueCallbackAnswer } from '../outbox/index.js';

import { acceptConsent } from './accept-consent.js';

export async function handleCallback(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  input: ClientInput,
): Promise<void> {
  const action = await one(
    tx,
    `SELECT * FROM callback_actions
     WHERE nonce=$1 AND org_id=$2 AND client_id=$3 AND expires_at>now()
     FOR UPDATE`,
    [input.callbackPayload ?? '', ctx.org, client.id],
  );
  await queueCallbackAnswer(tx, ctx, client, {
    sourceKey: input.sourceKey,
    callbackId: input.callbackId,
    notification: action ? 'Принято' : 'Кнопка устарела',
  });
  if (!action || action.used_at) {
    return;
  }
  await tx.query('UPDATE callback_actions SET used_at=now() WHERE nonce=$1', [
    input.callbackPayload,
  ]);
  if (action.policy_version !== ctx.config.POLICY_VERSION) {
    await sendConsentPrompt(tx, ctx, client, input.sourceKey);
    return;
  }
  if (action.action === 'accept') {
    await acceptConsent(tx, ctx, client, input.sourceKey);
  } else if (action.action === 'decline') {
    await declineConsent(tx, ctx, client, input.sourceKey);
  }
}
