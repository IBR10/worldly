// Checks over _headers — the Cloudflare Pages header file that carries the CSP.
//
// This file exists because of a production-only failure that nothing else could
// have caught. The CSP is delivered by Cloudflare, so the local dev server
// (scripts/spa-serve.py) sends none: every Playwright spec runs with no policy
// at all, and an image the real site refuses to load renders perfectly in CI.
//
// The specific incident: historic flags, the 95 US/Mexican/Canadian state flags
// and the religious symbols are all requested from commons.wikimedia.org's
// Special:FilePath endpoint, which redirects to whichever host is serving the
// bytes. Wikimedia moved thumbnails from upload.wikimedia.org to
// thumb.wikimedia.org; a CSP is enforced against the redirect TARGET, so every
// one of those images silently vanished in production while CI stayed green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const headers = fs.readFileSync(`${root}_headers`, 'utf8');

const csp = headers
  .split('\n')
  .find((l) => l.trim().startsWith('Content-Security-Policy:'))
  ?.replace(/^\s*Content-Security-Policy:\s*/, '');

/** The source list for one directive, e.g. img-src -> ["'self'", 'https://…']. */
function directive(name) {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found ? found.slice(name.length + 1).trim().split(/\s+/) : [];
}

/** Does the policy permit this host, directly or through a wildcard? */
function permits(sources, host) {
  return sources.some((src) => {
    const s = src.replace(/^https:\/\//, '');
    if (s === host) return true;
    if (s.startsWith('*.')) return host === s.slice(2) || host.endsWith(s.slice(1));
    return false;
  });
}

test('_headers carries a Content-Security-Policy', () => {
  assert.ok(csp, 'a Content-Security-Policy line exists');
});

test('img-src permits every host the app loads images from', () => {
  const img = directive('img-src');
  // flagcdn serves country and state-of-the-union style flags by ISO code.
  assert.ok(permits(img, 'flagcdn.com'), 'flagcdn.com');
  // Commons is where the request starts...
  assert.ok(permits(img, 'commons.wikimedia.org'), 'commons.wikimedia.org');
  // ...and these are where it has been redirected to. Both must pass, because
  // the policy is checked against the host that finally serves the image.
  assert.ok(permits(img, 'upload.wikimedia.org'), 'upload.wikimedia.org (the previous thumbnail host)');
  assert.ok(permits(img, 'thumb.wikimedia.org'), 'thumb.wikimedia.org (current thumbnail host)');
});

test('img-src covers Wikimedia by wildcard, so the next host move does not break it', () => {
  const img = directive('img-src');
  assert.ok(
    img.some((s) => s === 'https://*.wikimedia.org'),
    'img-src should list https://*.wikimedia.org rather than naming hosts individually — '
    + 'Special:FilePath redirects to whatever host Wikimedia is currently using, and CSP is '
    + 'enforced against that target',
  );
});

test('the policy still refuses inline script and style', () => {
  // The whole app is built on this: no style="" attributes, no on*= handlers,
  // dynamic widths set through the CSSOM instead.
  for (const name of ['script-src', 'style-src']) {
    const sources = directive(name);
    assert.ok(sources.length, `${name} is declared`);
    assert.ok(!sources.includes("'unsafe-inline'"), `${name} has no 'unsafe-inline'`);
    assert.ok(!sources.includes("'unsafe-eval'"), `${name} has no 'unsafe-eval'`);
  }
});
