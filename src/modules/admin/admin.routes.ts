import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { permissionsOf, ROLES } from '../../shared/access.js';
import { idempotencyKey, ifMatchVersion, paramsId, routeParam, staffOf } from '../../shared/http/request.js';
import { access } from '../../shared/http/route-access.js';

import type { Admin, AdminRequest } from './admin.js';

export const adminRoutes: FastifyPluginAsync<{ admin: Admin }> = async (app, { admin }) => {
    addAdminReads(app, admin);
    addAdminMutations(app, admin);
};

export const opsRoutes: FastifyPluginAsync<{ admin: Admin }> = async (app, { admin }) => {
    app.get('/v1/admin/diagnostics', access('operations.view'), async () => admin.diagnostics());

    app.post('/v1/admin/jobs/:id/retry', access('operations.retry'), async (request) => {
        idempotencyKey(request);
        await admin.retryJob(staffOf(request).employee, paramsId(request));

        return { ok: true };
    });
};

function addAdminReads(app: FastifyInstance, admin: Admin): void {
    app.get('/v1/admin/employees', access('employees.manage'), async () => admin.employees());

    app.get('/v1/admin/roles', access('employees.manage'), async () => ({
        items: ROLES.map((role) => ({ code: role, permissions: permissionsOf(role) })),
    }));

    app.get('/v1/admin/templates', access('organization.configure'), async () => admin.templates());
    app.get('/v1/admin/settings', access('organization.configure'), async () => admin.currentSettings());
    app.get('/v1/admin/audit', access('audit.view'), async () => admin.audit());
}

function addAdminMutations(app: FastifyInstance, admin: Admin): void {
    app.post('/v1/admin/employees', access('employees.manage'), async (request) => admin.employee(mutation(request)));

    app.patch('/v1/admin/employees/:id', access('employees.manage'), async (request) => {
        const employeeId = paramsId(request);

        return admin.employee({ ...mutation(request), employeeId });
    });

    app.put('/v1/admin/dictionaries', access('organization.configure'), async (request) =>
        admin.dictionary(mutation(request)),
    );

    app.put('/v1/admin/templates/:code', access('organization.configure'), async (request) => {
        const code = String(routeParam(request, 'code'));

        return admin.template({ ...mutation(request), code });
    });

    app.put('/v1/admin/settings', access('organization.configure'), async (request) =>
        admin.settings(mutation(request)),
    );
}

function mutation(request: FastifyRequest): AdminRequest {
    return {
        actor: staffOf(request).employee,
        body: request.body,
        expectedVersion: ifMatchVersion(request),
        idempotencyKey: idempotencyKey(request),
    };
}
