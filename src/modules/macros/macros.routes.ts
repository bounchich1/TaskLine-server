import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { runAdminMutation } from '../../shared/admin-mutation.js';
import type { Database, Sql } from '../../shared/db.js';
import { idempotencyKey, ifMatchVersion, paramsId, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';
import type { Employee, Row } from '../../shared/types/entities.js';

import { createMacro, deleteMacro, listMacros, macroBody, updateMacro } from './macros.js';

export const macrosRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (app, { db, org }) => {
    const mutate = (
        request: FastifyRequest,
        { route, body, objectId }: { route: string; body: Row; objectId?: string },
        apply: (tx: Sql, actor: Employee) => Promise<unknown>,
    ) =>
        runAdminMutation(
            db,
            org,
            {
                actor: staffOf(request).employee,
                permission: 'tickets.work',
                route,
                objectId,
                body,
                expectedVersion: request.method === 'POST' ? 0 : ifMatchVersion(request),
                idempotencyKey: idempotencyKey(request),
            },
            apply,
        );

    app.get('/v1/macros', access('tickets.work'), async (request) => listMacros(db, org, staffOf(request).employee));

    app.post('/v1/macros', access('tickets.work'), async (request) => {
        const body = macroBody.parse(request.body ?? {});

        return mutate(request, { route: 'macro.created', body }, async (tx, actor) =>
            createMacro(tx, org, actor, body),
        );
    });

    app.patch('/v1/macros/:id', access('tickets.work'), async (request) => {
        const id = paramsId(request);
        const body = macroBody.parse(request.body ?? {});
        const expectedVersion = ifMatchVersion(request);

        return mutate(request, { route: 'macro.updated', body, objectId: id }, async (tx, actor) =>
            updateMacro(tx, org, actor, { id, body, expectedVersion }),
        );
    });

    app.delete('/v1/macros/:id', access('tickets.work'), async (request) => {
        const id = paramsId(request);
        const expectedVersion = ifMatchVersion(request);

        return mutate(request, { route: 'macro.deleted', body: { id }, objectId: id }, async (tx, actor) =>
            deleteMacro(tx, org, actor, { id, expectedVersion }),
        );
    });
};
