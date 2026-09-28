import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { mediaHostsCommand } from '../src/app/cli/commands/media-hosts.js';
import { migrateCommand } from '../src/app/cli/commands/migrate.js';
import { seedTestDataCommand } from '../src/app/cli/commands/seed-test-data.js';
import { Inbox } from '../src/modules/inbox/index.js';
import { requireOne } from '../src/shared/db.js';
import type { Client } from '../src/shared/types/entities.js';

import { fixture, testConfig } from './helpers.js';

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

it('loads solved and open test tickets for synthetic clients without contacting MAX', async () => {
    const stand = await fixture(undefined, testConfig({ AI_ENABLED: 'false' }));
    const seed = () => seedTestDataCommand({ db: stand.db, config: stand.c, args: [] });

    try {
        expect(await seed()).toBe('Loaded 6 solved cases and 6 open tickets.');
        expect(await seed()).toBe('Loaded 6 solved cases and 6 open tickets.');

        const summary = await requireOne(
            stand.db,
            `SELECT count(*) FILTER(WHERE t.status='closed')::int AS closed,
       count(*) FILTER(WHERE t.status='open')::int AS open,
       count(*) FILTER(WHERE c.synthetic AND c.consent_state='granted')::int AS synthetic,
       (SELECT count(*)::int FROM closures WHERE org_id=$1 AND rating IS NOT NULL) AS rated,
       (SELECT count(*)::int FROM jobs WHERE org_id=$1 AND kind='learning') AS learning,
       (SELECT count(*)::int FROM deliveries WHERE org_id=$1 AND state='delivered' AND provider_ref LIKE 'synthetic-%')>0
         AS simulated,
       (SELECT count(*)::int FROM deliveries WHERE org_id=$1
         AND (state IN('failed','unknown','canceled') OR (state='delivered' AND provider_ref NOT LIKE 'synthetic-%'))) AS real
     FROM tickets t JOIN clients c ON c.id=t.client_id WHERE t.org_id=$1`,
            [stand.c.ORG_ID],
        );

        expect(summary).toEqual({ closed: 6, open: 6, synthetic: 12, rated: 6, learning: 6, simulated: true, real: 0 });
    } finally {
        await stand.db.close();
    }
});

it('never turns a real client into a test client', async () => {
    const real = await requireOne<Client>(context.db, 'SELECT * FROM clients WHERE id=$1', [
        (await context.create()).client_id,
    ]);

    const inbox = new Inbox(context.db, context.c);

    await expect(
        inbox.ingestConsented({
            kind: 'message',
            userId: real.max_user_id,
            chatId: real.chat_id,
            messageId: 'test-real',
            sourceKey: 'message_created:test-real',
            text: 'Тест',
        }),
    ).rejects.toMatchObject({ code: 'real_client' });
});

it('refuses to load test data into a production stand without demo codes', async () => {
    const production = { ...context.c, NODE_ENV: 'production' as const, DEMO_ROLE_CODES: '' };

    await expect(seedTestDataCommand({ db: context.db, config: production, args: [] })).rejects.toThrow(
        'development and demo',
    );
});
