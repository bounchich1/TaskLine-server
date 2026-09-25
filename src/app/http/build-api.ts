import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { MaxClient } from '../../integrations/max/index.js';
import { Admin, adminRoutes, opsRoutes } from '../../modules/admin/index.js';
import { deliveryRoutes, DeliveryWorker } from '../../modules/delivery/index.js';
import { dictionariesRoutes } from '../../modules/dictionaries/index.js';
import { Files, filesRoutes } from '../../modules/files/index.js';
import { devInboundRoutes, Inbox, webhookRoutes } from '../../modules/inbox/index.js';
import { eventsRoutes, notificationsRoutes } from '../../modules/notifications/index.js';
import { authRoutes, employeesRoutes } from '../../modules/staff/index.js';
import { TicketCommands, TicketQueries, ticketRoutes } from '../../modules/tickets/index.js';
import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';

import { handleError } from './error-handler.js';
import { healthRoutes } from './health.routes.js';
import { addOriginHook, addSessionHook } from './hooks.js';
import { loggerOptions } from './logger.js';
import { useStrictJsonParser } from './strict-json-parser.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function buildApi(db: Database, config: Config): Promise<FastifyInstance> {
    const app = Fastify({
        bodyLimit: MAX_BODY_BYTES,
        trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
        logger: loggerOptions(config),
    });

    await registerInfrastructure(app);
    useStrictJsonParser(app);
    app.setErrorHandler(handleError);
    addOriginHook(app, config);
    addSessionHook(app, db, config);
    await registerRoutes(app, db, config);

    return app;
}

async function registerInfrastructure(app: FastifyInstance): Promise<void> {
    await app.register(cookie);
    await app.register(helmet, { contentSecurityPolicy: false });
    await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });

    await app.register(multipart, {
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 0, parts: 1 },
    });
}

async function registerRoutes(app: FastifyInstance, db: Database, config: Config): Promise<void> {
    const org = config.ORG_ID;
    const inbox = new Inbox(db, config);
    const files = new Files(db, config);
    const admin = new Admin(db, org);
    const deliveries = new DeliveryWorker(db, config, new MaxClient(config), files);
    const queries = new TicketQueries(db, org);
    const commands = new TicketCommands(db, config);

    await app.register(healthRoutes, { db, config });
    await app.register(webhookRoutes, { inbox, config });
    await app.register(authRoutes, { db, config });
    await app.register(ticketRoutes, { queries, commands });
    await app.register(employeesRoutes, { db, org });
    await app.register(dictionariesRoutes, { db, org });
    await app.register(notificationsRoutes, { db, org });
    await app.register(deliveryRoutes, { deliveries });
    await app.register(filesRoutes, { files });
    await app.register(adminRoutes, { admin });
    await app.register(opsRoutes, { admin });
    await app.register(eventsRoutes, { db, config });

    if (config.DEV_AUTH_ENABLED && config.NODE_ENV !== 'production') {
        await app.register(devInboundRoutes, { inbox });
    }
}
