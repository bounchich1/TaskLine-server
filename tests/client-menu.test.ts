import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { one } from '../src/shared/db.js';

import { fixture } from './helpers.js';
let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
});

afterEach(async () => {
    await context.db.close();
});

describe('client menu', () => {
    const menuButtons = async (kind: string) => {
        const delivery = await one(context.db, 'SELECT body FROM deliveries WHERE kind=$1 ORDER BY created_at DESC', [
            kind,
        ]);

        const body = (typeof delivery!.body === 'string' ? JSON.parse(delivery!.body) : delivery!.body) as {
            attachments?: { type: string; payload: { buttons: { type: string; text: string }[][] } }[];
        };

        return body.attachments?.flatMap((attachment) => attachment.payload.buttons.flat());
    };

    const press = async (action: string) => {
        const client = await one(context.db, 'SELECT * FROM clients');

        const pressed = await one(
            context.db,
            'SELECT nonce FROM callback_actions WHERE client_id=$1 AND action=$2 AND used_at IS NULL',
            [client!.id, action],
        );

        await context.domain.ingest({
            kind: 'callback',
            userId: '100',
            chatId: '100',
            sourceKey: `press-${randomUUID()}`,
            callbackId: `press-${action}`,
            callbackPayload: String(pressed!.nonce),
        });

        await context.domain.processClient(String(client!.id));
    };

    it('attaches message buttons that route back to client commands', async () => {
        await context.create();
        const labels = ['Мои обращения', 'Помощь', 'Отозвать согласие'];

        for (const kind of ['consent_accepted', 'ticket_created']) {
            expect((await menuButtons(kind))?.map((button) => [button.type, button.text])).toEqual(
                labels.map((label) => ['message', label]),
            );
        }

        await context.input('Мои обращения');
        expect((await menuButtons('history_page'))?.map((button) => button.text)).toEqual(labels);
        await context.input('Помощь');
        expect((await menuButtons('help'))?.map((button) => button.text)).toEqual(labels);
        expect((await menuButtons('consent_request'))?.map((button) => button.type)).toEqual(['callback', 'callback']);

        expect(
            (await context.db.query("SELECT text FROM messages WHERE author_type='client' ORDER BY seq")).rows,
        ).toEqual([{ text: 'Не работает подключение' }]);
    });

    it('asks before withdrawing from the menu button; cancel keeps the ticket', async () => {
        await context.create();
        await context.input('Отозвать согласие');
        expect((await context.ticket()).status).toBe('open');
        expect((await menuButtons('withdraw_confirm'))?.map((button) => button.text)).toEqual(['Отозвать', 'Отмена']);

        await press('keep');
        expect((await context.ticket()).status).toBe('open');
        expect((await one(context.db, 'SELECT consent_state FROM clients'))!.consent_state).toBe('granted');

        await context.input('Отозвать согласие');
        await press('withdraw');
        expect((await context.ticket()).status).toBe('closed');
        expect((await one(context.db, 'SELECT consent_state FROM clients'))!.consent_state).toBe('withdrawn');
        expect((await one(context.db, 'SELECT count(*)::int AS n FROM callback_actions'))!.n).toBe(0);
    });
});
