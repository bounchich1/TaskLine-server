import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { DemoRoles, parseRoleCodes } from '../src/modules/demo-access/index.js';
import { one } from '../src/shared/db.js';
import type { Employee, Row } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';

const SUPPORT_CODE = 'SUP-7K2M-9QXD-4HPT';
const ADMIN_CODE = 'ADM-3JQW-8RTV-2LXN';
const CODES = `support:${SUPPORT_CODE}, admin:${ADMIN_CODE.toLowerCase()}`;

let messageSeq = 0;

function message(text: string, sender: Row = { user_id: 300, first_name: 'Ирина', last_name: 'Петрова' }) {
    return {
        update_type: 'message_created',
        message: {
            sender,
            recipient: { chat_id: 900, chat_type: 'dialog' },
            body: { mid: `demo-m${++messageSeq}`, text },
        },
    };
}

describe('demo role codes', () => {
    it('parses role:CODE pairs case-insensitively', () => {
        expect(parseRoleCodes('')).toEqual([]);

        expect(parseRoleCodes(CODES)).toEqual([
            { role: 'support', code: SUPPORT_CODE },
            { role: 'admin', code: ADMIN_CODE },
        ]);
    });

    it('rejects unknown roles, short codes and repeated codes', () => {
        expect(() => parseRoleCodes(`client:${SUPPORT_CODE}`)).toThrow('DEMO_ROLE_CODES');
        expect(() => parseRoleCodes('support:SHORT')).toThrow('DEMO_ROLE_CODES');
        expect(() => parseRoleCodes(SUPPORT_CODE)).toThrow('DEMO_ROLE_CODES');
        expect(() => parseRoleCodes(`support:${SUPPORT_CODE},admin:${SUPPORT_CODE}`)).toThrow('twice');
    });
});

describe('demo code command', () => {
    const roles = new DemoRoles({} as never, testConfig({ DEMO_ROLE_CODES: CODES }), { send: vi.fn() });

    it('reads /code with its argument and the sender name', () => {
        expect(roles.read(JSON.stringify(message(`/Code  ${SUPPORT_CODE} `)))).toEqual({
            edited: false,
            userId: '300',
            chatId: '900',
            name: 'Ирина Петрова',
            code: SUPPORT_CODE,
        });

        expect(roles.read(JSON.stringify(message('/code', { user_id: 301 })))?.name).toBe('Эксперт 301');
    });

    it('leaves every other update to the inbox', () => {
        expect(roles.read(JSON.stringify(message('Не работает принтер')))).toBeUndefined();
        expect(roles.read(JSON.stringify(message(`/codex ${SUPPORT_CODE}`)))).toBeUndefined();
        expect(roles.read(JSON.stringify(message('/code', { user_id: 300, is_bot: true })))).toBeUndefined();

        expect(
            roles.read(JSON.stringify({ update_type: 'bot_started', chat_id: 900, user: { user_id: 300 } })),
        ).toBeUndefined();

        expect(roles.read('{not json')).toBeUndefined();
    });
});

describe('demo access webhook', () => {
    let context: Awaited<ReturnType<typeof fixture>>;
    let app: Awaited<ReturnType<typeof buildApi>>;

    const send = (payload: ReturnType<typeof message>, secret = context.c.MAX_WEBHOOK_SECRET) =>
        app.inject({ method: 'POST', url: '/webhooks/max', headers: { 'x-max-bot-api-secret': secret }, payload });

    const employee = (userId = '300') =>
        one<Employee>(context.db, 'SELECT * FROM employees WHERE org_id=$1 AND max_user_id=$2', [
            context.c.ORG_ID,
            userId,
        ]);

    const inboxCount = async () => (await one(context.db, 'SELECT count(*)::int AS n FROM inbox'))?.n;

    beforeEach(async () => {
        context = await fixture(undefined, testConfig({ DEMO_ROLE_CODES: CODES }));
        app = await buildApi(context.db, context.c);
    });

    afterEach(async () => {
        await app.close();
        await context.db.close();
    });

    it('grants a pending employee account without touching the inbox', async () => {
        expect((await send(message(`/code ${SUPPORT_CODE}`))).statusCode).toBe(200);

        expect(await employee()).toMatchObject({
            name: 'Ирина Петрова',
            role: 'support',
            blocked: false,
            activated_at: null,
        });

        expect(await inboxCount()).toBe(0);

        const entry = await one(context.db, "SELECT detail FROM audit WHERE action='employee.demo_role'");

        expect(entry?.detail).toEqual({ role: 'support', previous: null });
    });

    it('switches roles and revokes open sessions', async () => {
        await send(message(`/code ${SUPPORT_CODE}`));
        const before = await employee();

        await context.db.query(
            `INSERT INTO staff_sessions(hash,org_id,employee_id,employee_version,csrf_hash,launch_hash)
       VALUES('demo-session',$1,$2,$3,'csrf','launch')`,
            [context.c.ORG_ID, before?.id, before?.version],
        );

        await send(message(`/code ${ADMIN_CODE.toLowerCase()}`));
        const after = await employee();

        expect(after).toMatchObject({ id: before?.id, role: 'admin', version: Number(before?.version) + 1 });
        const session = await one(context.db, "SELECT revoked FROM staff_sessions WHERE hash='demo-session'");

        expect(session?.revoked).toBe(true);

        const login = await app.inject({
            method: 'POST',
            url: '/v1/auth/dev',
            headers: { origin: context.c.APP_ORIGIN },
            payload: { user_id: '300' },
        });

        expect(login.statusCode).toBe(200);
        expect(login.json<{ permissions: string[] }>().permissions).toContain('employees.manage');
        expect((await employee())?.activated_at).not.toBeNull();
    });

    it('swallows wrong codes and codes from blocked accounts', async () => {
        expect((await send(message('/code WRONG-CODE-0000'))).statusCode).toBe(200);
        expect(await employee()).toBeUndefined();

        await context.db.query("UPDATE employees SET blocked=true WHERE org_id=$1 AND max_user_id='1'", [
            context.c.ORG_ID,
        ]);

        await send(message(`/code ${ADMIN_CODE}`, { user_id: 1 }));
        expect(await employee('1')).toMatchObject({ role: 'support', blocked: true });
        expect(await inboxCount()).toBe(0);
    });

    it('passes ordinary messages and unsigned requests through', async () => {
        expect((await send(message('Не работает принтер'))).statusCode).toBe(200);
        expect(await inboxCount()).toBe(1);

        expect((await send(message(`/code ${ADMIN_CODE}`), 'x'.repeat(40))).statusCode).toBe(401);
        expect(await employee()).toBeUndefined();
    });
});

describe('demo access switch', () => {
    it('sends /code to the inbox like any message when no codes are configured', async () => {
        const context = await fixture();
        const app = await buildApi(context.db, context.c);

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/webhooks/max',
                headers: { 'x-max-bot-api-secret': context.c.MAX_WEBHOOK_SECRET },
                payload: message(`/code ${SUPPORT_CODE}`),
            });

            expect(response.statusCode).toBe(200);
            expect((await one(context.db, 'SELECT count(*)::int AS n FROM inbox'))?.n).toBe(1);
        } finally {
            await app.close();
            await context.db.close();
        }
    });

    it('replies with the outcome of each code', async () => {
        const context = await fixture(undefined, testConfig({ DEMO_ROLE_CODES: CODES }));
        const reply = vi.fn<(chatId: string, body: Row) => Promise<string>>().mockResolvedValue('mid');
        const roles = new DemoRoles(context.db, context.c, { send: reply });
        const apply = async (text: string) => roles.apply(roles.read(JSON.stringify(message(text)))!);

        try {
            expect(await apply(`/code ${SUPPORT_CODE}`)).toContain('Роль «Сотрудник поддержки» выдана');
            expect(await apply(`/code ${SUPPORT_CODE}`)).toContain('У вас уже роль «Сотрудник поддержки»');
            expect(await apply('/code')).toContain('Код не подошёл');
            await roles.reply('900', 'ok');
            expect(reply).toHaveBeenCalledWith('900', { text: 'ok' });
        } finally {
            await context.db.close();
        }
    });
});
