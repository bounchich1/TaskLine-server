import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { serverFile } from '../src/shared/paths.js';

// Files outside src/ are read at runtime through serverFile(); moving shared/paths.ts to a
// different depth would silently point these at the wrong directory.
it.each([
  'package.json',
  'migrations/001_initial.sql',
  'contracts/triage-result.schema.json',
  'contracts/memorize-resolution.schema.json',
  'agent-skills/support-triage/SKILL.md',
  'agent-skills/support-close-learning/SKILL.md',
])('resolves %s from the server root', (relativePath) => {
  expect(existsSync(fileURLToPath(serverFile(relativePath)))).toBe(true);
});
