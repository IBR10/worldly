# Worldly — Technical Due Diligence & Next Steps

**Date:** 2026-07-21
**Scope:** `playworldly.pages.dev` (live) + `IBR10/worldly` @ `971cae3` (90 commits, single `main` branch)
**Method:** live-site inspection first (Chromium 1228, desktop 1440×900 + mobile 390×844), then source review.
**Posture:** adversarial. This document is a defect register, not a review. Things that work well are listed once, in §1, and then dropped.

Every claim below marked **[measured]** was reproduced against the live site. Claims marked **[read]** come from source inspection only.

---

## 1. Product understanding

### What it is
A no-build, no-account, client-side learning game for world knowledge — capitals, flags, languages, religions, currencies, maps, phrases, music, and curated crisis briefings — wrapped in a Leitner spaced-repetition scheme with XP, levels, streaks and 23 achievements. Static files on Cloudflare Pages, plus five Pages Functions backed by D1 and KV for server-graded Challenge/Daily runs and a global leaderboard.

**Content inventory:** 156 countries, 50 US states, 32 Mexican states, 13 Canadian provinces, 10 religions, 34 historic flags, 12 similar-flag groups, 16 phrase sets, 17 music sets (46 songs), 24 crisis entries, 23 achievements. Four map SVGs. **[measured]**

### Target audience
Self-directed adult learners and students — the "I want to actually know where Burkina Faso is" crowd. Adjacent: geography-quiz hobbyists (Sporcle/Seterra/Worldle audience), and a smaller "current affairs literacy" segment pulled in by Crises & Events.

### Does the implementation support the goal?
**Partially, and it is capped by two structural decisions.**

The *learning* engine is genuinely good. `quiz.js`'s `geoDistractors()` — tiering distractors through subregion → region → world, with a `normalize` hook so "Christianity" and "Christianity (Catholic)" can't be offered against each other — is the kind of thing most quiz apps never bother to get right. The SRS weighting in `srs.js` is correct and testable. 72 tests pass. **[measured]**

The *product* is capped because:

1. **There is no URL.** Not one screen is addressable. `grep -n 'pushState\|popstate\|location.hash' js/main.js` returns nothing. **[read]** Browser Back exits the app to `about:blank`. **[measured]** This kills sharing, SEO, deep-linking, analytics funnels, and return-visit bookmarking simultaneously.
2. **The global leaderboard is empty on all three tabs.** `/api/leaderboard?mode={challenge,daily,xp}` all return `{"entries":[]}`. **[measured]** Five API endpoints, a D1 database, a KV namespace and two migrations currently return zero rows. The API itself works — `POST /api/session/start` returns a valid 15-question session **[measured]** — so this is a distribution problem, not a bug. The engineering investment in server-verified scoring has produced no product value yet.

### Biggest strengths
- Question-generation quality (`quiz.js:112` `geoDistractors`) and SRS correctness.
- Pure-logic/rendering separation — `quiz.js`, `srs.js`, `maps.js` have zero DOM coupling and are unit-tested in plain Node.
- Genuinely fast cold load: **TTFB 73 ms, FCP 772 ms, LCP 1228 ms, CLS 0.0000, 161 KB over 32 requests.** **[measured]** Most React quiz apps ship 400 KB of JS to do less.
- A strict CSP with no `unsafe-inline`, shipped and actually enforced.
- Comment quality is unusually high. Several comments (`main.js:50-60` on TTS voice fallback, `mapview.js:229-234` on keydown propagation) document real bugs that were found and fixed. This is a developer who debugs properly.

### Biggest weaknesses
- No routing. Everything downstream of that is compromised.
- `main.js` is 1,792 lines and holds ~70% of the application. It has **0% test coverage.**
- Flag Key fires **251 simultaneous image requests with a 1,009 ms long task**, and typing three characters costs **1.6 s**. **[measured]**
- **30 of 51 US states are smaller than 24×24 CSS px on a 390 px phone** (Rhode Island: 3.5×4.8 px). **[measured]** Direct WCAG 2.2 SC 2.5.8 failure and a plain playability failure.
- The quiz screen — the single most-used screen — has **zero heading elements**. **[measured]**
- Zero linting, zero formatting, zero types, zero E2E tests, and a CI pipeline that does not deploy.

---

## 2. Architecture review

### Current shape

```
index.html ──> js/main.js (1792 LOC, controller + all views + all state)
                  ├── data.js      (loads 11 JSON files eagerly at boot)
                  ├── state.js     (localStorage profile — the only real store)
                  ├── quiz.js  ─┐
                  ├── maps.js  ─┼── pure, tested, DOM-free
                  ├── srs.js   ─┘
                  ├── mapview.js   (the one DOM-coupled widget)
                  ├── achievements.js
                  └── analytics.js
functions/api/*  ──> imports js/quiz.js + data/*.json  (server reuses client code)
```

**Verdict: correct instincts, one catastrophic omission, one god object.**

The pure-core/impure-shell split is the right architecture for this problem and it is well executed. Shipping `js/quiz.js` to both the browser and the Cloudflare Function so client and server compute identical XP (`sessionQuestionXp`, `challengeMultiplier`, `seededRng`) is a genuinely smart move — it makes the Daily Challenge verifiable without duplicating the scoring rules.

Then everything else got dumped into `main.js`.

### Missing abstractions (the real problem)

**1. A router.** Non-negotiable. Everything in §5 and §8 is downstream of this.

**2. A screen/view module boundary.** `main.js` contains 14 top-level `show*()` / `render*()` functions that each do: build an HTML string → `app.innerHTML = ...` → re-query the DOM → attach listeners. That pattern repeats 14 times. It should be `js/screens/{home,quiz,map,flagkey,phrases,music,crises,stats,achievements,leaderboard,profile,about}.js`, each exporting `render(ctx)`.

**3. A quiz-session state machine.** `S` is a bare mutable object with 20 fields and four different mutation sites (`answer`, `answerTyped`, `mapAnswer`, `startTimer`). Three of those four repeat the *same 12-line block*:

```js
// main.js:679-686, 891-896, 962-966 — near-verbatim, three times
const newly = checkAchievements(getProfile());
saveProfile();
if (newly.length) track('achievement_unlocked');
if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));
renderFeedback(correct, q, res.xpGained);
renderHUD();
```

This is where the next bug will land. Extract `commitAnswer(q, correct, { multiplier, xpOverride })`.

**4. A quiz chrome component.** The `quiz-top` progress header is duplicated verbatim in four renderers (`main.js:634-641, 693-700, 746-753, 908-914`). All four carry the same off-by-one progress bug (§3.1). One fix should not require four edits.

**5. A list→detail screen component.** `showPhrases`/`renderPhraseDetail`, `showMusic`/`renderMusicDetail`, `showCrises`/`renderCrisisDetail` are the same screen three times: grid of flag cards → click → detail with `topNav`, `phrase-head`, back buttons. ~180 lines of structural duplication.

**6. A `data-action` event delegation layer.** `showHome` hand-wires 13 individual `querySelector(...).addEventListener` calls (`main.js:322-336`). Adding a card requires editing three places (`MODE_CARDS`, the tab config, and a wiring line). A single delegated `app.addEventListener('click', e => route(e.target.closest('[data-action]')))` removes all of it.

**7. An HTML templating helper.** Hand-concatenated template literals with manual `esc()` calls are one forgotten call away from XSS. A tagged template that escapes interpolations by default (`html\`<div>${untrusted}</div>\``) makes the safe path the default path. Two `href` interpolations are already unescaped (§9.1).

### Unnecessary abstractions / over-engineering
Very little — which is a compliment. Two notes:
- `data.js` exposes `getRegions` / `getContinents` / `getSubregions`, where the latter two are trivial wrappers used once each.
- `sessionGen` (`main.js:34`) is a hand-rolled cancellation token. It's correct and well-commented, but `AbortController` is the platform primitive for exactly this and would express intent better.

### Under-engineering
- Module-level mutable globals for all UI state: `S`, `sessionGen`, `homeTab`, `crisesPeriod`, `crisesTab`, `leaderboardTab`, `flagKeyTab`, `flagKeySearch`, `flagKeyRegion`. Eight ad-hoc variables scattered across 1,700 lines. Once routing exists, most of these become URL state and simply disappear.
- No error boundary. Any throw inside a `render*()` leaves `#app` half-written with no recovery path.
- No data schema validation. `data/*.json` is hand-maintained and consumed with `c.capital`, `c.funFact`, `entry.songs[0].youtubeId` etc. with no guards. One malformed record ships a broken build.

### Coupling / cohesion
Cohesion inside the pure modules: high. Cohesion of `main.js`: none — it is a 1,792-line namespace.

The **client→server coupling is the sharpest architectural risk**: `functions/api/session/start.js:1` imports `../../../js/quiz.js`. The day someone adds a `document.` reference or a browser-only API to `quiz.js`, the Challenge and Daily leaderboards break at runtime — and **CI will not catch it**, because CI runs `node --test tests/*.test.mjs` and never builds or smoke-tests the Functions. Add an explicit `js/engine/` directory with a documented "no browser globals" contract and a test that imports every engine module in a bare Node context.

### Recommended target architecture

Stay vanilla. Do **not** introduce React — it would trade a real strength (161 KB total, 1.2 s LCP) for tooling you don't need. Do introduce structure:

```
js/
  engine/          quiz.js srs.js maps.js scoring.js   ← pure, shared with Functions, no browser globals
  data/            loader.js (lazy, per-dataset) schema.js
  state/           profile.js (localStorage) session.js (quiz state machine)
  ui/              html.js (escaping tagged template) toast.js dom.js mapview.js
  screens/         home.js quiz.js flagkey.js …        ← each exports render(ctx)
  router.js        History API, hash-free, /quiz/:mode /explore/crises/:slug …
  main.js          ~120 lines: boot, wire router, error boundary
```

Effort: 3–5 focused days. Risk: moderate (no type system to catch mistakes — do it screen-by-screen behind the test suite, and add E2E smoke tests *first*).

---

## 3. Code quality — confirmed defects

Ordered by severity. All **[measured]** items were reproduced in a real browser against production.

### 3.1 The progress bar is permanently off by one and never updates — **High**
`main.js:633, 692, 740, 904` — `const progressPct = Math.round((S.index / S.total) * 100)`.

`S.index` increments *after* the answer is recorded, and the header is only rendered when a *question* renders — never after. Result: **on question 1 of 12 the bar reads 0%, and it still reads 0% on the feedback screen after answering.** The bar can never reach 100%. **[measured — see screenshot evidence in §5]**

- **Why it matters:** progress indicators are a primary motivation device in learning apps. A bar that reads 0% after you've answered feels broken.
- **User impact:** perceived stall; the app feels unresponsive at the exact moment it should feel rewarding.
- **Engineering impact:** the bug exists in four copies because the header is duplicated four times — it is a symptom of the missing quiz-chrome component.
- **Business impact:** direct hit to session completion rate.
- **Fix:** render the header from a single component; compute `(S.index + (S.phase === 'feedback' ? 1 : 0)) / S.total`; re-render the header inside `renderFeedback`.
- **Effort:** 30 min (2 h if done properly, by extracting the component).
- **Priority: High**

### 3.2 The "Danger zone" reset button has a duplicate `class` attribute — **Medium**
`main.js:1671`:
```html
<button class="btn" id="resetBtn" class="btn danger">Reset all progress</button>
```
HTML5 parsing discards the second `class`. Live DOM: `class="btn"`, `border-color: rgb(42,55,93)` (`--border`) instead of `rgb(248,114,114)` (`--bad`). **[measured]** The irreversible destructive action is styled identically to every neutral button on the page.

- **User impact:** the one control that permanently destroys all progress carries no visual warning. `confirm()` is the only guard.
- **Fix:** `class="btn danger"`. Also replace the native `confirm()` with a typed-confirmation modal.
- **Effort:** 5 min (2 min for the class, 45 min for a proper modal).
- **Priority: Medium** (trivially cheap, and it's the highest-consequence button in the app)

### 3.3 Inline `onerror` on Flag Key images is blocked by your own CSP — **Medium**
`main.js:1189`: `<img class="emoji-flag" … onerror="this.style.display='none'">`

Your CSP is `script-src 'self' …` with no `unsafe-inline`, so **inline event handlers do not execute**. Forcing a Flag Key image to 404 produces:
> `Executing inline event handler violates the following Content Security Policy directive 'script-src 'self' …'`

and the image remains `display: block`. **[measured]**

- **User impact:** any flag Wikimedia can't serve renders as a browser broken-image icon inside a reference screen whose entire purpose is showing flags.
- **Engineering impact:** dead code that *looks* like working error handling. This is the only inline handler left in the codebase — everything else was correctly migrated to `addEventListener`; this one was missed.
- **Fix:** delete the attribute and reuse the existing `wireFlagFallback()` pattern, or attach `img.addEventListener('error', …)` after render.
- **Effort:** 15 min. **Priority: Medium**

### 3.4 `.pill .fire` is a descendant selector that never matches — **Low**
`styles.css:168` `.pill .fire { color: var(--bad); }` vs markup `<span class="pill fire">` (`main.js:639, 698, 750, 912`). Computed colour of `.pill.fire` in a live quiz: `rgb(238,242,255)` — plain `--text`, not `--bad`. **[measured]** The streak pill has never been red. (Note `.pill .accent` on line 167 *is* correct — `<span class="accent">` really is a descendant. Easy mistake to make once you have both.)
- **Fix:** `.pill.fire`. **Effort:** 1 min. **Priority: Low**

### 3.5 Flag Key: 251 images, no lazy-loading, no debounce, 1-second long tasks — **Critical (performance)**
`main.js:1172-1241`. Opening Flag Key: **251 `<img>` elements, 0 with `loading="lazy"`, 0 with `width`/`height`, 251 network requests, 7.4 s to settle, long tasks of 51/127/**1009**/168/84/181/163/615/228 ms.** **[measured]**

Three compounding causes:
1. **All four tab panels are built and inserted at once** (`main.js:1206-1209`) — countries + US + MX + CA — and hidden with `display: none`. Hidden images still download. 251 requests for ~180 visible cards.
2. **No `loading="lazy"` / `decoding="async"` anywhere in the codebase.**
3. **Every keystroke re-renders the entire grid** (`main.js:1228-1235`): `input` → `flagKeySearch[id] = value` → `rerenderGroup(id)` → `panelFor(g)` rebuilds the whole HTML string → new `<img>` elements → new requests. No debounce, no `requestAnimationFrame`, no keying. Typing `uni` (3 chars) took **1.61 s** and produced two long tasks of 615 ms and 228 ms. **[measured]**

- **User impact:** the search box feels broken. INP well past 500 ms → a failing Core Web Vital on a screen users are told is a "live search."
- **Business impact:** Flag Key is a genuine differentiator (a browsable reference nobody else ships) and its first impression is a frozen page.
- **Fix, in order of ROI:** (a) render only the active tab panel — one line, removes ~40% of requests; (b) add `loading="lazy" decoding="async" width height` to every `<img>` — kills the request storm and the CLS; (c) debounce input at 150 ms; (d) diff instead of rebuild, or use CSS `:has()`/`hidden` toggling on already-rendered cards instead of regenerating HTML.
- **Effort:** (a)+(b)+(c) = 1.5 h and gets ~90% of the win. (d) = +3 h.
- **Priority: Critical**

### 3.6 Map hit-testing is O(regions) with a forced layout per region — **High**
`mapview.js:172-193` `regionAt()` iterates **every** `path[id]`, calling `isPointInFill()` and `getBBox()` on each, to find the smallest containing region.

The intent is correct and well-documented (small regions like DC and Andorra are painted *under* larger neighbours, so `elementFromPoint` returns the wrong answer). The implementation costs 256 `isPointInFill` + 256 `getBBox` calls per click on the world map. `getBBox()` forces synchronous layout.

- **Fix:** precompute each path's bbox area **once** at map-mount time and cache it on the element (`el.__area`). Then use `elementFromPoint` first and only fall back to the full scan when the hit region contains smaller candidates. Or build a simple spatial index (grid buckets) at mount.
- **Effort:** 2 h. **Priority: High** (this is the interaction cost on every single map answer, on the lowest-powered devices)

### 3.7 Eleven JSON datasets are fetched before the home screen renders — **High**
`data.js:31-43` `Promise.all` over all 11 files. The home screen needs **none** of them except `achievements.json` (for the HUD) and, arguably, `countries.json`. `crises.json` (18.4 KB), `phrases.json` (6.3 KB), `music.json` (5.9 KB) are downloaded and parsed by every visitor including the ~90% who never open Explore. **[measured]** ~34 KB and the associated parse cost on the critical path.
- **Fix:** split into `loadCore()` (countries, states, achievements) and per-screen `loadDataset(name)` with the same in-flight-promise caching already used correctly for maps (`data.js:110-121` — the pattern is already in the codebase, just not applied here).
- **Effort:** 2 h. **Priority: High**

### 3.8 The KV rate limiter does not rate limit — **High (security/cost)**
`functions/api/session/start.js:34-37` and `functions/api/xp.js:38-41`:
```js
const countStr = await env.SESSIONS_KV.get(rlKey);
const count = countStr ? parseInt(countStr, 10) : 0;
if (count >= RATE_LIMIT_MAX) return json({ error: 'rate_limited' }, 429);
await env.SESSIONS_KV.put(rlKey, String(count + 1), { … });
```
Two independent failures:
1. **Read-then-write is not atomic.** Fire 500 concurrent requests and they all read the same count and all pass. The limit is bypassed by removing the delay between requests.
2. **KV is eventually consistent** (up to ~60 s global propagation). Even serially, the counter is stale by design. Cloudflare's own docs say KV is unsuitable for rate limiting.

- **Impact:** unauthenticated endpoints that perform a KV write and a full quiz-pool build per call, with an advisory-only limiter. This is a metered-cost amplification vector (KV writes and Function invocations are billed), not a data-breach vector.
- **Fix:** use Cloudflare's [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) or a Durable Object counter. Add a WAF rate-limiting rule on `/api/*` as a zero-code stopgap **today**.
- **Effort:** WAF rule 15 min; binding 2 h. **Priority: High**

### 3.9 The XP leaderboard is unauthenticated, name-keyed, and monotonic — **High (product integrity)**
`functions/api/xp.js:43-48`, `migrations/0002:name TEXT PRIMARY KEY`.

```sql
INSERT INTO xp_leaderboard (name, xp, …) VALUES (?, ?, …)
ON CONFLICT(name) DO UPDATE SET xp = MAX(xp_leaderboard.xp, excluded.xp)
```

Three distinct problems, one of which is not a security issue but a **product bug**:

1. **Anyone can POST any name with any XP up to 100,000,000.** The code comments acknowledge this ("a player could submit any number"). Fine as a stated trade-off — but combined with (3) it isn't recoverable.
2. **The default display name is `Explorer`** (`state.js:14`, and `sanitizeName()` falls back to `'Explorer'` on both endpoints). **Every player who never opens Profile and sets a name shares one leaderboard row.** The XP leaderboard's likeliest top entry is a merged identity representing an unbounded number of anonymous users. This makes the feature meaningless before anyone attacks it.
3. **`MAX()` makes poisoning permanent.** Once a name is pinned to 100,000,000 there is no code path that can ever lower it. Recovery requires manual `wrangler d1 execute`. And any legitimate user who later picks that display name inherits the poisoned score.

- **Fix (minimum):** generate a random `playerId` (UUID) in the profile on first run, key the table on `playerId`, display `name` as a mutable label. Add a profanity/impersonation filter on names (they render publicly — see §9.4). Cap per-submission XP delta rather than accepting absolute totals. Add a `reported`/moderation column.
- **Effort:** 4 h + a migration. **Priority: High**

### 3.10 Service worker cache grows without bound — **Medium**
`sw.js:28-45`. `networkFirst` does `cache.put(req, res.clone())` for *every* successful same-origin GET, and `cacheFirst` caches every flag and Wikimedia image forever. One cache (`worldly-v2`), no size cap, no LRU, no age-based eviction. A user who browses Flag Key (251 flags) plus all four map SVGs (1.6 MB of SVG) plus every dataset accumulates a large, permanently-growing cache.
- **Impact:** on iOS Safari, exceeding the origin quota causes the browser to evict *the whole origin's storage* — including `localStorage`. **That means silent, total loss of the player's profile: XP, streaks, achievements, SRS boxes.** For an app whose entire value proposition is accumulated progress with no account backup, this is the highest-consequence latent failure in the codebase.
- **Fix:** separate caches for shell / data / images; cap the image cache (e.g. 300 entries, FIFO eviction in the `fetch` handler); consider `navigator.storage.persist()`. Long-term: cloud profile sync (§16).
- **Effort:** 3 h. **Priority: Medium→High** (Medium likelihood, catastrophic impact)

### 3.11 Other code smells
| Location | Issue |
|---|---|
| `main.js:245` | `homeCard()` interpolates `m.title` / `m.desc` **without `esc()`** while every sibling call escapes. Safe today (static constants) — but it is precisely the inconsistency that turns into an XSS when someone makes card titles data-driven. |
| `main.js:975`, `main.js:1478` | `<a href="${l.url}">` — URL interpolated raw into an attribute. See §9.1. |
| `styles.css:531` + `styles.css:547` | `.mt-10` defined twice, identically. |
| `styles.css:298` + `styles.css:306` | `touch-action: none` declared twice in `.map-holder`. |
| `styles.css:159` | `.card.badge-locked` — no code ever applies this class. Dead. |
| `main.js:1152` | `.flagkey-card` is a `<div class="card">` styled `cursor: default` — a non-interactive element wearing an interactive component's class. Should be a `<li>`/`<article>`, not `.card`. |
| `main.js:848` | On a dropped connection mid-Challenge, the current question is silently scored **wrong** (`correct = false`) rather than skipped. Comment acknowledges it. A user on flaky mobile gets penalised for their carrier. Prefer: don't record the answer at all, re-ask locally. |
| `README.md:31` | Says "48 tests". Actual: **72**. **[measured]** Docs drift. |
| `package.json:11-12` | `deploy: wrangler deploy` / `preview: wrangler dev` — both wrong for a Pages project. The README correctly says `wrangler pages deploy . --project-name=playworldly`. Running `npm run deploy` does not deploy this site. |
| `js/analytics.js:10` | Analytics loads as a top-level module side effect, unconditionally, before any consent check. See §9.5. |

---

## 4. Performance audit

### Measured baseline (production, desktop 1440×900, warm CDN) **[measured]**

| Metric | Value | Verdict |
|---|---|---|
| TTFB | 73 ms | Excellent |
| FCP | 772 ms | Good |
| LCP | 1,228 ms | Good (< 2.5 s) |
| CLS (home) | 0.0000 | Excellent |
| Total transfer | 161 KB / 32 requests | Excellent |
| Largest JS | `clarity.js` 25.8 KB — **larger than `main.js` (24.4 KB)** | See below |
| `networkidle` | **never reached in 60 s** | Clarity keeps polling |
| Flag Key long task | **1,009 ms** | Failing |
| Flag Key search (3 chars) | **1,610 ms** | Failing |
| World map ready | 1,127 ms | Acceptable |
| Mobile viewport overflow | `scrollWidth 401` vs `clientWidth 390` | **11 px horizontal scroll** |

The cold-load story is genuinely strong and should be protected. **Every performance problem in this app is post-load interaction cost, not load cost.** That reframes the whole optimisation list.

### Ranked by ROI

| # | Change | Est. impact | Effort |
|---|---|---|---|
| 1 | `loading="lazy" decoding="async" width height` on all `<img>` | Flag Key: 251 → ~30 initial requests. Kills the 1 s long task and the flag-load CLS on every quiz question. | 45 min |
| 2 | Render only the active Flag Key tab panel | −40% requests, −60% DOM nodes on that screen | 30 min |
| 3 | Debounce Flag Key search 150 ms + diff instead of rebuild | INP 1,610 ms → <200 ms | 2 h |
| 4 | Lazy-load the 8 non-core datasets | −34 KB and associated parse off the critical path | 2 h |
| 5 | Cache path bbox areas at map mount (§3.6) | Removes 256 forced layouts per map click | 2 h |
| 6 | Self-host or defer Clarity | −25.8 KB, removes the third-party CSP error, lets `networkidle` settle | 1 h |
| 7 | `content-visibility: auto` on off-screen card grids | Reduces style/layout on Flag Key and Explore | 30 min |
| 8 | `<link rel="preload" as="fetch" crossorigin>` for `countries.json` | ~100–150 ms earlier first render | 15 min |
| 9 | Pre-connect to `flagcdn.com` | ~100 ms off first flag paint | 5 min |
| 10 | Cache-Control on `/js/*` is `max-age=300` | Every return visit within a day re-validates 8 JS files. With `_headers`-based fingerprinting or a version query param, this could be `immutable`. | 1 h |

### Bundle
No bundler, no tree-shaking, 8 separate JS requests. On HTTP/2 this is fine at current size and is a deliberate, defensible trade. **Do not add a bundler.** Revisit only if JS exceeds ~150 KB.

### Fonts
System font stack (`styles.css:10`). Zero webfont cost, zero FOIT/FOUT. Correct call, and it should stay that way — though it is also why the UI reads as generic (§6).

### Rendering / rerenders
Every navigation is a full `app.innerHTML = ...` teardown. At current DOM sizes this is fine and avoids a VDOM. The exception is Flag Key, where the same pattern applied to 251 nodes on every keystroke is the top INP problem in the app. **The pattern isn't wrong; applying it to a 251-item list without diffing is.**

### CLS
Home is 0.0000 — but that's because the home flags are 40 px and cached. `.q-flag` on the quiz screen has **no `width`, no `height`, no `aspect-ratio`, and `width: 60%; max-width: 240px`** (`styles.css:173`; live DOM confirms no dimension attributes **[measured]**). Every flag question shifts the layout when the image resolves. Not captured in the home-page CLS number, but real, and it happens on the app's highest-frequency screen.

---

## 5. UX review — as a first-time visitor

### The cold-open problem
The landing screen gives a new visitor: an `h1` ("Explore the world 🌍"), one sentence of subcopy, a dense yellow-bordered onboarding box that is the most visually prominent element on the page, four tabs, and five equally-weighted cards. Below the fold: **nothing — roughly 30% of a 1440×900 viewport is empty.**

Problems, in the order a visitor hits them:

1. **No CTA hierarchy.** Five cards, identical size, identical weight. There is no "start here." A first-timer must read five descriptions and choose. The correct design is one dominant primary action (`▶ Start learning` → a 5-question taster) with everything else demoted.
2. **The onboarding box out-competes the product.** The single loudest element explains *spaced repetition* before the user has answered a single question. It also carries two buttons ("Got it" / "Learn more") that compete with the real CTAs. **This is also the first Tab stop** (§7). Teach the mechanic *after* the first correct answer, in context, not before engagement.
3. **The HUD advertises emptiness.** A brand-new user sees `Lvl 1 · XP 0 · 🔥 0 · 🎯 0%` — four zeros across the top of the screen. Gamification chrome shown to someone with zero progress is demotivating. Hide the HUD (or show a "first quiz →" nudge) until `totalAnswered > 0`.
4. **No proof of value.** No sample question, no screenshot, no "156 countries · 46 songs · 24 crisis briefings," no indication of scope. The user must commit before seeing anything.

### Confirmed abandonment points

| Where | What happens | Severity |
|---|---|---|
| **Browser Back, anywhere** | Leaves the site entirely (`about:blank`) **[measured]**. Mid-quiz Back = all run progress gone, no warning. On mobile, Back is a reflex gesture. | **Critical** |
| **Flag Key search** | Type 3 characters → 1.6 s freeze **[measured]**. Reads as a crash. | **Critical** |
| **Any map mode on mobile** | 30/51 states under 24 px **[measured]**; Rhode Island 3.5×4.8 px; map opens un-zoomed with ~60% empty container. The question "Where is Hawaii?" renders Hawaii at 10.9×21.7 px in a corner. Unplayable without pinch-zooming, and nothing tells the user to. | **Critical** |
| **Mid-quiz `✕`** | Unlabeled, positioned where "Back" would be, no confirmation. One mis-tap discards the run. | High |
| **Progress bar** | Reads 0% after answering question 1 (§3.1). Reads as frozen. | High |
| **Challenge mode** | 10-second hard timer with no warm-up and no pause. First-time users will time out on Q1 before understanding the rules. | Medium |
| **Leaderboard** | All three tabs empty **[measured]**. A brand-new user opening 🏆 sees "No scores yet — be the first!" three times. Reads as abandoned. | Medium |
| **Remote answer submission** | `answer()` awaits a network round-trip before marking any choice (`main.js:830-875`). On slow mobile there is **zero feedback between tap and response** — no spinner, no pressed state. Users will tap again (the `phase` guard silently swallows it) and conclude it's broken. | High |

### Loading / empty / error states
- Loading: three bare text strings ("Loading the world…", "Loading the map…", "Loading…"). No skeletons, no spinners.
- Empty: handled thoughtfully in places (`"Flawless run — nothing to review. 🌟"`, `"No matches."`). Good instinct, inconsistently applied.
- Error: the boot failure screen (`main.js:1769-1777`) is genuinely excellent — it detects `file://` and gives exact instructions. This is better error handling than most production apps. It is also the *only* error state in the app; there is no error boundary for anything after boot.

### Mobile (390×844) **[measured]**
- **11 px horizontal overflow.** The theme-toggle button is visibly clipped at the right edge.
- Topbar wraps to two rows, pushing the quiz header down.
- `quiz-top` wraps: `✕ / progress / 1/10 / 🔥 0` on row 1, `⭐ 0` orphaned on row 2.
- Sub-44 px tap targets: footer links (30 px and 15 px tall), "Got it" and "Learn more" (42 px — close, but under).
- Map container: 300×439 with the map letterboxed into the middle, roughly 60% wasted.

---

## 6. UI / visual design

**Assessment: competent, coherent, and completely generic.** This is "dark dashboard template" — the same navy/blue/card-grid you'd get from any admin starter. Nothing in the visual language says *world, culture, travel, or discovery*. For a product whose pitch is "learn the world," that is a positioning failure, not a taste quibble.

**Typography** — one system stack, effectively three sizes (1.6rem / 1.05rem / 0.85rem), weights 600–800. No display face, no scale, no rhythm. The `h1` at 25.6 px is *smaller than the body copy on most marketing sites*. There is no typographic personality at all.
→ **Fix:** one characterful display face for `h1`/`.q-prompt`/`.score` (self-hosted, `font-display: swap`, subset — ~15 KB). Establish a real modular scale (1.250). Body stays system.

**Colour** — `--primary: #4f8cff` (generic blue) carries everything; `--accent: #ffce54` (gold) appears almost nowhere (hover states, pronunciation text). The palette has no relationship to the subject matter.
→ **Fix:** commit to the gold as a genuine secondary — it's the more distinctive of the two and it reads as *maps, brass, old atlases*. Use it for XP/streak/achievement (the reward system) and keep blue purely for navigation/interactive affordances. One decision, large payoff.

**Iconography** — emoji everywhere. Cheap to ship and it does convey warmth, but: rendering differs per OS, optical sizes are inconsistent (the 📅 renders as a full-colour "July 17" calendar next to a flat 🔁), and you've *already* had to work around it (`main.js:207-211` uses real flag images because Windows has no flag-emoji font). You've discovered the constraint and half-adopted the fix.
→ **Fix:** a small consistent SVG icon set (Lucide, ~1 KB per icon inlined) for structural UI. Keep emoji for content/personality (achievement toasts, crisis tiers) where the inconsistency doesn't hurt.

**Visual hierarchy** — the single biggest miss. On home, the *dismissible onboarding note* and the *five equal cards* have the same visual weight. Nothing is primary.

**Interaction feedback** — hover states exist and are consistent (`translateY(-1px)`, border → primary). Missing: `:active` pressed states, loading states on any async action, and — critically — a **designed focus ring**. There is no `:focus-visible` rule for `.btn`, `.card`, `.tab`, or `.choice`; they inherit browser defaults (`outline-width: 3px, outline-style: auto` **[measured]**). Functional, but visually foreign to the design and inconsistent across browsers.

**Animation** — `slidein`, `pop`, `tab-fade`, all ~160–240 ms. Tasteful and restrained. `prefers-reduced-motion` is respected via a blanket `* { transition: none !important; animation: none !important; }` (`styles.css:290-292`). Correct and complete.

**Premium feel** — currently absent, and it's *close*. The spacing system is disciplined, the shadows are consistent, the dark theme is well-balanced. What's missing is: (1) a real focus ring, (2) `:active` states, (3) skeleton loaders instead of "Loading…", (4) one distinctive type choice, (5) filling the empty 30% below the fold. Roughly 1.5 days of work stands between "looks like a side project" and "looks like a product."

**Theme** — `index.html:2` hardcodes `data-theme="dark"` and JS applies the stored preference after boot. There is no `prefers-color-scheme` support at all: a user whose OS is set to light gets dark on first visit, forever, until they find the 🌙 button. Add `@media (prefers-color-scheme: light)` as the default when no stored preference exists.

---

## 7. Accessibility — WCAG 2.2

This codebase shows more genuine a11y effort than most commercial products — `focusTitle()` for screen-reader announcements, roving-tabindex tab bars with full arrow-key support (`main.js:120-145`), keyboard-operable SVG map regions with `role="button"` and `aria-label` (`mapview.js:219-238`), an `.sr-only` announcement for the highlighted map region, a documented `stopPropagation` fix so Enter doesn't skip the feedback screen, and an explicit 44 px touch-target block (`styles.css:108-113`).

And it still has three hard failures.

### 7.1 The quiz screen has zero headings — **Fail (1.3.1, 2.4.6, 2.4.10)** — **[measured]**
`document.querySelectorAll('h1,h2,h3,h4')` on a live quiz screen returns **`[]`**. After answering, exactly one `<h3>` appears (`✗ The answer is …`) with no `h1` or `h2` ancestor — a skipped heading level.

The question prompt is `<div class="q-prompt">` (`main.js:645, 703, 758, 918`). The app's primary screen is structurally headless: screen-reader users cannot navigate by heading, and the "H" key does nothing on the screen they'll spend 95% of their time on.

**Fix:** `<h1 class="q-prompt">` (it *is* the page's main heading), `<h2>` for the feedback result. `focusTitle()` already targets `.q-prompt` so focus management keeps working unchanged. **Effort: 20 min. Priority: Critical (cheapest high-impact a11y fix in the repo).**

### 7.2 Map regions are 3.5×4.8 px — **Fail (2.5.8 Target Size Minimum, AA)** — **[measured]**
At 390 px viewport: **30 of 51 US states are under 24 CSS px** in at least one dimension. Rhode Island 3.5×4.8. Delaware 5.5×8.9. Connecticut 8.9×8.7. Hawaii 10.9×21.7.

The exception for "essential" spatial targets is arguable for a map, but the *undisputed* failure is that there's no alternative path: no keyboard-accessible region list, no zoom-on-load, no hint that pinching is required, and the reverse "name it" MCQ modes aren't offered as a substitute.

**Fix:** zoom-to-fit the target's neighbourhood on load; add a visible "pinch or use ＋ to zoom" hint on first map question; scale small-region hit areas by adding an invisible `stroke-width` halo (`stroke: transparent; stroke-width: 12; vector-effect: non-scaling-stroke` widens the hit area without changing the visual). **Effort: 4 h. Priority: Critical.**

### 7.3 Focus on boot lands mid-page and skips the entire header — **Fail (2.4.3 Focus Order)** — **[measured]**
`focusTitle()` runs on initial boot (`main.js:311`), focusing `.screen-title` with `tabindex="-1"`. Measured Tab order from a fresh load:

```
1. "Got it"        (onboarding)
2. "Learn more"
3. tab "🎮 Play"
4-8. the five cards
9-10. footer links
11. <body>
12. .brand   ← header finally reached, at position 12
13. HUD name
14. ❓ help
```

Home / Leaderboard / Theme are the **last** things a keyboard user reaches, after cycling the entire page. On subsequent in-app navigations `focusTitle()` is correct and valuable — the bug is applying it to the *initial* load, where the natural document order is already correct.

**Fix:** skip `focusTitle()` on first render; add a "Skip to main content" link as the first focusable element. **Effort: 30 min. Priority: High.**

### 7.4 Other findings

| Issue | Location | Severity |
|---|---|---|
| `role="status" aria-live="assertive"` is contradictory — `role="status"` has an implicit `aria-live="polite"`; combining them is undefined behaviour across AT | `main.js:647, 714, 765, 924` | Medium — use `role="alert"`, or `aria-live="assertive"` alone |
| `<div id="brand" role="button" tabindex="0">` with hand-rolled Enter/Space handling instead of `<button>` | `index.html:28`, `main.js:1749-1751` | Medium — the platform element is free and correct |
| No designed `:focus-visible` for `.btn`/`.card`/`.tab`/`.choice`; browser default only | `styles.css` | Medium |
| No skip link | `index.html` | Medium |
| Sub-44 px targets: footer links 30 px / 15 px tall; "Got it" 42 px | measured | Low (2.5.8 min is 24 px; these pass AA, fail AAA/2.5.5) |
| Icon-only buttons rely on `title` + `aria-label` — correct — but the mid-quiz `✕` has only `title="Back to home"` and no `aria-label` | `main.js:636, 695, 747, 909` | Medium |
| Achievement toasts fire into `aria-live="polite"` while the answer feedback fires `assertive` simultaneously — competing announcements | `index.html:39` + feedback regions | Low |
| No `lang` attribute on foreign-language phrase text — a screen reader reads Japanese with an English voice | `main.js:1305-1319` | Medium — add `lang="${entry.langCode}"` on `.ph-local` / `.say-local` |
| Colour contrast | `--muted #9aa7c7` on `--surface #18213a` ≈ 6.4:1; light theme `#5b6783` on `#fff` ≈ 5.6:1 | **Pass** |
| `prefers-reduced-motion` | `styles.css:290` | **Pass — complete** |

---

## 8. SEO

**Current state: one indexable page for an app containing 156 countries, 46 songs, 24 crisis briefings and 16 phrasebooks.** This is the single largest unforced business error in the project.

### What's right
`<title>`, `meta description`, `og:type/site_name/title/description/url/image`, `twitter:card`, `canonical`, `robots.txt`, `404.html` with `noindex`, `lang="en"`, a web manifest.

### What's missing

| Gap | Impact |
|---|---|
| **No routes → no indexable content.** With JS disabled, `document.body.innerText` is: `"🌍 Worldly ❓ 🏆 🌙 Worldly · learn the world through active recall · 💬 Feedback & requests · GitHub"` **[measured]**. Googlebot renders JS, but with no URLs there is nothing to render *into*. | **Critical** |
| **No `sitemap.xml`**, and `robots.txt` has no `Sitemap:` directive | High |
| **No structured data.** No `WebApplication`, `Quiz`, `Course`, `FAQPage`, or `BreadcrumbList` JSON-LD. Quiz and Course schemas are eligible for rich results. | High |
| **Heading structure is broken** — quiz screens have zero headings **[measured]**; home has exactly one `h1` and no `h2`. | High |
| **No internal linking.** Every navigation is a JS click handler. Zero crawlable `<a href>` between screens. | High |
| **`og:image` is a 402 KB full-page screenshot** of the home screen — not a designed social card, and heavy. No `og:image:width/height/alt`. | Medium |
| No `twitter:title` / `twitter:description` (inherits OG — acceptable) | Low |
| No `hreflang`; app is English-only despite being about the world | Low (future) |

### The opportunity, quantified
Once routing exists, these become real, crawlable, long-tail landing pages:

- `/quiz/capital`, `/quiz/flag`, `/quiz/similar-flags`, … — **18 quiz modes**
- `/map/world`, `/map/usa`, `/map/mexico`, `/map/canada`, + reverse/flag variants — **10 map modes**
- `/explore/crises/<slug>` — **24 pages**, targeting genuinely underserved queries ("Sudan conflict explained", "underreported crises 2026")
- `/explore/phrases/<country>` — **16 pages** ("basic Japanese phrases with pronunciation")
- `/explore/music/<country>` — **17 pages**
- `/flags/<country>` — **156 pages** ("flag of Burkina Faso")

**~240 indexable pages** from content that already exists in `data/*.json`. The crisis briefings in particular are original editorial content with dated sourcing — the hardest kind of SEO asset to acquire, and it's currently invisible to every search engine on earth.

Pre-render them at deploy time with a ~60-line Node script that walks the JSON and emits static HTML shells (the SPA hydrates over them). No framework required. **Effort: 2 days after routing. This is the highest-ROI work in the entire document.**

---

## 9. Security

**Overall: better than the median side project, and better than a lot of funded startups.** A strict CSP with no `unsafe-inline`, `nosniff`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, `rel="noopener"` on every external link, consistent HTML escaping, parameterised D1 queries throughout, `youtube-nocookie` embeds, and a server-verified scoring path that deliberately withholds answers from the client. Someone thought about this.

### 9.1 Unescaped URL interpolation into `href` — **Medium**
`main.js:975` and `main.js:1478`:
```js
`<a href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`
```
The label is escaped; **the URL is not.** Today `l.url` comes from `learnMoreFor()` (constructed, safe) and `data/crises.json` (hand-authored), so this is not currently exploitable. But:
- A `"` in a crisis link breaks out of the attribute → arbitrary attribute injection.
- A `javascript:` URL in `data/crises.json` executes on click. CSP does not block `javascript:` in `href` navigations.
- Crisis data is explicitly documented as community-contributable ("corrections are welcome… everything lives in open JSON data files"). **The moment you accept a data PR, this is a live XSS vector with a low-privilege entry point.**

**Fix:** a `safeUrl()` helper that allow-lists `https:`/`http:` schemes and escapes the result; apply at both sites. **Effort: 20 min. Priority: Medium (High if you accept community data PRs).**

### 9.2 Rate limiting is non-functional — see §3.8 — **High**

### 9.3 XP leaderboard is forgeable and permanently poisonable — see §3.9 — **High**

### 9.4 Public display names have no moderation — **Medium**
`sanitizeName()` (`functions/api/session/finish.js:5-8`, `functions/api/xp.js:9-12`) strips control characters and truncates to 20 chars. That's it. Any 20-character string — slurs, harassment, impersonation ("Admin", "Worldly Team"), or a plausible-looking URL — renders publicly on the leaderboard to every visitor.

XSS is correctly prevented (`esc()` at `main.js:1634`). The exposure is **brand and moderation**, not code execution. There is no reporting mechanism, no blocklist, and no admin tooling — removal requires manual `wrangler d1 execute` against production.

**Fix:** a profanity/impersonation blocklist at write time, a `hidden BOOLEAN` column, and a minimal admin endpoint behind a Cloudflare Access policy. **Effort: 3 h. Priority: Medium (rises to High the moment the site gets real traffic).**

### 9.5 Analytics loads before any consent gate — **Medium (compliance)**
`analytics.js:10-20` is an IIFE that runs on import — Microsoft Clarity loads for every visitor, unconditionally, on first paint. Clarity performs **session recording and DOM capture**, not just event counting.

The About screen (`main.js:351-355`) and README both describe this as "anonymous usage analytics (which screens and modes get used)". Clarity's default behaviour is broader than that description. For EU/UK visitors this is a GDPR/ePrivacy exposure: no consent banner, no opt-out, and no `Do Not Track` / `globalPrivacyControl` check.

**Fix (minimum):** honour `navigator.globalPrivacyControl` and `navigator.doNotTrack` before loading; add an opt-out toggle in Profile; align the privacy copy with what Clarity actually records. **Fix (better):** replace Clarity with a cookieless, consent-exempt analytics product (Cloudflare Web Analytics is free, already on your platform, and needs no banner). That also removes 25.8 KB of third-party JS and the CSP error below.

### 9.6 A CSP violation fires on every single page load — **Low**
**[measured]** — every load produces:
> `Loading the image 'https://c.bing.com/c.gif?ctsa=mr&CtsSyncId=…' violates the following Content Security Policy directive: "img-src 'self' https://flagcdn.com …"`

Clarity attempts a Bing ad-sync pixel your CSP correctly blocks. The CSP is doing its job. But a permanent console error on every page load is noise that will mask a real error later, and it's the first thing any reviewer sees when they open DevTools.
**Fix:** removing Clarity (§9.5) resolves it. Do not widen the CSP to accommodate an ad-sync pixel.

### 9.7 CSP hardening — **Low**
Missing directives: `base-uri 'none'` (prevents `<base>` injection hijacking every relative URL), `form-action 'self'`, `object-src 'none'` (covered by `default-src` but explicit is better), `frame-ancestors 'none'` (you have `X-Frame-Options: DENY`, but `frame-ancestors` is the modern equivalent and supersedes it). No `Strict-Transport-Security` header. No `Cross-Origin-Opener-Policy`.
**Effort: 15 min for all of it.**

### 9.8 Not issues (verified)
- **No secrets in the repo.** `.gitignore` correctly excludes `.dev.vars*` and `.env*`. `wrangler.toml` contains a D1 `database_id` and KV namespace `id` — these are resource identifiers, not credentials, and are useless without account auth. Fine to commit.
- **No dependency risk.** One devDependency (`wrangler ^4.107.1`), zero runtime dependencies. `npm audit` surface is effectively nil. This is a real advantage of the no-build approach and should be defended.
- **SQL injection:** all D1 queries use `.bind()`. Clean.
- **Session grading:** `/api/session/answer` correctly never returns unanswered questions' answers, rejects double-answers (409) and unknown question IDs. `/api/session/finish` requires all questions answered before writing a score. The design is sound.
- **XSS in rendered content:** every user- and data-sourced *text* interpolation goes through `esc()`. Only the two `href` cases in §9.1 are unescaped.

---

## 10. Scalability

### 10k monthly users
Handles it without changes. Static assets on Cloudflare's edge; Functions only fire for Challenge/Daily/leaderboard. Expected cost: **$0–5/month.**

**Risks at this tier:**
- The `leaderboard` table grows unbounded — one row per completed Challenge/Daily run, never pruned. Indexes exist (`idx_leaderboard_mode_score`, `idx_leaderboard_mode_date`) so reads stay fast, but the table only grows.
- `/api/session/finish` runs **four sequential D1 queries** per completion (1 INSERT + 3 SELECTs; the last three are `Promise.all`'d but the INSERT is serial). Fine here.
- No observability. If Functions start 500ing you will find out from a user, or not at all.

### 100k monthly users
**First real breakages.**

1. **KV rate limiting collapses** (§3.8) — already broken, but at this scale it starts costing money. KV writes are billed per operation; one write per session start, per XP sync, per rate-limit check.
2. **The XP leaderboard becomes unusable.** With `name TEXT PRIMARY KEY` and a default of `Explorer`, tens of thousands of players collapse into a handful of rows (§3.9). The feature stops meaning anything long before it breaks technically.
3. **Name collisions become the norm.** Two players named "Alex" are one row.
4. **`leaderboard` at ~1M rows** — `SELECT COUNT(*) WHERE mode = ? AND score > ?` on every completion is an index scan that degrades linearly. Replace with a periodically-materialised rank table or approximate percentile.
5. **No moderation tooling** (§9.4) becomes an active brand problem.
6. **The SW cache eviction risk (§3.10) starts producing real support load** — "I lost all my progress" with no recovery path, because there is no cloud backup.

**Required before this tier:** Rate Limiting binding or WAF rules · `playerId`-keyed leaderboard · leaderboard retention/rollup job (Cron Trigger) · Cloudflare Workers Analytics + Logpush · an error-reporting endpoint · a moderation column and admin path.

### 1M monthly users
Static delivery is still free-ish and fine. The architecture that breaks is everything stateful:

- **D1 write throughput** becomes the ceiling. Move leaderboard writes behind a Queue, batch-insert, and serve reads from a materialised top-20 in KV or Edge Config with a 60 s TTL. The leaderboard is read constantly and written rarely — it should never hit D1 on a read path.
- **`localStorage`-only profiles are the product ceiling, not just a technical one.** No cross-device, no recovery, no re-engagement (no email, no push), no cohort analysis. Every retention lever a learning product has requires accounts. This is the decision that determines whether Worldly is a toy or a business.
- **Content operations.** 24 crisis entries hand-edited in JSON and deployed manually does not survive contact with a real audience expecting current information. Needs a CMS or at minimum a scheduled data build.

### Deployment risk — **the most serious operational finding**
From `README.md:121-131`:

> "a Cloudflare Pages project deployed by **direct upload**, not git integration — pushing to `main` runs the test suite in CI but does **not** publish the site."

**Consequences:**
1. **CI green means nothing.** The tested commit and the deployed artefact are unrelated. There is no mechanism preventing untested, uncommitted, or locally-modified code from being deployed.
2. **No deployment provenance.** Nothing records which commit is live.
3. **No rollback path** beyond manually redeploying an older working tree.
4. **Bus factor of one** — deployment lives entirely in one person's shell history.
5. A second, git-connected legacy Worker exists and is documented as "safe to ignore." Confusing infrastructure is infrastructure that gets misconfigured.

**Fix:** a `deploy.yml` GitHub Action on `main` that runs tests → `wrangler pages deploy` with `CLOUDFLARE_API_TOKEN` in repo secrets → tags the commit. Delete the legacy Worker. **Effort: 2 h. Priority: Critical.** This is the cheapest risk reduction available anywhere in this document.

### Observability gaps
No error tracking. No uptime monitoring. No Function logs or Logpush. No alerting. No RUM (Clarity is session-replay, not Web Vitals). No structured logging in any Function — every `catch` is silent. When something breaks in production, the only signal available is a user opening a GitHub issue.

**Minimum viable:** Cloudflare Workers Analytics (free, one toggle) · Logpush on Functions · a `/api/error` beacon posting `window.onerror` + `unhandledrejection` · Cloudflare Web Analytics for real Core Web Vitals RUM.

---

## 11. Developer experience

| Area | State | Assessment |
|---|---|---|
| **TypeScript** | None | Acceptable given the no-build stance — but JSDoc is used well already, so `checkJs` with a `tsconfig.json` would give ~70% of the safety for **zero runtime cost and no build step**. Would have caught the duplicate `class` attribute? No. Would catch `q.answer` being undefined on the remote path? Yes. |
| **Linting** | **None** | ESLint flat config with `eslint-plugin-html` would have caught the duplicate `class` attribute (§3.2), the dead `.pill .fire` selector via stylelint (§3.4), and the inline handler (§3.3). **Three shipped bugs, all statically detectable, all in production right now.** |
| **Formatting** | **None** | Style is impressively consistent by hand — but that's a person doing a machine's job. Prettier, 15 minutes. |
| **Tests** | 72 passing, pure-logic only **[measured]** | Excellent *within its scope*. Zero coverage of `main.js` (1,792 LOC, ~70% of the app), zero coverage of `functions/api/*`, zero DOM tests, zero E2E. Every defect in §3 is in untested code. That is not a coincidence. |
| **CI** | Tests only, on push + PR | Runs `node --test tests/*.test.mjs` — note this diverges from `npm test`, which uses the tdd-guard reporter. No lint, no build check, no E2E, no Lighthouse budget, **no deploy**. |
| **Docs** | README is genuinely good | Architecture diagram, extension guide, data-model notes, honest editorial disclaimers. Stale in places (says 48 tests, actual 72). No `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODEOWNERS`, or ADRs. |
| **Scripts** | `deploy`/`preview` are wrong for a Pages project (§3.11) | A new contributor running `npm run deploy` does something other than deploy this site. |
| **Onboarding** | `python3 -m http.server 8000` — good | Requires Python for a Node project. `npx serve` removes the dependency. |
| **Git hygiene** | 90 commits, **`main` only, no branches, no PRs** | CI is configured to run on `pull_request` but no PR has ever run it. All work goes straight to `main`. No review gate, no revert granularity. |
| **`docs/superpowers/`** | 5 design specs + 3 plans, ~180 KB | Genuinely valuable — real design docs with rationale. Buried in a tool-specific path and not linked from the README. Promote to `docs/design/`. |

**The single highest-leverage DX change:** add ESLint + Prettier + `tsconfig.json` with `checkJs`. Roughly 45 minutes, and it converts three currently-shipped bugs into build failures.

---

## 12. Dependencies

```json
"devDependencies": { "wrangler": "^4.107.1" }
```

**One dependency. Zero runtime dependencies.** This is the correct answer and is a genuine competitive advantage: no supply-chain surface, no `npm audit` noise, no transitive CVE triage, no framework churn. Protect it.

**Assessment:**
- `wrangler ^4.107.1` — current, first-party, correct. The caret range is fine for a dev tool.
- **The only real third-party runtime dependency is not in `package.json`** — it's Microsoft Clarity, loaded at runtime from `scripts.clarity.ms` (25.8 KB, **larger than your own `main.js`** **[measured]**). It is unversioned, unpinned, and outside any review process. See §9.5.
- `/home/isaac/package.json` in the parent directory declares `@microsoft/clarity` — unused by this project, and a sign of a stray install. Not in this repo; noted only so it isn't mistaken for a project dependency.

**Recommended additions (all dev-only, all zero runtime cost):**

| Package | Why |
|---|---|
| `eslint` + `@eslint/js` | Would catch three shipped bugs today |
| `prettier` | Removes an entire class of review comments |
| `stylelint` | Would catch `.pill .fire` and the duplicate declarations |
| `@playwright/test` | E2E smoke tests for the 70% of the app with no coverage |
| `typescript` (for `checkJs` only) | Type safety with no build step and no `.ts` files |

**Recommended removal:** Microsoft Clarity → Cloudflare Web Analytics (free, already on-platform, cookieless, consent-exempt, no CSP error, −25.8 KB).

---

## 13. Configuration review

| File | Assessment |
|---|---|
| **`package.json`** | `deploy`/`preview` scripts are wrong for a Pages project (§3.11). `test` uses a local tdd-guard reporter that CI doesn't use — the two paths can diverge. `engines` field absent (CI pins Node 22; nothing enforces it locally). No `lint`/`format`/`e2e` scripts. |
| **`wrangler.toml`** | Correct and minimal. `pages_build_output_dir = "."` is right for no-build. `compatibility_date = "2026-07-08"` is current. `nodejs_compat` is enabled but nothing appears to require it — verify and drop if unused. IDs are resource identifiers, not secrets — fine to commit. |
| **`_headers`** | Strong. CSP with no `unsafe-inline` is real work and it's done. Missing `base-uri`, `form-action`, `frame-ancestors`, HSTS (§9.7). `img-src` lacks `data:` — fine today. `/js/*` at `max-age=300` forces revalidation of 8 files on every return visit; with content-hashed filenames or a version query this could be `immutable`. `/assets/*` at 1 day is conservative for immutable map SVGs — those could be a year. |
| **`.github/workflows/test.yml`** | Minimal and functional. Missing: lint, `npm ci` (it never installs — fine today with zero deps, but it will silently break the day a dep is added), a concurrency group, and **any deploy step** (§10). |
| **`.assetsignore`** | Well-considered — and the comment documents the actual 121 MiB build failure it was written to fix. Good practice. |
| **`.gitignore`** | Correct. `.dev.vars*` and `.env*` excluded with `!` re-includes for examples. Missing `node_modules` (covered by `.assetsignore` for deploy, but it should be here too) and `.DS_Store`. |
| **`site.webmanifest`** | **Weakest config file.** One 256×256 icon — Android's install prompt requires 192 and 512, and there is no `maskable` variant, so the icon will be letterboxed on Android. No `screenshots` (needed for the richer install UI). No `id`, no `orientation`, no `categories`. `theme_color: #0f1420` **does not match** the CSS `--bg: #0f1525` — a visible seam between the browser chrome and the page on installed PWAs. |
| **`robots.txt`** | Functional, but no `Sitemap:` directive and no sitemap exists (§8). |
| **`404.html`** | Correct: `noindex`, own lightweight CSS, links home. Note that `GET /api/session/start` returns this 404 page with `Content-Type: text/html` **[measured]** — an API path returning an HTML error page. Add a `onRequest` handler returning `405` JSON. |
| **`.gitattributes`** | **Missing — and it is actively causing a problem.** `git status` on a clean checkout reports **every one of the 58 tracked text files as modified**, with `git diff` showing whole-file rewrites. Cause: the working tree has CRLF endings while the index has LF, and nothing normalises them. **[measured]** |
| **Missing entirely** | `.gitattributes`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`, `.nvmrc`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODEOWNERS`, `.github/dependabot.yml`, `sitemap.xml`, `deploy.yml` |

### The line-ending problem deserves its own entry — **High**

**[measured]** On a clean checkout with no local edits, `git status --short` reports 58 modified files. `git diff js/srs.js` shows `49 insertions(+), 49 deletions(-)` on a 49-line file — every line rewritten, CRLF vs LF.

- **Why it matters:** `git status` is permanently noisy, so it stops being a signal. Real changes are invisible in the noise.
- **Engineering impact:** one careless `git add -A` produces a ~5,000-line whitespace-only commit that destroys `git blame` across the entire repository. `git diff` is unusable for review. Any future contributor hits this on their first clone.
- **Business impact:** if this project is ever handed over, audited, or opened to contributors, the version history is the primary artefact of engineering quality — and it is one commit away from being worthless.
- **Fix:**
  ```
  # .gitattributes
  * text=auto eol=lf
  *.bat text eol=crlf
  *.png binary
  *.ico binary
  ```
  then `git add --renormalize . && git commit -m "chore: normalise line endings"` as a single isolated commit, and `git config core.autocrlf input`.
- **Effort:** 20 min. **Priority: High** (trivial cost, and the downside is irreversible history damage)

---

## 14. File-by-file review

### `index.html` (49 lines)
**Purpose:** app shell — topbar, `#app` mount, toast container, footer.
**Problems:** `data-theme="dark"` hardcoded (line 2) → no `prefers-color-scheme` support, and a theme flash for light-mode users. `#brand` is a `div role="button" tabindex="0"` (line 28) instead of a `<button>`. No skip link. No `<noscript>`. No JSON-LD. `og:image` points at a 402 KB screenshot with no dimensions or alt. No `preconnect` to `flagcdn.com`. No `preload` for `countries.json`.
**Recommendations:** `<button class="brand">`; skip link as first focusable; `<noscript>` with real static content (doubles as SEO baseline); JSON-LD `WebApplication`; inline a tiny theme-detection script — or better, use `@media (prefers-color-scheme)` in CSS so no script is needed and the CSP stays clean; designed 1200×630 OG card.
**Priority:** High

### `js/main.js` (1,792 lines) — **the file that needs the most work**
**Purpose:** routing, all 14 screens, quiz session, HUD, theme, boot.
**Problems:** God object. 0% test coverage. No URL routing (the root cause of §5 and §8). Four duplicated quiz headers, all carrying the off-by-one progress bug (§3.1). Triplicated answer-commit blocks (§2). Triplicated list→detail screens. 13 hand-wired click handlers in `showHome`. Duplicate `class` attribute (line 1671). CSP-blocked inline `onerror` (line 1189). Unescaped `href` ×2 (lines 975, 1478). Unescaped `homeCard` interpolation (line 245). No debounce on Flag Key search (line 1228). Eight module-level mutable UI-state globals. No error boundary.
**Recommendations:** split into `js/screens/*` + `js/router.js` + `js/state/session.js`; extract `<QuizChrome>` and `commitAnswer()`; delegate events via `data-action`; introduce an escaping `html` tagged template.
**Priority:** Critical

### `js/quiz.js` (492 lines)
**Purpose:** pure question-generation engine.
**Assessment:** the best file in the repository. `geoDistractors()` (line 112) with its `normalize` hook is thoughtful, well-documented design. `answerMatches()` (line 145) handles diacritics, punctuation and spacing correctly. `sessionQuestionXp`/`challengeMultiplier` are deliberately self-contained so client and server agree — exactly right.
**Problems:** `makeQuestion()` is a 180-line switch with per-mode special cases woven through the distractor logic — adding a mode means touching three places. `learnMoreFor()` (line 196) emits a **Google search URL** labelled "Culture Guide," which is filler dressed as a curated resource. No input validation — a malformed data record produces `undefined` in a prompt.
**Recommendations:** move each mode to a `MODE_HANDLERS[mode] = { prompt, answer, distractors }` table so `MODES` becomes the single extension point. Replace or remove the Google-search link.
**Priority:** Medium

### `js/state.js` (241 lines)
**Purpose:** localStorage profile — the single source of truth for all progress.
**Problems:** `saveProfile()` is called on **every single answer** — a full `JSON.stringify` of a profile whose `srs` and `missed` maps grow unbounded with play. A long-term player's profile will reach hundreds of KB, serialised synchronously on the main thread per question. `importProfile()` (line 89) validates only that `xp` is a number and `srs` is an object, then spreads arbitrary attacker-controlled JSON into the profile — a malicious export file can inject any field, including a forged `xp` for leaderboard submission. `profile.leaderboard` is capped at 10; `srs` and `missed` are capped at nothing.
**Recommendations:** debounce/coalesce saves (or write on `visibilitychange`); validate imports against a schema; prune `srs` entries not seen in 180 days; version the profile and add a migration path (`version: 1` exists but is never checked).
**Priority:** High

### `js/data.js` (126 lines)
**Purpose:** dataset loading, flag URL construction, lazy map loading.
**Problems:** loads all 11 datasets eagerly (§3.7). Contains three functions — `historicFlagUrl`, `stateFlagUrl`, `symbolImageUrl` — that are **byte-identical** apart from their names and doc comments.
**Assessment:** the lazy-map loader (lines 110-121) with in-flight promise caching and cache-poisoning protection on failure is exactly right — apply the same pattern to the datasets.
**Recommendations:** collapse the three URL helpers into one `commonsFileUrl(filename, width)`; split loading into core vs. on-demand.
**Priority:** High

### `js/mapview.js` (255 lines)
**Purpose:** the interactive map widget — SVG injection, pan/zoom/pinch, hit-testing, keyboard support.
**Assessment:** the most impressive piece of engineering in the codebase. Pointer-event handling correctly distinguishes click / drag / pinch with a threshold. The smallest-region hit-test solves a real problem (nested regions painted under neighbours). Keyboard operability with `stopPropagation` to prevent feedback-skip is a bug that was found and fixed properly.
**Problems:** `regionAt()` is O(n) with a forced layout per region (§3.6). `svg.style.transform` on the root `<svg>` repaints the entire vector — transforming an inner `<g>` is cheaper. No zoom-to-fit on load for non-continent modes, which is what makes mobile unplayable (§7.2). No pinch/zoom affordance or hint. `focusIds` fitting runs in `requestAnimationFrame` with a comment explaining the assumption that `.el` is appended synchronously — correct today, fragile as a contract.
**Recommendations:** cache bbox areas at mount; wrap paths in a `<g>` and transform that; auto-fit to the target region's neighbourhood on mobile; add transparent stroke halos to widen small hit areas.
**Priority:** High

### `js/maps.js` (181 lines)
**Purpose:** pure question engine for click-the-map modes.
**Assessment:** clean, well-tested, mirrors `quiz.js` appropriately.
**Problems:** `parseSvgRegions()` (line 36) parses SVG with regex. It works because the input is a known, bundled, controlled asset — and the comment says so — but it will fail silently on any SVG where `id` or `aria-label` uses single quotes. `regionIdFor()` (line 61) does a linear scan over all regions with `normalizeName()` recomputed per comparison, per lookup, for every state-mode pool build.
**Recommendations:** precompute a normalized-name → id index once per map. Note the regex-parsing constraint explicitly in a test.
**Priority:** Low

### `js/srs.js` (49 lines)
**Purpose:** Leitner weighting and selection.
**Assessment:** clean, pure, correct, well-commented, fully tested. **No changes needed.**
**Priority:** —

### `js/achievements.js` (68 lines)
**Purpose:** evaluate achievement definitions against the profile.
**Problems:** `checkAchievements()` iterates all 23 definitions on **every answer**, and is called from three separate places that each then call `saveProfile()` separately — so most answers trigger two profile writes. `levelTitle()` hardcodes eight titles in code while every other content string lives in JSON.
**Recommendations:** only evaluate achievements whose `type` matches what changed; move titles to `data/`.
**Priority:** Low

### `js/analytics.js` (30 lines)
**Purpose:** Microsoft Clarity integration.
**Problems:** loads on import with no consent gate, no DNT/GPC check, no opt-out (§9.5). 25.8 KB of third-party JS, larger than `main.js`. Causes a CSP violation on every page load (§9.6). Privacy copy in About and README understates what Clarity records.
**Recommendations:** replace with Cloudflare Web Analytics.
**Priority:** Medium

### `sw.js` (80 lines)
**Purpose:** offline resilience.
**Assessment:** the strategy split (network-first for code/data, cache-first for images) is correct, and the `safely()` wrapper preventing `respondWith()` rejection is a subtle detail most implementations get wrong.
**Problems:** unbounded cache growth with iOS storage-eviction risk (§3.10). Precaches only `/`, `/css/styles.css`, `/js/main.js` — so a first visit that goes offline before the datasets load has a shell that cannot function. `CACHE = 'worldly-v2'` is hand-versioned, so forgetting to bump it on a strategy change strands users on stale logic.
**Recommendations:** separate bounded caches; precache the core datasets; derive the cache name from a build timestamp.
**Priority:** Medium

### `css/styles.css` (560 lines)
**Purpose:** the entire design system.
**Problems:** `.pill .fire` never matches (§3.4). `.mt-10` duplicated (531, 547). `touch-action: none` duplicated (298, 306). `.card.badge-locked` is dead. No `:focus-visible` for `.btn`/`.card`/`.tab`/`.choice`. No `prefers-color-scheme`. `.q-flag` has no reserved aspect ratio → CLS on every flag question. Utility classes (`.mt-10`…`.mt-18`) are a partial, ad-hoc Tailwind that will keep growing one class at a time.
**Assessment:** for 560 hand-written lines this is disciplined — consistent token use, a real dark/light system, and complete `prefers-reduced-motion` support.
**Recommendations:** add a designed focus ring; add `aspect-ratio` to flag images; deduplicate; formalise spacing as tokens rather than growing the utility list.
**Priority:** Medium

### `functions/api/session/start.js` (76 lines)
**Purpose:** create a server-graded Challenge/Daily session.
**Problems:** broken rate limiter (§3.8). Imports `../../../js/quiz.js` — client/server coupling with no CI guard (§2). Builds the entire quiz pool (156 countries × 18 modes) on **every** request with no caching. No `onRequest` handler, so `GET` returns the HTML 404 page **[measured]**. `expirationTtl: 3600` on sessions means an abandoned session occupies KV for an hour.
**Recommendations:** Rate Limiting binding; cache the built pool at module scope (Workers reuse isolates); add a `405` JSON handler for non-POST.
**Priority:** High

### `functions/api/session/answer.js` (47 lines)
**Purpose:** grade one answer server-side.
**Assessment:** correct. Rejects double-answers (409), unknown question IDs (409), missing sessions (404). Never leaks unanswered answers. Good design.
**Problems:** a full KV read + JSON parse + JSON stringify + KV write **per answer** — 15 round-trips per Challenge run. No rate limiting at all on this endpoint (only `start` is limited). `value` is not type-validated before `value === q.answer`.
**Recommendations:** consider a Durable Object for session state (KV is the wrong primitive for read-modify-write per request); validate `value` is a string.
**Priority:** Medium

### `functions/api/session/finish.js` (51 lines)
**Purpose:** finalise a session, write the score, return the rank.
**Assessment:** correctly requires all questions answered before writing. Parameterised queries. Deletes the session after use.
**Problems:** `COUNT(*) WHERE score > ?` on every completion degrades linearly with table size (§10). No rate limiting. No name moderation (§9.4).
**Priority:** Medium

### `functions/api/xp.js` (51 lines)
**Purpose:** self-reported lifetime XP sync.
**Problems:** see §3.9 — unauthenticated, name-keyed, monotonic, and the default name is shared by every anonymous player. The code comments are honest about the forgeability but not about the `Explorer` collision, which is the bigger problem.
**Priority:** High

### `functions/api/leaderboard.js` (25 lines)
**Purpose:** read top 20 per mode.
**Problems:** no caching — every view hits D1 for data that changes rarely. No `Cache-Control` header. Currently returns `{"entries":[]}` for all three modes **[measured]**.
**Recommendations:** `Cache-Control: public, max-age=60` and/or serve from KV.
**Priority:** Medium

### `tests/engine.test.mjs` (568 lines) + `tests/maps.test.mjs` (221 lines)
**Assessment:** 72 tests, all passing, no dependencies, fast (548 ms) **[measured]**. Well-written and readable.
**Problems:** they test the 25% of the codebase that is already the most reliable. Zero coverage of `main.js`, the Functions, or any DOM behaviour. **Every defect in §3 lives in untested code.**
**Recommendations:** add Playwright E2E covering the six core flows (start quiz → answer → feedback → results; map mode; Flag Key search; theme toggle; export/import; leaderboard load). Add Function tests via `wrangler dev`.
**Priority:** High

### `migrations/0001_leaderboard.sql`, `0002_xp_leaderboard.sql`
**Assessment:** clean, indexed correctly, `CHECK` constraint on `mode`.
**Problems:** `xp_leaderboard.name` as PRIMARY KEY is the root of §3.9. No retention policy on `leaderboard`. No `hidden`/moderation column.
**Priority:** High (a `0003` migration to `playerId` is required)

### `README.md`
**Assessment:** genuinely above-average. Architecture diagram, extension guide, data-model notes, honest editorial disclaimers, credits with correct licence attribution (including the CC BY-NC constraint on the USA map — **note this legally prohibits commercial use of that asset**, which matters for any monetisation in §16).
**Problems:** says 48 tests (actual 72). Documents the manual-deploy footgun clearly but doesn't fix it. Doesn't link `docs/superpowers/`.
**Priority:** Low

---

## 15. Pull-request-style comments

---
**File:** `js/main.js`
**Line:** 1671

**Issue:** Duplicate `class` attribute. The HTML parser discards the second one, so this renders as `class="btn"` and the `.btn.danger` styling never applies. Verified in the live DOM: `border-color: rgb(42,55,93)` (`--border`), not `rgb(248,114,114)` (`--bad`).

**Recommendation:**
```diff
-      <button class="btn" id="resetBtn" class="btn danger">Reset all progress</button>
+      <button class="btn danger" id="resetBtn">Reset all progress</button>
```

**Reasoning:** This is the only irreversible destructive action in the product and it currently carries no visual warning whatsoever. It's also a class of bug that an HTML-aware linter catches for free — which is the real fix. Separately, `confirm()` is a weak guard for permanent data loss; a typed-confirmation modal ("type RESET") is warranted here.

---
**File:** `js/main.js`
**Line:** 1189

**Issue:** Inline `onerror` handler. Your own CSP (`script-src 'self'` with no `unsafe-inline`) blocks it. Reproduced against production — forcing a 404 logs `Executing inline event handler violates the following Content Security Policy directive` and the image stays `display: block`.

**Recommendation:** Delete the attribute; attach the handler after render, reusing the existing pattern:
```js
panel.querySelectorAll('.flagkey-card img').forEach((img) =>
  img.addEventListener('error', () => img.classList.add('hidden')));
```

**Reasoning:** Every other inline handler in this codebase was correctly migrated to `addEventListener` when the CSP was tightened — this one was missed, and now it's dead code that reads like working error handling. The user-visible result is broken-image icons in a screen whose entire purpose is displaying flags. A linter rule banning inline handlers would prevent recurrence.

---
**File:** `js/main.js`
**Line:** 633 (and identically at 692, 740, 904)

**Issue:** `progressPct` is computed from `S.index` *before* the current question is answered, and the header is only rendered when a question renders — never after. Question 1 of 12 shows 0%, and it still shows 0% on the feedback screen. The bar can never reach 100%.

**Recommendation:** Extract a single `renderQuizChrome()` used by all four renderers, compute `(S.index + (S.phase === 'feedback' ? 1 : 0)) / S.total`, and call it from `renderFeedback()` as well.

**Reasoning:** The bug exists in four copies because the header is duplicated four times — this is the clearest argument in the codebase for extracting a quiz-chrome component. Any fix applied to one copy will drift from the other three. Progress feedback is a primary motivation mechanic in a learning product; a bar that reads 0% after you've answered a question reads as broken.

---
**File:** `js/main.js`
**Line:** 1228

**Issue:** No debounce, and the handler rebuilds the entire panel HTML on every keystroke. Measured on production: typing three characters took **1.61 s** with long tasks of 615 ms and 228 ms. Each rebuild also discards and recreates up to 251 `<img>` elements, re-issuing their requests.

**Recommendation:**
```js
let t;
panel.querySelector('.flagkey-search').addEventListener('input', (e) => {
  flagKeySearch[id] = e.target.value;
  clearTimeout(t);
  t = setTimeout(() => filterCardsInPlace(id), 150);  // toggle .hidden, don't rebuild
});
```
Filter by toggling a class on already-rendered cards rather than regenerating the markup — that also removes the focus/selection-restoration hack on lines 1232-1234.

**Reasoning:** This is the worst INP in the app and it's on a screen advertised as having "live search." The current code fights itself: it rebuilds the DOM, then has to manually restore focus and cursor position because it destroyed the input it was reading from. Not rebuilding solves both problems at once.

---
**File:** `js/main.js`
**Line:** 975 (and identically at 1478)

**Issue:** `l.url` is interpolated raw into an `href` while the adjacent label is escaped. Not currently exploitable (URLs come from `learnMoreFor()` and hand-authored JSON), but `data/crises.json` is explicitly documented as accepting community corrections. A `"` breaks out of the attribute; a `javascript:` URL executes on click, and CSP does not block `javascript:` navigations.

**Recommendation:**
```js
const safeUrl = (u) => {
  try {
    const parsed = new URL(u, location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? esc(parsed.href) : '#';
  } catch { return '#'; }
};
```

**Reasoning:** Escaping discipline in this codebase is otherwise excellent — every text interpolation goes through `esc()`. These two `href`s are the only gap, and they sit on exactly the data path you've invited outside contributions to. The structural fix is an `html` tagged template that escapes by default, so the safe path stops depending on remembering.

---
**File:** `functions/api/session/start.js`
**Line:** 34-37 (and `functions/api/xp.js:38-41`)

**Issue:** Read-then-write rate limiting on eventually-consistent KV. Two problems: the read/write pair isn't atomic (N concurrent requests all read the same count and all pass), and KV propagation lag means the counter is stale by design. Cloudflare's documentation explicitly recommends against KV for rate limiting.

**Recommendation:** Use the [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
```toml
[[unsafe.bindings]]
name = "SESSION_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
```
As a same-day stopgap with zero code, add a Cloudflare WAF rate-limiting rule on `/api/*`.

**Reasoning:** These are unauthenticated endpoints that perform a billed KV write and a full quiz-pool build per invocation. The limiter reads as protection but provides none — which is worse than no limiter, because it stops you looking for one. The WAF rule takes fifteen minutes and should go in before this document is finished being read.

---
**File:** `functions/api/xp.js`
**Line:** 43-48 (with `migrations/0002_xp_leaderboard.sql:2`)

**Issue:** `name TEXT PRIMARY KEY` + `ON CONFLICT(name) DO UPDATE SET xp = MAX(...)`. Three compounding problems: (1) any client can submit any name with any XP; (2) `sanitizeName()` defaults to `'Explorer'`, so **every player who never sets a display name shares one row**; (3) `MAX()` makes any poisoned value permanent — no code path can ever lower it.

**Recommendation:** Generate a UUID `playerId` in the profile on first run. Migrate to `playerId TEXT PRIMARY KEY, name TEXT NOT NULL, xp INTEGER, hidden INTEGER DEFAULT 0`. Accept XP *deltas* with a plausibility cap rather than absolute totals.

**Reasoning:** (2) is the one to fix first and it isn't a security issue — it's a product bug that makes the feature meaningless before anyone attacks it. The most likely top entry on the XP leaderboard today is a merged identity representing every anonymous player who ever finished a quiz. (3) turns any future abuse into a permanent, manually-recoverable-only state.

---
**File:** `js/main.js`
**Line:** 645, 703, 758, 918

**Issue:** The question prompt is a `<div>`. Verified on production: the quiz screen contains **zero** heading elements. After answering, a lone `<h3>` appears with no `h1`/`h2` ancestor — a skipped level.

**Recommendation:** `<h1 class="q-prompt">` for the prompt, `<h2>` for the feedback result. `focusTitle()` already targets `.q-prompt`, so focus management is unaffected.

**Reasoning:** This is the screen users spend 95% of their time on and it has no document structure at all. Screen-reader users cannot navigate by heading; the "H" key does nothing. It's a WCAG 1.3.1 / 2.4.6 / 2.4.10 failure and roughly a twenty-minute fix — the best a11y return per minute available in this repo. Given how much correct a11y work is already here (roving tabindex, live regions, keyboard map regions, `.sr-only` announcements), this gap is conspicuous.

---
**File:** `js/mapview.js`
**Line:** 172-193

**Issue:** `regionAt()` calls `isPointInFill()` **and** `getBBox()` on every `path[id]` per click — 256 of each on the world map. `getBBox()` forces synchronous layout, so this is ~256 forced reflows per answer.

**Recommendation:** Compute and cache bbox areas once at mount:
```js
const areas = new WeakMap();
svg.querySelectorAll('path[id]').forEach((el) => {
  const b = el.getBBox();
  areas.set(el, b.width * b.height);
});
```
Then `regionAt()` only calls `isPointInFill()`, reading area from the cache.

**Reasoning:** The smallest-region strategy is the right call and the comment explaining *why* (DC under Maryland, Andorra under France) is exactly the kind of documentation that should exist. The geometry it depends on is static — it can be computed once instead of 256 times per click. This runs on every map answer, on the devices least able to absorb it.

---
**File:** `js/data.js`
**Line:** 31-43

**Issue:** All 11 datasets are fetched before the home screen renders. The home screen needs `achievements.json` and (arguably) `countries.json`. `crises.json` (18.4 KB), `phrases.json` (6.3 KB) and `music.json` (5.9 KB) are downloaded and parsed by every visitor, including the large majority who never open Explore.

**Recommendation:** Split into `loadCore()` and per-screen `loadDataset(name)` — reusing the in-flight-promise caching pattern already implemented correctly for maps at lines 110-121.

**Reasoning:** The correct pattern is already in this file, twenty lines below, complete with cache-poisoning protection on failure. It just wasn't applied to the datasets. This is ~34 KB and the associated parse cost removed from the critical path for a mechanical change.

---

## 16. Feature recommendations

Ranked by expected business impact.

### Tier 1 — unlocks growth

**1. URL routing + pre-rendered content pages.** ~240 indexable pages from data that already exists (§8). This is the only change in this document with a plausible path to 10× traffic. Everything else optimises a funnel that nothing is entering.
*Impact: very high · Effort: 2 days routing + 2 days pre-render*

**2. Shareable daily result (Wordle-style emoji grid).** Already in `ROADMAP.md` and still unbuilt. Wordle's entire growth engine was a copyable grid. You have a Daily Challenge with a deterministic seed — the hard part is done. Add a "Share" button producing `Worldly #412 — 8/10 🟩🟩🟥🟩... playworldly.pages.dev`.
*Impact: very high · Effort: 4 h · **Best effort-to-impact ratio in this document.***

**3. Accounts / cloud sync.** Currently the ceiling on everything: no cross-device, no recovery from the SW eviction risk (§3.10), no email, no push, no cohort analysis, and a leaderboard that can't have stable identities (§3.9). Cloudflare Access or a magic-link flow on D1 avoids a password system entirely.
*Impact: very high · Effort: 3–4 days*

### Tier 2 — retention

**4. Streak calendar + streak-freeze.** Daily streaks are the single strongest retention mechanic in consumer learning apps (Duolingo's core loop). You track `lastDaily` and `dailyCompleted` already but never visualise them, and there's no loss-aversion device.
*Impact: high · Effort: 1 day*

**5. Push/email daily reminder.** Requires (3). The highest-leverage retention lever that exists for a daily-habit product.
*Impact: high · Effort: 1 day after accounts*

**6. Difficulty-adaptive sessions.** You have per-category accuracy and full SRS boxes and use them only for weighting. Auto-tune session composition toward weak areas and surface it ("Today: 60% Africa — your weakest region").
*Impact: high · Effort: 1 day*

**7. Fix the empty leaderboard problem.** Even with traffic, three empty tabs are a dead end. Add seeded/bot baseline scores, weekly resets so the board is always winnable, and friend/private boards.
*Impact: medium-high · Effort: 1 day*

### Tier 3 — depth

**8. Per-country deep-dive pages** (in `ROADMAP.md`). 156 pages combining flag, map position, capital, currency, language, religion, phrases, music, fun fact, history. Doubles as the strongest SEO asset available.
*Impact: high (SEO) · Effort: 2 days after routing*

**9. Landmark-recognition mode** (in `ROADMAP.md`). Needs an image pipeline and licence diligence — Wikimedia Commons has the assets but licences vary per file.
*Impact: medium · Effort: 3 days*

**10. Country → flag (reverse)** and **flag speed-round** (both in `ROADMAP.md`). Small additions to an engine that already supports flag choices via `map_country_flag`.
*Impact: medium · Effort: 4 h each*

### Monetisation
Weak candidates in a market where the closest comparables (Seterra, Worldle) are free.
- **Most viable:** a "Worldly for Classrooms" tier — teacher dashboards, class leaderboards, assignment sets, progress export. Geography teachers are an underserved segment with real budget.
- **Also viable:** one-time "supporter" unlock (custom themes, unlimited custom-study length, offline flag bundle). Low revenue, zero brand damage.
- **Avoid:** ads. They would destroy the load-performance advantage that is currently one of the product's few genuine differentiators.
- ⚠️ **Licence constraint:** `assets/maps/usa.svg` is **CC BY-NC 4.0** (non-commercial). Any commercial offering requires replacing that asset or licensing it. Resolve this *before* building a paid tier, not after.

### Analytics
Current tracking (`track()` calls) fires event names with no properties — you can see *that* a quiz started, never *which mode*, *what score*, or *whether it completed*. Add properties to every event, define a funnel (land → start → Q1 answered → completed → returned D1/D7), and instrument drop-off at each of the abandonment points in §5. Without this, every prioritisation decision after this document is guesswork.

---

## 17. Refactoring roadmap

### Critical

| Item | Impact | Effort | Depends on | Risk | Payoff |
|---|---|---|---|---|---|
| **CI/CD deploy pipeline** (§10) | Removes the tested-≠-deployed gap, gives provenance + rollback | 2 h | Cloudflare API token | Low | Eliminates the largest operational risk in the project |
| **URL routing (History API)** | Unblocks SEO, sharing, Back button, analytics funnels | 2 days | — | Medium (no types; touches every screen) | The gate on ~everything in §16 |
| **Flag Key performance** (§3.5) | 1,610 ms → <200 ms INP; 251 → ~30 requests | 3 h | — | Low | Fixes the worst interaction in the app |
| **Map usability + WCAG 2.5.8** (§7.2) | Makes map modes playable on phones | 4 h | — | Low | Unblocks the flagship feature on the majority platform |
| **Quiz screen headings** (§7.1) | WCAG 1.3.1 / 2.4.6 / 2.4.10 | 20 min | — | None | Best a11y return per minute in the repo |
| **E2E smoke tests** | Coverage for the untested 70% | 1 day | — | Low | Prerequisite for safely doing the routing refactor |

### High

| Item | Impact | Effort | Depends on | Risk | Payoff |
|---|---|---|---|---|---|
| ESLint + Prettier + stylelint + `checkJs` | Converts 3 shipped bugs into build failures | 45 min | — | Low | Compounding |
| Split `main.js` into `screens/` | Makes the codebase contributable | 2 days | E2E tests, routing | Medium | Compounding |
| Real rate limiting (§3.8) | Closes cost-amplification vector | 2 h (15 min WAF stopgap) | — | Low | High |
| `playerId`-keyed leaderboard (§3.9) | Makes the leaderboard mean something | 4 h + migration | — | Medium (data migration) | High |
| Lazy dataset loading (§3.7) | −34 KB off critical path | 2 h | — | Low | Medium |
| Extract `commitAnswer()` + `QuizChrome` | Kills the triplication; fixes §3.1 once | 3 h | — | Low | Compounding |
| `focusTitle()` on boot (§7.3) | Fixes focus order | 30 min | — | None | Medium |
| Bounded SW caches (§3.10) | Prevents catastrophic profile loss | 3 h | — | Low | High (low likelihood, total impact) |

### Medium
Pre-rendered SEO pages (2 days, blocked on routing) · replace Clarity with Cloudflare Web Analytics (2 h) · `safeUrl()` (20 min) · designed focus ring + `:active` states (3 h) · manifest icons 192/512/maskable (1 h) · debounce `saveProfile()` (2 h) · `aspect-ratio` on flag images (30 min) · `Cache-Control` on the leaderboard endpoint (15 min) · CSP hardening + HSTS (15 min) · name moderation (3 h) · error beacon + Workers Analytics (3 h)

### Low
Dedupe CSS · fix `.pill.fire` · `.card.badge-locked` removal · README test count · fix `package.json` scripts · promote `docs/superpowers/` to `docs/design/` · collapse the three identical Commons URL helpers · `CONTRIBUTING.md` / `SECURITY.md` / `.editorconfig` / `.nvmrc` / dependabot

---

## 18. Quick wins (under one hour each)

1. `class="btn danger"` on `#resetBtn` — **2 min** (§3.2)
2. `.pill .fire` → `.pill.fire` — **1 min** (§3.4)
3. `<div class="q-prompt">` → `<h1 class="q-prompt">` ×4 — **20 min** (§7.1)
4. `loading="lazy" decoding="async"` on all `<img>` — **20 min** (§4)
5. `width`/`height`/`aspect-ratio` on `.q-flag` and `.emoji-flag` — kills quiz CLS — **20 min**
6. Render only the active Flag Key tab panel — **30 min** (§3.5)
7. Debounce Flag Key search at 150 ms — **20 min** (§3.5)
8. Delete the inline `onerror`, attach via `addEventListener` — **15 min** (§3.3)
9. `base-uri 'none'; form-action 'self'; frame-ancestors 'none'` + HSTS in `_headers` — **15 min** (§9.7)
10. Cloudflare WAF rate-limiting rule on `/api/*` — **15 min** (§3.8)
11. `<link rel="preconnect" href="https://flagcdn.com">` — **5 min**
12. `<link rel="preload" as="fetch" crossorigin href="/data/countries.json">` — **10 min**
13. Manifest: add 192 + 512 + maskable icons; fix `theme_color` to `#0f1525` — **45 min**
14. `sitemap.xml` (even single-URL) + `Sitemap:` in `robots.txt` — **20 min**
15. `Cache-Control: public, max-age=60` on `/api/leaderboard` — **10 min**
16. Skip `focusTitle()` on initial boot — **10 min** (§7.3)
17. `@media (prefers-color-scheme: light)` default when no stored theme — **30 min**
18. Add `aria-label="Quit quiz"` to the `✕` buttons — **10 min**
19. Fix `package.json` `deploy`/`preview` scripts — **5 min**
20. README: 48 → 72 tests — **1 min**
21. Prettier + `.editorconfig` + `npm run format` — **30 min**
22. Delete `.card.badge-locked`, dedupe `.mt-10` and `touch-action` — **10 min**
23. `lang="${entry.langCode}"` on phrase text — **15 min**
24. Collapse the three identical Commons URL helpers — **15 min**
25. `405` JSON handler for GET on API routes — **20 min**
26. `<noscript>` block with real content in `index.html` — **20 min**
27. `SECURITY.md` + `CONTRIBUTING.md` — **30 min**
28. **`.gitattributes` + `git add --renormalize .` as one isolated commit — 20 min** (§13). Do this *before* any other code PR, so the fix is a single reviewable commit rather than whitespace noise smeared through every future diff.

**Total: roughly one focused day for all 28.** Items 1–10 alone resolve two Critical and four High findings.

---

## 19. The ten highest-leverage changes

| # | Change | Effort | Why it wins |
|---|---|---|---|
| 1 | **CI/CD deploy pipeline** | 2 h | Eliminates the tested-≠-deployed gap. Nothing else in this document is safe to ship repeatedly without it. |
| 2 | **Quick wins 1–10** | 4 h | Two Critical + four High findings, in half a day. |
| 3 | **URL routing** | 2 days | The single structural change. Unblocks SEO, sharing, Back, analytics, and half of §16. |
| 4 | **Shareable daily result** | 4 h | The only cheap organic-growth mechanic available. Wordle's entire engine. |
| 5 | **ESLint + Prettier + `checkJs`** | 45 min | Turns three shipped bugs into build failures, permanently. |
| 6 | **Playwright E2E smoke tests** | 1 day | Coverage for the untested 70%, and the prerequisite for refactoring safely. |
| 7 | **Map zoom-to-fit + hit halos** | 4 h | Makes the flagship feature playable on phones and clears a WCAG 2.2 AA failure. |
| 8 | **Pre-rendered content pages** | 2 days | ~240 indexable pages from data that already exists. |
| 9 | **`playerId` leaderboard + moderation** | 6 h | Makes a feature that currently returns zero rows actually work when traffic arrives. |
| 10 | **Extract `commitAnswer()` + `QuizChrome`** | 3 h | Removes the worst duplication and fixes the progress bar in one place forever. |

**Sequencing note:** 1 → 5 → 2 → 6 → 3 → 4 → 7 → 10 → 8 → 9. Ship the pipeline first, the linter second (so the quick wins land clean), tests before the refactor, growth before scale.

---

## 20. Scorecard

| Category | Score | Rationale |
|---|---:|---|
| **Architecture** | **6/10** | Pure/impure separation is genuinely well done and the client/server engine sharing is smart. A 1,792-line god object and zero routing cap it hard. |
| **Code Quality** | **6/10** | Readable, consistently styled, exceptionally well-commented. Undermined by triplicated logic and three statically-detectable bugs shipped to production. |
| **Maintainability** | **5/10** | Docs and comments are above average; `main.js` and the absence of any linting are below it. Adding a screen means editing three places. |
| **Scalability** | **5/10** | Static tier scales free. Every stateful path (KV limiter, name-keyed leaderboard, unbounded D1) breaks between 10k and 100k. Manual deploy is the real ceiling. |
| **Performance** | **6/10** | World-class cold load (LCP 1.2 s, CLS 0, 161 KB). Interaction cost is failing (1,009 ms long task, 1,610 ms INP). Split verdict. |
| **UX** | **4/10** | Deep, thoughtful content and learning design. No Back button, no CTA hierarchy, unplayable maps on mobile, a lying progress bar. |
| **UI** | **5/10** | Coherent, disciplined, consistent — and entirely generic. Nothing signals "world/culture." No focus ring, no `:active`, no skeletons. |
| **Accessibility** | **6/10** | More genuine effort than most commercial products (roving tabindex, live regions, keyboard SVG regions, complete reduced-motion). Three hard failures pull it down. |
| **SEO** | **3/10** | Meta tags are correct and complete. One indexable page for ~240 pages of content. Correct execution of the wrong scope. |
| **Security** | **7/10** | Strict CSP without `unsafe-inline`, parameterised queries, server-verified scoring, zero dependencies. Broken rate limiter, poisonable leaderboard, two unescaped `href`s. |
| **Developer Experience** | **4/10** | Great README, great comments, genuinely good tests — over 25% of the codebase. No lint, no format, no types, no E2E, no PR flow, no deploy automation. |

### Overall Engineering Grade: **C+ / 5.6 out of 10**

A well-reasoned core wrapped in an unfinished production practice. The distribution is unusual: the *hard* parts (SRS weighting, distractor selection, map hit-testing, CSP, server-verified scoring) are done to a genuinely high standard, and the *routine* parts (linting, routing, deploy automation, error handling, image attributes) are missing entirely. That's the signature of someone who is strong at problem-solving and hasn't yet internalised production hygiene.

### Would I approve this for production?

**As a personal project on a free domain: yes, it's already there.**

**As a company's product: no — pending four blockers.**
1. CI/CD deploy pipeline (the tested artefact and the live artefact are unrelated).
2. URL routing (Back button exits the site; nothing is shareable).
3. Flag Key performance (1.6 s freeze on a documented "live search").
4. Map usability + WCAG 2.5.8 on mobile (30/51 targets under 24 px on the majority platform).

All four are ≤2 days of work. This is a fixable "no," not a structural one.

### Would I hire the engineer based on this repository?

**For a mid-level frontend role: yes, without much hesitation.**

The evidence in favour is specific and hard to fake:
- `geoDistractors()` with a `normalize` hook shows genuine problem decomposition — most people ship random distractors and never notice that "Christianity" vs "Christianity (Catholic)" is unfair.
- `mapview.js`'s smallest-region hit-test identifies and solves a subtle rendering-order bug, with a comment explaining why.
- The `stopPropagation` fix at `mapview.js:229-234` documents a real bug found and fixed properly rather than papered over.
- Ships a strict CSP with no `unsafe-inline` — including doing the work to move every inline style to CSSOM.
- Writes pure, DOM-free, unit-tested logic modules by choice.
- The boot-failure screen detects `file://` and gives exact remediation steps.
- Comments explain *why*, not *what*. Consistently. Across 5,000 lines.

**For a senior role: not yet.** The gaps are the ones seniority is defined by:
- Deploys manually and documents the footgun in the README rather than fixing it.
- 1,792-line file with no test coverage, where every production defect in this audit lives.
- No lint/format/type tooling, when three shipped bugs are statically detectable.
- Knows the rate limiter is on KV, and didn't check whether KV can rate-limit.
- Works directly on `main` with CI configured for PRs that have never run.

The distinguishing trait of a senior engineer isn't solving hard problems — it's making the routine ones impossible to get wrong. This repository shows the first and not yet the second. That's a coaching gap, not a ceiling.

### Engineering maturity level: **Mid-Level**, with clear Senior trajectory

- **Junior?** No. Junior code doesn't produce pure testable engines, injectable RNG for deterministic tests, or a CSP without `unsafe-inline`.
- **Mid-Level?** Yes. Solves hard problems well, structures logic sensibly, writes honest documentation — and hasn't yet built the systems (CI, lint, types, tests-as-a-net) that make quality independent of individual care.
- **Senior?** Not yet, and the gap is narrow and well-defined: automate the deploy, add the linter, test the controller, stop working on `main`. Six weeks of deliberate practice, not six months.

---

## If I became tech lead tomorrow: the first five PRs

### PR #0 — `chore: normalise line endings`
`.gitattributes` with `* text=auto eol=lf`, then `git add --renormalize .` as one isolated commit.

**Why before everything:** on a clean checkout `git status` currently reports all 58 tracked files as modified. Until that's fixed, no diff in any subsequent PR is readable and one `git add -A` permanently destroys `git blame`. Twenty minutes, and it has to be its own commit or it contaminates whatever it's bundled with.

### PR #1 — `ci: deploy from GitHub Actions on green main`
Add `deploy.yml`: test → `wrangler pages deploy . --project-name=playworldly` with `CLOUDFLARE_API_TOKEN` in secrets → tag the deployed commit. Add branch protection on `main` requiring a passing check. Delete the legacy git-connected Worker. Update the README.

**Why first:** right now the tested commit and the deployed artefact have no relationship, there is no record of what's live, and there is no rollback. Every subsequent PR in this list is a change I'd have to hand-deploy from a laptop. This is two hours and it is the highest risk-reduction-per-hour available anywhere in this document. Nothing else should ship before it.

### PR #2 — `chore: eslint, prettier, stylelint, checkJs`
Flat ESLint config with `eslint-plugin-html`, Prettier, stylelint, and a `tsconfig.json` with `checkJs: true` and no emit. Wire all three into CI. Fix the fallout — which includes the duplicate `class`, the inline `onerror`, and `.pill .fire`.

**Why second:** three bugs currently live in production are statically detectable. I want the net in place *before* the quick-win PR, so those fixes land verified rather than by inspection — and so the same class of bug can't come back. Forty-five minutes plus fallout.

### PR #3 — `fix: 10 confirmed defects (a11y, perf, CSP)`
Quick wins 1–10 from §18: quiz headings, `class="btn danger"`, `.pill.fire`, lazy images + dimensions, active-panel-only Flag Key, debounced search, `addEventListener` error handling, CSP hardening, WAF rate-limit rule, `focusTitle()` on boot.

**Why third:** four hours, and it clears two Critical and four High findings including the worst INP in the app (1,610 ms → <200 ms), a WCAG 1.3.1 failure, and the non-functional rate limiter. Highest concentration of user-visible improvement per hour in the entire plan, and with #1 and #2 in place it ships safely and stays fixed.

### PR #4 — `test: playwright e2e for the six core flows`
Cover: start quiz → answer → feedback → results; map mode load and answer; Flag Key search; theme toggle persistence; profile export → import round-trip; leaderboard fetch and error state. Run in CI on every PR. Add a Lighthouse CI budget asserting LCP < 2.0 s and INP < 200 ms.

**Why fourth:** 70% of this application has zero test coverage and I am about to restructure all of it. Doing the routing refactor without an integration net is how a working product becomes a broken one. The performance budget also locks in the genuinely excellent load characteristics so the next feature can't quietly regress them.

### PR #5 — `feat: URL routing (History API)`
Introduce `js/router.js`. Map every screen to a real path: `/`, `/quiz/:mode`, `/map/:mode`, `/explore/crises/:slug`, `/explore/phrases/:country`, `/explore/music/:country`, `/flags/:country`, `/leaderboard`, `/stats`, `/profile`. Wire Back/Forward. Convert navigation from click handlers to real `<a href>` with intercepted clicks. Delete the `homeTab`/`crisesTab`/`flagKeyTab`/`leaderboardTab` globals in favour of URL state. Add `sitemap.xml`.

**Why fifth and not first:** it's the most valuable change in the document and the most dangerous one — it touches every screen in an untyped 1,792-line file. PRs #1–#4 exist to make it survivable. Once it lands: Back works, every screen is shareable, ~240 pages become indexable, analytics gets real funnels, and the daily-result share feature (§16.2) becomes buildable. It is the gate on essentially every growth lever this product has.

**Immediately after:** split `main.js` into `screens/`, pre-render the content pages, then ship the shareable daily grid.

---

*Prepared 2026-07-21. Measurements taken against production at commit `971cae3` using Chromium 1228 at 1440×900 and 390×844. All performance figures are single-run on a warm CDN over a fast connection — real-world numbers on mid-tier mobile hardware will be materially worse, particularly the long-task and INP measurements.*
