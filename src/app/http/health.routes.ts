import { readFile } from 'node:fs/promises';

import type { FastifyPluginAsync } from 'fastify';

import type { Config } from '../../shared/config.js';
import { latestMigration, schemaVersion, type Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import { serverFile } from '../../shared/paths.js';

export const healthRoutes: FastifyPluginAsync<{ db: Database; config: Config }> = async (app, { db, config }) => {
    const expectedSchema = await latestMigration();
    const openapi = await readFile(serverFile('openapi.yaml'), 'utf8');

    app.get('/health/live', async () => ({ status: 'ok', version: config.APP_VERSION }));

    app.get('/health/ready', async () => {
        ensure((await schemaVersion(db)) >= expectedSchema, 'schema_outdated', 503);

        return { status: 'ready', version: config.APP_VERSION };
    });

    app.get('/openapi.yaml', async (_request, reply) => reply.type('application/yaml; charset=utf-8').send(openapi));
};
