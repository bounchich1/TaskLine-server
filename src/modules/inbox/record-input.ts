import type { Ctx } from '../../shared/context.js';
import { encrypt } from '../../shared/crypto.js';
import { one, requireOne, type Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';

/**
 * Durably records an inbound update before it is acknowledged, numbered per client so it is
 * later routed in arrival order. Idempotent by source key; unusable updates are quarantined.
 */
export async function recordInput(tx: Sql, ctx: Ctx, input: ClientInput): Promise<void> {
  if (await alreadyReceived(tx, ctx, input.sourceKey)) {
    return;
  }
  if (!input.userId || !input.chatId || input.kind === 'unknown') {
    await tx.query(
      `INSERT INTO inbox(org_id,source_key,kind,state,reason)
       VALUES($1,$2,$3,'quarantined','unsupported_update') ON CONFLICT DO NOTHING`,
      [ctx.org, input.sourceKey, input.kind],
    );
    return;
  }
  await tx.query(
    'INSERT INTO clients(org_id,max_user_id,chat_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ctx.org, input.userId, input.chatId],
  );
  const client = await requireOne<Client>(
    tx,
    'SELECT * FROM clients WHERE org_id=$1 AND max_user_id=$2 FOR UPDATE',
    [ctx.org, input.userId],
  );
  // A MAX direct user has one dialog; unexpected changes are quarantined for review.
  if (client.chat_id !== input.chatId) {
    await tx.query(
      `INSERT INTO inbox(org_id,source_key,client_id,kind,state,reason)
       VALUES($1,$2,$3,$4,'quarantined','chat_mismatch') ON CONFLICT DO NOTHING`,
      [ctx.org, input.sourceKey, client.id, input.kind],
    );
    return;
  }
  // Checked again now that the client row is locked: a concurrent delivery may have won.
  if (await alreadyReceived(tx, ctx, input.sourceKey)) {
    return;
  }
  const sequence = await requireOne(
    tx,
    'UPDATE clients SET next_ingress=next_ingress+1 WHERE id=$1 RETURNING next_ingress',
    [client.id],
  );
  await tx.query(
    `INSERT INTO inbox(org_id,source_key,client_id,ingress_seq,kind,payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      ctx.org,
      input.sourceKey,
      client.id,
      sequence.next_ingress,
      input.kind,
      encrypt(input, ctx.config.ENCRYPTION_KEY),
    ],
  );
}

async function alreadyReceived(tx: Sql, ctx: Ctx, sourceKey: string): Promise<boolean> {
  const receipt = await one(tx, 'SELECT id FROM inbox WHERE org_id=$1 AND source_key=$2', [
    ctx.org,
    sourceKey,
  ]);
  return receipt !== undefined;
}
