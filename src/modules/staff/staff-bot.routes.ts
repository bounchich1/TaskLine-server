import type { FastifyPluginAsync } from 'fastify';

import { equal } from '../../shared/crypto.js';
import { ensure } from '../../shared/errors.js';

import type { StaffBot } from './staff-bot.js';

interface StaffBotRouteOptions {
    bot: StaffBot;
    secret: string;
}

export const staffBotRoutes: FastifyPluginAsync<StaffBotRouteOptions> = async (app, { bot, secret }) => {
    app.post('/webhooks/max-staff', async (request, reply) => {
        const header = request.headers['x-max-bot-api-secret'];

        ensure(typeof header === 'string' && equal(header, secret), 'webhook_unauthorized', 401);

        bot.answer(String(request.body)).catch((error: unknown) => {
            request.log.warn({ err: error }, 'staff_bot_reply_failed');
        });

        return reply.code(200).send({ ok: true });
    });
};
