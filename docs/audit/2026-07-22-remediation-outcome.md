# Worldly — Remediation Outcome & Audit Errata

**Date:** 2026-07-22
**Covers:** `bdfc0fa..f7d7c17` — PRs [#4](https://github.com/IBR10/worldly/pull/4), [#5](https://github.com/IBR10/worldly/pull/5), [#6](https://github.com/IBR10/worldly/pull/6), [#7](https://github.com/IBR10/worldly/pull/7)
**Companion to:** [`2026-07-21-technical-due-diligence.md`](2026-07-21-technical-due-diligence.md)

The audit document has deliberately **not** been edited to hide its mistakes. An audit that quietly rewrites itself after the fact is worth nothing — you can no longer tell which of its claims were verified and which were guesses that happened to survive. Corrections live here, and §1 comes first for that reason.

**Scope note.** The owner scoped remediation to *correctness, free-tier survival and cheap wins*, explicitly excluding URL routing, SEO pre-rendering and any restructuring of `main.js`. §4 lists what that left on the table.

---

## 1. Errata — where the audit was wrong

### E1. §3.6 "Map hit-testing is O(regions) with a forced layout per region — **High**" → **withdrawn**

The audit claimed `regionAt()` calls `getBBox()` on every one of ~256 paths per click, forcing ~256 synchronous layouts, and recommended a bbox cache (§4 ROI table, row 5, "2 h").

**This is false.** `getBBox()` sits behind `if (!inside) continue` — it runs only for paths that actually contain the click point, which is 1–3. The audit read the loop body and did not read the guard above it.

Measured on the live world map: `isPointInFill` × 51 regions = **0.38 ms**. There was no bottleneck.

The recommended fix would also have been worthless independent of the bug being real: each question mounts a *fresh* map view, and a question takes one click. A bbox cache would be built and thrown away once per question, never read twice.

**Action taken: none.** The correct response to a finding that doesn't reproduce is to delete it, not to ship a change that makes the number look addressed.

### E2. §3.8 / §18 quick win #10 — "Cloudflare WAF rate-limiting rule on `/api/*` — 15 min" → **unimplementable**

WAF rate-limiting rules apply to **a zone you own**. `playworldly.pages.dev` sits in Cloudflare's `pages.dev` zone, not the owner's. There is no zone to attach a rule to, and `ratelimits` is not among the bindings available to Pages Functions.

The audit recommended a control that cannot be purchased, configured or enabled on this deployment, and costed it at 15 minutes.

**Action taken:** the limiter was fixed *in code* — a single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` against D1, which is what the original KV read-then-write should have been.

### E3. §11 / §18 / "PR #2" — "three shipped bugs are statically detectable" → **overstated**

The audit asserted that ESLint + stylelint + `checkJs` would have caught the duplicate `class` attribute, the CSP-dead inline `onerror`, and the never-matching `.pill .fire`, and built its recommended PR ordering around putting the linter in *before* the defect fixes so they would "land verified".

They would not have. Every piece of markup in this codebase lives inside a JavaScript template literal, which ESLint parses as an opaque string. And no CSS linter can know whether `.pill .fire` matches any markup, because the markup is in another file, in a string.

What the linters actually caught, once added: the duplicate `.mt-10` and the duplicate `touch-action` — **two cosmetic smells, and zero of the three shipped bugs.**

**Action taken:** the recurrence prevention came from somewhere else — a DOM-level structural audit (`tests/e2e/helpers/html-audit.js`) that runs on every rendered screen and asserts no duplicate attributes, no inline `on*=` handlers, exactly one `h1`, and no skipped heading levels. This needed a hand-written tokenizer, because `outerHTML` cannot expose the bug either: the HTML parser discards the duplicate `class` attribute before it reaches the DOM, so the serialized markup looks correct.

The linters were still worth adding. They were not worth the claim the audit made for them.

### E4. What the audit missed entirely: the free tier was the real deadline

§3.8 criticised the KV rate limiter for being non-atomic — a correctness argument, graded High. That was right and far too small.

The audit reviewed the code and never checked the platform's limits. Cloudflare KV Free allows **1,000 writes/day** and **1 write/second/key**. A single 15-question Challenge run cost ~18 KV writes:

| Path | Writes |
|---|---|
| `session/start` — rate-limit + session | 2 |
| `session/answer` — session, × 15 questions | 15 |
| `xp` — rate limit, on every quiz finish | 1 |

That is **~55 Challenge runs per day, site-wide**, before writes begin failing. The leaderboard was empty, so nothing had broken yet — it would have broken on the first day of real traffic, which is the worst possible time to discover it.

Worse, the **1 write/sec/key** cap applied to `session:{uuid}`, written on every answer. A player using the number-key shortcuts could answer two questions inside one second → KV 429 → Function 500 → the client's catch → **the question scored wrong**, plus a "Connection lost" toast. The platform was penalising exactly the fast play Challenge mode exists to reward.

This was the single largest omission in the audit, and it was structural: I audited the repository and not the deployment target. A finding graded "High" for atomicity was actually a ship-blocker for capacity, and the two have nothing to do with each other.

**Action taken:** session and rate-limit state moved to D1 (100,000 row writes/day, no per-key rate cap). A Challenge run now costs 21 row writes → **~4,700 runs/day**, an ~85× increase in free-tier headroom, and the fast-player scoring bug is gone.

### E5. A regression introduced by the remediation itself

The audit's own quick win #12 was written correctly:

> `<link rel="preload" as="fetch" crossorigin href="/data/countries.json">`

The remediation plan then contradicted it, confidently and wrongly:

> **No `crossorigin` attribute** — the actual request is same-origin non-CORS, and adding it would cause a duplicate download.

This is backwards. `as="fetch"` **always** uses CORS mode, same-origin or not, so without `crossorigin` the preload and the later `fetch()` are two different requests. Shipping it caused precisely the duplicate download the comment claimed to prevent: `countries.json` was fetched twice, 2 × ~18.8 KB, on every cold load.

It survived review because the request *count* looks the same either way — a consumed preload also produces two resource-timing entries. Only `transferSize` distinguishes "served from the preload" (0 bytes) from "downloaded again" (18,874 bytes). The first verification script I wrote to check this had a bug that reported `downloaded=0` against data plainly showing two 18 KB transfers; I caught it only by reading the raw entries instead of trusting my own summary line.

**Action taken:** fixed in PR #6. `countries.json` now transfers exactly once — re-verified on production today at 18,874 bytes, one download.

---

## 2. Finding-by-finding status

### §3 — Code quality

| # | Finding | Severity | Status |
|---|---|---|---|
| 3.1 | Progress bar off-by-one, never updates | High | **Fixed.** `quizChrome()` extracted (replaced 4 duplicated headers); `syncQuizProgress()` called from `renderFeedback()`. The plan's proposed formula was itself wrong — `S.index` increments *before* `renderFeedback` runs, so `+1` for the feedback phase double-counted. The real bug was never the formula; it was that nothing re-rendered the bar. |
| 3.2 | Duplicate `class` attribute on the reset button | Medium | **Fixed.** Now `class="btn danger"`. |
| 3.3 | Inline `onerror` blocked by own CSP | Medium | **Fixed.** `addEventListener('error')` adding `.hidden`, not the full-width `wireFlagFallback()` message — correct for one quiz flag, wrong for a grid cell. |
| 3.4 | `.pill .fire` never matches | Low | **Fixed.** `.pill.fire`. |
| 3.5 | Flag Key: 251 images, no lazy-load, 1 s long tasks | Critical (perf) | **Fixed.** Active panel only; `loading="lazy" decoding="async"`; filtering toggles `.hidden` on rendered cards instead of rebuilding. No debounce added — with no rebuild it measured unnecessary, and adding one would have made it feel *less* responsive. |
| 3.6 | Map hit-test forced layouts | High | **Withdrawn — see E1.** Not a defect. No change made. |
| 3.7 | Eleven datasets fetched before first render | High | **Fixed.** `loadData()` (8 core) + `loadDataset()` on demand for phrases/music/crises, sharing the in-flight-promise cache. |
| 3.8 | KV rate limiter does not rate limit | High | **Fixed, and rescoped — see E2, E4.** Atomic D1 upsert. Proven: 60 concurrent `session/start` → 18 accepted, 42 rejected. The old limiter passed all 60. |
| 3.9 | Leaderboard unauthenticated, name-keyed, monotonic | High | **Fixed (identity).** UUID `playerId` in the profile, `xp_leaderboard` re-keyed on it. Proven: two players both named "Ada" now hold separate rows (900, 500) instead of collapsing into one. Moderation is **not** done — see §4. |
| 3.10 | Service worker cache grows without bound | Medium→High | **Fixed (PR #7).** Split into a bounded shell cache and a capped image cache (300 entries, FIFO). See §3. |
| 3.11 | `homeCard()` unescaped interpolation | — | **Fixed.** |
| 3.11 | Raw `l.url` into `href` (also §9.1) | Medium | **Fixed.** `safeUrl()` allow-lists `http:`/`https:` via `new URL()`, else `#`. |
| 3.11 | Duplicate `.mt-10`, duplicate `touch-action`, dead `.card.badge-locked` | — | **Fixed.** |
| 3.11 | README "48 tests" | — | **Fixed** — and now accurate at 72 + 37 E2E. |
| 3.11 | `package.json` `deploy`/`preview` are Workers commands | — | **Fixed.** |
| 3.11 | Analytics loads unconditionally | Medium | **Fixed** — see §9.5 below. |
| 3.11 | Dropped connection scores the question wrong | — | **Partly fixed.** The run now degrades to a local engine with an honest toast, and the feedback screen no longer crashes on missing fields. The *current* question is still recorded as incorrect. |
| 3.11 | `.flagkey-card` is a `div.card` that isn't interactive | — | **Open.** Cosmetic; no user-visible effect. |
| 3.11 | Three identical Commons URL helpers | — | **Open.** Deliberate: collapsing them is churn with no behaviour change. |

### §7 — Accessibility

| Finding | Status |
|---|---|
| 7.1 Quiz screens have zero headings (1.3.1, 2.4.6, 2.4.10) | **Fixed.** `h1.q-prompt`, feedback demoted to `h2`. Asserted in E2E on every screen. |
| 7.2 Map targets 3.5×4.8 px (2.5.8 AA) | **Improved, not cleared.** Double-tap-to-zoom + a visible hint; the frame no longer wastes half its area. 21/51 → 41/51 US states clear 24 px after one double-tap. At rest, the smallest still fail. |
| 7.3 Focus on boot lands mid-page (2.4.3) | **Fixed.** `focusTitle()` no-ops on first render only. |
| 7.4 `role="status"` + `aria-live="assertive"` | **Fixed.** `role="status"` alone. |
| 7.4 `div[role=button]` brand | **Fixed.** Real `<button>`; hand-rolled key handling deleted. |
| 7.4 No `:focus-visible` ring | **Fixed.** |
| 7.4 No skip link | **Fixed.** First focusable element. |
| 7.4 `✕` has no accessible name | **Fixed.** One `aria-label="Quit quiz"` — one, not four, because the chrome is now a single component. |
| 7.4 No `lang` on foreign-language phrases | **Fixed.** `localText()` tags BCP-47. |
| 7.4 Competing live regions | **Open.** Low. |
| §4 baseline — 11px mobile horizontal scroll (`scrollWidth 401` vs `clientWidth 390`) | **Fixed.** The top bar's fixed padding + gaps left no room for the third 44px icon button once the level chip's 120px XP bar was in the row; the button spilled 11px past the viewport on *every* screen. Tightened bar spacing and narrowed the decorative XP bar on small screens — no control hidden, no touch target shrunk. Verified 0 overflow from 320px to 430px. |

### §9 — Security

| Finding | Status |
|---|---|
| 9.1 Unescaped URL into `href` | **Fixed** (`safeUrl()`). |
| 9.2 Rate limiting non-functional | **Fixed** (E2). |
| 9.3 Leaderboard forgeable/poisonable | **Partly fixed** — identity yes, moderation no. |
| 9.4 No display-name moderation | **Open.** A `hidden` column exists and `/api/leaderboard` filters on it, so a bad row *can* be suppressed — by hand, via `wrangler d1 execute`. No blocklist, no reporting, no admin UI. |
| 9.5 Analytics loads before any consent gate | **Fixed.** Gated on `navigator.globalPrivacyControl`, `navigator.doNotTrack` and a stored opt-out, with a toggle in Profile. Clarity kept, per the owner's decision; the About copy now says session replay rather than implying event counting. |
| 9.6 CSP violation on every load | **Open by design.** Clarity's Bing ad-sync pixel is still blocked, and still logs. Widening `img-src` to silence it would be trading a working control for a quiet console. It is the only console error on the site. |
| 9.7 CSP hardening | **Fixed.** `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, plus HSTS. |

### §13 / §11 — Configuration and developer experience

| Finding | Status |
|---|---|
| Line endings: all 58 tracked files permanently "modified" | **Fixed.** `.gitattributes`, no content rewrite needed — the index was already LF. |
| Manual deploy; tested commit ≠ deployed artefact | **Fixed.** `deploy.yml` deploys `main` after tests, with a `deploy-production` concurrency group. |
| CI configured for PRs that had never run | **Fixed.** Lint + 72 unit + 37 E2E on every PR; artefacts on failure. Four PRs have now run through it. |
| No lint / format / types | **Partly.** ESLint (flat) + stylelint added. Prettier and `checkJs` deliberately skipped: reformatting 5,000 lines destroys `git blame` for no defect caught, and `checkJs` on untyped code produces noise that gets suppressed rather than fixed. |
| No `SECURITY.md` / `CONTRIBUTING.md` / `.nvmrc` | **Fixed.** |
| Quick win #26 — `<noscript>` | **Fixed (PR #7).** The page was previously blank without JS. |
| Quick win #14 — `sitemap.xml` | **Dropped, deliberately.** With routing out of scope the site has exactly one URL. A one-entry sitemap tells Google nothing it cannot already see. Revisit with routing. |
| Quick win #13 — 192/512/maskable icons | **Blocked.** No Pillow, no pip, no ImageMagick in this environment. Upscaling the 256 px source produces a blurry icon, and labelling a non-maskable icon `maskable` makes Android crop into the artwork. Both are worse than shipping one honest 256 px icon. |

---

## 3. Measured outcome

### Deterministic — re-verified against production today (`f7d7c17`)

| Metric | Before | Now |
|---|---:|---:|
| Cold-load requests | 32 | **28** |
| Cold-load transfer | 161 KB | **131 KB** |
| CLS | 0.000 | **0.000** |
| `countries.json` downloads per cold load | 1 (2 after PR #4's regression) | **1** (18,874 B) |
| Console errors | 2 | **1** (Clarity's Bing pixel, blocked as designed) |
| Flag Key images on open | 251 | **40** |
| US states ≥ 24 px, after one double-tap | 21/51 | **41/51** |
| Mobile map frame wasted | 48% | **~0%** |
| Mobile horizontal overflow (320–430px) | 11 px @ 390px | **0 px** |
| Challenge runs/day within the free tier | ~55 | **~4,700** |
| Tests | 72 unit, 0 browser | **72 unit + 37 browser** |

### Timing — measured 2026-07-21/22 on an idle machine

| Metric | Before | After |
|---|---:|---:|
| LCP | 1,228 ms | **896 ms** |
| Flag Key longest task | 1,009 ms | **111 ms** |
| Type 3 characters into Flag Key search | 1,610 ms | **580 ms** |

These are **not** re-measured in the table above, and the distinction is deliberate. Today's host is at load average 9+, and two back-to-back runs against identical content returned LCP 23,596 ms and 4,132 ms. Timing numbers taken under that contention would be fiction. The byte counts, request counts, CLS and image counts are content-derived, were identical across both runs, and are safe to publish.

Note also that the search figure **missed its stated target** of < 200 ms. 580 ms is a 2.8× improvement and it is not a pass.

### PR #7 — the service-worker cache cap, verified rather than assumed

The FIFO invariant, in a real Chromium `CacheStorage`:

```
seededInOrder: true    seededCount: 340    afterCount: 300
oldestKept: /probe/0040    newestKept: /probe/0339
afterTwiceCount: 300    readDidNotReorder: true
```

`Cache.keys()` returns insertion order, trimming is idempotent, and a re-read does not reorder — this is FIFO, not LRU, and the code says so rather than implying otherwise.

End-to-end on production, seeded past the cap and then driven through three real browsing waves:

```
seeded          : { total: 340, synthetic: 340 }
after wave 1    : { total: 339, synthetic: 300 }
after wave 2    : { total: 300, synthetic: 261 }
after wave 3    : { total: 300, synthetic: 261 }
```

It converges to the cap and holds there, evicting oldest-first, rather than merely being smaller once. The old single `worldly-v2` cache is gone, which also clears existing players' accumulated bloat exactly once.

Why this one mattered more than its "Medium" label: on iOS Safari, exceeding the origin quota evicts *the whole origin's storage*, `localStorage` included — and `localStorage` holds the only copy of the player's XP, streaks, achievements and SRS boxes, with no account to restore from. An unbounded image cache put a player's entire progress behind an eviction policy nobody here controlled.

---

## 4. Still open

Ranked by value, with the reason each is still open stated plainly.

1. **URL routing.** Excluded by the owner's scope decision. Still the single highest-value change available: Back currently exits the site, nothing is shareable, ~240 pages of existing content remain unindexable, and analytics has no funnels. Everything in the audit's §16 growth section is gated behind it.
2. **Leaderboard moderation (§9.4).** Identity is fixed; a slur or an impersonation still requires a manual `wrangler d1 execute` to remove. Rises to High the day the site gets traffic.
3. **PWA icons (§18 #13).** Environment-blocked, not deferred. `scripts/make_icon.py` already renders at 1024 px supersample — this is a small job on any machine with Pillow.
4. **Map target size at rest (§7.2).** Improved and still not a WCAG 2.5.8 pass without a deliberate zoom. A genuine fix is zoom-to-fit plus transparent stroke halos, verified visually across all four SVGs — its own change, not a defect fix.
5. **`commitAnswer()` extraction (§17).** Deliberately deferred. Pure refactor, no user-visible benefit; with the E2E net now green it is finally safe to do.
6. **Dropped-connection question still scored wrong (§3.11).** Partly addressed; the honest fix is to not record the answer at all and re-ask locally.
7. **SEO pre-rendering (§8).** Excluded by scope, and gated on item 1 anyway.

### Owner actions this work cannot do for you

- **Rotate the Cloudflare API token.** It was pasted into a chat transcript. It was never committed — verified with `git log --all -S` and a working-tree grep — and the staging file was deleted, but it must be treated as public. Update the repo secret through the **GitHub web UI**: `gh secret set` under a non-interactive shell reads empty stdin and silently blanks the secret, which already happened once here and produced a deploy with an empty token.
- **Delete the legacy git-connected Cloudflare Worker.** Its "Workers Builds" check fails on every PR. All four PRs above needed `--admin` to merge past it, which means branch protection cannot be turned on until it is gone.
- **Delete the `SESSIONS_KV` namespace.** Unreferenced since PR #4.

---

## 5. Revised scorecard

| Category | Was | Now | Why it moved |
|---|---:|---:|---|
| Architecture | 6 | **6** | Unchanged, honestly. `main.js` is still a 1,900-line god object and there is still no routing. Extracting `quizChrome()` and splitting data loading are real, and they are not architecture. |
| Code Quality | 6 | **7.5** | Every statically-shipped defect is gone and verified by a test that fails if it returns. Held back by the surviving triplication in the scoring path. |
| Maintainability | 5 | **6.5** | Lint, a browser suite and a green CI gate now exist. Adding a screen still means editing three places. |
| Scalability | 5 | **7** | The ~85× free-tier headroom increase and an actually-atomic limiter. Still one D1 with no archival strategy, and moderation is manual. |
| Performance | 6 | **8** | Cold load improved rather than merely surviving; the worst interaction went 1,009 ms → 111 ms. Not a 9: the search target was missed, and there is no automated budget guarding regressions. |
| UX | 4 | **5.5** | Progress bar honest, map playable, Explore screens load on demand, no-JS page exists. Still no Back button — the largest single UX defect is untouched by design. |
| UI | 5 | **5.5** | Focus rings and a fixed flag box. Still entirely generic; nothing signals "world/culture". |
| Accessibility | 6 | **8** | Headings, skip link, focus order, focus ring, accessible names, `lang` tagging — and structural assertions that fail CI if they regress. Not higher while 2.5.8 needs a deliberate zoom. |
| SEO | 3 | **3.5** | Only the `<noscript>` content moved. One indexable page for ~240 pages of content, by decision. |
| Security | 7 | **8.5** | `safeUrl()`, atomic limiter, per-player identity, CSP hardening, HSTS, a consent gate. Not 9 while display names are unmoderated. |
| Developer Experience | 4 | **8** | The largest single move: automated deploy on green `main`, PR-gated lint + 109 tests, `.gitattributes`, `SECURITY.md`, `CONTRIBUTING.md`, `.nvmrc`. Held back by the legacy Worker check that still blocks branch protection. |

### Revised grade: **B / 6.7** (was C+ / 5.6)

The distribution has changed shape, not just magnitude. The audit's core criticism was that the hard parts were done well and the routine parts were missing entirely. The routine parts are now largely present — deploy automation, a test net, lint, hygiene files, a working rate limiter. What remains is a *structural* gap (no routing, one god object) rather than a hygiene gap, and structural gaps are the honest kind to still have.

### Would I approve this for production now?

The audit named four blockers. Three are cleared: the CI/CD gap, Flag Key performance, and map usability (improved to playable, though 2.5.8 still needs a deliberate zoom). **URL routing remains**, and it remains a genuine blocker for anything with a growth or sharing requirement — but it is now the only one, and it is a feature gap rather than a defect.

**As a personal project: comfortably yes.** **As a company's product: yes for a soft launch, with routing as the next sprint.**

### Does the hiring assessment change?

Partly, and the honest answer is that this document is weak evidence for it — the remediation was not done by the repository's author. What it does establish is that the gaps the audit identified were real, addressable, and correctly located: every fix landed roughly where the audit said it would, in roughly the time it estimated, except the two the audit got wrong.

The audit's original read — *strong at hard problems, hasn't yet internalised production hygiene, six weeks of deliberate practice rather than six months* — is unchanged, and §1 of this document is the more useful artefact for the author to read than §5.

---

## 6. Process notes

Four things worth keeping from how this went.

**Measure before you fix, and be willing to delete the finding.** §3.6 was a High-severity performance finding with a plausible mechanism and a costed fix. It took one measurement (0.38 ms) to establish there was nothing there. Shipping the bbox cache would have added code, added a cache-invalidation surface, and improved nothing — while letting everyone believe a "High" had been addressed.

**Verify the fix, not the diff.** PR #4's preload looked correct in review, matched a plausible mental model, and doubled a download in production. What caught it was reading `transferSize` on the actual resource-timing entries. Three separate summaries of that same data — including one I wrote — said the opposite of what the raw numbers said.

**Check the platform, not only the code.** The largest finding in this whole exercise (E4) was invisible from the repository. Nothing in the source is wrong; KV is used correctly. It was the *free-tier quota* that made the design unshippable, and no amount of code review would have surfaced it.

**Set budgets after measuring, not before.** The Flag Key test was initially written asserting `< 60` images. The real number after the fix was 76 in that measurement window. The budget was corrected to 110 with a comment explaining the window — rather than contorting the code to hit a number that had been guessed rather than derived.

---

*Prepared 2026-07-22 against production at `f7d7c17`. Deterministic metrics re-verified today; timing metrics carried forward from the 2026-07-21/22 measurements and labelled as such, because today's host was too contended to produce honest numbers.*
