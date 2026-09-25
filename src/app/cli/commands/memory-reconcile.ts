import { Memory } from '../../../modules/ai/index.js';
import { ensure } from '../../../shared/errors.js';
import type { CliCommand } from '../cli-command.js';

export const memoryReconcileCommand: CliCommand = async ({ db, config, args }) => {
  const [id] = args;
  ensure(id, 'record_id_required', 422);
  await new Memory(db, config).reconcile(id);
  return 'Memory reconciliation completed.';
};
