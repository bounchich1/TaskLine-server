import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';

import { listDictionaries } from './dictionaries.js';

export const dictionariesRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (
  app,
  { db, org },
) => {
  app.get('/v1/dictionaries', async () => listDictionaries(db, org));
};
