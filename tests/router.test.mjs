// Unit tests for the router's one pure, load-bearing function: matchPath.
// createRouter's other behaviour (history, clicks, popstate) is DOM-bound and
// is covered by tests/e2e/routing.spec.js instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPath } from '../js/router.js';

test('static routes match exactly and yield empty params', () => {
  assert.deepEqual(matchPath('/', '/'), {});
  assert.deepEqual(matchPath('/leaderboard', '/leaderboard'), {});
  assert.equal(matchPath('/leaderboard', '/stats'), null);
});

test('a trailing slash is ignored on either side', () => {
  assert.deepEqual(matchPath('/flags', '/flags/'), {});
  assert.deepEqual(matchPath('/flags/', '/flags'), {});
  assert.deepEqual(matchPath('/', ''), {}); // '' normalizes to '/'
});

test('a :param captures exactly one segment', () => {
  assert.deepEqual(matchPath('/quiz/:mode', '/quiz/mixed'), { mode: 'mixed' });
  assert.deepEqual(matchPath('/crises/:slug', '/crises/sudan-conflict'), { slug: 'sudan-conflict' });
});

test('segment counts must match — a param does not span slashes', () => {
  assert.equal(matchPath('/quiz/:mode', '/quiz'), null);
  assert.equal(matchPath('/quiz/:mode', '/quiz/mixed/extra'), null);
  assert.equal(matchPath('/crises/:slug', '/crises'), null);
});

test('a param segment must be non-empty', () => {
  assert.equal(matchPath('/quiz/:mode', '/quiz/'), null);
});

test('param values are percent-decoded; a bad escape is a non-match, not a throw', () => {
  assert.deepEqual(matchPath('/phrases/:slug', '/phrases/c%C3%B4te'), { slug: 'côte' });
  assert.equal(matchPath('/phrases/:slug', '/phrases/%E0%A4%A'), null); // malformed %-escape
});

test('literal segments are matched case-sensitively', () => {
  assert.equal(matchPath('/Flags', '/flags'), null);
});

test('multi-segment patterns bind each param', () => {
  assert.deepEqual(matchPath('/a/:x/b/:y', '/a/1/b/2'), { x: '1', y: '2' });
  assert.equal(matchPath('/a/:x/b/:y', '/a/1/c/2'), null);
});
