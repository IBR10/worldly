# Worldly 🌍

A polished, no-build geography & **cultural-awareness** learning game. The goal
isn't just memorising capitals — it's building global literacy: languages,
religions, regions, flags and the stories behind them, reinforced with **active
recall** and **spaced repetition** so it actually sticks.

Pure HTML/CSS/vanilla-JS (ES modules). No framework, no build step, no backend.
All progress is saved locally in your browser. Host it anywhere static
(GitHub Pages, Netlify, an S3 bucket) or just run a local server.

![home screen](assets/screenshot-home.png)

## Quick start

Browsers block `fetch()` on `file://`, so serve the folder over HTTP:

```bash
cd Worldly
python3 -m http.server 8000     # or:  npm start
# open http://localhost:8000
```

Run the engine tests:

```bash
npm test        # node --test over tests/*.test.mjs  (11 tests, no deps)
```

## Game modes

| Mode | Question |
|------|----------|
| **Country → Capital** | "What is the capital of Japan?" |
| **Capital → Country** | "Which country has the capital Tokyo?" |
| **Country → Largest Religion** | "What is the largest religion in Indonesia?" |
| **Country → Primary Language** | "What is the most widely spoken language in Brazil?" |
| **US States → Capitals** | "What is the capital of Colorado?" |
| **Mexico States → Capitals** | "What is the capital of Jalisco?" |
| **Flag Mode** | Identify the country from its flag |
| **Historic Flags** | Identify the nation from a flag of the past |
| **Similar Flags** | Tell look-alike flags apart (e.g. France vs Netherlands, Belgium vs Germany) |
| **Mixed** | All of the above, shuffled |
| **Challenge** | Timed, with a streak-based score multiplier |
| **Daily Challenge** | A fixed 10-question set, identical for everyone each day |
| **Custom Study** | Choose your own modes, continents, difficulty & length |
| **Review Missed** | Practise only the questions you've gotten wrong |

## Learning design

- **Every correct answer teaches something.** Feedback shows a fun fact plus
  *Learn More* links (Wikipedia, CIA World Factbook, a culture guide).
- **Spaced repetition.** A Leitner-box scheme (`js/srs.js`) tracks each item.
  Forgotten and missed items resurface far more often; mastered items get an
  occasional refresh. New items keep a solid baseline weight so coverage stays
  broad.
- **Weak-area tracking.** Misses go into a review pool keyed by item; the Stats
  screen surfaces your most-missed questions and per-category / per-region
  accuracy.
- **Gamification that rewards learning, not grinding.** XP with a level curve,
  current/best streaks, 18 achievements (Capital Master, Language Expert,
  Geography Wizard, region masters, …), and a local leaderboard.

## Architecture

No build tooling — the browser loads ES modules directly. Logic is split so the
game rules are testable in plain Node, independent of the DOM.

```
Worldly/
├── index.html              # shell: top bar, #app mount, toasts
├── css/styles.css          # themeable design system (dark + light)
├── js/
│   ├── data.js             # loads JSON datasets; flag URLs; continents
│   ├── state.js            # localStorage profile: XP, streaks, stats, SRS, achievements
│   ├── srs.js              # pure Leitner spaced-repetition picker
│   ├── quiz.js             # pure question-generation engine (all modes)
│   ├── achievements.js     # achievement evaluation against the profile
│   └── main.js             # controller: routing, rendering, quiz session
├── data/
│   ├── countries.json      # 76 countries, all continents
│   ├── us_states.json      # all 50 US states
│   ├── mexico_states.json  # all 32 Mexican states
│   └── achievements.json   # achievement definitions
└── tests/engine.test.mjs   # 11 Node tests for quiz.js + srs.js
```

**Why vanilla / no-build?** It maximises longevity and portability — there's
nothing to `npm install`, no transpiler to age out, and it deploys as plain
static files. The separation of *pure logic* (`quiz.js`, `srs.js`) from
*rendering* (`main.js`) keeps the core unit-testable.

### Data model

`countries.json` records carry: `name, iso2, capital, region, subregion,
population, language, religion, currency, funFact, wiki`. State files carry
`name, capital, region, funFact, wiki`. Flags are rendered on demand from
[flagcdn.com](https://flagcdn.com) using the ISO-3166 `iso2` code (no API key).

The player profile lives in `localStorage` under `worldly_profile_v1`.

## Data sources & accuracy

Country/state facts (capitals, languages, dominant religion, fun facts) are
curated from public reference data (Wikipedia, the CIA World Factbook). "Primary
language" and "largest religion" are deliberate simplifications of plural
realities — they reflect the single most common answer for quiz purposes, not
the full picture. Corrections and additions are welcome; everything lives in the
`data/*.json` files and needs no code changes to extend.

## Extending it

- **Add a country / state:** append an object to the relevant JSON file. That's
  it — it joins every relevant mode automatically.
- **Add an achievement:** add a definition to `achievements.json`; if it needs a
  new `type`, add a case in `progressFor()` (`js/achievements.js`).
- **Add a mode:** add an entry to `MODES` in `js/quiz.js` and a `case` in
  `makeQuestion()`, then a card in `MODE_CARDS` (`js/main.js`).

## Future enhancements

- Interactive click-the-map modes (world / US / Mexico SVG maps).
- "Map location" mode (click where a country is) and famous-landmark mode.
- Richer cultural-quiz content (food, festivals, traditions).
- Larger country set (all ~195) and per-country deep-dive study pages.
- Optional online leaderboard / cloud sync (currently local-first by design).
- PWA manifest + service worker for offline play and installability.

## License

MIT.
