import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { paramsId, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import { exportFilename } from './export-grants.js';
import type { Privacy } from './privacy.js';

const grantParam = z.string().min(32).max(128);
const erasureBody = z.object({ confirm: z.literal(true) }).strict();

export const privacyRoutes: FastifyPluginAsync<{ privacy: Privacy }> = async (app, { privacy }) => {
    app.get('/v1/admin/clients/:id/export', access('clients.privacy'), async (request, reply) => {
        const clientId = paramsId(request);

        return sendExport(reply, clientId, await privacy.export(staffOf(request).employee, clientId));
    });

    app.post('/v1/admin/clients/:id/export-grant', access('clients.privacy'), async (request) =>
        privacy.grantExport(staffOf(request), paramsId(request)),
    );

    app.get('/download/export/:grant', async (request, reply) => {
        const { clientId, data } = await privacy.redeemExport(grantParam.parse(routeParam(request, 'grant')));

        return sendExport(reply.header('Referrer-Policy', 'no-referrer'), clientId, data);
    });

    app.post('/v1/admin/clients/:id/erase', access('clients.privacy'), async (request) => {
        erasureBody.parse(request.body ?? {});

        return privacy.erase(staffOf(request).employee, paramsId(request));
    });
};

function sendExport(reply: FastifyReply, clientId: string, data: unknown) {
    return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${exportFilename(clientId)}"`)
        .send(JSON.stringify(data, null, 2));
}
