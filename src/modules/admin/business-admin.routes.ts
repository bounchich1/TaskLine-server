import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { idempotencyKey, ifMatchVersion, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import type { AdminRequest } from './admin.js';
import type { BusinessAdmin } from './business-admin.js';

const configure = access('organization.configure');

export const businessAdminRoutes: FastifyPluginAsync<{ business: BusinessAdmin }> = async (app, { business }) => {
    app.get('/v1/admin/profile', configure, async () => business.profile());
    app.put('/v1/admin/profile', configure, async (request) => business.saveProfile(mutation(request)));
    app.get('/v1/admin/bot', configure, async () => business.bot());
    app.put('/v1/admin/bot', configure, async (request) => business.saveBot(mutation(request)));
    app.get('/v1/admin/presets', configure, async () => business.presets());

    app.get('/v1/admin/presets/:id/preview', configure, async (request) =>
        business.presetPreview(String(routeParam(request, 'id'))),
    );

    app.post('/v1/admin/presets/:id/apply', configure, async (request) =>
        business.applyPreset({ ...mutation(request), id: String(routeParam(request, 'id')) }),
    );
};

function mutation(request: FastifyRequest): AdminRequest {
    return {
        actor: staffOf(request).employee,
        body: request.body ?? {},
        expectedVersion: ifMatchVersion(request),
        idempotencyKey: idempotencyKey(request),
    };
}
