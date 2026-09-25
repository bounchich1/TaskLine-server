import { migrate } from '../../../shared/db.js';
import { seed } from '../../bootstrap/seed.js';
import type { CliCommand } from '../cli-command.js';

export const migrateCommand: CliCommand = async ({ db, config }) => {
  await migrate(db);
  await seed(db, config);
  return 'Schema and reserved defaults ready.';
};
