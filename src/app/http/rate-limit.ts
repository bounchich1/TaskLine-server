import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';

import type { Config } from '../../shared/config.js';
import { equal } from '../../shared/crypto.js';

const REQUESTS_PER_MINUTE = 180;

export function rateLimitOptions(config: Config): RateLimitPluginOptions {
    const secrets = new Map<string, string>([
        ['/webhooks/max', config.MAX_WEBHOOK_SECRET],
        ['/webhooks/max-staff', config.MAX_STAFF_WEBHOOK_SECRET],
    ]);

    return {
        max: REQUESTS_PER_MINUTE,
        timeWindow: '1 minute',
        allowList: (request) => isSignedWebhook(request, secrets),
    };
}

function isSignedWebhook(request: FastifyRequest, secrets: ReadonlyMap<string, string>): boolean {
    const expected = secrets.get(request.routeOptions.url ?? '');
    const header = request.headers['x-max-bot-api-secret'];

    return !!expected && typeof header === 'string' && equal(header, expected);
}
