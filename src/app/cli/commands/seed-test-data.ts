import { readFile } from 'node:fs/promises';

import { ensure } from '../../../shared/errors.js';
import { TestDataLoader, type ResolvedCase } from '../../bootstrap/test-data.js';
import type { CliCommand } from '../cli-command.js';

const OPEN_FILE = 'test-data/max-updates.json';
const RESOLVED_FILE = 'test-data/resolved-cases.json';

export const seedTestDataCommand: CliCommand = async ({ db, config, args }) => {
    ensure(
        config.NODE_ENV !== 'production' || config.DEMO_ROLE_CODES,
        'test_data_forbidden',
        409,
        'Test data is loaded only into development and demo stands.',
    );

    const loader = new TestDataLoader(db, config, (line) => {
        console.log(line);
    });

    const solved = await loader.loadResolved((await readArray(RESOLVED_FILE)) as ResolvedCase[]);
    const open = await loader.loadOpen(await readArray(args.at(0) ?? OPEN_FILE));

    return `Loaded ${solved} solved cases and ${open} open tickets.`;
};

async function readArray(path: string): Promise<unknown[]> {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));

    ensure(Array.isArray(data), 'invalid_test_data', 422, `${path} must be a JSON array.`);

    return data as unknown[];
}
