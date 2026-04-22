// ESLint v9 flat config. Scope-split between Node and Browser/ServiceWorker
// so each part of the codebase only sees the globals that actually exist
// there (e.g. `window` in frontend, `process` in backend).
import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      '.pnpm-store/**',
      'data/**',
      'docs/screenshots/**',
      'docs/mockup.html',
      'docs/design-historical.md',
      // Bundled third-party JS (highlight.js, BSD-3-Clause). Keep as-is so
      // we never modify the upstream artefact.
      'frontend/js/lib/**',
    ],
  },

  js.configs.recommended,

  // Project-wide rule overrides on top of eslint:recommended.
  {
    rules: {
      // Underscore-prefixed identifiers are an established "intentionally
      // unused" marker in this codebase (e.g. Express error-handler `_next`,
      // tuple destructuring `[_a, b]`).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  // Backend (Node) — Express + node:fs/promises etc.
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ai-server (Node) — runs on host, no Express, only node:http + child_process
  {
    files: ['ai-server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Frontend ES modules — Browser context.
  {
    files: ['frontend/js/**/*.js'],
    ignores: ['frontend/js/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  // Frontend ServiceWorker — separate global set (self / caches / clients).
  {
    files: ['frontend/js/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.serviceworker },
    },
  },

  // The eslint config itself runs in Node when the CLI bootstraps.
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Must be last: disable formatting-related rules that Prettier owns.
  prettierConfig,
];
