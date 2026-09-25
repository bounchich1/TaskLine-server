import Fastify, { type FastifyInstance } from 'fastify';

import { executeRequestSchema, Gateway } from '../../modules/ai/index.js';
import type { Config } from '../../shared/config.js';
import { equal } from '../../shared/crypto.js';
import type { Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';

const MAX_BODY_BYTES = 512 * 1024;

export async function buildGateway(db: Database, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: false });
  const gateway = new Gateway(db, config);
  app.get('/health', async () => ({ status: 'ok', permits: await gateway.permits() }));
  app.post('/execute', async (request, reply) => {
    if (!equal(request.headers.authorization ?? '', `Bearer ${config.GATEWAY_SECRET}`)) {
      return reply.code(401).send({ code: 'unauthorized' });
    }
    try {
      return await gateway.execute(executeRequestSchema.parse(request.body));
    } catch (error) {
      return reply
        .code(error instanceof AppError ? error.status : 503)
        .send({ code: error instanceof AppError ? error.code : 'gateway_unavailable' });
    }
  });
  return app;
}
