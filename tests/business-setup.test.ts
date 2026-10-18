import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';
import { Workflows, type Model, type ModelRequest } from '../src/modules/ai/index.js';
import { one } from '../src/shared/db.js';
import type { Job, Row } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';
import { staffLogin, type StaffHeaders } from './support/http-client.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin: StaffHeaders;
let support: StaffHeaders;

beforeEach(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);
    admin = (await staffLogin(app, context.c.APP_ORIGIN, '2')).headers;
    support = (await staffLogin(app, context.c.APP_ORIGIN, '1')).headers;
});

afterEach(async () => {
    await app.close();
    await context.db.close();
});

async function read<T = Row>(url: string): Promise<T> {
    const response = await app.inject({ url, headers: admin() });

    expect(response.statusCode).toBe(200);

    return response.json<T>();
}

function send(method: 'PUT' | 'POST', url: string, version: number, payload: Row = {}) {
    return app.inject({ method, url, headers: admin({ 'if-match': String(version) }), payload });
}

async function tags(): Promise<Row[]> {
    const { items } = await read<{ items: Row[] }>('/v1/dictionaries');

    return items.filter((item) => item.dimension === 'tag');
}

const activeCodes = async () =>
    (await tags())
        .filter((tag) => tag.active)
        .map((tag) => tag.code)
        .sort();

const profileBody = {
    description: 'Интернет-магазин электроники',
    offerings: 'Смартфоны, ноутбуки, аксессуары',
    tone: 'friendly',
    rules: ['Не обещать скидку'],
    glossary: [{ term: 'ПВЗ', meaning: 'пункт выдачи заказов' }],
    configured: true,
};

it('starts a fresh organisation from the general preset with described topics and levels', async () => {
    expect(await read('/v1/admin/profile')).toMatchObject({ preset: 'general', configured: false, tone: 'formal' });
    expect(await activeCodes()).toContain('question');
    expect(await activeCodes()).not.toContain('wifi_router');

    const { items } = await read<{ items: Row[] }>('/v1/dictionaries');
    const critical = items.find((item) => item.dimension === 'urgency' && item.code === 'critical');

    expect(critical?.description).toMatch(/многих клиентов/);
    expect((await app.inject({ url: '/v1/admin/profile', headers: support() })).statusCode).toBe(403);
});

it('previews and applies an industry preset without deleting topics in use', async () => {
    const ticket = await context.create('Хочу узнать график работы');

    await context.db.query("UPDATE tickets SET tag='question' WHERE id=$1", [ticket.id]);

    const presets = await read<{ items: Row[]; current: string }>('/v1/admin/presets');

    expect(presets.current).toBe('general');
    expect(presets.items.map((item) => item.id)).toEqual(['general', 'ecommerce', 'clinic', 'saas', 'telecom']);

    const preview = await read('/v1/admin/presets/ecommerce/preview');

    expect(preview.add).toContain('Статус и доставка заказа');
    expect(preview.deactivate).toEqual(expect.arrayContaining(['Вопрос или консультация', 'Отзыв или предложение']));
    expect(preview.update).toContain('Оплата и чеки');

    const { version } = await read<{ version: number }>('/v1/admin/profile');

    expect((await send('POST', '/v1/admin/presets/ecommerce/apply', version + 1)).statusCode).toBe(409);
    const applied = await send('POST', '/v1/admin/presets/ecommerce/apply', version);

    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ profile: Row }>().profile).toMatchObject({ preset: 'ecommerce', tone: 'friendly' });
    expect(applied.json<{ profile: Row }>().profile.rules).toContain('Не обещать возврат денег до проверки товара');
    expect(await activeCodes()).toContain('delivery');
    expect(await activeCodes()).not.toContain('question');
    expect((await tags()).find((tag) => tag.code === 'question')).toMatchObject({ active: false });
    expect((await context.ticket()).tag).toBe('question');

    const again = await read('/v1/admin/presets/ecommerce/preview');

    expect(again).toMatchObject({ add: [], update: [], deactivate: [] });
    expect((await app.inject({ url: '/v1/admin/presets/unknown/preview', headers: admin() })).statusCode).toBe(404);
});

it('saves the business profile with optimistic versions and size limits', async () => {
    const { version } = await read<{ version: number }>('/v1/admin/profile');
    const saved = await send('PUT', '/v1/admin/profile', version, profileBody);

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ...profileBody, configured: true, version: version + 1 });
    expect((await send('PUT', '/v1/admin/profile', version, profileBody)).statusCode).toBe(409);

    const tooLong = await send('PUT', '/v1/admin/profile', version + 1, {
        ...profileBody,
        description: 'а'.repeat(501),
    });

    expect(tooLong.statusCode).toBe(422);
});

it('creates a topic from its name only and keeps descriptions when an old client omits them', async () => {
    const create = (payload: Row) =>
        app.inject({
            method: 'PUT',
            url: '/v1/admin/dictionaries',
            headers: admin({ 'if-match': '0' }),
            payload: { dimension: 'tag', rank: 5, active: true, ...payload },
        });

    const first = await create({
        label: 'Возврат товара',
        description: 'Клиент хочет вернуть товар',
        examples: ['Как вернуть?'],
    });

    const second = await create({ label: 'Возврат товара!' });

    expect(first.json<Row>()).toMatchObject({ code: 'vozvrat_tovara', examples: ['Как вернуть?'] });
    expect(second.json<Row>().code).toBe('vozvrat_tovara_2');

    const renamed = await app.inject({
        method: 'PUT',
        url: '/v1/admin/dictionaries',
        headers: admin({ 'if-match': String(first.json<Row>().version) }),
        payload: { dimension: 'tag', code: 'vozvrat_tovara', label: 'Возвраты', rank: 5, active: true },
    });

    expect(renamed.json()).toMatchObject({ label: 'Возвраты', description: 'Клиент хочет вернуть товар' });
});

it('serves menu labels to clients and keeps the old labels working as commands', async () => {
    const bot = await read<Row & { version: number; menu: Row }>('/v1/admin/bot');

    expect(bot).toMatchObject({ policy_version: 'test-1', policy_version_source: 'deployment' });

    const conflict = await send('PUT', '/v1/admin/bot', bot.version, {
        policy_url: bot.policy_url,
        alternative_contact: bot.alternative_contact,
        menu: { tickets: 'Помощь', help: 'Справка', withdraw: 'Отозвать согласие' },
    });

    expect(conflict.statusCode).toBe(422);

    const saved = await send('PUT', '/v1/admin/bot', bot.version, {
        policy_url: bot.policy_url,
        alternative_contact: 'Телефон 8 800 000-00-00',
        menu: { tickets: 'Мои заявки', help: 'Справка', withdraw: 'Отозвать согласие' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ alternative_contact: 'Телефон 8 800 000-00-00', policy_version: 'test-1' });

    await context.create();
    await context.input('Справка');

    const help = await one(context.db, "SELECT body FROM deliveries WHERE kind='help' ORDER BY created_at DESC");
    const body = (typeof help!.body === 'string' ? JSON.parse(help!.body) : help!.body) as Row;

    expect(body.text).toContain('«Мои заявки» (/tickets)');
    expect(JSON.stringify(body.attachments)).toContain('Мои заявки');

    await context.input('Мои обращения');
    expect(await one(context.db, "SELECT 1 AS found FROM deliveries WHERE kind='history_page'")).toBeTruthy();

    expect(
        (await context.db.query("SELECT text FROM messages WHERE author_type='client' ORDER BY seq")).rows,
    ).toHaveLength(1);
});

it('asks every client without an open ticket for consent again after a new policy edition', async () => {
    const ticket = await context.create('Здравствуйте');

    await context.db.query("UPDATE tickets SET status='closed',closed_at=now() WHERE id=$1", [ticket.id]);

    const bot = await read<Row & { version: number }>('/v1/admin/bot');

    const saved = await send('PUT', '/v1/admin/bot', bot.version, {
        policy_url: 'https://shop.example/privacy',
        alternative_contact: bot.alternative_contact,
        menu: bot.menu as Row,
        new_policy_edition: true,
    });

    expect(saved.json()).toMatchObject({
        policy_url: 'https://shop.example/privacy',
        policy_version_source: 'organization',
    });

    const prompts = async () =>
        (await one<{ n: number }>(
            context.db,
            "SELECT count(*)::int AS n FROM deliveries WHERE kind='consent_request'",
        ))!.n;

    const before = await prompts();

    await context.input('Новый вопрос');
    expect(await prompts()).toBe(before + 1);

    const prompt = await one(
        context.db,
        "SELECT body FROM deliveries WHERE kind='consent_request' ORDER BY created_at DESC",
    );

    expect(JSON.stringify(prompt!.body)).toContain('https://shop.example/privacy');
});

it('gives the model the business profile and the topic descriptions', async () => {
    const { version } = await read<{ version: number }>('/v1/admin/profile');

    await send('PUT', '/v1/admin/profile', version, profileBody);
    await context.create('Не пришёл заказ');

    const requests: ModelRequest[] = [];

    const model: Model = {
        complete(_job, _step, request) {
            requests.push(request);

            return Promise.resolve({ content: JSON.stringify(request.mock), toolCalls: [], usage: {} });
        },
    };

    const job = (await one<Job>(
        context.db,
        "UPDATE jobs SET state='running',generation=generation+1 WHERE kind='triage' RETURNING *",
    ))!;

    const recall = { search: () => Promise.resolve([]), expand: () => Promise.resolve([]) };

    await new Workflows(context.db, context.c, model, recall).triage(job);

    const system = String(requests[0].messages[0].content);
    const input = JSON.parse(String(requests[0].messages[1].content)) as Row & { business: Row; dictionaries: Row[] };

    expect(system).toContain('version: 1.4.0');
    expect(input.business).toMatchObject({ description: 'Интернет-магазин электроники', tone: 'friendly' });
    expect(input.dictionaries.find((entry) => entry.code === 'question')?.description).toMatch(/Нужна информация/);

    const audit = await one(context.db, "SELECT detail FROM audit WHERE action='ai.triage' ORDER BY created_at DESC");

    expect(audit!.detail).toMatchObject({ business_version: version + 1 });
});
