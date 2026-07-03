// sw.js — offline-resilience service worker.
//
// Strategy (no build step, so no versioned filenames):
//  - network-first for the app shell, code and data (always fresh online;
//    served from cache when offline)
//  - cache-first for images/maps/flags (incl. flagcdn + Wikimedia) — once a
//    flag has been seen it keeps working even if the CDN is unreachable.
// The SW file itself is served with no-cache headers, so updates roll out on
// the next visit.

const CACHE = 'worldly-v1';

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
    if (req.mode === 'navigate') return cache.match('/');
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept analytics or YouTube.
  if (url.hostname.endsWith('clarity.ms') || url.hostname.includes('youtube')) return;

  if (CACHE_FIRST_HOSTS.includes(url.hostname) || url.pathname.startsWith('/assets/')) {
    e.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  }
});
