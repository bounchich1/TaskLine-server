import type { Database } from '../../../shared/db.js';

import type { Permit } from './admission.js';

/** Stores the encrypted reply and frees the permit. */
export async function settleSuccess(
  db: Database,
  {
    callId,
    permit,
    encryptedReply,
    usage,
  }: {
    callId: string;
    permit: Permit;
    encryptedReply: string;
    usage: string;
  },
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE ai_calls SET state='completed',response=$2,usage=$3,finished_at=now()
       WHERE id=$1 AND state='running'`,
      [callId, encryptedReply, usage],
    );
    await tx.query(
      `UPDATE ai_permits SET state='free',holder=NULL,started_at=NULL,provider_ref=NULL
       WHERE slot=$1 AND holder=$2 AND generation=$3`,
      [permit.slot, callId, permit.generation],
    );
  });
}

/**
 * A call that is known not to have run remotely (or was rejected) fails and frees its permit.
 * Otherwise the provider may still be working on it: the call becomes `uncertain` and keeps
 * its permit until an operator resolves it, so the concurrency cap is never exceeded.
 */
export async function settleFailure(
  db: Database,
  { callId, permit, known }: { callId: string; permit: Permit; known: boolean },
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE ai_calls SET state=$2,reason=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END
       WHERE id=$1 AND state='running'`,
      [
        callId,
        known ? 'failed' : 'uncertain',
        known ? 'provider_rejected' : 'remote_outcome_unknown',
      ],
    );
    await tx.query(
      `UPDATE ai_permits SET state=$4,holder=CASE WHEN $4='free' THEN NULL ELSE holder END
       WHERE slot=$1 AND holder=$2 AND generation=$3`,
      [permit.slot, callId, permit.generation, known ? 'free' : 'uncertain'],
    );
  });
}
