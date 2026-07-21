import js from '@eslint/js';

// Flat config. Deliberately narrow: the value here is finding genuine dead
// code and typos, not enforcing style (see .prettierrc / the note in
// docs/audit). Note that ESLint cannot see the app's markup at all -- every
// screen is built from JS template literals -- so HTML defects are caught by
// the DOM assertions in the Playwright suite, not here.

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  CustomEvent: 'readonly',
  SpeechSynthesisUtterance: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  CSS: 'readonly',
  PerformanceObserver: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  confirm: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  caches: 'readonly',
  self: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', '.wrangler/**', 'assets/**', 'data/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      // The only control-character classes in this codebase are the deliberate
      // name sanitisers in functions/api/{xp,session/finish}.js, where matching
      // control characters is the entire point.
      'no-control-regex': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-globals': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Node contexts: tests, build-ish scripts, Cloudflare Pages Functions.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs', 'functions/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', crypto: 'readonly', Response: 'readonly', URL: 'readonly' },
    },
  },
];
