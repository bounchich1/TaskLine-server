import type { FastifyPluginAsync } from 'fastify';

import type { Sql } from '../../shared/db.js';
import { requireOpsToken } from '../../shared/http/ops-token.js';

import { collectMetrics } from './metrics.js';

interface MetricsRouteOptions {
    db: Sql;
    org: string;
    token: string;
    version: string;
}

export const metricsRoutes: FastifyPluginAsync<MetricsRouteOptions> = async (app, { db, org, token, version }) => {
    app.get('/metrics', async (request, reply) => {
        requireOpsToken(request, token);

        return reply
            .header('Cache-Control', 'no-store')
            .type('text/plain; version=0.0.4; charset=utf-8')
            .send(await collectMetrics(db, org, version));
    });
};
