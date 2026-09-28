import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { mediaHostsCommand } from '../src/app/cli/commands/media-hosts.js';
import { migrateCommand } from '../src/app/cli/commands/migrate.js';
import { seedTestDataCommand } from '../src/app/cli/commands/seed-test-data.js';
import { requireOne } from '../src/shared/db.js';
import type { Client } from '../src/shared/types/entities.js';

import { fixture } from './helpers.js';

let context: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
    context = await fixture();
});

afterEach(async () => {
    await context.db.close();
});

const run = (command: typeof migrateCommand) => command({ db: context.db, config: context.c, args: [] });

it('reports an up-to-date schema on a repeated migrate', async () => {
    expect(await run(migrateCommand)).toBe('Schema up to date; reserved defaults ready.');
});

it('lists the hosts of attachments waiting for download', async () => {
    expect(await run(mediaHostsCommand)).toBe('No attachments are waiting for download.');
    const client = (await context.create()).client_id;

    const { max_user_id: userId, chat_id: chatId } = await requireOne<Client>(
        context.db,
        'SELECT * FROM clients WHERE id=$1',
        [client],
    );

    const key = `m-${randomUUID()}`;

    await context.domain.ingest({
        kind: 'message',
        userId,
        chatId,
        messageId: key,
        sourceKey: key,
        text: 'Скриншот ошибки',
        attachments: [{ kind: 'image', filename: 'error.png', url: 'https://files.example.test/a/1' }],
    });

    await context.domain.processClient(client);

    expect(await run(mediaHostsCommand)).toBe('Hosts of attachments waiting for download: files.example.test');
});

it('loads the test data as consented clients whose messages open tickets', async () => {
    expect(await run(seedTestDataCommand)).toBe('Loaded 7 test client messages.');
    expect(await run(seedTestDataCommand)).toBe('Loaded 7 test client messages.');

    const { rows: clients } = await context.db.query<Client>(
        "SELECT * FROM clients WHERE org_id=$1 AND max_user_id LIKE '91%' ORDER BY max_user_id",
        [context.c.ORG_ID],
    );

    expect(clients.map((client) => client.consent_state)).toEqual(Array.from({ length: 6 }, () => 'granted'));

    for (const client of clients) {
        while (await context.domain.processClient(client.id)) {
            continue;
        }
    }

    const tickets = await requireOne(
        context.db,
        `SELECT count(DISTINCT t.id)::int AS tickets,count(m.id)::int AS messages
     FROM tickets t JOIN messages m ON m.ticket_id=t.id AND m.author_type='client' WHERE t.org_id=$1`,
        [context.c.ORG_ID],
    );

    expect(tickets).toEqual({ tickets: 6, messages: 7 });
});

it('refuses to load test data into a production stand without demo codes', async () => {
    const production = { ...context.c, NODE_ENV: 'production' as const, DEMO_ROLE_CODES: '' };

    await expect(seedTestDataCommand({ db: context.db, config: production, args: [] })).rejects.toThrow(
        'development and demo',
    );
});
