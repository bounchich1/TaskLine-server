import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { runAdminMutation } from '../../shared/admin-mutation.js';
import type { Database, Sql } from '../../shared/db.js';
import { idempotencyKey, ifMatchVersion, paramsId, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';
import type { Row } from '../../shared/types/entities.js';

import { listRules, replaceRules, rulesBody } from './rules.js';
import { archiveTeam, createTeam, listTeams, teamBody, updateTeam } from './teams.js';

interface TeamsRouteOptions {
    db: Database;
    org: string;
}

export const teamsRoutes: FastifyPluginAsync<TeamsRouteOptions> = async (app, { db, org }) => {
    const mutate = (
        request: FastifyRequest,
        route: string,
        { body, objectId }: { body: Row; objectId?: string },
        apply: (tx: Sql) => Promise<unknown>,
    ) =>
        runAdminMutation(
            db,
            org,
            {
                actor: staffOf(request).employee,
                permission: 'teams.manage',
                route,
                objectId,
                body,
                expectedVersion: request.method === 'POST' ? 0 : ifMatchVersion(request),
                idempotencyKey: idempotencyKey(request),
            },
            apply,
        );

    app.get('/v1/teams', access('tickets.view'), async () => listTeams(db, org));
    app.get('/v1/admin/routing-rules', access('teams.manage'), async () => listRules(db, org));

    app.post('/v1/admin/teams', access('teams.manage'), async (request) => {
        const body = teamBody.parse(request.body ?? {});

        return mutate(request, 'admin.team_created', { body }, async (tx) => createTeam(tx, org, body));
    });

    app.patch('/v1/admin/teams/:id', access('teams.manage'), async (request) => {
        const id = paramsId(request);
        const body = teamBody.parse(request.body ?? {});
        const expectedVersion = ifMatchVersion(request);

        return mutate(request, 'admin.team_updated', { body, objectId: id }, async (tx) =>
            updateTeam(tx, org, { id, body, expectedVersion }),
        );
    });

    app.delete('/v1/admin/teams/:id', access('teams.manage'), async (request) => {
        const id = paramsId(request);
        const expectedVersion = ifMatchVersion(request);

        return mutate(request, 'admin.team_archived', { body: { id }, objectId: id }, async (tx) =>
            archiveTeam(tx, org, { id, expectedVersion }),
        );
    });

    app.put('/v1/admin/routing-rules', access('teams.manage'), async (request) => {
        const body = rulesBody.parse(request.body ?? {});
        const expectedVersion = ifMatchVersion(request);

        return mutate(request, 'admin.routing_rules', { body }, async (tx) =>
            replaceRules(tx, org, { body, expectedVersion }),
        );
    });
};
