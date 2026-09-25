import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';
import { passesConsentGate, withdrawConsent } from '../consent/index.js';
import { reviseClientMessage } from '../messages/index.js';
import { queueBotMessage } from '../outbox/index.js';
import { handleClientContent, sendTicketHistory } from '../tickets/index.js';

import { handleCallback } from './callback.js';

const WITHDRAW_COMMANDS = ['/withdraw', 'отозвать согласие'];
const HISTORY_COMMANDS = ['/tickets', 'мои обращения'];

export interface RoutedInput {
    client: Client;
    input: ClientInput;
    receivedAt: string;
}

export async function routeClientInput(tx: Sql, ctx: Ctx, { client, input, receivedAt }: RoutedInput): Promise<void> {
    if (input.kind === 'callback') {
        await handleCallback(tx, ctx, client, input);

        return;
    }

    if (input.kind === 'edit' || input.kind === 'delete') {
        await reviseClientMessage(tx, ctx, client, input);

        return;
    }

    const command = input.text?.trim().toLowerCase() ?? '';

    if (WITHDRAW_COMMANDS.includes(command)) {
        await withdrawConsent(tx, ctx, client, input.sourceKey);

        return;
    }

    if (HISTORY_COMMANDS.includes(command)) {
        await sendTicketHistory(tx, ctx, client, input.sourceKey);

        return;
    }

    if (!(await passesConsentGate(tx, ctx, client, input))) {
        return;
    }

    if (input.kind === 'started' || command === '/start') {
        await queueBotMessage(tx, ctx, {
            client,
            template: 'consent_accepted',
            key: `ready:${input.sourceKey}`,
        });

        return;
    }

    await handleClientContent(tx, ctx, { client, input, receivedAt });
}
