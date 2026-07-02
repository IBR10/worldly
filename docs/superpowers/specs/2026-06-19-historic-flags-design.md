# Historic Flags Mode — Design

**Date:** 2026-06-19
**Status:** Approved

## Goal

Add a new single-topic gamemode to Worldly: show a historical flag (a former
nation, empire, or pre-redesign national flag) and ask the player which
nation/entity flew it. It mirrors the existing current-`flag` mode end to end,
reusing the multiple-choice engine.

## Decisions (from brainstorming)

- **Question type:** Identify the nation/empire from a historical flag.
- **Image source:** Hotlink Wikimedia Commons via the stable `Special:FilePath`
  endpoint (no fragile hashed URLs). All filenames verified to resolve (HTTP 200)
  before shipping.
- **Scope:** ~35 curated historic flags spanning empires, former states, and
  pre-redesign national flags.
- **Excluded for sensitivity:** Nazi-era and Confederate flags are intentionally
  omitted (legal/display concerns and tone for a casual learning game). The
  German Empire (1871–1918) covers historic Germany instead.

## Data

New file `data/historic_flags.json` — array of entries:

```json
{
  "name": "Soviet Union",
  "img": "Flag of the Soviet Union.svg",
  "era": "1922–1991",
  "region": "Europe",
  "funFact": "…",
  "wiki": "https://en.wikipedia.org/wiki/Soviet_Union"
}
```

- `name` — the correct answer (the entity).
- `img` — exact Wikimedia Commons filename (used by `Special:FilePath`).
- `era` — shown in feedback for context.
- `region` — reuses the existing continent buckets (Asia/Europe/Africa/North
  America/South America) so per-region stats and the `hard` distractor grouping
  work, and historic answers contribute to existing region achievements.
- `funFact`, `wiki` — same shape used elsewhere.

Loaded in `data.js` alongside the other datasets (one more `loadJSON` in the
`Promise.all`), exposed on the `DATA` singleton as `historicFlags`.

## Image hotlinking

New helper in `data.js`:

```js
export function historicFlagUrl(filename, width = 320) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=${width}`;
}
```

`Special:FilePath` 302-redirects to the current upload; `?width=` returns a
rasterized thumbnail (works for both SVG and raster sources).

## Engine (`quiz.js`)

- Add mode: `historic_flag: { label: 'Historic Flags', source: 'historic' }`.
- `buildPool`: new `historic` branch — one item per `data.historicFlags` entry,
  `id` = `historic_flag:<name>`, carrying `region` and `source`.
- `makeQuestion`: new `historic_flag` case:
  - prompt: `"Which nation flew this flag?"`
  - answer: entity `name`.
  - distractors: drawn from **other historic entity names** (coherent options).
    `hard` difficulty prefers same-region entities; tops up from the full
    historic set if a region is short.
  - sets `flagSrc` (full Wikimedia URL via `historicFlagUrl`) instead of
    `flagIso`.
  - `learnMore`: Wikipedia only (these are not current countries, so no World
    Factbook link). Achieved by passing `isCountry = false`.

Questions gain one new optional field: `flagSrc` (string URL). Existing modes
leave it `null`.

## UI (`main.js`)

- One new card in `MODE_CARDS`:
  `{ key: 'historic_flag', emoji: '🏴', title: 'Historic Flags', desc: 'Identify the nation from a flag of the past.' }`.
- `renderMcqQuestion`: image `src` becomes `q.flagSrc || (q.flagIso && flagUrl(q.flagIso))`.
- Because Mixed / Challenge / Daily / Custom all iterate `ALL_MODES`, the mode
  joins them automatically.

## Achievements (`achievements.json`)

Add one: `history_buff` — `categoryCorrect` on category `historic_flag`,
threshold 15, icon 🏴, "History Buff". The generic achievement engine needs no
code change.

## Tests (`tests/engine.test.mjs`)

TDD — add to the synthetic dataset a small `historicFlags` array and assert:

1. `buildPool` includes one item per historic flag when the mode is enabled.
2. `makeQuestion` for `historic_flag` sets `flagSrc` (a Wikimedia URL), sets
   `flagIso` null, answer is the entity name, and the correct answer is among
   the choices.
3. Distractors are other historic entity names (not country names).
4. `learnMore` has Wikipedia but **not** World Factbook.

Existing suite must stay green (the `ALL_MODES` count test updates by +1 mode).

## Out of scope (YAGNI)

- Chronological-ordering gameplay.
- Bundling images locally / offline play for this mode.
- A dedicated "history" region bucket or separate stats screen.
