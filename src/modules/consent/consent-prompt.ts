import { consentKeyboard } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import { token } from '../../shared/crypto.js';
import type { Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

const CONSENT_BUTTONS = [
  ['accept', 'Согласен'],
  ['decline', 'Отказаться'],
] as const;

/**
 * Asks the client for consent under the current policy. Each button carries a single-use nonce
 * bound to the policy version, so a button from an outdated prompt cannot grant consent.
 */
export async function sendConsentPrompt(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  sourceKey: string,
): Promise<void> {
  const buttons = [];
  for (const [action, label] of CONSENT_BUTTONS) {
    const nonce = token();
    await tx.query(
      `INSERT INTO callback_actions(nonce,org_id,client_id,action,policy_version)
       VALUES($1,$2,$3,$4,$5)`,
      [nonce, ctx.org, client.id, action, ctx.config.POLICY_VERSION],
    );
    buttons.push({ type: 'callback', text: label, payload: nonce });
  }
  await queueBotMessage(tx, ctx, {
    client,
    template: 'consent_request',
    key: `consent:${sourceKey}`,
    extra: { attachments: [consentKeyboard(buttons)] },
  });
}
