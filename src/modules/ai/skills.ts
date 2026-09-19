import { readFileSync } from 'node:fs';

import { serverFile } from '../../shared/paths.js';

// Model instructions from agent-skills/*/SKILL.md, read once at startup so a missing file fails
// fast. Their hashes are written to the audit log with every result they produce.

export const TRIAGE_SKILL = readFileSync(
  serverFile('agent-skills/support-triage/SKILL.md'),
  'utf8',
);
export const LEARNING_SKILL = readFileSync(
  serverFile('agent-skills/support-close-learning/SKILL.md'),
  'utf8',
);
