import type { Ctx } from '../../shared/context.js';
import { token } from '../../shared/crypto.js';
import type { Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { currentPolicyVersion } from '../business/index.js';

export async function callbackButtons(
    tx: Sql,
    ctx: Ctx,
    client: Client,
    actions: readonly (readonly [action: string, label: string])[],
): Promise<{ text: string; payload: string }[]> {
    const buttons = [];
    const policyVersion = await currentPolicyVersion(tx, ctx);

    for (const [action, label] of actions) {
        const nonce = token();

        await tx.query(
            `INSERT INTO callback_actions(nonce,org_id,client_id,action,policy_version)
       VALUES($1,$2,$3,$4,$5)`,
            [nonce, ctx.org, client.id, action, policyVersion],
        );

        buttons.push({ text: label, payload: nonce });
    }

    return buttons;
}
