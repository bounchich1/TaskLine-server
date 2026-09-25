import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../../shared/config.js';
import { hash } from '../../shared/crypto.js';
import type { Database } from '../../shared/db.js';
import { AppError, ensure } from '../../shared/errors.js';
import { staffOf } from '../../shared/http/request.js';

import { verifyLaunch, type VerifiedLaunch } from './launch-verification.js';
import { describeSession, issueSession, revokeSession, rotateSession } from './sessions.js';

interface AuthRouteOptions {
  db: Database;
  config: Config;
}

const SESSION_COOKIE = 'support_session';
const SESSION_MAX_AGE_SECONDS = 28800;
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

const maxLoginBody = z.object({ init_data: z.string().min(1).max(16384) }).strict();
const devLoginBody = z.object({ user_id: z.string().regex(/^\d+$/) }).strict();

/** Login (MAX launch or local dev), session info, logout and token rotation. */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  addMaxLogin(app, options);
  addDevLogin(app, options);
  addSessionRoutes(app, options);
};

function addMaxLogin(app: FastifyInstance, { db, config }: AuthRouteOptions): void {
  const rateLimit = { max: 20, timeWindow: '1 minute' };
  app.post('/v1/auth/max', { config: { rateLimit } }, async (request, reply) => {
    const body = maxLoginBody.parse(request.body);
    const launch = verifyLaunchOrReject(body.init_data, config.MAX_BOT_TOKEN);
    const issued = await issueSession(db, config, launch.userId, launch.digest);
    reply.setCookie(SESSION_COOKIE, issued.token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return { ...issued, start_param: launch.startParam ?? null };
  });
}

function verifyLaunchOrReject(initData: string, botToken: string): VerifiedLaunch {
  try {
    return verifyLaunch(initData, botToken);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'invalid_launch',
      401,
      'Не удалось проверить запуск. Откройте приложение из MAX.',
    );
  }
}

/** Sign in as any employee by MAX user id: local development only, from loopback only. */
function addDevLogin(app: FastifyInstance, { db, config }: AuthRouteOptions): void {
  app.post('/v1/auth/dev', async (request, reply) => {
    ensure(
      config.NODE_ENV !== 'production' &&
        config.DEV_AUTH_ENABLED &&
        LOOPBACK_ADDRESSES.includes(request.ip),
      'not_found',
      404,
    );
    const { user_id: userId } = devLoginBody.parse(request.body);
    // Every dev login is a launch of its own. The replay limit guards signed MAX launch data,
    // which a dev login has none of; a local stand reloads far more than 5 times in 5 minutes.
    const issued = await issueSession(db, config, userId, hash(`dev:${userId}:${randomUUID()}`));
    reply.setCookie(SESSION_COOKIE, issued.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return issued;
  });
}

function addSessionRoutes(app: FastifyInstance, { db, config }: AuthRouteOptions): void {
  app.get('/v1/me', async (request) =>
    describeSession(db, config.ORG_ID, staffOf(request).employee),
  );
  app.post('/v1/auth/logout', async (request, reply) => {
    await revokeSession(db, staffOf(request).hash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.post('/v1/auth/refresh', async (request, reply) => {
    const rotated = await rotateSession(db, staffOf(request).hash);
    reply.setCookie(SESSION_COOKIE, rotated.token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    return rotated;
  });
}
