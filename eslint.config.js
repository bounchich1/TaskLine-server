// @ts-check
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import boundaries from 'eslint-plugin-boundaries';
import importX from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Allowed module → module dependencies (see ARCHITECTURE.md). Every edge points to a lower
 * layer, so the graph stays acyclic. Adding an edge here is an architectural decision.
 * @type {Record<string, string[]>}
 */
const MODULE_DEPENDENCIES = {
  templates: [],
  learning: [],
  dictionaries: [],
  staff: [],
  files: [],
  messages: ['learning'],
  outbox: ['templates', 'messages'],
  ratings: ['outbox'],
  consent: ['outbox', 'learning'],
  tickets: ['messages', 'outbox', 'ratings', 'learning', 'dictionaries'],
  inbox: ['consent', 'tickets', 'messages', 'outbox'],
  delivery: ['files'],
  notifications: ['staff'],
  admin: ['templates', 'dictionaries'],
  ai: ['dictionaries'],
};

/** Modules and integrations are consumed only through their public `index.ts`. */
const publicApi = (/** @type {string} */ type, /** @type {string[] | undefined} */ names) => ({
  element: {
    type,
    fileInternalPath: 'index.ts',
    ...(names ? { captured: names.map((name) => ({ name })) } : {}),
  },
});

const moduleDependencyPolicies = Object.entries(MODULE_DEPENDENCIES)
  .filter(([, deps]) => deps.length > 0)
  .map(([name, deps]) => ({
    from: { element: { type: 'module', captured: { name } } },
    allow: { to: publicApi('module', deps) },
  }));

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.data/**', 'infra/**', '.sql-trace/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // Before the budget block: eslint-config-prettier turns off `curly` and `max-len`,
  // which are deliberately re-enabled below.
  prettier,

  // Readability budget: the rules that keep the code from sliding back into dense one-liners.
  {
    plugins: { 'import-x': importX, unicorn },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
    rules: {
      'max-lines': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      'max-nested-callbacks': ['error', 3],
      '@typescript-eslint/max-params': ['error', { max: 4 }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'max-statements-per-line': ['error', { max: 1 }],
      'max-len': [
        'error',
        {
          code: 120,
          ignoreUrls: true,
          ignoreRegExpLiterals: true,
          ignoreTemplateLiterals: true,
          ignoreStrings: false,
        },
      ],
      curly: ['error', 'all'],
      'no-nested-ternary': 'error',
      'id-length': [
        'error',
        { min: 2, exceptions: ['_', 'i', 'j', 'x', 'y'], properties: 'never' },
      ],
      // `type` and `interface` are both fine; forcing interfaces drops implicit index signatures.
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-default-export': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', ['sibling', 'index']],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    },
  },

  // Architecture: where files may live and what they may import.
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true } },
      'boundaries/include': ['src/**/*.ts'],
      // Process entry points: role/command dispatch only.
      'boundaries/ignore': ['src/main.ts', 'src/cli.ts'],
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app', partialMatch: false },
        { type: 'module', pattern: 'src/modules/*', capture: ['name'], partialMatch: false },
        {
          type: 'integration',
          pattern: 'src/integrations/*',
          capture: ['name'],
          partialMatch: false,
        },
        { type: 'shared', pattern: 'src/shared', partialMatch: false },
        // Temporary: files not yet moved into the layout above. Nothing new may depend on them.
        { type: 'legacy', pattern: 'src', partialMatch: false },
      ],
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            'Architecture boundary: other modules are importable only via their index.ts, and only ' +
            'along the edges in MODULE_DEPENDENCIES (eslint.config.js). See ARCHITECTURE.md.',
          policies: [
            { allow: { to: { module: { origin: ['external', 'core'] } } } },
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            {
              from: { element: { type: 'shared' } },
              allow: { to: { element: { type: 'shared' } } },
            },
            {
              from: { element: { type: 'integration' } },
              allow: { to: { element: { type: 'shared' } } },
            },
            {
              from: { element: { type: 'module' } },
              allow: { to: [{ element: { type: 'shared' } }, publicApi('integration')] },
            },
            ...moduleDependencyPolicies,
            {
              from: { element: { type: 'app' } },
              allow: {
                to: [
                  { element: { type: 'shared' } },
                  publicApi('integration'),
                  publicApi('module'),
                  { element: { type: 'legacy' } },
                ],
              },
            },
            {
              from: { element: { type: 'legacy' } },
              allow: {
                to: { element: { type: ['legacy', 'shared', 'integration', 'module', 'app'] } },
              },
            },
          ],
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },
);
