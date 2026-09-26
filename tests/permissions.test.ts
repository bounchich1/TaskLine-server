import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { addSessionHook } from '../src/app/http/hooks.js';
import { Admin } from '../src/modules/admin/index.js';
import { permissionsOf } from '../src/shared/access.js';
import { one, requireOne } from '../src/shared/db.js';
import type { Employee } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let admin: Admin;

beforeEach(async () => {
    context = await fixture();
    admin = new Admin(context.db, context.c.ORG_ID);
});

afterEach(async () => {
    await context.db.close();
});

const addEmployee = async (maxId: string, role: string, activated = true) =>
    requireOne<Employee>(
        context.db,
        `INSERT INTO employees(org_id,max_user_id,name,role,activated_at)
     VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END) RETURNING *`,
        [context.c.ORG_ID, maxId, `Сотрудник ${maxId}`, role, activated],
    );

const change = (actor: Employee, target: Employee, body: Record<string, unknown>) =>
    admin.employee({
        actor,
        employeeId: target.id,
        body,
        expectedVersion: target.version,
        idempotencyKey: randomUUID(),
    });

const reload = async (employee: Employee) =>
    requireOne<Employee>(context.db, 'SELECT * FROM employees WHERE id=$1', [employee.id]);

describe('role permissions', () => {
    it('grants each role a fixed permission set', () => {
        expect(permissionsOf('support')).toEqual(['tickets.view', 'tickets.work']);

        expect(permissionsOf('supervisor')).toEqual([
            'tickets.view',
            'tickets.work',
            'tickets.classify_any',
            'tickets.reply_any',
            'tickets.transfer_any',
            'tickets.close_any',
            'tickets.reopen_any',
            'deliveries.resolve_unknown',
            'operations.view',
            'operations.retry',
        ]);

        expect(permissionsOf('admin')).toEqual([
            ...permissionsOf('supervisor'),
            'employees.manage',
            'organization.configure',
            'audit.view',
        ]);

        expect(permissionsOf('unknown')).toEqual([]);
    });

    it('refuses to register an API route without an access rule', async () => {
        const app = Fastify();

        addSessionHook(app, context.db, context.c);

        const handler = () => ({ ok: true });
        const undeclared = () => app.get('/v1/open', handler);
        const declared = () => app.get('/v1/declared', { config: { access: 'session' } }, handler);

        expect(undeclared).toThrow('must declare its access rule');
        expect(declared).not.toThrow();
        await app.close();
    });

    it('lets supervisors run operations but not administration', async () => {
        await addEmployee('3', 'supervisor');
        const app = await buildApi(context.db, context.c);
        const { headers } = await staffLogin(app, context.c.APP_ORIGIN, '3');

        expect((await app.inject({ url: '/v1/admin/diagnostics', headers: headers() })).statusCode).toBe(200);

        for (const path of ['employees', 'roles', 'templates', 'settings', 'audit']) {
            expect((await app.inject({ url: `/v1/admin/${path}`, headers: headers() })).statusCode).toBe(403);
        }

        await app.close();
    });
});

describe('employee administration', () => {
    it('lets an administrator rename only themselves', async () => {
        await change(context.admin, context.admin, { name: 'Главный' });
        const renamed = await reload(context.admin);

        expect(renamed.name).toBe('Главный');

        for (const body of [{ role: 'support' }, { blocked: true }, { max_user_id: '99' }]) {
            await expect(change(renamed, renamed, body)).rejects.toMatchObject({ code: 'self_change_forbidden' });
        }
    });

    it('protects active administrators from other administrators', async () => {
        const other = await addEmployee('3', 'admin');

        for (const body of [{ name: 'Другой' }, { blocked: true }, { role: 'support' }]) {
            await expect(change(context.admin, other, body)).rejects.toMatchObject({
                code: 'employee_protected',
            });
        }
    });

    it('edits a pending invite freely and locks its MAX ID once the employee signs in', async () => {
        const invited = await addEmployee('3', 'admin', false);

        await change(context.admin, invited, { max_user_id: '4', role: 'support' });
        const corrected = await reload(invited);

        expect(corrected).toMatchObject({ max_user_id: '4', role: 'support', activated_at: null });

        const app = await buildApi(context.db, context.c);

        await staffLogin(app, context.c.APP_ORIGIN, '4');
        await app.close();
        const active = await reload(invited);

        expect(active.activated_at).not.toBeNull();

        await expect(change(context.admin, active, { max_user_id: '5' })).rejects.toMatchObject({
            code: 'employee_already_active',
        });

        await change(context.admin, active, { name: 'Вера', blocked: true });
        expect(await reload(invited)).toMatchObject({ name: 'Вера', blocked: true, max_user_id: '4' });

        const audit = await one(context.db, "SELECT object_id FROM audit WHERE action='employee.activated'");

        expect(audit?.object_id).toBe(invited.id);
    });

    it('rejects a MAX ID that another employee already uses', async () => {
        const invited = await addEmployee('3', 'support', false);

        await expect(change(context.admin, invited, { max_user_id: '1' })).rejects.toMatchObject({
            code: 'max_id_taken',
        });

        await expect(
            admin.employee({
                actor: context.admin,
                body: { max_user_id: '1', name: 'Дубль', role: 'support' },
                expectedVersion: 0,
                idempotencyKey: randomUUID(),
            }),
        ).rejects.toMatchObject({ code: 'max_id_taken' });
    });

    it('blocking ends the sessions of the blocked employee', async () => {
        const app = await buildApi(context.db, context.c);
        const { headers } = await staffLogin(app, context.c.APP_ORIGIN, '1');

        await change(context.admin, await reload(context.staff), { blocked: true });
        expect((await app.inject({ url: '/v1/me', headers: headers() })).statusCode).toBe(401);
        await app.close();
    });

    it('denies employee changes to staff without the permission', async () => {
        const supervisor = await addEmployee('3', 'supervisor');

        await expect(change(supervisor, context.staff, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('reports each employee status', async () => {
        await addEmployee('3', 'support', false);
        await change(context.admin, await addEmployee('4', 'support'), { blocked: true });
        const { items } = await admin.employees();
        const statuses = Object.fromEntries(items.map((row) => [String(row.max_user_id), String(row.status)]));

        expect(statuses).toEqual({ '1': 'active', '2': 'active', '3': 'pending', '4': 'blocked' });
    });
});

describe('ticket actions', () => {
    it('keeps a colleague ticket closed to support but open to supervisors', async () => {
        const colleague = await addEmployee('3', 'support');
        const supervisor = await addEmployee('4', 'supervisor');

        await context.create();
        await context.command('classification', { urgency: 'high', revisions: { urgency: 0 } }, colleague);
        await context.command('assign');

        await expect(
            context.command('classification', { urgency: 'low', revisions: { urgency: 1 } }, colleague),
        ).rejects.toMatchObject({ code: 'forbidden' });

        await context.command('classification', { urgency: 'low', revisions: { urgency: 1 } }, supervisor);
        await context.command('transfer', { employee_id: colleague.id, comment: 'Помоги' }, supervisor);
        expect((await context.ticket()).assignee_id).toBe(colleague.id);
    });

    it('never assigns a ticket to an employee who has not signed in', async () => {
        const invited = await addEmployee('3', 'support', false);

        await context.create();
        await context.command('assign');

        await expect(context.command('transfer', { employee_id: invited.id, comment: 'Возьми' })).rejects.toMatchObject(
            { code: 'invalid_employee' },
        );
    });
});
