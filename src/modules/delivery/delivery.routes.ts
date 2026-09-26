import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { idempotencyKey, paramsId, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import type { DeliveryWorker } from './delivery-worker.js';

const resolveBody = z.object({ evidence: z.string().max(2000).optional() }).strict();

export const deliveryRoutes: FastifyPluginAsync<{ deliveries: DeliveryWorker }> = async (app, { deliveries }) => {
    for (const action of ['cancel', 'retry'] as const) {
        app.post(`/v1/messages/:id/${action}`, access('tickets.work'), async (request) => {
            idempotencyKey(request);
            const body = resolveBody.parse(request.body ?? {});
            const employee = staffOf(request).employee;

            return deliveries.resolve(employee, paramsId(request), action, body.evidence);
        });
    }
};
