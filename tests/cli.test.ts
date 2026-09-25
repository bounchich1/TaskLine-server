import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { mediaHostsCommand } from '../src/app/cli/commands/media-hosts.js';
import { migrateCommand } from '../src/app/cli/commands/migrate.js';
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

const run = (command: typeof migrateCommand) =>
  command({ db: context.db, config: context.c, args: [] });

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

  expect(await run(mediaHostsCommand)).toBe(
    'Hosts of attachments waiting for download: files.example.test',
  );
});
