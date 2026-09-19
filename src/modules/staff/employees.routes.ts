import type { FastifyPluginAsync } from 'fastify';

import type { Database } from '../../shared/db.js';

import { listEmployees } from './employee-directory.js';

export const employeesRoutes: FastifyPluginAsync<{ db: Database; org: string }> = async (
  app,
  { db, org },
) => {
  app.get('/v1/employees', async () => listEmployees(db, org));
};
