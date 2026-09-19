import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApi } from '../src/api.js';
import { fixture } from './helpers.js';

// Refactoring safety net: the HTTP surface (paths and methods) must not change while routes move
// into feature modules. The route tree is flattened and sorted so registration order is irrelevant.

let f: Awaited<ReturnType<typeof fixture>>;
let app: Awaited<ReturnType<typeof buildApi>>;

beforeAll(async () => {
  f = await fixture();
  app = await buildApi(f.db, f.c);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await f.db.close();
});

function flattenRouteTree(tree: string): string[] {
  const prefixes: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^(.*?)[├└]── (.+?)(?: \(([^)]+)\))?$/.exec(line);
    if (!match) {
      continue;
    }
    const [, indent = '', segment = '', methods] = match;
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
