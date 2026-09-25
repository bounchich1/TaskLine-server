import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempFile {
    path: string;
    cleanup: () => Promise<void>;
}

export async function createTempFile(prefix: string): Promise<TempFile> {
    const directory = await mkdtemp(join(tmpdir(), prefix));

    return {
        path: join(directory, 'body'),
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}
