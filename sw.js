// sw.js — offline-resilience service worker.
//
// Strategy (no build step, so no versioned filenames):
//  - network-first for the app shell, code and data (always fresh online;
//    served from cache when offline)
//  - cache-first for images/maps/flags (incl. flagcdn + Wikimedia) — once a
//    flag has been seen it keeps working even if the CDN is unreachable.
// The SW file itself is served with no-cache headers, so updates roll out on
// the next visit.

const CACHE = 'worldly-v2'; // v2: connect-src fix — SW fetch of flag CDNs was blocked by the worker's own CSP

const CACHE_FIRST_HOSTS = ['flagcdn.com', 'commons.wikimedia.org', 'upload.wikimedia.org'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/css/styles.css', '/js/main.js'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    // Graceful network-error response: respondWith() must never reject, or the
    // browser logs SW errors for every aborted image/fetch.
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Opaque (no-cors flag/commons images) responses are cacheable too; put()
    // can throw on quota — never let that break the response.
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return Response.error(); // lets <img onerror> fallbacks do their job
  }
}

// respondWith() must NEVER reject (browsers log SW errors for every aborted
// image/page load otherwise) — any unexpected failure becomes a network error,
// which lets <img onerror> fallbacks behave exactly as they would without a SW.
const safely = (p) => p.catch(() => Response.error());

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept analytics or YouTube.
  if (url.hostname.endsWith('clarity.ms') || url.hostname.includes('youtube')) return;

  if (CACHE_FIRST_HOSTS.includes(url.hostname) || url.pathname.startsWith('/assets/')) {
    e.respondWith(safely(cacheFirst(req)));
  } else if (url.origin === self.location.origin) {
    e.respondWith(safely(networkFirst(req)));
  }
});
