import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';
import { staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import { listEmployees } from './employee-directory.js';
import { presenceBody, setPresence } from './presence.js';

export const employeesRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (app, { db, org }) => {
    app.get('/v1/employees', access('tickets.view'), async () => listEmployees(db, org));

    app.put('/v1/presence', access('tickets.work'), async (request) =>
        setPresence(db, org, staffOf(request).employee.id, presenceBody.parse(request.body ?? {}).presence),
    );
};
