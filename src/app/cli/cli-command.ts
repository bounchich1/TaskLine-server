import type { Config } from '../../shared/config.js';
import type { Database } from '../../shared/db.js';

export interface CliContext {
  db: Database;
  config: Config;
  /** Arguments after the command name. */
  args: string[];
}

/** An operator command; resolves to the confirmation message to print. */
export type CliCommand = (context: CliContext) => Promise<string>;
