import type { Ctx } from '../../shared/context.js';
import type { Sql } from '../../shared/db.js';
import type { ClientInput } from '../../shared/types/client-input.js';
import type { Client } from '../../shared/types/entities.js';
import { menuActionFor, readBotSettings, type MenuAction } from '../business/index.js';
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
    ['/tickets', sendTicketHistory],
    ['/help', sendHelp],
    ['/menu', sendHelp],
    ['меню', sendHelp],
]);

const MENU_COMMANDS: Record<MenuAction, ClientCommand> = {
    tickets: sendTicketHistory,
    help: sendHelp,
    withdraw: confirmWithdrawal,
};

const MAX_MENU_LABEL = 40;

async function findCommand(tx: Sql, ctx: Ctx, command: string): Promise<ClientCommand | undefined> {
    const fixed = COMMANDS.get(command);

    if (fixed || !command || command.length > MAX_MENU_LABEL) {
        return fixed;
    }

    const action = menuActionFor((await readBotSettings(tx, ctx)).menu, command);

    return action ? MENU_COMMANDS[action] : undefined;
}

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
    const run = await findCommand(tx, ctx, command);

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
