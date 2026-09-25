import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';

interface CliContext {
    db: Database;
    config: Config;
    args: string[];
}

export type CliCommand = (context: CliContext) => Promise<string>;
