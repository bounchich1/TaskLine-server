import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';

import { fixture, testConfig } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;

beforeAll(async () => {
    context = await fixture();
    app = await buildApi(context.db, context.c);
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await context.db.close();
});

function flattenRouteTree(tree: string): string[] {
    const prefixes: string[] = [];
    const routes: string[] = [];

    for (const line of tree.split('\n')) {
        const match = /^(.*?)[├└]── (.+?)(?: \(([^)]+)\))?$/.exec(line);

        if (!match) {
            continue;
        }

        const [, indent = '', segment = ''] = match;
        const methods = match.at(3);
        const depth = indent.length / 4;
        const path = (depth > 0 ? (prefixes[depth - 1] ?? '') : '') + segment;

        prefixes[depth] = path;
        prefixes.length = depth + 1;

        for (const method of methods?.split(', ') ?? []) {
            routes.push(`${method} ${path}`);
        }
    }

    return routes.sort();
}

it('keeps the registered route table stable', () => {
    expect(flattenRouteTree(app.printRoutes({ commonPrefix: false }))).toMatchSnapshot();
});

function documentedRoutes(spec: string): string[] {
    const routes: string[] = [];
    let path = '';

    for (const line of spec.split('\n')) {
        const pathMatch = /^ {2}(\/\S*):$/.exec(line);
        const methodMatch = /^ {4}(get|post|put|patch|delete):$/.exec(line);

        if (pathMatch) {
            path = pathMatch[1].replaceAll(/\{(\w+)\}/g, ':$1');
        } else if (/^\S/.test(line)) {
            path = '';
        } else if (methodMatch && path) {
            routes.push(`${methodMatch[1].toUpperCase()} ${path}`);
        }
    }

    return routes.sort();
}

it('documents every route of a fully configured API in openapi.yaml', async () => {
    const config = testConfig({ MAX_STAFF_BOT_TOKEN: 'staff-token', MAX_STAFF_WEBHOOK_SECRET: 's'.repeat(40) });
    const full = await fixture(undefined, config);
    const api = await buildApi(full.db, config);

    try {
        await api.ready();

        const registered = flattenRouteTree(api.printRoutes({ commonPrefix: false })).filter(
            (route) => !route.startsWith('HEAD '),
        );

        expect(documentedRoutes(await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8'))).toEqual(
            registered,
        );
    } finally {
        await api.close();
        await full.db.close();
    }
});
