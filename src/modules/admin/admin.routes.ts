import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
    idempotencyKey,
    ifMatchVersion,
    paramsId,
    requireAdmin,
    requireOps,
    routeParam,
    staffOf,
} from '../../shared/http/request.js';

import type { Admin, AdminRequest } from './admin.js';

const ROLES = ['support', 'supervisor', 'admin'];

export const adminRoutes: FastifyPluginAsync<{ admin: Admin }> = async (app, { admin }) => {
    addAdminReads(app, admin);
    addAdminMutations(app, admin);
};

export const opsRoutes: FastifyPluginAsync<{ admin: Admin }> = async (app, { admin }) => {
    app.get('/v1/admin/diagnostics', async (request) => {
        requireOps(request);

        return admin.diagnostics();
    });

    app.post('/v1/admin/jobs/:id/retry', async (request) => {
        requireOps(request);
        idempotencyKey(request);
        await admin.retryJob(paramsId(request));

        return { ok: true };
    });
};

function addAdminReads(app: FastifyInstance, admin: Admin): void {
    app.get('/v1/admin/employees', async (request) => {
        requireAdmin(request);

        return admin.employees();
    });

    app.get('/v1/admin/roles', async (request) => {
        requireAdmin(request);

        return { items: ROLES.map((role) => ({ code: role })) };
    });

    app.get('/v1/admin/templates', async (request) => {
        requireAdmin(request);

        return admin.templates();
    });

    app.get('/v1/admin/settings', async (request) => {
        requireAdmin(request);

        return admin.currentSettings();
    });

    app.get('/v1/admin/audit', async (request) => {
        requireAdmin(request);

        return admin.audit();
    });
}

function addAdminMutations(app: FastifyInstance, admin: Admin): void {
    app.post('/v1/admin/employees', async (request) => admin.employee(mutation(request)));

    app.patch('/v1/admin/employees/:id', async (request) => {
        const employeeId = paramsId(request);

        return admin.employee({ ...mutation(request), employeeId });
    });

    app.put('/v1/admin/dictionaries', async (request) => admin.dictionary(mutation(request)));

    app.put('/v1/admin/templates/:code', async (request) => {
        const code = String(routeParam(request, 'code'));

        return admin.template({ ...mutation(request), code });
    });

    app.put('/v1/admin/settings', async (request) => admin.settings(mutation(request)));
}

function mutation(request: FastifyRequest): AdminRequest {
    return {
        actor: staffOf(request).employee,
        body: request.body,
        expectedVersion: ifMatchVersion(request),
        idempotencyKey: idempotencyKey(request),
    };
}
