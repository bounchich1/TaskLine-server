import type { Ctx } from '../../shared/context.js';
import { decrypt } from '../../shared/crypto.js';
import { requireOne, type Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';
import { clearPreconsentBuffers, grantConsent, listPreconsentBuffers } from '../consent/index.js';
import { queueBotMessage } from '../outbox/index.js';
import { handleClientContent } from '../tickets/index.js';

/**
 * The client pressed "agree": record consent, then replay the messages they sent before
 * consenting (those still within retention) as if they had just arrived.
 */
export async function acceptConsent(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  sourceKey: string,
): Promise<void> {
  const granted = await grantConsent(tx, ctx, client, sourceKey);
  if (!granted) {
    return;
  }
  const buffers = await listPreconsentBuffers(tx, granted.id);
  const now = await requireOne(tx, 'SELECT now() AS now');
  let expired = false;
  for (const buffer of buffers) {
    if (new Date(buffer.expires_at).getTime() <= new Date(String(now.now)).getTime()) {
      expired = true;
      continue;
    }
    await handleClientContent(tx, ctx, {
      client: granted,
      input: decrypt<ClientInput>(buffer.payload, ctx.config.ENCRYPTION_KEY),
      receivedAt: buffer.created_at,
    });
  }
  await clearPreconsentBuffers(tx, granted.id);
  if (expired) {
    await queueBotMessage(tx, ctx, {
      client: granted,
      template: 'buffer_expired',
      key: `expired:${sourceKey}`,
    });
  }
}
