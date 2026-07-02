# Similar Flags Mode — Design

**Date:** 2026-07-01
**Status:** Shipped

## Goal

Add a single-topic gamemode that trains the player to distinguish **look-alike
national flags** — the classic confusions like France vs the Netherlands, Belgium
vs Germany, Chad vs Romania, or the five Nordic crosses. It reuses the existing
current-`flag` rendering (flagcdn images via `iso2`) but curates the distractors
so every option is a genuinely confusable flag rather than a random country.

## Decisions

- **Question type:** show one flag, ask which country it belongs to, with the
  other members of the same look-alike group as the wrong answers.
- **Distractors:** always drawn from the *same confusion group*. Groups smaller
  than the choice count top up from the wider pool of look-alike countries — so
  a two-member group like Belgium/Germany still yields four confusable options,
  never a giveaway random country.
- **Teaching moment:** each group carries a `tip` explaining how to tell its
  flags apart; that tip is surfaced as the question's fun fact on the feedback
  screen.
- **Data independence:** the mode ships its own `iso2` list, so it can include
  countries outside the 76-country `countries.json` set (Nordics, Gulf states,
  Central America) without expanding the core dataset.

## Data

New file `data/similar_flags.json` — an array of confusion groups:

```json
{
  "group": "Red-white-blue tricolours",
  "tip": "France is vertical blue-white-red. The Netherlands is horizontal red-white-blue; Luxembourg is the same but longer with a lighter sky-blue; Russia is horizontal white-blue-red.",
  "countries": [
    { "name": "France", "iso2": "FR" },
    { "name": "Netherlands", "iso2": "NL" },
    { "name": "Luxembourg", "iso2": "LU" },
    { "name": "Russia", "iso2": "RU" }
  ]
}
```

- `group` — a human label for the family (not shown to the player directly).
- `tip` — how to distinguish the flags; becomes the fun fact.
- `countries[].name` / `countries[].iso2` — the answer and its flagcdn image key.

Twelve groups ship at launch: red-white-blue tricolours, black-yellow-red
(Belgium/Germany), blue-yellow-red verticals (Chad/Romania/Andorra/Moldova),
green-white-orange (Ireland/Côte d'Ivoire/Italy), red-and-white bicolours
(Indonesia/Monaco/Poland), Nordic crosses, Gran Colombia yellow-blue-red,
Central American blue-white-blue, Arab Liberation red-white-black, West African
green-yellow-red, Pan-Slavic with shields, and the Argentine/Uruguayan
sun-and-stripes.

Loaded in `data.js` alongside the other datasets (one more `loadJSON` in the
`Promise.all`), exposed on the `DATA` singleton as `similarFlags`.

## Engine (`quiz.js`)

- Add mode: `similar_flag: { label: 'Similar Flags', source: 'similar' }`.
- `buildPool`: new `similar` branch — one item per country per group. Each item
  carries `group` (the member names) and a synthesised `source` = the country
  fields plus `funFact` (the group tip) and a generated Wikipedia `wiki` URL.
  Region is `'World'` (groups span continents), so they're exempt from the
  continent filter, matching the religion modes.
- `makeQuestion`: new `similar_flag` case — prompt "These flags all look alike —
  which country is this?", answer = country name, `flagIso` = its `iso2`,
  distractors taken from `item.group`. A dedicated top-up fills short groups from
  the union of all look-alike countries; the mode is marked `selfContained` so it
  never falls back to random countries/capitals.

No new question fields: the mode reuses the existing `flagIso` path, so
`renderMcqQuestion` renders it with zero UI changes.

## UI (`main.js`)

One new card in `MODE_CARDS`:
`{ key: 'similar_flag', emoji: '🎌', title: 'Similar Flags', desc: 'Tell look-alike flags apart (France vs Netherlands…).' }`.

Mixed / Challenge / Daily / Custom all iterate `ALL_MODES`, so the mode joins
them automatically.

## Achievements (`achievements.json`)

Add `flag_detective` — `categoryCorrect` on category `similar_flag`, threshold
20, icon 🎌, "Flag Detective". The generic achievement engine needs no change.

## Tests (`tests/engine.test.mjs`)

Added a synthetic `similarFlags` dataset (a 4-member and a 2-member group) and
assertions that:

1. `buildPool` yields one item per country per group and each item carries its
   full group.
2. The mode ignores the continent filter.
3. `makeQuestion` sets `flagIso` (not `flagImg`), the country as the answer, and
   the answer is among four unique choices.
4. Distractors stay within the same group when it is large enough.
5. A short group tops up only from other look-alike flags — never a plain random
   country.
6. The group `tip` is surfaced as the fun fact.

The `ALL_MODES` pool-count test updates by +6 synthetic items.

## Out of scope (YAGNI)

- Side-by-side "spot the difference" gameplay showing all group flags at once.
- Country → flag (pick the right flag) reverse variant.
- Difficulty tuning specific to this mode (groups are already hard by design).
