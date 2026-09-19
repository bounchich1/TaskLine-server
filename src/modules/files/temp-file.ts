import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempFile {
  /** Path of the (not yet created) file inside a private temporary directory. */
  path: string;
  /** Removes the directory and the file; safe to call more than once. */
  cleanup: () => Promise<void>;
}

export async function createTempFile(prefix: string): Promise<TempFile> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return {
    path: join(directory, 'body'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
