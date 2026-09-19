import type { Database } from '../../shared/db.js';
import { ensure } from '../../shared/errors.js';
import type { Employee } from '../../shared/types/entities.js';
import { DEFAULT_TEMPLATES, validateTemplate } from '../templates/index.js';

import { runAdminMutation } from './admin-mutation.js';
import {
  listAllEmployees,
  listTemplates,
  readSettings,
  recentAudit,
  retryFailedJob,
} from './admin-queries.js';
import { adminDiagnostics } from './diagnostics.js';
import { dictionaryBody, publishDictionaryEntry } from './dictionaries.js';
import { createEmployee, employeeBody, updateEmployee } from './employees.js';
import {
  assertValidTimezone,
  settingsBody,
  templateBody,
  updateSettings,
  updateTemplate,
} from './organization.js';

export interface AdminRequest {
  actor: Employee;
  /** Unvalidated request body. */
  body: unknown;
  expectedVersion: number;
  idempotencyKey: string;
}

/** Administration of staff, dictionaries, bot templates and organization settings. */
export class Admin {
  constructor(
    private readonly db: Database,
    private readonly org: string,
  ) {}

  /** Creates an employee (no `employeeId`) or updates one. */
  async employee(request: AdminRequest & { employeeId?: string }) {
    const { employeeId, expectedVersion } = request;
    const body = employeeBody.parse(request.body);
    const route = `admin.employee:${employeeId ?? body.max_user_id}`;
    return runAdminMutation(this.db, this.org, { ...request, route, body }, (tx) =>
      employeeId
        ? updateEmployee(tx, this.org, { id: employeeId, body, expectedVersion })
        : createEmployee(tx, this.org, body),
    );
  }

  async dictionary(request: AdminRequest) {
    const body = dictionaryBody.parse(request.body);
    const route = `admin.dictionary:${body.dimension}:${body.code}`;
    return runAdminMutation(this.db, this.org, { ...request, route, body }, (tx) =>
      publishDictionaryEntry(tx, this.org, { body, expectedVersion: request.expectedVersion }),
    );
  }

  async template(request: AdminRequest & { code: string }) {
    const { code, expectedVersion } = request;
    const body = templateBody.parse(request.body);
    validateTemplate(body.body);
    ensure(code in DEFAULT_TEMPLATES, 'unknown_template', 422);
    return runAdminMutation(
      this.db,
      this.org,
      { ...request, route: `admin.template:${code}`, body },
      (tx) => updateTemplate(tx, this.org, { code, body: body.body, expectedVersion }),
    );
  }

  async settings(request: AdminRequest) {
    const settings = settingsBody.parse(request.body);
    assertValidTimezone(settings.timezone);
    return runAdminMutation(
      this.db,
      this.org,
      { ...request, route: 'admin.settings', body: settings },
      (tx) => updateSettings(tx, this.org, { settings, expectedVersion: request.expectedVersion }),
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

  async retryJob(jobId: string): Promise<void> {
    await retryFailedJob(this.db, this.org, jobId);
  }
}
