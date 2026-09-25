import { buildGateway } from './app/gateway/build-gateway.js';
import { buildApi } from './app/http/build-api.js';
import { startWorkers } from './app/workers/start-workers.js';
import { readConfig } from './shared/config.js';
import { Postgres } from './shared/db.js';
const config = readConfig();
const db = new Postgres(config.DATABASE_URL);
const role = process.argv[2] ?? 'api';
const cleanups: (() => Promise<unknown>)[] = [];

if (role === 'gateway' || role === 'all') {
    if (config.AI_ENABLED && config.AI_MODE === 'live' && (!config.AI_API_KEY || !config.AI_MODEL)) {
        throw new Error('Configure AI_API_KEY and AI_MODEL in gateway environment');
    }

    const gateway = await buildGateway(db, config);

    await gateway.listen({ host: config.HOST, port: config.GATEWAY_PORT });
    cleanups.push(() => gateway.close());
}

if (role === 'api' || role === 'all') {
    const api = await buildApi(db, config);

    await api.listen({ host: config.HOST, port: config.PORT });
    cleanups.push(() => api.close());
}

if (role === 'worker' || role === 'all') {
    cleanups.push(startWorkers(db, config));
}

if (!['api', 'worker', 'gateway', 'all'].includes(role)) {
    throw new Error('Unknown process role');
}

let stopping = false;

const shutdown = async () => {
    if (stopping) {
        return;
    }

    stopping = true;

    for (const close of cleanups.reverse()) {
        await close();
    }

    await db.close();
};

process.on('SIGINT', () => {
    void shutdown();
});

process.on('SIGTERM', () => {
    void shutdown();
});
