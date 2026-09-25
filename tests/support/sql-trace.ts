import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterAll, expect } from 'vitest';

const traceDir = process.env.SQL_TRACE;
const traces = new Map<string, string[]>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeParam(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return UUID.test(value) ? 'uuid' : 'str';
  }
  return typeof value;
}

function normalize(sql: string): string {
  const compact = sql.replace(/\s+/g, '');
  return compact.length > 2000
    ? `script:${createHash('sha1').update(compact).digest('hex')}`
    : compact;
}

export function traceSql(sql: string, params: readonly unknown[] = []): void {
  if (!traceDir) {
    return;
  }
  const test = expect.getState().currentTestName ?? '<outside test>';
  const entries = traces.get(test) ?? [];
  entries.push(`${normalize(sql)} :: ${params.map(describeParam).join(',')}`);
  traces.set(test, entries);
}

export function traceTransaction(marker: 'begin' | 'end'): void {
  traceSql(`<tx:${marker}>`);
}

afterAll(() => {
  if (!traceDir || traces.size === 0) {
    return;
  }
  const testPath = expect.getState().testPath ?? 'unknown';
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, `${basename(testPath)}.json`),
    `${JSON.stringify(Object.fromEntries(traces), null, 2)}\n`,
  );
  traces.clear();
});
