import { createHmac } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { useStrictJsonParser } from '../src/app/http/strict-json-parser.js';
import { StaffBot, staffBotRoutes, verifyLaunch } from '../src/modules/staff/index.js';
import type { Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';

const now = 1800000000000;
const started = { update_type: 'bot_started', chat_id: 500, user: { user_id: 42 }, timestamp: 1 };

function signedLaunch(token: string) {
    const fields = { auth_date: String(now / 1000), user: '{"id":42}' };

    const canonical = Object.entries(fields)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const key = createHmac('sha256', 'WebAppData').update(token).digest();

    return new URLSearchParams({
        ...fields,
        hash: createHmac('sha256', key).update(canonical).digest('hex'),
    }).toString();
}

function directMessage(sender: Row, chatType = 'dialog') {
    return {
        update_type: 'message_created',
        message: {
            sender,
            recipient: { chat_id: 501, chat_type: chatType },
            body: { mid: 'staff-m1', text: 'Привет' },
        },
    };
}

function recordingBot() {
    const send = vi.fn<(chatId: string, body: Row) => Promise<string>>().mockResolvedValue('mid');

    return { send, bot: new StaffBot({ send }) };
}

describe('staff bot launch', () => {
    it('accepts launches signed by either bot and rejects any other token', () => {
        const tokens = ['staff-token', 'client-token'];

        expect(verifyLaunch(signedLaunch('staff-token'), tokens, now).userId).toBe('42');
        expect(verifyLaunch(signedLaunch('client-token'), tokens, now).userId).toBe('42');
        expect(() => verifyLaunch(signedLaunch('other-token'), tokens, now)).toThrow();
        expect(() => verifyLaunch(signedLaunch('staff-token'), ['', ''], now)).toThrow();
    });
});

describe('staff bot config', () => {
    it('requires the staff token for a live staff webhook and a header-safe secret', () => {
        const live = { MAX_MODE: 'live', MAX_BOT_TOKEN: 'client-token', MAX_STAFF_WEBHOOK_SECRET: 's'.repeat(40) };

        expect(() => testConfig(live)).toThrow('MAX_STAFF_BOT_TOKEN');
        expect(testConfig({ ...live, MAX_STAFF_BOT_TOKEN: 'staff-token' }).MAX_STAFF_BOT_TOKEN).toBe('staff-token');
        expect(() => testConfig({ MAX_STAFF_WEBHOOK_SECRET: 'short' })).toThrow();
        expect(() => testConfig({ MAX_STAFF_WEBHOOK_SECRET: `${'s'.repeat(40)}!` })).toThrow();
    });
});

describe('staff bot replies', () => {
    it('answers a start or a direct message with the sender MAX id', async () => {
        const { send, bot } = recordingBot();

        await bot.answer(JSON.stringify(started));
        await bot.answer(JSON.stringify(directMessage({ user_id: 43 })));

        expect(send.mock.calls.map(([chatId]) => chatId)).toEqual(['500', '501']);
        const [, body] = send.mock.calls[0];

        expect(body.text).toContain('Ваш MAX ID: 42');
        expect(JSON.stringify(body.attachments)).toContain('"type":"clipboard"');
        expect(JSON.stringify(body.attachments)).toContain('"payload":"42"');
    });

    it('ignores bots, group chats, callbacks and malformed updates', async () => {
        const { send, bot } = recordingBot();

        await bot.answer(JSON.stringify(directMessage({ user_id: 43, is_bot: true })));
        await bot.answer(JSON.stringify(directMessage({ user_id: 43 }, 'chat')));
        await bot.answer(JSON.stringify({ update_type: 'message_callback', callback: { user: { user_id: 43 } } }));
        await bot.answer('{not json');

        expect(send).not.toHaveBeenCalled();
    });
});

describe('staff bot webhook', () => {
    it('exists only with a secret and rejects requests without it', async () => {
        const secret = 's'.repeat(40);
        const plain = await fixture();
        const plainApp = await buildApi(plain.db, plain.c);
        const context = await fixture(undefined, testConfig({ MAX_STAFF_WEBHOOK_SECRET: secret }));
        const app = await buildApi(context.db, context.c);
        const request = { method: 'POST' as const, url: '/webhooks/max-staff', payload: started };

        try {
            expect((await plainApp.inject(request)).statusCode).toBe(404);
            expect((await app.inject(request)).statusCode).toBe(401);

            expect(
                (await app.inject({ ...request, headers: { 'x-max-bot-api-secret': 'x'.repeat(40) } })).statusCode,
            ).toBe(401);

            expect((await app.inject({ ...request, headers: { 'x-max-bot-api-secret': secret } })).statusCode).toBe(
                200,
            );
        } finally {
            await Promise.all([plainApp.close(), app.close()]);
            await Promise.all([plain.db.close(), context.db.close()]);
        }
    });

    it('hands the raw update to the bot and acknowledges before the reply', async () => {
        const secret = 's'.repeat(40);
        const { send, bot } = recordingBot();
        const app = Fastify();

        useStrictJsonParser(app);
        await app.register(staffBotRoutes, { bot, secret });

        const response = await app.inject({
            method: 'POST',
            url: '/webhooks/max-staff',
            headers: { 'x-max-bot-api-secret': secret },
            payload: started,
        });

        expect(response.statusCode).toBe(200);

        await vi.waitFor(() => {
            expect(send).toHaveBeenCalledOnce();
        });

        expect(send.mock.calls[0][0]).toBe('500');
        await app.close();
    });
});
