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
- [x] **Greet anyone, anywhere**: `data/greetings.json` covers all 256 regions
      on the world map — language, family, BCP-47 code, hello, pronunciation and
      how the greeting is actually performed.
- [x] Desktop launcher (`Worldly.bat`) + custom globe icon and Desktop shortcut.
- [x] **Pokédex** (fun corner): all 1025 species bundled offline, browsable by
      generation with search/type filters, seven practice modes, and a
      registration/mastery track to *Pokémon Master* — stored separately so it
      never affects Worldly XP, streaks or the leaderboard.
- [x] **Launch readiness**: MIT LICENSE + About/credits/privacy screen,
      youtube-nocookie embeds, `_headers` (CSP/caching), 404/robots/manifest,
      OG meta, flag-load fallback UI, challenge-timer & review-missed bugfixes.
- [x] **Visual redesign** ("deep chart & brass"): a self-hosted variable
      typeface used at three widths, a three-accent palette with a six-hue
      continent key, the graticule as the structural motif, real navigation
      (header rail + mobile tab bar), a home hero that paints the world map
      with the countries you actually know, the Statistics screen rebuilt as an
      explorer's console, country pages as travel-guide spreads, achievements as
      a stamp wall, drawn SVG icons in place of emoji chrome, and three
      breakpoints where there was one. See
      `docs/superpowers/specs/2026-09-08-visual-redesign-design.md`.
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
- [x] **Language Map** (`/languages`) — the world coloured by language family or
      by the ten most widespread languages, with a key that isolates one group.
- [x] **Say Hello map** (`/hello`) — tap any country for its greeting in the
      local script, with pronunciation and text-to-speech.

## Content & data
- [x] Expand country set from 76 → 155 → **198** (every region drawn on the world map now has a dataset entry).
- [ ] Famous-landmark mode (image → country).
- [ ] Cultural-quiz mode (food / festivals / traditions) with its own data file.
- [x] **Per-country deep-dive study pages** — `/country/:slug` for all 198: how to
      greet someone, five people the country is known for, the events that shaped
      it, a short read on its culture, three things worth bringing up and one to
      tread carefully around (`data/culture/*.json`).

## Platform / polish
- [x] Web app manifest + service worker (offline app shell; flags cached after first sight).
- [ ] Full offline play (bundle all flag images locally).
- [x] Export/import progress (JSON) for device transfer.
- [ ] Daily-result share (emoji grid) + streak calendar.
- [ ] Optional online leaderboard / cloud sync (currently local-first).
