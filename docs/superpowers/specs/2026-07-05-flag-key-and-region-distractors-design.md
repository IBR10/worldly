# Flag Key + Region-Aware Distractors — Design

## Context

Two related requests came in together:

1. A browsable reference "key" of territories, their names, and their flags — something players can consult outside quiz mode, separate from any quiz.
2. A quality complaint about existing quizzes: distractor choices are drawn from anywhere in the world, so a question like "which country is Niger?" can be trivially solved by elimination when none of the other three options are even in Africa. The fix should apply to every country-based quiz mode, not just flag identification, and should come with a way to browse/filter the reference key by continent/region — which in turn exposed that the country dataset (76 entries) is too thin in some regions (Africa: 10, Oceania: 4) to make region-based distractors meaningful, so the dataset needs to grow first.

These four pieces are interdependent (the data expansion feeds both the distractor quality and the Flag Key's usefulness) but have different risk profiles and testing needs, so this spec sequences them as build-order phases within one initiative rather than one flat feature list.

## Phase 1 — Country data expansion (76 → ~150-160)

**Goal:** every region has enough countries that region/subregion-based distractor selection (Phase 2) has real variety to draw from, and the Flag Key (Phase 3) is a genuinely useful reference.

**Target growth, by current region counts** (Asia 23, Europe 22, N. America 8, S. America 9, Africa 10, Oceania 4 = 76 today):
- Africa: 10 → 35+ (biggest gap — only ~1/5 of African sovereign states represented today)
- Oceania: 4 → 14+ (currently only the largest few Pacific nations)
- Asia, Europe, Americas: moderate top-ups to fill obvious well-known gaps
- Total target: **~150-160 countries**, not the full ~195 UN-recognized states — deliberately stopping short of full coverage to keep the fact-checking burden bounded (each new country needs a genuinely correct capital/language/religion/fun fact, and going further has diminishing returns for quiz variety while raising factual-dispute surface area).

**Schema:** unchanged — every new record uses the exact fields already in `data/countries.json`: `name, iso2, capital, region, subregion, population, language, religion, currency, funFact, wiki`, plus the optional `note` field (already used for Israel/Jerusalem) for any new entry whose capital or other fact is genuinely contested.

**Quality bar:** same standard already applied to the existing 76 — capitals are well-established, low-ambiguity public facts; "primary language" and "largest religion" carry the same inherent simplification already disclosed in the About screen (no new disclosure needed, just more entries under an existing, already-stated caveat). `subregion` values should be granular enough to power Phase 2 (e.g. "West Africa", "East Africa", "Southern Africa", "North Africa" within the Africa region, not just one flat "Africa" subregion for everything).

**Out of scope:** reaching full ~195 sovereign-state coverage (left as a possible future pass, per ROADMAP.md's existing "Expand country set" item, which this satisfies partially).

## Phase 2 — Region-aware distractor selection

**Goal:** wrong-answer choices for any country-based question are drawn preferentially from nearby countries, so questions can't be solved by "which of these is even in the right part of the world."

**Algorithm** (new pure function in `js/quiz.js`, alongside the existing `sampleDistinct`):
1. Try to fill distractors from countries sharing the target's **`subregion`** (excluding the answer itself).
2. If that pool has fewer than `choices - 1` candidates, top up from the target's **`region`**.
3. If still short (only possible for extremely sparse categories), top up from the **global** country pool as a last resort — this guarantees every question always has enough choices, matching the existing "top-up" pattern already used by similar-flags' distractor logic.

**Scope:** applies uniformly to every country-based MCQ mode that currently draws distractors from the country list — capital, country (capital→country), language, religion, and flag. All five key off the same `countries.json` records, so one shared helper covers all of them; no per-mode special-casing needed.

**Non-goals:** this does not change US/Mexico state modes (their region field already scopes them nationally, no cross-country proximity concept applies) or non-country modes (historic flags, similar flags, world religions topics), which keep their existing distractor logic untouched.

**Testing:** extend `tests/engine.test.mjs` with cases asserting: (a) distractors for a country with subregion-mates available are drawn from that subregion, (b) a country in a sparse subregion correctly falls back to region-mates, (c) the absolute-sparsest case still returns the full requested choice count via global fallback, (d) existing "no duplicate/no self-answer" invariants still hold.

## Phase 3 — Flag Key screen

**Placement:** a new card ("Flag Key" or similar working title) under the existing **Explore** tab, alongside Phrases/Music/Crises — no new top-level home tab.

**Navigation:** three sub-tabs reusing the existing `wireTabs()` helper (already used by Home and Crises): **Countries / US States / Mexican States**. Each sub-tab independently has:
- A text search box, filtering the current sub-tab's visible cards live on every keystroke (plain client-side filter — 150-160+50+32 ≈ 240 entries total is trivial to filter with no indexing/debouncing needed).
- A single-select region/continent dropdown (a plain `<select>`, matching the existing World Religions faith-picker pattern — not the multi-select checkboxes Custom Study uses for continents), populated from that sub-tab's own dataset (`region` for countries = continent; `region` for US states = existing US-region taxonomy; `region` for Mexican states = existing Mexican-region taxonomy) — reuses the same `getContinents()`-style pattern already used by Custom Study, generalized to also work for the two state datasets. Default option is "All".
- Search and region-filter combine (AND) when both are set.

**Entry content:** flag image + name (bold) + capital (muted subtitle) — reuses the existing `.card`/`.emoji-flag` markup already used by Phrases/Music. **No detail/drill-down screen** — everything needed fits on the card itself, tapping does nothing (flat reference list, not a browse-then-detail pattern).

## Phase 4 — State flag data (Wikimedia Commons)

**Data model:** add a `"flag"` field (a Wikimedia Commons filename, e.g. `"Flag of Texas.svg"`) to every record in `data/us_states.json` (50 entries) and `data/mexico_states.json` (32 entries) — the same shape as `historic_flags.json`'s existing `img` field.

**Helper:** new `stateFlagUrl(filename)` in `js/data.js`, built identically to the existing `historicFlagUrl()` (a stable `commons.wikimedia.org/wiki/Special:FilePath/...` URL, percent-encoded, fixed width param).

**Quality bar:** every one of the 82 filenames must be validated to actually resolve (HTTP 200 via `Special:FilePath`) before this ships — same validation discipline already applied to the 34 historic flags and 46 music YouTube IDs earlier in this project's history.

**Out of scope:** this phase only supplies flag *images* for the Flag Key reference screen. It does **not** add new quiz modes (e.g. "identify the US state from its flag") — that would be a separate future feature if ever wanted, not implied by this request.

## Verification (for the eventual implementation pass)
- `npm test` stays green throughout, with new Phase 2 test cases passing.
- After Phase 1: spot-check a sample of new country records (capital/region/subregion) against reference sources; confirm region/subregion counts meet the stated targets.
- After Phase 2: a manual/scripted check that repeated question generation for a known sparse-subregion country (e.g. a small Pacific nation) still always returns a full, non-duplicate, correct-inclusive choice set.
- After Phase 4: a validation script curl-checking all 82 new Commons URLs, mirroring the existing historic-flag/music validation approach used earlier this session.
- After Phase 3: a live browser pass exercising all three Flag Key sub-tabs, the search box, and the region dropdown (including combining both filters at once), on both the local dev server and the deployed production site.
