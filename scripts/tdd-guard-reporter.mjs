// Custom node:test reporter that publishes results in TDD Guard's schema.
//
// TDD Guard ships reporters for Vitest/Jest/pytest/etc. but not for Node's
// built-in test runner, so this bridges `node --test` → the file the TDD Guard
// hook reads: `<projectRoot>/.claude/tdd-guard/data/test.json`.
//
// projectRoot resolution (absolute, per TDD Guard's spec):
//   1. $TDD_GUARD_PROJECT_ROOT if set (this session's hook runs from there)
//   2. the repository root, derived from this file's location
// Results are written to every distinct root so the hook sees real red/green
// state regardless of which directory it scopes to.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));      // Worldly/scripts
const repoRoot = resolve(here, '..', '..');                // repository root

const roots = [...new Set([
  process.env.TDD_GUARD_PROJECT_ROOT,
  repoRoot,
].filter(Boolean))];

function isFileLevel(name) {
  // Node emits a pass/fail event for each test FILE too; skip those.
  return /\.(m|c)?js$/.test(name) || name.includes('/') || name.includes('\\');
}

// Acts as the sole reporter: yields a readable summary to stdout AND writes the
// TDD Guard data file as a side effect. Being the only reporter avoids a second
// --test-reporter-destination (a /dev/null stream fails to fsync on WSL mounts).
// When a test FILE fails to load/compile, Node only reports a generic
// "test failed" in the event — the real error (e.g. an ESM import of a
// not-yet-implemented export) is recovered by re-importing the file here.
async function loadError(relPath) {
  try {
    await import(`${pathToFileURL(resolve(process.cwd(), relPath)).href}?t=${Date.now()}`);
    return 'module failed to load';
  } catch (e) {
    return String(e.message).split('\n')[0];
  }
}

export default async function* tddGuardReporter(source) {
  const tests = [];
  const fileFails = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const name = event.data.name;
    const failed = event.type === 'test:fail';
    // Per-file rollup events are skipped, EXCEPT a file that failed to load —
    // that is a real red the guard must see, with its true error message.
    if (isFileLevel(name)) {
      if (failed) fileFails.push(name);
      continue;
    }
    const entry = { name, fullName: `tests/*.test.mjs > ${name}`, state: failed ? 'failed' : 'passed' };
    if (failed) {
      const msg = event.data.details?.error?.message || 'test failed';
      entry.errors = [{ message: String(msg).split('\n')[0] }];
    }
    tests.push(entry);
    yield `${failed ? '✗' : '✓'} ${name}\n`;
  }

  for (const f of fileFails) {
    const message = await loadError(f);
    tests.push({ name: f, fullName: `tests/*.test.mjs > ${f}`, state: 'failed', errors: [{ message }] });
    yield `✗ ${f} — ${message}\n`;
  }

  const payload = JSON.stringify({ testModules: [{ moduleId: 'tests/*.test.mjs', tests }] }, null, 2);
  for (const root of roots) {
    const dir = resolve(root, '.claude', 'tdd-guard', 'data');
    try { mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, 'test.json'), payload); }
    catch { /* a root may be unwritable on some machines; ignore */ }
  }

  const passed = tests.filter((t) => t.state === 'passed').length;
  const failedN = tests.length - passed;
  yield `\n${passed} passed, ${failedN} failed (${tests.length} total)\n`;
}
