import type { Ctx } from '../../shared/context.js';
import { requireOne, type Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

import { clearPreconsentBuffers } from './preconsent-buffers.js';

/**
 * Records consent under the current policy. Returns the updated client, or undefined when the
 * client had already consented to this policy version (nothing to do).
 */
export async function grantConsent(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  sourceKey: string,
): Promise<Client | undefined> {
  const policy = ctx.config.POLICY_VERSION;
  if (client.consent_state === 'granted' && client.consent_version === policy) {
    return undefined;
  }
  const granted = await requireOne<Client>(
    tx,
    `UPDATE clients SET consent_state='granted',consent_version=$2,consent_at=now(),
       consent_revision=consent_revision+1
     WHERE id=$1 RETURNING *`,
    [client.id, policy],
  );
  await tx.query(
    "INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'grant',$3)",
    [ctx.org, granted.id, policy],
  );
  await queueBotMessage(tx, ctx, {
    client: granted,
    template: 'consent_accepted',
    key: `accepted:${sourceKey}`,
  });
  return granted;
}

export async function declineConsent(
  tx: Sql,
  ctx: Ctx,
  client: Client,
  sourceKey: string,
): Promise<void> {
  // An old decline button cannot revoke a consent already granted by a newer action.
  if (client.consent_state === 'granted') {
    return;
  }
  await tx.query("UPDATE clients SET consent_state='declined' WHERE id=$1", [client.id]);
  await clearPreconsentBuffers(tx, client.id);
  await tx.query(
    "INSERT INTO consent_events(org_id,client_id,action,policy_version) VALUES($1,$2,'decline',$3)",
    [ctx.org, client.id, ctx.config.POLICY_VERSION],
  );
  await queueBotMessage(tx, ctx, {
    client,
    template: 'consent_declined',
    key: `declined:${sourceKey}`,
  });
}
