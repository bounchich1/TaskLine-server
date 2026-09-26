import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';
import { access } from '../../shared/http/route-access.js';

import { listDictionaries } from './dictionaries.js';

export const dictionariesRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (app, { db, org }) => {
    app.get('/v1/dictionaries', access('tickets.view'), async () => listDictionaries(db, org));
};
