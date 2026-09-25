import { one } from '../../../shared/db.js';
import { ensure } from '../../../shared/errors.js';
import { audit } from '../../../shared/events.js';
import type { CliCommand } from '../cli-command.js';

export const permitResolveCommand: CliCommand = async ({ db, config, args }) => {
    const slot = Number(args.at(0));
    const evidence = args.at(1);

    ensure(
        Number.isInteger(slot) && slot >= 1 && slot <= 15 && evidence !== undefined && evidence.length >= 20,
        'provider_evidence_required',
        422,
    );

    await db.tx(async (tx) => {
        const permit = await one(tx, 'SELECT * FROM ai_permits WHERE slot=$1 FOR UPDATE', [slot]);

        ensure(permit?.state === 'uncertain', 'permit_not_uncertain');

        await audit(tx, config.ORG_ID, {
            actor: null,
            action: 'ai.permit.resolved',
            objectId: String(slot),
            detail: {
                evidence,
                holder: permit.holder,
            },
        });

        await tx.query(
            `UPDATE ai_calls SET state='failed',reason='operator_confirmed_ended',finished_at=now()
       WHERE id=$1`,
            [permit.holder],
        );

        await tx.query("UPDATE ai_permits SET state='free',holder=NULL,started_at=NULL WHERE slot=$1", [slot]);
    });

    return 'Permit released using recorded operator evidence.';
};
