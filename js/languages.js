// languages.js — pure logic for the language choropleth.
//
// No DOM, no fetch, so this runs under plain `node --test` like quiz.js/maps.js.
// It answers two questions: which bucket does a country belong to, and what CSS
// class should its map region get. The colours themselves live in css/styles.css
// as .lf-* / .lg-* rules, because the app has no build step and painting via a
// class keeps both themes working with no JS colour table to keep in sync.
//
// Why bucket at all: data/greetings.json holds 120 distinct languages across 250
// regions, and most appear exactly once. A colour per language is unreadable, so
// the default view groups the 18 language-family values in the data into 11
// display buckets, and the second view colours the ten most widespread
// individual languages plus "Other".

/** Display buckets, in legend order. `families` lists the greetings.json values
 *  that fold into each one.
 *
 *  Eleven, not eighteen, and the number is measured rather than chosen by taste.
 *  The palette was searched with the data-viz validator over OKLCH (L, C, hue)
 *  per slot, scoring the worst *all-pairs* separation — the right pairlist for a
 *  choropleth, where any two regions can end up side by side. Eleven slots clear
 *  the CVD target and the normal-vision floor; more slots do not. Groups that had
 *  to fold are folded along real lines (the East/Southeast Asian bucket is a
 *  geographic grouping and is labelled as one, not passed off as a family). */
export const FAMILY_BUCKETS = [
  { key: 'romance', label: 'Romance', className: 'lf-romance', families: ['romance'] },
  { key: 'germanic', label: 'Germanic', className: 'lf-germanic', families: ['germanic'] },
  { key: 'slavic', label: 'Slavic', className: 'lf-slavic', families: ['slavic'] },
  { key: 'indo-iranian', label: 'Indo-Iranian', className: 'lf-indo-iranian', families: ['indo-iranian'] },
  { key: 'afro-asiatic', label: 'Afro-Asiatic', className: 'lf-afro-asiatic', families: ['afro-asiatic'] },
  { key: 'niger-congo', label: 'Niger-Congo', className: 'lf-niger-congo', families: ['niger-congo'] },
  { key: 'turkic', label: 'Turkic', className: 'lf-turkic', families: ['turkic'] },
  { key: 'east-asian', label: 'East & Southeast Asian', className: 'lf-east-asian', families: ['sino-tibetan', 'japonic', 'koreanic', 'austroasiatic', 'kra-dai'] },
  { key: 'austronesian', label: 'Austronesian', className: 'lf-austronesian', families: ['austronesian'] },
  { key: 'creole', label: 'Creole & pidgin', className: 'lf-creole', families: ['creole'] },
  { key: 'other', label: 'Other families', className: 'lf-other', families: ['other-indo-european', 'uralic', 'other'] },
];

/** Regions with no permanent population, and anything we cannot classify. */
export const NO_DATA = { key: 'none', label: 'No permanent population', className: 'lf-nodata' };

/** How many individual languages the "by language" view colours before Other. */
export const TOP_LANGUAGE_COUNT = 10;

const BY_FAMILY = new Map();
for (const b of FAMILY_BUCKETS) for (const f of b.families) BY_FAMILY.set(f, b);

/** greetings.json `family` value -> bucket key. Unknown values fall into
 *  'other' rather than disappearing, so a new family in the data still paints. */
export function bucketForFamily(family) {
  if (family === 'none' || !family) return NO_DATA.key;
  return (BY_FAMILY.get(family) || BY_FAMILY.get('other')).key;
}

/** Bucket key -> CSS class name. */
export function classForBucket(key) {
  if (key === NO_DATA.key) return NO_DATA.className;
  const b = FAMILY_BUCKETS.find((x) => x.key === key);
  return b ? b.className : NO_DATA.className;
}

/** Legend for the family view: only buckets actually present, biggest first,
 *  with No data always last so it reads as a footnote rather than a category. */
export function familyLegend(rows) {
  const counts = new Map();
  for (const r of rows) {
    const key = bucketForFamily(r.family);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = FAMILY_BUCKETS
    .filter((b) => counts.get(b.key))
    .map((b) => ({ key: b.key, label: b.label, className: b.className, count: counts.get(b.key) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (counts.get(NO_DATA.key)) {
    out.push({ ...NO_DATA, count: counts.get(NO_DATA.key) });
  }
  return out;
}

/** The n most widespread languages by number of regions. Ties break
 *  alphabetically so the palette is stable across data edits. */
export function topLanguages(rows, n = TOP_LANGUAGE_COUNT) {
  const counts = new Map();
  for (const r of rows) {
    if (r.family === 'none' || !r.language || r.language === '—') continue;
    counts.set(r.language, (counts.get(r.language) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, n))
    .map(([language]) => language);
}

/** Palette slots for the language view. Deliberately their own class names
 *  rather than reused .lf-* ones: colouring France with a class called
 *  "lf-germanic" would be a colour that works and a DOM that lies. css/styles.css
 *  aliases .lg-1 … .lg-10 onto the same colour tokens, so no new colours. */
const LANGUAGE_CLASSES = Array.from({ length: TOP_LANGUAGE_COUNT }, (_, i) => `lg-${i + 1}`);
const LANGUAGE_OTHER = 'lg-other';

/** Legend for the language view: top n languages, then Other, then No data. */
export function languageLegend(rows, n = TOP_LANGUAGE_COUNT) {
  const top = topLanguages(rows, n);
  const slot = new Map(top.map((lang, i) => [lang, LANGUAGE_CLASSES[i % LANGUAGE_CLASSES.length]]));
  const counts = new Map();
  let other = 0, none = 0;
  for (const r of rows) {
    if (r.family === 'none' || !r.language || r.language === '—') { none++; continue; }
    if (slot.has(r.language)) counts.set(r.language, (counts.get(r.language) || 0) + 1);
    else other++;
  }
  const out = top.map((lang) => ({
    key: lang, label: lang, className: slot.get(lang), count: counts.get(lang) || 0,
  }));
  if (other) out.push({ key: '__other', label: 'Other languages', className: LANGUAGE_OTHER, count: other });
  if (none) out.push({ ...NO_DATA, count: none });
  return out;
}

/**
 * The paint instruction for the map: lowercase SVG region id -> CSS class.
 * `mode` is 'family' or 'language'. Region ids are lowercased here because
 * world.svg uses lowercase ISO-3166 alpha-2 while the datasets use uppercase —
 * the same join maps.js#regionIdFor performs.
 */
export function regionClassesFor(rows, mode = 'family', n = TOP_LANGUAGE_COUNT) {
  const out = {};
  if (mode === 'language') {
    const top = topLanguages(rows, n);
    const slot = new Map(top.map((lang, i) => [lang, LANGUAGE_CLASSES[i % LANGUAGE_CLASSES.length]]));
    for (const r of rows) {
      if (!r.iso2) continue;
      const noLang = r.family === 'none' || !r.language || r.language === '—';
      out[r.iso2.toLowerCase()] = noLang ? NO_DATA.className : (slot.get(r.language) || LANGUAGE_OTHER);
    }
    return out;
  }
  for (const r of rows) {
    if (!r.iso2) continue;
    out[r.iso2.toLowerCase()] = classForBucket(bucketForFamily(r.family));
  }
  return out;
}

/** Every class this module can emit, so a repaint can clear the previous one
 *  without knowing which mode produced it. */
export const ALL_REGION_CLASSES = [
  ...FAMILY_BUCKETS.map((b) => b.className),
  NO_DATA.className,
  ...LANGUAGE_CLASSES,
  LANGUAGE_OTHER,
];
