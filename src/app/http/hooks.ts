import type { FastifyInstance } from 'fastify';

import { authenticate } from '../../modules/staff/index.js';
import type { Config } from '../../shared/config.js';
import { equal, hash } from '../../shared/crypto.js';
import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { sessionToken } from '../../shared/http/request.js';

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS =
  'Content-Type,Authorization,X-CSRF-Token,Idempotency-Key,If-Match,Last-Event-ID';
/** Login routes: the only /v1 routes reachable without a session. */
const PUBLIC_API_ROUTES = ['/v1/auth/max', '/v1/auth/dev'];

/**
 * CORS for the mini-app origin, preflight answers, and origin checks: /v1 mutations must come
 * from the mini-app. Added on the root instance so it also covers unknown routes.
 */
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

/**
 * Attaches the staff session to every /v1 request except login (unknown /v1 routes answer 401,
 * not 404) and checks the CSRF token on mutations.
 */
export function addSessionHook(app: FastifyInstance, db: Database, config: Config): void {
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/v1/') || PUBLIC_API_ROUTES.includes(request.url)) {
      return;
    }
    request.staff = await authenticate(db, config.ORG_ID, sessionToken(request));
    if (request.method !== 'GET') {
      const csrf = request.headers['x-csrf-token'];
      ensure(
        typeof csrf === 'string' && equal(hash(csrf), request.staff.csrfHash),
        'csrf_failed',
        403,
      );
    }
  });
}
