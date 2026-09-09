// icons.js — the drawn icon set for Worldly's chrome.
//
// Why not an icon font or an SVG sprite file: the CSP is `default-src 'self'`
// with no room for a third party, a font would be a second webfont download for
// a dozen glyphs, and a sprite sheet would be one more request before the header
// could paint. These are a few hundred bytes of strings that inline straight
// into the templates main.js already builds.
//
// Why not emoji, which the rest of the app still uses: emoji render differently
// on every platform (Windows has no flag emoji at all), cannot take the brand's
// colour, and are the single biggest reason the old header read as assembled
// from defaults rather than designed. Emoji stay where they are *content* —
// the mode cards, the culture grid, the achievements — and are gone from the
// chrome, where they were standing in for an icon set that did not exist.
//
// Every icon is drawn on the same 24-unit grid at 1.6 stroke with round joins,
// so they sit together, and every one inherits `currentColor` so it themes for
// free. They are decorative: each is aria-hidden, and the control that holds one
// carries its own accessible name.

const PATHS = {
  // The brand mark: a globe with its own graticule — the site's structural
  // motif stated before any content appears.
  globe:
    '<circle cx="12" cy="12" r="8.6"/>' +
    '<path d="M3.4 12h17.2"/>' +
    '<path d="M12 3.4c2.5 2.4 3.8 5.3 3.8 8.6s-1.3 6.2-3.8 8.6c-2.5-2.4-3.8-5.3-3.8-8.6S9.5 5.8 12 3.4Z"/>',
  // Home: a dividers/compass pair opened over a baseline — the tool you plan a
  // route with, rather than a house.
  home:
    '<circle cx="12" cy="12" r="8.6"/>' +
    '<path d="m12 5.4 2 4.6 4.6 2-4.6 2-2 4.6-2-4.6L5.4 12l4.6-2Z"/>',
  // Countries: a folded map sheet.
  map:
    '<path d="M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7Z"/>' +
    '<path d="M9 4v13"/>' +
    '<path d="M15 7v13"/>',
  // Flags: a pennant on a staff.
  flag:
    '<path d="M6 21V3.5"/>' +
    '<path d="M6 4.6h11.5l-2.4 3.9 2.4 3.9H6"/>',
  // Progress: a sounding line — depth marks read down a scale.
  gauge:
    '<path d="M4 20V8"/>' +
    '<path d="M10 20V4"/>' +
    '<path d="M16 20v-8"/>' +
    '<path d="M22 20H2"/>',
  trophy:
    '<path d="M7 4h10v5a5 5 0 0 1-10 0Z"/>' +
    '<path d="M7 5.5H4.5V7A3.5 3.5 0 0 0 8 10.5"/>' +
    '<path d="M17 5.5h2.5V7A3.5 3.5 0 0 1 16 10.5"/>' +
    '<path d="M12 14v3.5"/>' +
    '<path d="M8.5 20.5h7"/>' +
    '<path d="M9.5 17.5h5l1 3h-7Z"/>',
  help:
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 3.9"/>' +
    '<path d="M12 17.3h.01"/>',
  moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z"/>',
  sun:
    '<circle cx="12" cy="12" r="4.2"/>' +
    '<path d="M12 2.6v2.1M12 19.3v2.1M4.3 4.3l1.5 1.5M18.2 18.2l1.5 1.5M2.6 12h2.1M19.3 12h2.1M4.3 19.7l1.5-1.5M18.2 5.8l1.5-1.5"/>',
  back: '<path d="M15 5.5 8 12l7 6.5"/>',
  // The streak: a flame, drawn rather than 🔥.
  flame:
    '<path d="M12 3c3.4 3.2 5.4 6 5.4 9a5.4 5.4 0 0 1-10.8 0c0-1.6.6-3 1.8-4.3.3 1.1 1 1.9 1.9 2.1C10 7.8 10.6 5.4 12 3Z"/>',
  // Accuracy: a target, drawn rather than 🎯.
  target:
    '<circle cx="12" cy="12" r="8.4"/>' +
    '<circle cx="12" cy="12" r="4.2"/>' +
    '<circle cx="12" cy="12" r="0.9"/>',
  person:
    '<circle cx="12" cy="8" r="3.6"/>' +
    '<path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',
  reset:
    '<path d="M4.6 9.5A8 8 0 1 1 4 13.4"/>' +
    '<path d="M4.2 4.4v5.3h5.3"/>',
  bolt: '<path d="M13.4 3 5.6 13.4h5.2L10.6 21l7.8-10.4h-5.2Z"/>',
  close: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8"/>',
  // Pronunciation: a speaker with two arcs, replacing the 🔊 that rendered at a
  // different size and colour on every platform.
  speaker:
    '<path d="M4 9.4h3.2L12 5.6v12.8L7.2 14.6H4Z"/>' +
    '<path d="M15.6 9.6a3.4 3.4 0 0 1 0 4.8"/>' +
    '<path d="M18.2 7a7 7 0 0 1 0 10"/>',
};

/**
 * An inline SVG icon, as a string ready to interpolate into a template.
 *
 * Decorative by definition — the control that holds it must carry its own
 * accessible name (aria-label, or visible text alongside).
 *
 * @param {keyof PATHS} name
 * @returns {string} SVG markup, or '' for an unknown name
 */
export function icon(name) {
  const d = PATHS[name];
  if (!d) return '';
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    d +
    '</svg>'
  );
}

/** The names this module can draw — used by the icon test to keep it honest. */
export const ICON_NAMES = Object.keys(PATHS);
