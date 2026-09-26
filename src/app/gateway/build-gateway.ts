import Fastify, { LogController, type FastifyInstance } from 'fastify';

import { executeRequestSchema, Gateway } from '../../modules/ai/index.js';
import type { Config } from '../../shared/config.js';
import { equal } from '../../shared/crypto.js';
import type { Database } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { loggerOptions } from '../http/logger.js';

const MAX_BODY_BYTES = 512 * 1024;

export async function buildGateway(db: Database, config: Config): Promise<FastifyInstance> {
    const app = Fastify({
        bodyLimit: MAX_BODY_BYTES,
        logger: loggerOptions(config),
        logController: new LogController({ disableRequestLogging: (request) => request.url === '/health' }),
    });

    const gateway = new Gateway(db, config);

    app.get('/health', async () => ({ status: 'ok', permits: await gateway.permits() }));

    app.post('/execute', async (request, reply) => {
        if (!equal(request.headers.authorization ?? '', `Bearer ${config.GATEWAY_SECRET}`)) {
            return reply.code(401).send({ code: 'unauthorized' });
        }

        const startedAt = Date.now();

        try {
            return await gateway.execute(executeRequestSchema.parse(request.body));
        } catch (error) {
            if (!(error instanceof AppError) || error.status >= 500) {
                request.log.error(
                    { ...callTarget(request.body), ...failureDetail(error), elapsed_ms: Date.now() - startedAt },
                    'Model call failed',
                );
            }

            return reply
                .code(error instanceof AppError ? error.status : 503)
                .send({ code: error instanceof AppError ? error.code : 'gateway_unavailable' });
        }
    });

    return app;
}

function callTarget(body: unknown) {
    const { job_id: jobId, step } = (body ?? {}) as { job_id?: unknown; step?: unknown };

    return { job_id: String(jobId), step: String(step) };
}

function failureDetail(error: unknown) {
    if (!(error instanceof Error)) {
        return { reason: 'non_error', detail: String(error) };
    }

    const cause = (error.cause ?? {}) as {
        code?: unknown;
        message?: unknown;
        status?: unknown;
        finish_reason?: unknown;
    };

    return {
        reason: error instanceof AppError ? error.code : error.name,
        detail: error instanceof AppError ? undefined : error.message,
        cause: cause.code ?? cause.message,
        status: cause.status,
        finish_reason: cause.finish_reason,
    };
}
