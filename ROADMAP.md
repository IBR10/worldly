# Worldly — Roadmap / TODO

Living checklist of what's done and what's planned. Tick items as they ship.

## Done
- [x] Quiz modes: country↔capital, language, religion, US capitals, Mexico
      capitals, **flag identification**, plus typed-answer input.
- [x] World Religions: founders, texts, holidays, **symbols, places of worship,
      origins** — six question types per faith, single-faith filter.
- [x] Mixed, timed Challenge, Daily Challenge, Custom Study, Review-Missed.
- [x] Spaced repetition (Leitner) + weak-area tracking.
- [x] XP / levels, streaks, 23 achievements, stats dashboard, local leaderboard.
- [x] Dark/light theme, keyboard play, responsive layout.
- [x] Explore: Phrases (16 countries + TTS), Music (17 countries, 46 songs with
      "why this song" notes), Crises & Events (two tiers: Underreported and
      Major Conflicts, dated summaries).
- [x] Desktop launcher (`Worldly.bat`) + custom globe icon and Desktop shortcut.
- [x] **Launch readiness**: MIT LICENSE + About/credits/privacy screen,
      youtube-nocookie embeds, `_headers` (CSP/caching), 404/robots/manifest,
      OG meta, flag-load fallback UI, challenge-timer & review-missed bugfixes.

## Flag capability — enhancements
Flag → country already exists. Planned extensions:
- [ ] **Country → flag** (reverse): show the country name, pick the correct flag
      from four flag thumbnails.
- [ ] **Flag → capital / region** variants for harder play.
- [x] **Similar Flags** mode: identify a flag when every distractor is a real
      look-alike (France/Netherlands/Luxembourg, Belgium/Germany, Chad/Romania,
      Nordic crosses…). Curated confusion groups in `data/similar_flags.json`,
      each with a tip on how to tell them apart.
- [ ] Flag-only "speed round" preset in Challenge mode.
- [ ] Bundle flag images locally (or cache) so flag modes work fully offline.

## Interactive maps (biggest next feature)
- [x] **Click-the-country** world map mode (inline SVG world map; click the right
      country). Uses bundled MIT `@svg-maps/world` SVG, ISO2-keyed regions.
- [x] **Click-the-US-state** map mode (SVG of 50 states).
- [x] **Click-the-Mexican-state** map mode (SVG of 32 states).
- [ ] **Map-location mode**: given a country, click roughly where it is; score by
      distance.
- [x] Reusable `MapMode` component (`js/mapview.js`) — all three maps share
      pan/zoom + native SVG hit-testing; pure logic lives in `js/maps.js`.

## Content & data
- [ ] Expand country set from 76 → all ~195 sovereign states.
- [ ] Famous-landmark mode (image → country).
- [ ] Cultural-quiz mode (food / festivals / traditions) with its own data file.
- [ ] Per-country deep-dive study pages (population, currency, neighbours…).

## Platform / polish
- [x] Web app manifest (installable shell); service worker / offline play still to do.
- [ ] PWA service worker → full offline play (bundle or cache flags).
- [ ] First-visit onboarding (explain SRS / streaks / daily) + help affordance.
- [ ] Export/import progress (JSON) for device transfer.
- [ ] Daily-result share (emoji grid) + streak calendar.
- [ ] Map pinch-zoom on touch devices.
- [ ] Accessibility pass: focus management on screen changes, aria-live answer
      feedback, arrow-key tab navigation.
- [ ] Optional online leaderboard / cloud sync (currently local-first).
