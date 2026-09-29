import { consentKeyboard } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { Client } from '../../shared/types/entities.js';
import { queueBotMessage } from '../outbox/index.js';

import { callbackButtons } from './callback-buttons.js';

const CONSENT_BUTTONS = [
    ['accept', 'Согласен'],
    ['decline', 'Отказаться'],
] as const;

export async function sendConsentPrompt(tx: Sql, ctx: Ctx, client: Client, sourceKey: string): Promise<void> {
    await queueBotMessage(tx, ctx, {
        client,
        template: 'consent_request',
        key: `consent:${sourceKey}`,
        extra: { attachments: [consentKeyboard(await callbackButtons(tx, ctx, client, CONSENT_BUTTONS))] },
    });
}
