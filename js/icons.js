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
  // ---- home: play ----------------------------------------------------------
  dice:
    '<rect x="3.8" y="3.8" width="16.4" height="16.4" rx="3.6"/>' +
    '<circle cx="8.6" cy="8.6" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="15.4" cy="15.4" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/>',
  stopwatch:
    '<circle cx="12" cy="13.6" r="7.4"/>' +
    '<path d="M12 9.8v3.8l2.5 1.7"/>' +
    '<path d="M9.6 2.9h4.8"/>' +
    '<path d="M12 2.9v3.3"/>' +
    '<path d="m18.7 6.4 1.5-1.5"/>',
  calendar:
    '<rect x="3.4" y="5" width="17.2" height="15.6" rx="2.6"/>' +
    '<path d="M3.4 9.7h17.2"/>' +
    '<path d="M8 3v4M16 3v4"/>',
  temple:
    '<path d="M3.6 20.6h16.8"/>' +
    '<path d="M12 3.2c2.9 1.9 4.4 4 4.4 6 0 1.3-.6 2.3-1.6 3"/>' +
    '<path d="M12 3.2c-2.9 1.9-4.4 4-4.4 6 0 1.3.6 2.3 1.6 3"/>' +
    '<path d="M6.6 12.2h10.8"/>' +
    '<path d="M8.2 20.6v-8.4M15.8 20.6v-8.4"/>' +
    '<path d="M12 20.6v-4.2"/>',
  repeat:
    '<path d="M4.6 9.4V8.6a3.4 3.4 0 0 1 3.4-3.4h8.8"/>' +
    '<path d="m14.2 2.6 2.9 2.6-2.9 2.6"/>' +
    '<path d="M19.4 14.6v.8a3.4 3.4 0 0 1-3.4 3.4H7.2"/>' +
    '<path d="m9.8 21.4-2.9-2.6 2.9-2.6"/>',
  // ---- home: quizzes -------------------------------------------------------
  city:
    '<path d="M2.6 20.6h18.8"/>' +
    '<path d="M5 20.6V9.4h5.2v11.2"/>' +
    '<path d="M14 20.6V5.4h5v15.2"/>' +
    '<path d="M7.1 12.4h1M7.1 15.6h1M16.3 8.6h.9M16.3 11.8h.9M16.3 15h.9"/>',
  pin:
    '<path d="M12 21.2s6.9-5.7 6.9-11a6.9 6.9 0 1 0-13.8 0c0 5.3 6.9 11 6.9 11Z"/>' +
    '<circle cx="12" cy="10.1" r="2.5"/>',
  dove:
    '<path d="M3.6 12.9c2.6 0 4.6-1.1 6-3.2 1.4 2.8 3.6 4.2 6.6 4.2h3.9l-2.6 2.9c-1.6 3-4.7 4.6-8 4.3"/>' +
    '<path d="M9.6 9.7c-.5-2 .4-4.1 2.3-5.2"/>' +
    '<circle cx="16.4" cy="11.7" r=".85" fill="currentColor" stroke="none"/>',
  speech:
    '<path d="M20.4 12.4c0 3.9-3.8 7.1-8.4 7.1-1 0-1.9-.14-2.8-.4L4.2 20.8l1.1-3.3c-1.1-1.3-1.7-3-1.7-4.9 0-3.9 3.8-7.1 8.4-7.1s8.4 3.2 8.4 7.1Z"/>' +
    '<path d="M8.6 11.2h6.8M8.6 14.4h4.4"/>',
  coin:
    '<circle cx="12" cy="12" r="8.6"/>' +
    '<path d="M12 6.9v10.2"/>' +
    '<path d="M14.7 9.3a2.8 2.8 0 0 0-2.7-1.6c-1.6 0-2.8.9-2.8 2.3 0 3 5.6 1.7 5.6 4.6 0 1.4-1.2 2.3-2.8 2.3a2.8 2.8 0 0 1-2.7-1.6"/>',
  people:
    '<circle cx="9.3" cy="8.4" r="3.3"/>' +
    '<path d="M3.2 19.8a6.1 6.1 0 0 1 12.2 0"/>' +
    '<path d="M16.1 5.6a3.3 3.3 0 0 1 0 6.3"/>' +
    '<path d="M17.5 14.2a6.1 6.1 0 0 1 3.3 5.6"/>',
  // A flag that is flying, rather than the flat pennant of `flag` — the past,
  // not the present.
  banner:
    '<path d="M5.4 21V3.4"/>' +
    '<path d="M5.4 5.2c3.4-1.9 6.3 1.9 9.7 0v6.9c-3.4 1.9-6.3-1.9-9.7 0Z"/>',
  flags:
    '<path d="M4 20.6V4"/>' +
    '<path d="M4 5.2h7.8v5.6H4"/>' +
    '<path d="M11.2 20.6V8.6"/>' +
    '<path d="M11.2 9.8H19v5.6h-7.8"/>',
  // ---- home: maps ----------------------------------------------------------
  crosshair:
    '<circle cx="12" cy="12" r="7.4"/>' +
    '<path d="M12 1.9v3.4M12 18.7v3.4M1.9 12h3.4M18.7 12h3.4"/>' +
    '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  search:
    '<circle cx="10.8" cy="10.8" r="6.6"/>' +
    '<path d="m15.6 15.6 4.6 4.6"/>',
  // ---- home: explore -------------------------------------------------------
  wave:
    '<path d="M9.4 12.4V5.1a1.5 1.5 0 0 1 3 0v5.9"/>' +
    '<path d="M12.4 10.5V4.5a1.5 1.5 0 0 1 3 0v6.6"/>' +
    '<path d="M15.4 11.3V6.5a1.5 1.5 0 0 1 3 0v7.9c0 3.6-2.6 6.2-6.2 6.2-2.6 0-4.4-1-5.6-3L4.3 13.9a1.5 1.5 0 0 1 2.3-1.9l2.8 2.8"/>',
  note:
    '<path d="M9.2 18.2V5.4l10-2v12.4"/>' +
    '<path d="M9.2 9.4l10-2"/>' +
    '<ellipse cx="6.6" cy="18.2" rx="2.6" ry="2.2"/>' +
    '<ellipse cx="16.6" cy="15.8" rx="2.6" ry="2.2"/>',
  news:
    '<path d="M4 5.4h12.6v13.2a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2Z"/>' +
    '<path d="M16.6 9.6h3.4v9a2 2 0 0 1-2 2"/>' +
    '<path d="M7 9h6.6M7 12.4h6.6M7 15.8h4"/>',
  sliders:
    '<path d="M5 3.6v6.2M5 14.2v6.2M12 3.6v3M12 10.6v9.8M19 3.6v10.2M19 18.4v2"/>' +
    '<circle cx="5" cy="12" r="2.2"/>' +
    '<circle cx="12" cy="8.6" r="2.2"/>' +
    '<circle cx="19" cy="16.2" r="2.2"/>',
  info:
    '<circle cx="12" cy="12" r="8.8"/>' +
    '<path d="M12 11v5.6"/>' +
    '<path d="M12 7.4h.01"/>',
  compass:
    '<circle cx="12" cy="12" r="8.8"/>' +
    '<path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1Z"/>',
  book:
    '<path d="M4 4.6h5.4A2.6 2.6 0 0 1 12 7.2v13.2a2.2 2.2 0 0 0-2.2-2.2H4Z"/>' +
    '<path d="M20 4.6h-5.4A2.6 2.6 0 0 0 12 7.2v13.2a2.2 2.2 0 0 1 2.2-2.2H20Z"/>',
  // ---- achievements --------------------------------------------------------
  star: '<path d="m12 3.3 2.75 5.6 6.15.9-4.45 4.35 1.05 6.15L12 17.4l-5.5 2.9 1.05-6.15L3.1 9.8l6.15-.9Z"/>',
  scroll:
    '<path d="M7 3.6h10a2 2 0 0 1 2 2v12.8a2 2 0 0 1-2 2H7"/>' +
    '<path d="M7 3.6a2 2 0 0 0-2 2v.6h4"/>' +
    '<path d="M7 20.4a2 2 0 0 0 2-2v-.6H5"/>' +
    '<path d="M10.4 8.6h6M10.4 12.2h6"/>',
  spark:
    '<path d="M12 3v5.2M12 15.8V21M3 12h5.2M15.8 12H21"/>' +
    '<path d="m6.4 6.4 2.6 2.6M15 15l2.6 2.6M17.6 6.4 15 9M9 15l-2.6 2.6"/>',
  runner:
    '<circle cx="15.3" cy="4.8" r="2"/>' +
    '<path d="m8.6 21 2.9-5.6-2.5-2.5 1.4-4.8 3.6-1.4 2.9 2.7 2.9 1"/>' +
    '<path d="m11.5 15.4-4.4-1L4.4 18"/>' +
    '<path d="m14.1 12.3 1.9 3.4 1.4 5.3"/>',
  crown:
    '<path d="M4.4 18.6h15.2"/>' +
    '<path d="m3.5 6.8 3.7 3.5L12 4.8l4.8 5.5 3.7-3.5-1.5 8.6H5Z"/>',
  medal:
    '<circle cx="12" cy="15.2" r="5.4"/>' +
    '<path d="m8.7 10.4-3.3-6.2h4.1l2.2 4.2"/>' +
    '<path d="m15.3 10.4 3.3-6.2h-4.1l-2.2 4.2"/>',
  // ---- Pokedex -------------------------------------------------------------
  gamepad:
    '<path d="M7.2 8h9.6a5 5 0 0 1 4.9 5.9l-.6 3.2a2.8 2.8 0 0 1-5.1.9l-1.3-2.1H9.3L8 18a2.8 2.8 0 0 1-5.1-.9l-.6-3.2A5 5 0 0 1 7.2 8Z"/>' +
    '<path d="M7.2 11.4v2.3M6.1 12.6h2.3"/>' +
    '<circle cx="15.9" cy="12" r=".9" fill="currentColor" stroke="none"/>' +
    '<circle cx="18" cy="14" r=".9" fill="currentColor" stroke="none"/>',
  sprout:
    '<path d="M12 20.6v-7.5"/>' +
    '<path d="M12 13.1C12 9.5 9.4 6.9 5.8 6.9c0 3.6 2.6 6.2 6.2 6.2Z"/>' +
    '<path d="M12 13.1c0-3.9 2.9-6.9 6.8-6.9 0 3.9-2.9 6.9-6.8 6.9Z"/>',
  swords:
    '<path d="M18.4 3.4h2.2v2.2l-8.5 8.5-2.2-2.2Z"/>' +
    '<path d="M5.6 3.4H3.4v2.2l8.5 8.5 2.2-2.2Z"/>' +
    '<path d="m6.6 16.6 2.9 2.9"/>' +
    '<path d="m17.4 16.6-2.9 2.9"/>',
  // ---- toasts --------------------------------------------------------------
  check: '<path d="m4.8 12.6 4.7 4.7 9.7-9.7"/>',
  warning:
    '<path d="M12 4.2 21 19.6H3Z"/>' +
    '<path d="M12 10.4v3.9"/>' +
    '<path d="M12 17h.01"/>',
  download:
    '<path d="M12 3.6v11.2"/>' +
    '<path d="m7.4 10.2 4.6 4.6 4.6-4.6"/>' +
    '<path d="M4.5 19.8h15"/>',
  upload:
    '<path d="M12 15.4V4.2"/>' +
    '<path d="m7.4 8.8 4.6-4.6 4.6 4.6"/>' +
    '<path d="M4.5 19.8h15"/>',
  signalOff:
    '<path d="M4.6 9.2a10.5 10.5 0 0 1 6.2-2.8"/>' +
    '<path d="M16.4 7.4a10.5 10.5 0 0 1 3 1.8"/>' +
    '<path d="M7.8 12.6a6 6 0 0 1 2.4-1.3"/>' +
    '<path d="M15.4 12.4a6 6 0 0 1 .8.2"/>' +
    '<path d="M12 17.4h.01"/>' +
    '<path d="m3.4 3.4 17.2 17.2"/>',
  bellOff:
    '<path d="M9 5.6a5.6 5.6 0 0 1 8.6 4.7v4.1l1.4 2.8"/>' +
    '<path d="M6.4 10.3v4.1L4.6 17.8h11.6"/>' +
    '<path d="M10.2 20.6a2 2 0 0 0 3.6 0"/>' +
    '<path d="M12 3.4v1.4"/>' +
    '<path d="m3.4 3.4 17.2 17.2"/>',
  levelUp:
    '<path d="M12 20.4V5"/>' +
    '<path d="m5.8 11.2 6.2-6.2 6.2 6.2"/>',
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
