import type { Permission } from '../../shared/access.js';
import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';
import { DEFAULT_TEMPLATES, validateTemplate } from '../templates/index.js';

import { runAdminMutation } from './admin-mutation.js';
import { listAllEmployees, listTemplates, readSettings, recentAudit, retryFailedJob } from './admin-queries.js';
import { adminDiagnostics } from './diagnostics.js';
import { dictionaryBody, publishDictionaryEntry } from './dictionaries.js';
import { createEmployee, employeeChangesBody, newEmployeeBody, updateEmployee } from './employees.js';
import { assertValidTimezone, settingsBody, templateBody, updateSettings, updateTemplate } from './organization.js';

export interface AdminRequest {
    actor: Employee;
    body: unknown;
    expectedVersion: number;
    idempotencyKey: string;
}

export class Admin {
    constructor(
        private readonly db: Database,
        private readonly org: string,
    ) {}

    async employee(request: AdminRequest & { employeeId?: string }) {
        const { employeeId, expectedVersion } = request;
        const permission: Permission = 'employees.manage';

        if (!employeeId) {
            const body = newEmployeeBody.parse(request.body);
            const route = `admin.employee:${body.max_user_id}`;

            return runAdminMutation(this.db, this.org, { ...request, permission, route, body }, (tx, actor) =>
                createEmployee(tx, this.org, actor, body),
            );
        }

        const changes = employeeChangesBody.parse(request.body);
        const mutation = { ...request, permission, route: `admin.employee:${employeeId}`, objectId: employeeId };

        return runAdminMutation(this.db, this.org, { ...mutation, body: changes }, (tx, actor) =>
            updateEmployee(tx, this.org, actor, { id: employeeId, changes, expectedVersion }),
        );
    }

    async dictionary(request: AdminRequest) {
        const body = dictionaryBody.parse(request.body);
        const route = `admin.dictionary:${body.dimension}:${body.code}`;

        return runAdminMutation(
            this.db,
            this.org,
            { ...request, permission: 'organization.configure', route, body },
            (tx) => publishDictionaryEntry(tx, this.org, { body, expectedVersion: request.expectedVersion }),
        );
    }

    async template(request: AdminRequest & { code: string }) {
        const { code, expectedVersion } = request;
        const body = templateBody.parse(request.body);

        validateTemplate(body.body);
        ensure(code in DEFAULT_TEMPLATES, 'unknown_template', 422);

        const mutation = { ...request, permission: 'organization.configure' as const, route: `admin.template:${code}` };

        return runAdminMutation(this.db, this.org, { ...mutation, body }, (tx) =>
            updateTemplate(tx, this.org, { code, body: body.body, expectedVersion }),
        );
    }

    async settings(request: AdminRequest) {
        const settings = settingsBody.parse(request.body);

        assertValidTimezone(settings.timezone);

        const mutation = { ...request, permission: 'organization.configure' as const, route: 'admin.settings' };

        return runAdminMutation(this.db, this.org, { ...mutation, body: settings }, (tx) =>
            updateSettings(tx, this.org, { settings, expectedVersion: request.expectedVersion }),
        );
    }

    async employees() {
        return listAllEmployees(this.db, this.org);
    }

    async templates() {
        return listTemplates(this.db, this.org);
    }

    async currentSettings() {
        return readSettings(this.db, this.org);
    }

    async audit() {
        return recentAudit(this.db, this.org);
    }

    async diagnostics() {
        return adminDiagnostics(this.db, this.org);
    }

    async retryJob(actor: Employee, jobId: string): Promise<void> {
        await retryFailedJob(this.db, this.org, { actor, jobId });
    }
}
