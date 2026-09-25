import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApi } from '../src/app/http/build-api.js';

import { fixture } from './helpers.js';

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
