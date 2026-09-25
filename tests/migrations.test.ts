import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { latestMigration, migrate, schemaVersion, type Database } from '../src/shared/db.js';
import { serverFile } from '../src/shared/paths.js';

import { emptyMemoryDb } from './helpers.js';

let db: Database;
let directory: string;

const directoryUrl = () => pathToFileURL(`${directory}/`);

const addMigration = async (name: string, sql: string) => {
    await writeFile(join(directory, name), sql);
};

beforeEach(async () => {
    db = emptyMemoryDb();
    directory = await mkdtemp(join(tmpdir(), 'migrations-test-'));
    await copyFile(serverFile('migrations/001_initial.sql'), join(directory, '001_initial.sql'));
});

afterEach(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
});

it('applies every migration in version order on a fresh database', async () => {
    await addMigration('010_later.sql', 'ALTER TABLE probe ADD COLUMN note text;');
    await addMigration('002_probe.sql', 'CREATE TABLE probe (id integer PRIMARY KEY);');
    await addMigration('README.md', 'not a migration');

    expect(await latestMigration(directoryUrl())).toBe(10);
    expect(await migrate(db, directoryUrl())).toEqual([1, 2, 10]);
    expect(await schemaVersion(db)).toBe(10);
    await db.query("INSERT INTO probe(id, note) VALUES (1, 'ok')");
});

it('applies only the migrations a database has not seen', async () => {
    expect(await migrate(db, directoryUrl())).toEqual([1]);
    await addMigration('002_probe.sql', 'CREATE TABLE probe (id integer PRIMARY KEY);');

    expect(await migrate(db, directoryUrl())).toEqual([2]);
    expect(await migrate(db, directoryUrl())).toEqual([]);
    expect(await schemaVersion(db)).toBe(2);
});

it('rolls back every pending migration when one fails', async () => {
    await addMigration('002_probe.sql', 'CREATE TABLE probe (id integer PRIMARY KEY);');
    await addMigration('003_broken.sql', 'ALTER TABLE missing ADD COLUMN x integer;');

    await expect(migrate(db, directoryUrl())).rejects.toThrow();
    expect(await migrate(db, serverFile('migrations/'))).toEqual([1]);
    expect(await schemaVersion(db)).toBe(1);
});

it('refuses two migrations with the same version', async () => {
    await addMigration('001_duplicate.sql', 'SELECT 1;');

    await expect(migrate(db, directoryUrl())).rejects.toThrow('share a version');
});
