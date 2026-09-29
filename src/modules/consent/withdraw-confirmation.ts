import { consentKeyboard } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

import { callbackButtons } from './callback-buttons.js';
import { withdrawConsent } from './withdraw.js';

const WITHDRAW_BUTTONS = [
    ['withdraw', 'Отозвать'],
    ['keep', 'Отмена'],
] as const;

export async function confirmWithdrawal(tx: Sql, ctx: Ctx, client: Client, sourceKey: string): Promise<void> {
    if (client.consent_state !== 'granted') {
        await withdrawConsent(tx, ctx, client, sourceKey);

        return;
    }

    await queueBotMessage(tx, ctx, {
        client,
        template: 'withdraw_confirm',
        key: `withdraw-confirm:${sourceKey}`,
        extra: { attachments: [consentKeyboard(await callbackButtons(tx, ctx, client, WITHDRAW_BUTTONS))] },
    });
}
