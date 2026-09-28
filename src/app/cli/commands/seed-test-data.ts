import { readFile } from 'node:fs/promises';

import { normalizeUpdate } from '../../../integrations/max/index.js';
import { Inbox } from '../../../modules/inbox/index.js';
import { ensure } from '../../../shared/errors.js';
import type { CliCommand } from '../cli-command.js';

const DEFAULT_FILE = 'test-data/max-updates.json';

export const seedTestDataCommand: CliCommand = async ({ db, config, args }) => {
    ensure(
        config.NODE_ENV !== 'production' || config.DEMO_ROLE_CODES,
        'test_data_forbidden',
        409,
        'Test data is loaded only into development and demo stands.',
    );

    const updates: unknown = JSON.parse(await readFile(args.at(0) ?? DEFAULT_FILE, 'utf8'));

    ensure(Array.isArray(updates), 'invalid_test_data', 422, 'Test data must be a JSON array of MAX updates.');
    const inbox = new Inbox(db, config);

    for (const update of updates) {
        await inbox.ingestConsented(normalizeUpdate(JSON.stringify(update)));
    }

    return `Loaded ${updates.length} test client messages.`;
};
