// sw.js — offline-resilience service worker.
//
// Strategy (no build step, so no versioned filenames):
//  - network-first for the app shell, code and data (always fresh online;
//    served from cache when offline)
//  - cache-first for images/maps/flags (incl. flagcdn + Wikimedia) — once a
//    flag has been seen it keeps working even if the CDN is unreachable.
// The SW file itself is served with no-cache headers, so updates roll out on
// the next visit.
//
// Two caches, not one. The split exists because only one of them is bounded:
//
//  - SHELL holds same-origin code, data and bundled assets. Its size is the
//    size of the site (~3 MB with all four map SVGs) and cannot grow past it,
//    so it needs no eviction.
//  - IMAGES holds third-party flag and symbol art from flagcdn/Wikimedia. That
//    set has no natural ceiling — every country, state, province, historic flag
//    and religious symbol a player ever looks at is a separate entry, and these
//    are opaque responses, which browsers pad heavily for quota accounting.
//    Left uncapped it is the largest thing this origin stores.
//
// Why that mattered enough to fix: on iOS Safari, blowing the origin quota
// evicts the *whole origin's* storage, localStorage included — and localStorage
// is where the player's XP, streaks, achievements and SRS boxes live, with no
// account to restore them from. An unbounded image cache put the only copy of
// a player's progress behind an eviction policy we did not control.

const VERSION = 'v3'; // v3: split shell/image caches and capped the image cache
const SHELL_CACHE = `worldly-shell-${VERSION}`;
const IMAGE_CACHE = `worldly-images-${VERSION}`;
const KEEP = [SHELL_CACHE, IMAGE_CACHE];

// Roughly a full pass through Flag Key plus the state/province and historic
// sets. Evicting past this only costs a re-fetch of art the player is no longer
// looking at.
const IMAGE_CACHE_MAX = 300;

const CACHE_FIRST_HOSTS = ['flagcdn.com', 'commons.wikimedia.org', 'upload.wikimedia.org'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(['/', '/css/styles.css', '/js/main.js'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    // Drops the old single `worldly-v2` cache, which is also how existing
    // players get their accumulated bloat cleared exactly once.
    await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
    // Belt-and-braces: the throttled trim below only runs while the worker is
    // alive, so enforce the cap once per worker start too.
    await trimImageCache();
    await self.clients.claim();
  })());
});

/**
 * Evict oldest-first down to IMAGE_CACHE_MAX. `Cache.keys()` yields entries in
 * insertion order, so slicing from the front is FIFO — not true LRU, but a
 * re-read does not reorder anything, and FIFO needs no bookkeeping of its own.
 */
async function trimImageCache() {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    const keys = await cache.keys();
    const excess = keys.length - IMAGE_CACHE_MAX;
    if (excess > 0) await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  } catch {
    // Eviction is maintenance; never let it surface as a failed request.
  }
}

// Walking every key on every image would be wasteful during a grid render that
// fires 40 requests at once, so amortise it. The cache can overshoot the cap by
// up to TRIM_EVERY entries between sweeps, which is the point of the headroom.
const TRIM_EVERY = 25;
let sinceTrim = 0;
function maybeTrimImageCache() {
  if (++sinceTrim < TRIM_EVERY) return Promise.resolve();
  sinceTrim = 0;
  return trimImageCache();
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
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

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Opaque (no-cors flag/commons images) responses are cacheable too; put()
    // can throw on quota — never let that break the response.
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return Response.error(); // lets the flag fallbacks do their job
  }
}

// respondWith() must NEVER reject (browsers log SW errors for every aborted
// image/page load otherwise) — any unexpected failure becomes a network error,
// which lets the flag fallbacks behave exactly as they would without a SW.
const safely = (p) => p.catch(() => Response.error());

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept analytics or YouTube.
  if (url.hostname.endsWith('clarity.ms') || url.hostname.includes('youtube')) return;

  if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    e.respondWith(safely(cacheFirst(req, IMAGE_CACHE)));
    e.waitUntil(maybeTrimImageCache());
  } else if (url.origin === self.location.origin) {
    // Bundled assets (icons, the four map SVGs) are cache-first but live in the
    // shell cache: they are part of the site, so they are bounded by it and
    // must not be evicted by a burst of flag art.
    e.respondWith(safely(url.pathname.startsWith('/assets/') ? cacheFirst(req, SHELL_CACHE) : networkFirst(req)));
  }
});
