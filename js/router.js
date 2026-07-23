// router.js — a tiny History-API router for a no-build, vanilla-ES-module SPA.
//
// It knows nothing about Worldly's screens. main.js hands it a route table of
// { path, title, render, noindex } and this module owns the URL: matching the
// current path to a route, running that route's renderer, keeping document.title
// and a robots <meta> in sync, pushing/popping history, and intercepting clicks
// on internal links. Keeping it screen-agnostic is what makes matchPath() a pure
// function that unit-tests without a DOM.
//
// Why History API and not hash routing: the audit's whole point was real,
// shareable, indexable URLs (`/leaderboard`, not `/#/leaderboard`). That needs
// the server to serve the app shell for unmatched paths — on Cloudflare Pages
// that is automatic once there is no top-level 404.html (SPA fallback), with
// Functions (/api/*) and real static assets still matched first.

/**
 * Match a route pattern against a concrete path.
 *
 * Patterns use `:name` for one path segment, e.g. '/crises/:slug'. Returns a
 * params object ({} for a static route) on a match, or null on no match.
 * A trailing slash is ignored on both sides so '/flags' and '/flags/' are one
 * route. Segment values are percent-decoded.
 *
 * Pure and DOM-free on purpose — this is the part worth unit-testing.
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {Record<string,string>|null}
 */
export function matchPath(pattern, path) {
  const norm = (s) => {
    const trimmed = s.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
  };
  const ps = norm(pattern).split('/');
  const cs = norm(path).split('/');
  if (ps.length !== cs.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i];
    if (seg.startsWith(':')) {
      if (cs[i] === '') return null; // a param must capture a non-empty segment
      try {
        params[seg.slice(1)] = decodeURIComponent(cs[i]);
      } catch {
        return null; // malformed %-escape in the URL → treat as no match
      }
    } else if (seg !== cs[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Build a router over a route table.
 *
 * @param {object}   cfg
 * @param {Array<{path:string,title?:string|((p:object)=>string),render:(p:object)=>any,noindex?:boolean}>} cfg.routes
 * @param {object}   cfg.fallback  route used when nothing matches (the 404)
 * @param {(err:any)=>void} [cfg.onError]
 */
export function createRouter({ routes, fallback, onError }) {
  let currentPath = null;

  function resolve(path) {
    for (const route of routes) {
      const params = matchPath(route.path, path);
      if (params) return { route, params };
    }
    return { route: fallback, params: {} };
  }

  // A single JS-managed robots meta. Absent by default (pages are indexable);
  // added only for routes that opt in (the 404). Without server-side rendering
  // we cannot return a real 404 status, so this is the honest signal to crawlers
  // that a client-routed miss is not a real page.
  function setNoindex(on) {
    let meta = document.querySelector('meta[data-router-robots]');
    if (on) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'robots';
        meta.content = 'noindex';
        meta.setAttribute('data-router-robots', '');
        document.head.appendChild(meta);
      }
    } else if (meta) {
      meta.remove();
    }
  }

  async function render(path) {
    const { route, params } = resolve(path);
    currentPath = path;
    if (route.title != null) {
      document.title = typeof route.title === 'function' ? route.title(params) : route.title;
    }
    setNoindex(!!route.noindex);
    try {
      await route.render(params);
    } catch (err) {
      if (onError) onError(err);
      else throw err;
    }
  }

  /**
   * Go to an internal path. Same-path navigations re-render without stacking a
   * duplicate history entry (so hammering a "Home" button does not fill the
   * back stack with copies of `/`).
   */
  function navigate(to, { replace = false } = {}) {
    const path = to.replace(/[?#].*$/, ''); // match on the path; keep query/hash in the URL
    if (path === location.pathname && !replace) return render(path);
    if (replace) history.replaceState({ path }, '', to);
    else history.pushState({ path }, '', to);
    return render(path);
  }

  function onPopState() {
    // Back/Forward: the URL already changed; just render it, never push.
    render(location.pathname);
  }

  // Delegated interception of internal-link clicks. Only same-origin, absolute
  // ('/…') paths on plain left-clicks are taken over; hash links (#app skip
  // link), external URLs, new-tab modifiers and download links fall through to
  // the browser untouched.
  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target.closest('[data-link], a[href]');
    if (!el) return;
    const raw = el.getAttribute('data-link') || el.getAttribute('href') || '';
    if (!raw.startsWith('/') || raw.startsWith('//')) return; // internal absolute paths only
    if (el.tagName === 'A' && ((el.target && el.target !== '_self') || el.hasAttribute('download'))) return;
    e.preventDefault();
    navigate(raw);
  }

  function start() {
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onClick);
    // Give the entry the app booted on a state object, so the first Back behaves.
    history.replaceState({ path: location.pathname }, '', location.pathname + location.search + location.hash);
    return render(location.pathname);
  }

  return {
    start,
    navigate,
    render,
    resolve,
    get current() { return currentPath; },
  };
}
