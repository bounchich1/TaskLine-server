import { MENU_LABELS } from '../../integrations/max/index.js';
import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';
import { confirmWithdrawal, passesConsentGate, withdrawConsent } from '../consent/index.js';
import { reviseClientMessage } from '../messages/index.js';
import { queueBotMessage } from '../outbox/index.js';
import { handleClientContent, sendTicketHistory } from '../tickets/index.js';

import { handleCallback } from './callback.js';

type ClientCommand = (tx: Sql, ctx: Ctx, client: Client, sourceKey: string) => Promise<void>;

const sendHelp: ClientCommand = (tx, ctx, client, sourceKey) =>
    queueBotMessage(tx, ctx, { client, template: 'help', key: `help:${sourceKey}` });

const COMMANDS = new Map<string, ClientCommand>([
    ['/withdraw', withdrawConsent],
    [MENU_LABELS.withdraw.toLowerCase(), confirmWithdrawal],
    ['/tickets', sendTicketHistory],
    [MENU_LABELS.tickets.toLowerCase(), sendTicketHistory],
    ['/help', sendHelp],
    ['/menu', sendHelp],
    ['меню', sendHelp],
    [MENU_LABELS.help.toLowerCase(), sendHelp],
]);

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
    const run = COMMANDS.get(command);

    if (run) {
        await run(tx, ctx, client, input.sourceKey);

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
