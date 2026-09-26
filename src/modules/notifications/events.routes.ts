import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../../shared/config.js';
import { one, type Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { access } from '../../shared/http/route-access.js';

import { UiEventStream } from './event-stream.js';
import { writeEventStreamHead } from './sse.js';

const eventsQuery = z.object({ cursor: z.string().regex(/^\d+$/).optional() }).strict();

async function latestCursor(db: Database, org: string): Promise<string> {
    const row = await one<{ cursor: string }>(db, 'SELECT cursor::text FROM organizations WHERE id=$1', [org]);

    return row?.cursor ?? '0';
}

export const eventsRoutes: FastifyPluginAsync<{ db: Database; config: Config }> = async (app, { db, config }) => {
    app.get('/v1/events', access('tickets.view'), async (request, reply) => {
        const query = eventsQuery.parse(request.query);
        const lastEventId = request.headers['last-event-id'];

        const cursor =
            query.cursor ?? (lastEventId === undefined ? await latestCursor(db, config.ORG_ID) : String(lastEventId));

        ensure(/^\d+$/.test(cursor), 'invalid_cursor', 422);
        reply.hijack();
        const corsOrigin = request.headers.origin === config.APP_ORIGIN ? config.APP_ORIGIN : undefined;

        writeEventStreamHead(reply.raw, corsOrigin);
        await new UiEventStream({ db, org: config.ORG_ID, request, raw: reply.raw }, cursor).run();
    });
};
