import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Permission } from '../../shared/access.js';
import { runAdminMutation } from '../../shared/admin-mutation.js';
import type { Config } from '../../shared/config.js';
import { createCtx, type Ctx } from '../../shared/context.js';
import type { Database, Sql } from '../../shared/db.js';
import { idempotencyKey, ifMatchVersion, paramsId, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';
import type { Employee, Row } from '../../shared/types/entities.js';

import {
    createBody,
    createIncident,
    dismissIncident,
    linkBody,
    linkToIncident,
    patchBody,
    patchIncident,
    unlinkFromIncident,
} from './incident-commands.js';
import { incidentDetail, listIncidents, listQuery } from './incident-queries.js';
import { incidentSettingsBody, readIncidentSettings, saveIncidentSettings } from './incident-settings.js';
import {
    changeEta,
    etaBody,
    messageBody,
    postMessage,
    reopenBody,
    reopenIncident,
    resolveBody,
    resolveIncident,
} from './updates.js';

interface IncidentsRouteOptions {
    db: Database;
    config: Config;
}

interface Mutation {
    route: string;
    body: Row;
    objectId?: string;
    permission?: Permission;
}

type Mutate = (
    request: FastifyRequest,
    mutation: Mutation,
    apply: (tx: Sql, actor: Employee) => Promise<unknown>,
) => Promise<unknown>;

interface Deps {
    db: Database;
    ctx: Ctx;
    mutate: Mutate;
}

const versioned = (request: FastifyRequest) => ({ id: paramsId(request), expectedVersion: ifMatchVersion(request) });

function mutator(db: Database, org: string): Mutate {
    return (request, mutation, apply) =>
        runAdminMutation(
            db,
            org,
            {
                actor: staffOf(request).employee,
                permission: mutation.permission ?? 'incidents.manage',
                route: mutation.route,
                objectId: mutation.objectId,
                body: mutation.body,
                expectedVersion: request.headers['if-match'] ? ifMatchVersion(request) : 0,
                idempotencyKey: idempotencyKey(request),
                event: 'incident.changed',
            },
            apply,
        );
}

function registerReads(app: FastifyInstance, { db, ctx, mutate }: Deps): void {
    app.get('/v1/incidents', access('incidents.manage'), async (request) =>
        listIncidents(db, ctx.org, listQuery.parse(request.query ?? {})),
    );

    app.get('/v1/incidents/settings', access('incidents.manage'), async () => readIncidentSettings(db, ctx.org));

    app.put('/v1/incidents/settings', access('organization.configure'), async (request) => {
        const body = incidentSettingsBody.parse(request.body ?? {});
        const expectedVersion = ifMatchVersion(request);
        const mutation = { route: 'incident.settings', body, permission: 'organization.configure' as const };

        return mutate(request, mutation, async (tx) => saveIncidentSettings(tx, ctx.org, { body, expectedVersion }));
    });

    app.get('/v1/incidents/:id', access('incidents.manage'), async (request) =>
        incidentDetail(db, ctx.org, paramsId(request)),
    );
}

function registerLifecycle(app: FastifyInstance, { ctx, mutate }: Deps): void {
    app.post('/v1/incidents', access('incidents.manage'), async (request) => {
        const body = createBody.parse(request.body ?? {});

        return mutate(request, { route: 'incident.created', body }, async (tx, actor) =>
            createIncident(tx, ctx, { body, actor }),
        );
    });

    app.patch('/v1/incidents/:id', access('incidents.manage'), async (request) => {
        const body = patchBody.parse(request.body ?? {});
        const target = versioned(request);

        return mutate(request, { route: 'incident.updated', body, objectId: target.id }, async (tx) =>
            patchIncident(tx, ctx, { ...target, body }),
        );
    });

    app.post('/v1/incidents/:id/dismiss', access('incidents.manage'), async (request) => {
        const target = versioned(request);

        return mutate(request, { route: 'incident.dismissed', body: {}, objectId: target.id }, async (tx, actor) =>
            dismissIncident(tx, ctx, { ...target, actorId: actor.id }),
        );
    });

    app.post('/v1/incidents/:id/resolve', access('incidents.manage'), async (request) => {
        const body = resolveBody.parse(request.body ?? {});
        const target = versioned(request);

        return mutate(request, { route: 'incident.resolved', body, objectId: target.id }, async (tx, actor) =>
            resolveIncident(tx, ctx, { ...target, body, actorId: actor.id }),
        );
    });

    app.post('/v1/incidents/:id/reopen', access('incidents.manage'), async (request) => {
        const body = reopenBody.parse(request.body ?? {});
        const target = versioned(request);

        return mutate(request, { route: 'incident.reopened', body, objectId: target.id }, async (tx, actor) =>
            reopenIncident(tx, ctx, { ...target, body, actorId: actor.id }),
        );
    });
}

function registerBroadcasts(app: FastifyInstance, { ctx, mutate }: Deps): void {
    app.post('/v1/incidents/:id/messages', access('incidents.manage'), async (request) => {
        const body = messageBody.parse(request.body ?? {});
        const id = paramsId(request);

        return mutate(request, { route: 'incident.message', body, objectId: id }, async (tx, actor) =>
            postMessage(tx, ctx, { id, body, actorId: actor.id }),
        );
    });

    app.post('/v1/incidents/:id/eta', access('incidents.manage'), async (request) => {
        const body = etaBody.parse(request.body ?? {});
        const target = versioned(request);

        return mutate(request, { route: 'incident.eta', body, objectId: target.id }, async (tx, actor) =>
            changeEta(tx, ctx, { ...target, body, actorId: actor.id }),
        );
    });

    app.post('/v1/incidents/:id/tickets', access('incidents.manage'), async (request) => {
        const id = paramsId(request);
        const body = linkBody.parse(request.body ?? {});

        return mutate(request, { route: 'incident.linked', body, objectId: id }, async (tx, actor) =>
            linkToIncident(tx, ctx, { id, ticketIds: body.ticket_ids, actorId: actor.id }),
        );
    });

    app.delete('/v1/incidents/:id/tickets/:ticketId', access('tickets.work'), async (request) => {
        const id = paramsId(request);
        const ticketId = z.uuid().parse(routeParam(request, 'ticketId'));
        const mutation = { route: 'incident.unlinked', body: { ticket_id: ticketId }, objectId: id };

        return mutate(request, { ...mutation, permission: 'tickets.work' }, async (tx, actor) =>
            unlinkFromIncident(tx, ctx, { id, ticketId, actor }),
        );
    });
}

export const incidentsRoutes: FastifyPluginAsync<IncidentsRouteOptions> = async (app, { db, config }) => {
    const ctx = createCtx(config);
    const deps = { db, ctx, mutate: mutator(db, ctx.org) };

    registerReads(app, deps);
    registerLifecycle(app, deps);
    registerBroadcasts(app, deps);
};
