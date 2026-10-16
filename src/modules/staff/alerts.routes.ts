import type { FastifyPluginAsync } from 'fastify';

import type { Sql } from '../../shared/db.js';
import { requireOpsToken } from '../../shared/http/ops-token.js';

import { relayAlerts, type AlertSender } from './alert-relay.js';

interface AlertRouteOptions {
    db: Sql;
    org: string;
    token: string;
    sender: AlertSender;
}

export const alertRoutes: FastifyPluginAsync<AlertRouteOptions> = async (app, { db, org, token, sender }) => {
    app.post('/internal/alerts', async (request) => {
        requireOpsToken(request, token);

        return { delivered: await relayAlerts(db, org, sender, request.body) };
    });
};
