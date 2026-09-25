import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { maxDispatcher, maxTrustedRoots } from '../src/shared/tls.js';

import { testConfig } from './helpers.js';

const EXTRA_ROOT = '-----BEGIN CERTIFICATE-----\nMIIBextra\n-----END CERTIFICATE-----\n';
let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tls-test-'));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

it('keeps the default trust store when no extra MAX root is configured', () => {
    expect(maxTrustedRoots({ MAX_CA_FILE: '' })).toBeUndefined();
    expect(maxDispatcher({ MAX_CA_FILE: '' })).toBeUndefined();
});

it('adds the configured root to the default ones for MAX connections only', async () => {
    const file = join(directory, 'root.pem');

    await writeFile(file, EXTRA_ROOT);

    const roots = maxTrustedRoots({ MAX_CA_FILE: file });

    expect(roots).toHaveLength(rootCertificates.length + 1);
    expect(roots?.at(-1)).toBe(EXTRA_ROOT);
    expect(maxDispatcher({ MAX_CA_FILE: file })).toBe(maxDispatcher({ MAX_CA_FILE: file }));
});

it('refuses to start with a missing MAX root file', () => {
    expect(() => testConfig({ MAX_CA_FILE: join(directory, 'missing.pem') })).toThrow('MAX_CA_FILE does not exist');
});
