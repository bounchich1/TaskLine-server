import type { FastifyInstance, FastifyRequest } from 'fastify';

import { authenticate } from '../../modules/staff/index.js';
import { can } from '../../shared/access.js';
import type { Config } from '../../shared/config.js';
import { equal, hash } from '../../shared/crypto.js';
import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { sessionToken } from '../../shared/http/request.js';
import type { RouteAccess } from '../../shared/http/route-access.js';

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Authorization,X-CSRF-Token,Idempotency-Key,If-Match,Last-Event-ID';

export function addOriginHook(app: FastifyInstance, config: Config): void {
    app.addHook('onRequest', async (request, reply) => {
        const origin = request.headers.origin;

        if (origin === config.APP_ORIGIN) {
            reply
                .header('Access-Control-Allow-Origin', origin)
                .header('Access-Control-Allow-Credentials', 'true')
                .header('Vary', 'Origin');
        }

        if (request.method === 'OPTIONS') {
            ensure(origin === config.APP_ORIGIN, 'origin_denied', 403);

            return reply
                .header('Access-Control-Allow-Methods', ALLOWED_METHODS)
                .header('Access-Control-Allow-Headers', ALLOWED_HEADERS)
                .code(204)
                .send();
        }

        if (request.url.startsWith('/v1/')) {
            reply.header('Cache-Control', 'no-store');

            if (request.method !== 'GET') {
                ensure(origin === config.APP_ORIGIN, 'origin_denied', 403);
            }
        }
    });
}

export function addSessionHook(app: FastifyInstance, db: Database, config: Config): void {
    app.addHook('onRoute', (route) => {
        if (route.url.startsWith('/v1/') && !route.config?.access) {
            throw new Error(`Route ${String(route.method)} ${route.url} must declare its access rule`);
        }
    });

    app.addHook('preHandler', async (request) => {
        const rule = request.routeOptions.config.access;

        if (!request.url.startsWith('/v1/') || rule === 'public') {
            return;
        }

        request.staff = await authenticate(db, config.ORG_ID, sessionToken(request));

        if (request.method !== 'GET') {
            const csrf = request.headers['x-csrf-token'];

            ensure(typeof csrf === 'string' && equal(hash(csrf), request.staff.csrfHash), 'csrf_failed', 403);
        }

        authorizeRoute(request, rule);
    });
}

function authorizeRoute(request: FastifyRequest, rule: Exclude<RouteAccess, 'public'> | undefined): void {
    if (rule === undefined) {
        ensure(request.is404, 'forbidden', 403);

        return;
    }

    if (rule !== 'session') {
        ensure(request.staff && can(request.staff.employee, rule), 'forbidden', 403);
    }
}
