import { migrate } from '../../../shared/db.js';
import { seed } from '../../bootstrap/seed.js';
import type { CliCommand } from '../cli-command.js';

export const migrateCommand: CliCommand = async ({ db, config }) => {
  const applied = await migrate(db);
  await seed(db, config);
  return applied.length
    ? `Applied migrations ${applied.join(', ')}; reserved defaults ready.`
    : 'Schema up to date; reserved defaults ready.';
};
