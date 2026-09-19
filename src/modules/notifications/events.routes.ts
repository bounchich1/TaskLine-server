import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';

import { UiEventStream } from './event-stream.js';
import { writeEventStreamHead } from './sse.js';

const eventsQuery = z.object({ cursor: z.string().regex(/^\d+$/).optional() }).strict();

/** Live UI updates (SSE). Resumes after `?cursor=` or the browser's `Last-Event-ID`. */
export const eventsRoutes: FastifyPluginAsync<{ db: Database; config: Config }> = async (
  app,
  { db, config },
) => {
  app.get('/v1/events', async (request, reply) => {
    const query = eventsQuery.parse(request.query);
    const cursor = query.cursor ?? String(request.headers['last-event-id'] ?? '0');
    ensure(/^\d+$/.test(cursor), 'invalid_cursor', 422);
    reply.hijack();
    const corsOrigin = request.headers.origin === config.APP_ORIGIN ? config.APP_ORIGIN : undefined;
    writeEventStreamHead(reply.raw, corsOrigin);
    await new UiEventStream({ db, org: config.ORG_ID, request, raw: reply.raw }, cursor).run();
  });
};
