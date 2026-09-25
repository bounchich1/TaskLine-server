import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';

import { openapi } from './openapi.js';

export const healthRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db.query('SELECT version FROM schema_migrations WHERE version=1');
    return { status: 'ready' };
  });
  app.get('/openapi.json', async () => openapi);
};
