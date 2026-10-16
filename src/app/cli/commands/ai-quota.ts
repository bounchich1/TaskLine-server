import { requireOne } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { audit } from '../../../shared/events.js';
import type { CliCommand } from '../cli-command.js';

export const aiQuotaCommand: CliCommand = async ({ db, config, args }) => {
    const raw = args.at(0) ?? '';
    const quota = raw === 'off' ? null : Number(raw);

    ensure(quota === null || (Number.isInteger(quota) && quota >= 1 && quota <= 15), 'invalid_quota', 422);

    await db.tx(async (tx) => {
        await requireOne(tx, 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [config.ORG_ID]);
        await tx.query('UPDATE organizations SET ai_quota=$2,version=version+1 WHERE id=$1', [config.ORG_ID, quota]);

        await audit(tx, config.ORG_ID, {
            actor: null,
            action: 'ai.quota.changed',
            objectId: config.ORG_ID,
            detail: { quota },
        });
    });

    return quota === null ? 'Organization AI quota removed.' : 'Organization AI quota updated.';
};
