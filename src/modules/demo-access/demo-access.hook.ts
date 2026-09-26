import type { FastifyInstance, FastifyRequest } from 'fastify';

import { equal } from '../../shared/crypto.js';

import type { DemoRoles } from './demo-roles.js';

const WEBHOOK_ROUTE = '/webhooks/max';

interface DemoAccessOptions {
    roles: DemoRoles;
    secret: string;
}

export function addDemoAccessHook(app: FastifyInstance, { roles, secret }: DemoAccessOptions): void {
    app.addHook('preHandler', async (request, reply) => {
        if (request.routeOptions.url !== WEBHOOK_ROUTE || !signedByMax(request, secret)) {
            return;
        }

        const command = roles.read(String(request.body));

        if (!command) {
            return;
        }

        const text = await roles.apply(command);

        if (text) {
            roles.reply(command.chatId, text).catch((error: unknown) => {
                request.log.warn({ err: error }, 'demo_role_reply_failed');
            });
        }

        return reply.code(200).send({ ok: true });
    });
}

function signedByMax(request: FastifyRequest, secret: string): boolean {
    const header = request.headers['x-max-bot-api-secret'];

    return typeof header === 'string' && equal(header, secret);
}
