import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ifMatchVersion, idempotencyKey, paramsId, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';
import type { Row } from '../../shared/types/entities.js';

import { COMMAND_SCHEMAS } from './commands/command-schemas.js';
import type { TicketCommands } from './commands/ticket-commands.js';
import { filtersSchema } from './queries/ticket-filters.js';
import type { TicketQueries } from './queries/ticket-queries.js';

interface TicketRouteOptions {
    queries: TicketQueries;
    commands: TicketCommands;
}

const messagePageQuery = z
    .object({
        before: z.coerce.number().int().positive().optional(),
        after: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict();

const memoryIdParam = z.uuid();

export const ticketRoutes: FastifyPluginAsync<TicketRouteOptions> = async (app, options) => {
    addQueryRoutes(app, options.queries);
    addCommandRoutes(app, options.commands);
};

function addQueryRoutes(app: FastifyInstance, queries: TicketQueries): void {
    app.get('/v1/tickets', access('tickets.view'), async (request) => queries.list(filtersSchema.parse(request.query)));

    app.get('/v1/tickets/counts', access('tickets.view'), async (request) =>
        queries.list(filtersSchema.parse(request.query), true),
    );

    app.get('/v1/tickets/:id', access('tickets.view'), async (request) => queries.ticket(paramsId(request)));

    app.get('/v1/tickets/:id/messages', access('tickets.view'), async (request) => {
        const page = messagePageQuery.parse(request.query);

        return queries.messages(paramsId(request), {
            before: page.before,
            after: page.after,
            limit: page.limit,
        });
    });

    app.get('/v1/tickets/:id/sources/:memoryId', access('tickets.view'), async (request) =>
        queries.openSource({
            ticketId: paramsId(request),
            memoryId: memoryIdParam.parse(routeParam(request, 'memoryId')),
            actorId: staffOf(request).employee.id,
        }),
    );
}

function addCommandRoutes(app: FastifyInstance, commands: TicketCommands): void {
    for (const [name, schema] of Object.entries(COMMAND_SCHEMAS)) {
        app.route({
            method: name === 'classification' ? 'PATCH' : 'POST',
            url: `/v1/tickets/:id/${name}`,
            ...access('tickets.work'),
            handler: async (request, reply) => {
                const ticketId = paramsId(request);
                const body = schema.parse(request.body ?? {}) as Row;

                const result = await commands.run({
                    actor: staffOf(request).employee,
                    ticketId,
                    name,
                    body,
                    expectedVersion: ifMatchVersion(request),
                    idempotencyKey: idempotencyKey(request),
                });

                if (name === 'messages') {
                    reply.code(202);
                }

                return result;
            },
        });
    }
}
