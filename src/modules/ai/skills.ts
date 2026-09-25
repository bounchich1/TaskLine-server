import { readFileSync } from 'node:fs';

import { serverFile } from '../../shared/paths.js';

export const TRIAGE_SKILL = readFileSync(
  serverFile('agent-skills/support-triage/SKILL.md'),
  'utf8',
);
export const LEARNING_SKILL = readFileSync(
  serverFile('agent-skills/support-close-learning/SKILL.md'),
  'utf8',
);
