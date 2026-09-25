import { requireOne } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { audit } from '../../../shared/events.js';
import type { CliCommand } from '../cli-command.js';

export const aiCapCommand: CliCommand = async ({ db, config, args }) => {
  const cap = Number(args[0]);
  ensure(Number.isInteger(cap) && cap >= 10 && cap <= 15, 'invalid_cap', 422);
  await db.tx(async (tx) => {
    await tx.query('SELECT id FROM ai_settings WHERE id=1 FOR UPDATE');
    const busy = await requireOne(
      tx,
      "SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'",
    );
    ensure(Number(busy.n) <= cap, 'drain_required');
    await tx.query('UPDATE ai_settings SET cap=$1 WHERE id=1', [cap]);
    await audit(tx, config.ORG_ID, {
      actor: null,
      action: 'ai.cap.changed',
      objectId: '1',
      detail: { cap },
    });
  });
  return 'Global AI cap updated.';
};
