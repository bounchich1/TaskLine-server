import type { Ctx } from '../../shared/context.js';
import { one, type Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client, Ticket } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

import { sendConsentPrompt } from './consent-prompt.js';
import { bufferPreconsentInput } from './preconsent-buffers.js';

export async function passesConsentGate(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  input: ClientInput,
): Promise<boolean> {
  const openTicket = await one<Ticket>(
    tx,
    "SELECT * FROM tickets WHERE org_id=$1 AND client_id=$2 AND status<>'closed'",
    [ctx.org, client.id],
  );
  const consented =
    client.consent_state === 'granted' &&
    (openTicket !== undefined || client.consent_version === ctx.config.POLICY_VERSION);
  if (consented) {
    return true;
  }
  const command = input.text?.trim().toLowerCase();
  if (input.kind === 'message' && command !== '/start') {
    const buffered = await bufferPreconsentInput(tx, ctx, client, input);
    if (!buffered) {
      await queueBotMessage(tx, ctx, {
        client,
        template: 'buffer_full',
        key: `bufferfull:${input.sourceKey}`,
      });
    }
  }
  await sendConsentPrompt(tx, ctx, client, input.sourceKey);
  return false;
}
