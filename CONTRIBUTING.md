# Contributing to Worldly

Corrections to the data are the most useful contribution — everything lives in
`data/*.json` and needs no code changes.

## Running it

Browsers block `fetch()` on `file://`, so serve the folder over HTTP:

```bash
npm start                 # python3 -m http.server 8000
```

To exercise the API routes (`/api/*`) you need the Functions runtime and a
local database:

```bash
for f in migrations/*.sql; do
  npx wrangler d1 execute worldly-leaderboard --local --file="$f"
done
npm run preview           # wrangler pages dev .
```

## Checks

```bash
npm run lint              # eslint + stylelint
npm run test:ci           # 72 engine tests, plain node --test
npm run test:e2e          # 37 browser tests (needs: npx playwright install chromium)
```

All three run in CI on every pull request. Merging to `main` deploys.

## Data changes

Append to the relevant file in `data/` — a new record joins every relevant mode
automatically. Keep facts sourced from public reference data (Wikipedia, CIA
World Factbook), and add a `note` for anything contested.

**Link fields matter for security.** Anything rendered into an `href` goes
through `safeUrl()` (`js/main.js`), which allows only `http(s)`. The CSP does
not block `javascript:` URLs on navigation, so that check is the control —
please don't route around it.

## Code conventions

- No build step, and no runtime dependencies. The browser loads ES modules
  directly. Please keep it that way.
- Game rules are pure functions (`js/quiz.js`, `js/srs.js`, `js/maps.js`) with
  no DOM access, so they can be tested under plain Node. `functions/api/` imports
  `js/quiz.js` directly, so a browser global added there breaks the leaderboard
  at runtime.
- All interpolated text goes through `esc()`. Markup lives in template
  literals, which ESLint cannot inspect — the structural assertions in
  `tests/e2e/screens.spec.js` are what catch duplicate attributes, heading-order
  regressions and inline event handlers.
- No inline `style=` or `on*=` attributes: the CSP has no `unsafe-inline`, so
  they silently do nothing. Set styles via CSSOM and events via
  `addEventListener`.

## Adding things

- **A country / state / song / crisis** — append to the relevant JSON file.
- **An achievement** — add a definition to `data/achievements.json`; a new
  `type` needs one case in `progressFor()` (`js/achievements.js`).
- **A quiz mode** — an entry in `MODES` plus a `case` in `makeQuestion()`
  (`js/quiz.js`), then a card in `MODE_CARDS` (`js/main.js`).
