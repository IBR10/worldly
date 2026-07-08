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
- [x] **Audit remediation**: first-visit onboarding + ❓ help, focus management
      & aria-live answer announcements, arrow-key tabs, 44px touch targets,
      map pinch-zoom, local-midnight daily, storage-failure toast, service
      worker (offline shell + flag caching), CSP without unsafe-inline,
      Microsoft Clarity analytics (anonymous events), GitHub Actions CI.

## Flag capability — enhancements
Flag → country already exists. Planned extensions:
- [ ] **Country → flag** (reverse): show the country name, pick the correct flag
      from four flag thumbnails.
- [ ] **Flag → capital / region** variants for harder play.
- [x] **Map ↔ flag modes**: a country highlighted on the map → pick its flag
      (Map → Flag), and see a flag → click the country (Flag → Map).
- [x] **Similar Flags** mode: identify a flag when every distractor is a real
      look-alike (France/Netherlands/Luxembourg, Belgium/Germany, Chad/Romania,
      Nordic crosses…). Curated confusion groups in `data/similar_flags.json`,
      each with a tip on how to tell them apart.
- [ ] Flag-only "speed round" preset in Challenge mode.
- [ ] Bundle flag images locally (or cache) so flag modes work fully offline.

## Interactive maps (biggest next feature)
- [x] **Click-the-country** world map mode (inline SVG world map; click the right
      country). Uses bundled `@svg-maps/world` SVG (CC BY 4.0), ISO2-keyed regions.
- [x] **Click-the-US-state** map mode (SVG of 50 states).
- [x] **Click-the-Mexican-state** map mode (SVG of 32 states).
- [x] **Click-the-Canadian-province** map mode (SVG of 13 provinces/territories).
- [x] **Regions & Continents mode**: pick one continent — the world map
      (and any world-map mode) is restricted to it and zoomed in.
- [ ] **Map-location mode**: given a country, click roughly where it is; score by
      distance.
- [x] Reusable `MapMode` component (`js/mapview.js`) — all maps share
      pan/zoom + native SVG hit-testing; pure logic lives in `js/maps.js`.

## Content & data
- [x] Expand country set from 76 → 155 (biggest gaps in Africa/Oceania filled; full ~195 coverage remains a future stretch goal).
- [ ] Famous-landmark mode (image → country).
- [ ] Cultural-quiz mode (food / festivals / traditions) with its own data file.
- [ ] Per-country deep-dive study pages (population, currency, neighbors…).

## Platform / polish
- [x] Web app manifest + service worker (offline app shell; flags cached after first sight).
- [ ] Full offline play (bundle all flag images locally).
- [x] Export/import progress (JSON) for device transfer.
- [ ] Daily-result share (emoji grid) + streak calendar.
- [ ] Optional online leaderboard / cloud sync (currently local-first).
