# Worldly — Culture, Greetings & Language Maps

Status: Approved — 2026-09-05

Branch: `feat/culture-language-maps` (off `main` @ `ad13e79`)

## Context

Worldly today teaches *facts about* places — capitals, flags, languages as quiz
answers. What it can't do is prepare you for the moment you actually meet
someone: greet them in their language, then say something true and interesting
about where they're from.

Two concrete gaps drive this work:

1. **`data/crises.json` is stale and mislabeled.** All 12 "current" entries claim
   `asOf: "July 2026"`, but the prose only covers events through late 2024 /
   early 2025 (newest in-text reference is a bare `2025`). The label is making a
   promise the content doesn't keep.
2. **There is no path from "a country" to "how to talk to someone from it."**
   `data/phrases.json` covers 16 of 250 map regions. `countries.json` has a
   single `language` string per country and nothing about people, history you
   could mention, or customs. Nothing renders a colored map — `mapview.js` can
   only highlight one region at a time.

Intended outcome: open Worldly, see the world colored by what people actually
speak, tap any country to hear its greeting, and open a page that gives you five
famous people, a few pivotal events, and enough cultural grounding to hold a
conversation. Every country, not a curated 16.

Decisions already made with the user:
- **Coverage: all ~195 sovereign states, full depth** (greeting + 5 people +
  events + culture notes each). Territories get greeting-level data so the map
  has no holes.
- **Events: web-researched**, not refreshed from model knowledge.
- **No portrait images** — text-only people entries. Keeps CSP, `sw.js` image
  cap, and licensing untouched.

## Ground rules (from the existing codebase)

These are conventions the implementation must follow, verified in the repo:

- No build step, no runtime deps. Screens are template strings assigned to
  `app.innerHTML`; **every interpolation goes through `esc()`** (`js/main.js:63`)
  and every href through `safeUrl()` (`js/main.js:70`).
- CSP has no `unsafe-inline`: **no inline `style=` or `on*=` attributes.** Styles
  via CSS classes or CSSOM, events via `addEventListener`.
- Pure logic lives in DOM-free modules (`js/quiz.js`, `js/srs.js`, `js/maps.js`)
  and is unit-tested under plain `node --test`. DOM code is covered by Playwright.
- New datasets register in `LAZY_FILES` (`js/data.js:63`) and load via
  `loadDataset()` / the `ensureDataset()` guard (`js/main.js:950`) — **never** in
  the eager `loadData()` path.
- New browser globals must be added to `browserGlobals` in `eslint.config.js`.
  (This plan needs none.)
- `css/styles.css` is one hand-written file with `no-duplicate-selectors` — append
  new selectors once, never reopen an existing one. All colors come from the
  `[data-theme="dark"]` / `[data-theme="light"]` token blocks (`css/styles.css:14-51`);
  never a literal hex in a component rule.
- No new external hosts → **no `_headers` change, no `sw.js` change.** New routes
  and new `data/*.json` need neither (SPA fallback + `networkFirst`).

Step 1 of implementation: copy this plan to
`docs/superpowers/specs/2026-09-05-culture-and-language-maps-design.md` and
commit, matching the repo's existing spec convention (`docs/superpowers/specs/`).

---

## Phase 1 — Refresh world events (`data/crises.json`)

Do this first, as the user asked. 24 entries: 12 current (6 famous, 6
underreported), 12 historical.

1. Web-research each of the 12 **current** entries for developments since early
   2025 through today (2026-09-05). Use WebSearch/WebFetch; prefer ReliefWeb,
   UN OCHA, Wikipedia, major wire services.
2. For each: rewrite the summary paragraphs so the *latest* paragraph describes
   the situation as of now, and set `asOf: "September 2026"`. Keep the existing
   3–5-paragraph shape and the `links` array (`Wikipedia` / `ReliefWeb` /
   `Latest news`).
3. **Retire what has resolved.** If a situation has genuinely ended, move the
   entry to `period: "historical"` — swap `asOf` for `era`, retarget `links` to
   Wikipedia/Britannica. Do not delete entries.
4. **Add newly significant situations** so each current tier still has ≥6 entries,
   using the same schema and researched sources.
5. `title` is the URL key — `slugify(title)` drives `/crises/:slug`
   (`js/main.js:432`). **Do not reword existing titles**; that silently breaks
   shared links. New entries only.
6. Surface freshness on the list screen: in `showCrises()` (`js/main.js:1603`),
   derive the newest `asOf` among current entries and render it as a
   `.muted-note` line ("Current entries reviewed September 2026"). Derive it —
   don't add a metadata object; the file is a bare array that `.map()` walks.
7. Add a `note` field for anything contested, per `CONTRIBUTING.md`.

Files: `data/crises.json`, `js/main.js` (one added line in `showCrises`).

---

## Phase 2 — Complete the country set (156 → ~197)

The choropleth makes this non-optional: 94 of 250 map regions currently have no
`countries.json` entry, and 41 of those are sovereign states — Azerbaijan,
Belarus, Bosnia and Herzegovina, Cyprus, Bahrain, Burundi, Brunei, Malta,
Moldova, Montenegro, Mauritania, Mauritius, Maldives, Liberia, Lesotho, Syria,
South Sudan, Tajikistan, Timor-Leste, Eswatini, Republic of Congo, Cape Verde,
Comoros, Equatorial Guinea, Guinea-Bissau, São Tomé and Príncipe, Seychelles,
the six Caribbean microstates, the five European microstates, Kosovo, Taiwan.
Grey holes over Belarus and Syria would read as a bug.

This is also an explicit ROADMAP item ("full ~195 coverage remains a future
stretch goal").

- Append 41 entries to `data/countries.json` using the exact existing 12-key
  schema (`name, iso2, capital, region, subregion, population, language,
  religion, currency, funFact, history, wiki`), keyed to the world.svg `id`
  (lowercase ISO 3166-1 alpha-2). Add `note` for contested cases (Kosovo,
  Taiwan, Western Sahara).
- `region` must be one of the six existing values: `Asia`, `Europe`, `Africa`,
  `North America`, `South America`, `Oceania`. Match `subregion` values to
  existing neighbors.

**Known side effect, called out deliberately:** `countries.json` feeds every
quiz mode, the SRS pool, region distractor tiering and Flag Key. 41 new
countries make those modes harder and broader. That's desirable and on the
roadmap, but it must be verified, not assumed — see Verification.

---

## Phase 3 — Language choropleth (`/languages`)

### 3a. New dataset: `data/greetings.json`

One entry per world.svg region (~250, including territories), so the map has no
unexplained holes. Registered in `LAZY_FILES` as `greetings`.

```json
{
  "iso2": "JP",
  "name": "Japan",
  "language": "Japanese",
  "family": "japonic",
  "langCode": "ja-JP",
  "hello": "こんにちは",
  "pron": "kon-nee-chee-wah",
  "literal": "Good day",
  "alsoTry": [
    { "en": "Thank you", "local": "ありがとう", "pron": "ah-ree-gah-toh" },
    { "en": "Goodbye",   "local": "さようなら", "pron": "sah-yoh-nah-rah" }
  ],
  "greetingNote": "A slight bow, not a handshake."
}
```

- `iso2` is the join key everywhere (uppercase in data, lowercased to match SVG
  ids — the same convention as `regionIdFor()` in `js/maps.js:61`).
- `langCode` is BCP-47 and is what drives TTS. `phrases.json` is the only
  existing source of these; extend the pattern.
- `pron` follows the existing `phrases.json` convention: plain romanization for
  Latin-script languages, `Romanized (sim-ple-FON-etic)` for others, so
  `phoneticOf()` (`js/main.js:128`) can extract the TTS fallback.
- The ~8 uninhabited regions (Bouvet, Heard, French Southern & Antarctic Lands,
  South Georgia, Glorioso, Juan de Nova, Norfolk-adjacent specks) get
  `"family": "none"` and no `hello`.
- `family` is a closed enum of ~17 values (`romance`, `germanic`, `slavic`,
  `indo-iranian`, `other-indo-european`, `afro-asiatic`, `niger-congo`,
  `nilo-saharan`, `turkic`, `sino-tibetan`, `austronesian`, `austroasiatic`,
  `dravidian`, `japonic`, `koreanic`, `uralic`, `kra-dai`, `creole`, `other`,
  `none`). Enforced by the data-integrity test.

### 3b. New pure module: `js/languages.js`

DOM-free and fetch-free, so it unit-tests under `node --test` like `js/maps.js`.

```js
export const FAMILY_BUCKETS   // 12 display buckets + 'none', ordered
export function bucketForFamily(family)      // 17 enum values -> 12 buckets
export function familyLegend(rows)           // [{ key, label, className, count }]
export function topLanguages(rows, n = 10)   // by country count, ties by name
export function languageLegend(rows, n = 10) // top n + 'Other' + 'No data'
export function regionClassesFor(rows, mode) // { 'jp': 'lf-japonic', ... }
```

Why bucketing: `countries.json` has 92 distinct `language` strings across 156
countries, **82 of them singletons** — a color per language is unreadable. The
default view colors by the 12 largest families (Sino-Tibetan keeps its own color
so China isn't dumped into "Other"); the second view colors by the top 10
individual languages + Other. Both stay at or under 13 swatches.

`bucketForFamily` also absorbs the data-quality wrinkles the exploration found:
`"Chadian Arabic"` groups with Arabic, `"Dari"` with Persian, and country names
mistakenly used as language values (`"Nauru"`, `"Kiribati"`) get corrected in the
data rather than special-cased in code.

### 3c. `js/mapview.js` — three additive changes

`createMapView` (`js/mapview.js:19`) today highlights exactly one region and
latches after the first pick (`let answered = !interactive;` at `:218`). All three
changes are opt-in and must leave the quiz behavior byte-identical.

1. **`regionClasses` option** — `{ [svgId]: cssClassName }`, applied in the
   injection block alongside the existing `highlightId` handling (`:51-59`).
2. **`repeat: true` option** — when set, don't latch `answered` after `onPick`
   (`:180`, `:257`), so a browsing map can be clicked repeatedly. Default stays
   `false`; `reveal()` still latches unconditionally.
3. **`paint(classMap)` on the returned object** — clears previously applied
   `lf-*` classes and applies a new set, so the family/language toggle doesn't
   remount the 1.18 MB SVG.

Return shape becomes `{ el, reveal, paint }`.

### 3d. CSS: coloring by class, not by CSSOM

Append to `css/styles.css`. One class per bucket, colors defined as tokens in
**both** `[data-theme]` blocks (never a hex in the component rule).

```css
/* Must come AFTER `.map-svg path:hover` (styles.css:396) — equal specificity,
   later rule wins, so a painted fill survives hover. Hover feedback on a
   choropleth is restored by .map-choropleth below, which does not touch fill. */
.map-svg path.lf-romance { fill: var(--lf-romance); stroke: var(--lf-romance); }
/* …one per bucket, plus .lf-nodata using var(--surface-2) */

.map-svg.map-choropleth path:hover { filter: brightness(1.22); stroke: var(--text); stroke-width: 1.2; }
.map-svg.map-choropleth { transition: none; }   /* no 250-path fill animation on first paint */
```

Legend swatches reuse the same `.lf-*` classes inside a new `.map-legend` /
`.legend-item` / `.legend-swatch` component.

**Before choosing the 12 colors, load the `dataviz` skill** and validate the
categorical palette for contrast in both themes — the palette must be checked,
not eyeballed.

### 3e. The screen

- Route `{ path: '/languages', title: 'Language Map — Worldly', render: showLanguageMap }`
  in the table at `js/main.js:2032`.
- Home card in `journeyCards` (`js/main.js:320`): `{ key: 'languages', emoji: '🗺️', title: 'Language Map', desc: 'See what the world actually speaks.' }`,
  plus `languages: '/languages'` in `GO_ROUTES` (`js/main.js:386`).
- Render: `topNav()` → `h1` → two-tab `.tabs` group (`By family` / `By language`)
  driven by `wireTabs()` with module-level state (the `crisesTab` idiom) → map
  mount → legend → back row.
- Load with `ensureDataset('greetings')` then `await loadMap('world')`, copying
  the `sessionGen` staleness guard from `startMapQuiz` (`js/main.js:694-712`) so a
  slow 394 KB (gzipped) SVG fetch can't hijack a screen the user navigated away from.
- Mount `createMapView({ svgText, regionClasses, repeat: true, onPick })`;
  `onPick(id)` navigates to `/country/<slug>`.
- Tab switch calls `view.paint(...)` and swaps the legend — no remount.

---

## Phase 4 — Say Hello map (`/hello`)

Same world SVG, same dataset, different interaction: click a country and the
greeting appears below the map, with TTS.

- Route `/hello`, home card `{ key: 'hello', emoji: '👋', title: 'Say Hello', desc: 'Tap any country to learn its greeting.' }`.
- `createMapView({ svgText, repeat: true, onPick })` with a neutral fill (no
  `regionClasses`), so this map reads as a picker rather than a chart.
- On pick, render into a `#helloPanel` below the map (do **not** re-render the
  screen — that would remount the SVG and lose the zoom):
  flag (`flagUrl(iso2, 'w160')`), country name, language, `hello` in native
  script via `localText(hello, langCode)`, the `🔊` button via
  `speakBtn(hello, langCode, phoneticOf(pron))`, the `pron`, the `literal`
  gloss, the `alsoTry` rows in a `.phrase-list`, the `greetingNote` in a
  `.callout`, and a link through to `/country/:slug`.
- Reuse `speak()` / `pickVoice()` / `phoneticOf()` verbatim (`js/main.js:80-128`).
  Rebind `[data-speak]` listeners after each panel render.
- Announce the selection in an `aria-live="polite"` region so keyboard and screen
  reader users get the greeting, matching the `.sr-only` pattern `mapview.js`
  already uses for highlights.
- Fallback: a searchable country `<select>` above the map, so the feature works
  without hunting for Andorra on a touch screen.

---

## Phase 5 — Country culture pages (`/country`, `/country/:slug`)

### 5a. Data: `data/culture/<region>.json` — six files

Split by the six `region` values, not one file. Rationale: ~197 full-depth
entries is ~440 KB of hand-authored JSON; six files keep the largest single
fetch to ~110 KB (~28 KB gzipped), let each authoring batch be one reviewable
commit, and let the UI ship working before every region is written.

Register six `LAZY_FILES` keys (`culture-africa`, `culture-asia`,
`culture-europe`, `culture-north-america`, `culture-south-america`,
`culture-oceania`) and add `ensureCulture(country)` in `main.js` that maps
`country.region` → key and delegates to the existing `ensureDataset()`.

```json
{
  "iso2": "JP",
  "people": [
    { "name": "Katsushika Hokusai", "native": "葛飾北斎", "years": "1760–1849",
      "field": "Artist",
      "why": "His print The Great Wave off Kanagawa is the most reproduced image in Japanese art.",
      "wiki": "https://en.wikipedia.org/wiki/Hokusai" }
  ],
  "events": [
    { "year": "1868", "title": "Meiji Restoration",
      "what": "Ended 250 years of shogun rule and began Japan's rapid industrialization.",
      "wiki": "https://en.wikipedia.org/wiki/Meiji_Restoration" }
  ],
  "culture": [
    { "icon": "🍜", "label": "Food",      "text": "…" },
    { "icon": "🎎", "label": "Festival",  "text": "…" },
    { "icon": "🙇", "label": "Etiquette", "text": "…" },
    { "icon": "⚾", "label": "Sport",     "text": "…" },
    { "icon": "🎨", "label": "Arts",      "text": "…" }
  ],
  "talkAbout": ["…", "…", "…"],
  "avoid": "…",
  "note": "…"
}
```

Content contract, enforced by the data-integrity test: **exactly 5 `people`**,
**3–5 `events`**, **4–6 `culture`** rows, **exactly 3 `talkAbout`**, `avoid`
present, every `wiki` an `https://` URL. `people[].why` and `events[].what` are
one sentence each — the point is something you could actually say out loud, not
an encyclopedia entry.

`avoid` is the sensitivity field: the one subject a visitor should not open
with. Written factually and without editorializing (e.g. "The 1994 genocide is
taught and commemorated openly, but it is not small talk"), and it earns a
`note` where contested.

**Author region by region, one commit per region, in this order:** Europe →
Asia → Africa → North America → South America → Oceania. Sourced from public
reference data (Wikipedia, Britannica, CIA World Factbook) per `CONTRIBUTING.md`.

### 5b. Index screen `/country`

197 pages need a browsable index. This is exactly `showFlagKey()`
(`js/main.js:1314-1424`) — copy its architecture, don't invent one:

- Controls rendered up front; the grid built once by `populate()` on first show.
- Live search + region `<select>` filter implemented as `.hidden` class toggles
  over `data-name` / `data-region` attributes on already-rendered cards — **never
  a rebuild** (rebuilding 197 `<img>` per keystroke is the exact regression the
  Flag Key comments and the 1200 ms typing budget in
  `tests/e2e/flagkey.spec.js` exist to prevent).
- Cards: `loading="lazy" decoding="async"`, fixed CSS box, `error` listener that
  adds `.hidden` (no inline `onerror` — the CSP kills it).
- Card subtitle shows the greeting, so the index is itself useful.

### 5c. Detail screen `/country/:slug`

Follows `routeCrisisDetail` / `renderCrisisDetail` exactly
(`js/main.js:432-455`, `1669-1701`):

- `{ path: '/country/:slug', render: (p) => routeCountryDetail(p.slug) }`.
- Resolve by re-slugifying the country name (`slugify(c.name) === slug`), the
  established pattern — no slug is stored. Miss →
  `navigate('/country', { replace: true })`. Set `document.title` in the route fn.
- **Slug decision, fixed now because it becomes a public URL:** slug by country
  *name* (`/country/japan`), consistent with `/crises/:slug` and `/phrases/:slug`.
  The six known `countries.json`↔SVG name disagreements (Czechia, Ivory Coast,
  Laos, North Macedonia, Palestine, DR Congo) resolve via `countries.json`, which
  is the naming authority — the SVG `aria-label` is never used for display.
- Layout, reusing existing components:
  - `.phrase-head` + `.phrase-flag` header (the de-facto generic detail header)
  - **Greeting block** — `hello`, `pron`, `🔊`, `literal`, `greetingNote`
  - **Fast facts** — `.stat-grid` of capital / population / currency / language /
    religion from `countries.json`
  - **5 famous people** — new `.people-list` / `.person` rows (name, native
    script, years, field, one-line why, Wikipedia link). Text-only; a
    `.person-initials` circle stands in for a portrait.
  - **Notable events** — `.track-list`-style rows keyed by year
  - **Culture** — `.culture-grid` of icon + label + text
  - **Talk about this** — `.callout` with the 3 starters
  - **Tread carefully** — `.callout` with `avoid`
  - `.crisis-body` prose for `funFact` / `history`, `.learn-more` for `wiki`
  - `.muted-note` for `note` when present
- Cross-links: → `/hello`, → `/languages`, and → `/phrases/:slug` when that
  country is one of the 16 with a full phrase set.
- **Graceful degradation while regions are unwritten:** if `culture/<region>`
  has no entry for the country, still render the header, greeting and fast facts,
  and show a `.callout` saying the deep dive is still being written. The screen
  must never 404 on a country that exists in `countries.json`.

### 5d. Note on `js/main.js` size

`js/main.js` is 2075 lines and the 2026-07-21 audit already flags it. These
screens add ~350 lines of markup and wiring. All *logic* goes into the DOM-free
`js/languages.js` (and a small `js/culture.js` for slug/region resolution) so the
growth is presentation only. Extracting shared render helpers (`esc`, `topNav`,
`wireTabs`, `speak`, …) into a `js/ui.js` would enable moving screens out of
`main.js`, but that refactor touches all 15 existing screens and does not belong
in a content feature — record it as a follow-up.

---

## Phase 6 — Tests

**Unit (`node --test`, DOM-free, synthetic inline fixtures — the house style):**
- `tests/languages.test.mjs` — `bucketForFamily` (all 17 enum values + unknown →
  `other`), `topLanguages` (ordering, tie-break, `n` clamping), `familyLegend` /
  `languageLegend` (counts, `Other`/`No data` placement), `regionClassesFor`
  (uppercase→lowercase iso2, `none` → `lf-nodata`, unknown id dropped).
- `tests/culture.test.mjs` — region→dataset-key mapping, slug resolution
  including the six name-disagreement countries and a percent-encoded slug.

**Data integrity (`tests/data-integrity.test.mjs`) — a deliberate, documented
departure from "unit tests never read `data/`.**  With ~197 hand-authored
entries and zero JSON schema validation anywhere in CI, this is the highest-value
test in the feature. Reads the real files with `node:fs` (no fetch, no DOM, so it
still runs under plain `node --test`) and asserts:
- every `countries.json` `iso2` has a `world.svg` path; every populated
  `world.svg` path has a `greetings.json` entry
- `iso2` unique across each file; `slugify(name)` unique across `countries.json`
- every `greetings.json` `family` is in the enum; every inhabited entry has
  `hello`, `pron`, `langCode`; `langCode` matches `/^[a-z]{2}(-[A-Za-z]{2,4})?$/`
- the culture content contract (5 people, 3–5 events, 4–6 culture rows, 3
  talkAbout, `avoid` present)
- every `wiki`/`url` is `https://` (so `safeUrl()` never has to degrade to `#`)
- every `crises.json` current entry has `asOf`, every historical entry has `era`

Written so it passes with regions not yet authored (assert only over entries
present), then tightened to full coverage in the final commit.

**E2E (Playwright):**
- Add three rows to the `SCREENS` table in `tests/e2e/screens.spec.js:25` —
  `{ label: 'language map', tab: /Explore/, card: /Language Map/ }`, `Say Hello`,
  `Country Guides`. This is the project's contract for a new screen and buys the
  duplicate-attribute / inline-handler / heading-order audit for free.
- New `tests/e2e/culture.spec.js`:
  - `/languages` paints: `.map-svg path[class*="lf-"]` count > 150; legend
    item count matches swatch count; switching to the language tab changes the
    classes without a new SVG request (`page.route` counter on `world.svg`)
  - `/hello`: click a known path (`#fr`) → panel shows the greeting and a
    `[data-speak]` button; click a second country → panel updates (proves
    `repeat: true`) and the SVG was not refetched
  - `/country`: typing three characters filters in < 1200 ms and issues no new
    image requests (mirroring the `flagkey.spec.js` budget)
  - `/country/japan` deep link renders 5 `.person` rows; a country with no
    culture entry still renders header + greeting and does not redirect
- `tests/e2e/routing.spec.js`: deep link + Back for `/languages`, `/hello`,
  `/country`, `/country/:slug`; unknown slug redirects to `/country`.

---

## Verification

Run exactly what CI runs, and confirm the output rather than assuming it:

```bash
cd /mnt/c/Users/isaac/Documents/GitHub/worldly
npm run lint          # eslint + stylelint
npm run test:ci       # unit tests — expect 80 existing + ~35 new to pass
npm run test:e2e      # Playwright (npx playwright install chromium first)
npm start             # http://localhost:8000
```

Manual pass in the browser, in **both themes** (`🌙` toggle) and at a narrow
viewport:

1. `/crises` — freshness line reads September 2026; open 3 current entries and
   confirm the newest paragraph describes 2026, and that every existing
   `/crises/:slug` link still resolves (titles unchanged).
2. `/languages` — no unexplained grey over inhabited land; legend matches the
   painted colors; hover still gives feedback on a painted country; toggle
   family↔language repaints without a visible reload; click a country → lands on
   its page.
3. `/hello` — click five countries in a row (proves the latch is lifted); 🔊
   speaks; zoom into Europe, pick Andorra and Liechtenstein (proves
   smallest-region hit-testing still works with fills applied); confirm the
   panel updates without resetting the zoom.
4. `/country` — search and region filter; `/country/japan` shows all sections.
5. **Regression check on Phase 2's blast radius:** run a Mixed quiz, a Flag quiz
   and the click-the-country map and confirm the 41 new countries appear as both
   answers and distractors; re-open Flag Key and confirm
   `tests/e2e/flagkey.spec.js`'s `imageRequests < 110` budget still holds with
   197 countries (it relies on `loading="lazy"`, so it should — verify, don't
   assume). Confirm a stored profile from before the change still loads (SRS
   boxes are keyed by item id).
6. DevTools Network: `world.svg` fetched once per map screen; `greetings.json`
   and one `culture/*.json` fetched on demand, never on the home screen.
7. Keyboard-only pass on `/hello`: tab to a country, Enter, confirm the greeting
   is announced.

Deploy is automatic on merge to `main` (`.github/workflows/deploy.yml`).

## Out of scope (YAGNI)

- Portrait images (decided: text-only — keeps CSP, `sw.js` image cap and
  licensing untouched).
- Quiz modes built on the new data ("which country is this person from?",
  culture/food quiz). Natural follow-up; the ROADMAP already lists a
  cultural-quiz mode. Not part of this change.
- New achievements for exploring culture pages.
- Audio pronunciation files (CSP has no `media-src`; TTS already covers it).
- Extracting shared render helpers into `js/ui.js`.
- Expanding `phrases.json` beyond 16 countries — `greetings.json` supersedes it
  for breadth; the two cross-link.

## ROADMAP updates on completion

Tick "Per-country deep-dive study pages", tick "Expand country set … full ~195
coverage", and add the two new map modes under Interactive maps.
