import { readConfig } from '../../shared/config.js';
import { Postgres } from '../../shared/db.js';

import type { CliCommand } from './cli-command.js';
import { aiCapCommand } from './commands/ai-cap.js';
import { bootstrapCommand } from './commands/bootstrap.js';
import { memoryReconcileCommand } from './commands/memory-reconcile.js';
import { migrateCommand } from './commands/migrate.js';
import { permitResolveCommand } from './commands/permit-resolve.js';
import { subscribeCommand } from './commands/subscribe.js';

const COMMANDS = new Map<string, CliCommand>([
  ['migrate', migrateCommand],
  ['bootstrap', bootstrapCommand],
  ['subscribe', subscribeCommand],
  ['memory-reconcile', memoryReconcileCommand],
  ['permit-resolve', permitResolveCommand],
  ['ai-cap', aiCapCommand],
]);

const USAGE =
  'Commands: migrate, bootstrap, subscribe, memory-reconcile <id>, ' +
  'permit-resolve <slot> <evidence>, ai-cap <10..15>';

export async function runCli(argv: string[]): Promise<void> {
  const config = readConfig();
  const db = new Postgres(config.DATABASE_URL);
  try {
    const command = COMMANDS.get(argv.at(0) ?? '');
    const args = argv.slice(1);
    if (!command) {
      throw new Error(USAGE);
    }
    console.log(await command({ db, config, args }));
  } finally {
    await db.close();
  }
}
