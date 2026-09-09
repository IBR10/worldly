# Worldly visual redesign — design

Date: 2026-09-08

## The problem

Worldly's content was well ahead of its presentation. Twelve quiz modes, eleven
map modes, 198 country guides, a language choropleth, greetings, phrases, music,
crises, XP, streaks, 23 achievements and a 1025-entry Pokédex — all of it
delivered through a stylesheet that used the OS font stack, one `--radius` on
everything, emoji in place of an icon set, a 920px column and a single 560px
breakpoint.

The result read as a settings panel that happened to contain a geography game.
It is why the site felt like a collection of quizzes rather than a world worth
exploring, and no amount of new content was going to fix that.

## The direction

**"Deep chart & brass."** The visual language of a bathymetric survey chart and
the brass instruments you would read one with — not travel brochure, not SaaS
dashboard.

- **Ground.** Deep teal-black water (`#06171c`), surfaces rising out of it like
  a shelf. The light theme is the same chart printed on paper.
- **Accents, three.** Brass acts (buttons, XP, progress, map highlight); jade is
  correct; coral is wrong. A fourth colour, ice-cyan, is reserved for focus
  rings alone — a brass ring would vanish on exactly the brass controls people
  tab to most.
- **A continent key.** Six hues, deliberately clear of brass's 40°, used on
  region badges, continent bars and the dashboard map, so the same continent is
  the same colour everywhere. Colour carrying information, not decorating.
- **The graticule.** Latitude/longitude lines are the structural device: section
  rules end in a ticked meridian, meters are scale bars rather than gradient
  pills, cards carry a faint grid at one corner, and the map's ocean is ruled.
- **One typeface, two axes.** Archivo variable, `wght 100–900` and
  `wdth 62–125`. Width is the expressive dimension — headlines stretch, data
  labels compress — which is a fitting device for a site about projections.

## What was decided, and why

**The hero is the world map, painted with what you know.** Not decoration: SRS
item ids are already `${mode}:${name}`, so `js/progressmap.js` reads per-country
mastery straight out of the Leitner boxes every profile has always kept. Nothing
new is tracked, and the picture is retroactively true. The screen's title sits in
a cartouche over the map the way a printed chart's does.

**The hero map is display-only.** Making 256 country paths focusable would put
the entire world between the header and the first card in the tab order. The way
in to a country is the Countries screen, which has search and a region filter.

**Emoji stay where they are content, and are gone from the chrome.** The mode
cards, the culture grid and the achievement badges keep theirs — they are data,
and several are asserted by name in the e2e suite. The header, nav, buttons, map
controls and pronunciation buttons now use a drawn set (`js/icons.js`) that
themes with `currentColor` and renders the same on every platform.

**Three stylesheets, not one.** `styles.css` (tokens, font, base, utilities),
`components.css` (the kit), `screens.css` (composition). They load in parallel,
share the `/css/*` cache rules, and keep stylelint's per-file
`no-duplicate-selectors` check meaningful.

**Navigation exists now.** Four destinations — Home, Countries, Flags, Stats —
in a header rail above 900px and a bottom tab bar below it. Only one is ever
displayed; `display: none` also removes the other from the accessibility tree,
so a screen reader is never offered the same four links twice. Everything else
stays reachable from Home or the header, because a nav bar listing twenty
screens is a sitemap, not navigation.

**Three measures, by role.** Prose (68ch), content (1120px) and wide (1320px).
`/country` is a grid of 198 cards and takes the wide measure; `/country/:slug`
is a page you read and does not.

## Constraints that shaped it

1. **The CSP is real.** `style-src 'self'` with no `unsafe-inline` means
   self-hosted fonts, no `<style>` blocks, no `style="…"` attributes and no
   `on*=` handlers. Dynamic widths keep using the existing `data-w` + CSSOM
   convention.
2. **The e2e suite audits raw markup.** Exactly one `<h1>` per screen, first in
   document order, no heading-level skips, no duplicate attributes, no inline
   handlers — on every screen.
3. **Accessible names are a contract.** Card labels carry emoji that tests match
   on; the country page asserts exact element counts; filtered grids must
   toggle visibility rather than rebuild.
4. **`.hidden` needs `!important`.** It now lives in the first of three
   stylesheets, so without it any later rule of equal specificity wins on source
   order — and the Flag Key, country index and Pokédex all filter by toggling
   that one class.

## Test contracts that moved

One, deliberately: `tests/e2e/flagkey.spec.js` raised its above-the-fold flag
image budget from 110 to 150. The Flag Key is a reference screen and now sits on
the wide measure, which genuinely puts more flags near the viewport (~113,
measured). The budget still guards the real regression — the 251 requests that
came from building all four tabs eagerly.
