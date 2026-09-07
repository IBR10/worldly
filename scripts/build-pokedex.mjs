// build-pokedex.mjs — one-shot generator for the Pokédex feature's data + sprites.
//
// Worldly has no build step: the browser loads ES modules and JSON directly. So
// this script is a *development* tool, run by hand, whose output is committed.
// Nothing here ships to users and nothing at runtime depends on PokéAPI.
//
//   node scripts/build-pokedex.mjs
//
// It writes:
//   data/pokemon.json        1025 species records
//   data/pokemon_types.json  the 18x18 type-effectiveness chart
//   assets/pokemon/<id>.png  one sprite per species (~1.4 MB total)
//
// Why bundle the sprites instead of hotlinking PokéAPI's CDN: the site's CSP
// (_headers) allows neither pokeapi.co nor raw.githubusercontent.com, the
// service worker's image cache is deliberately capped at 300 entries (see the
// comment block in sw.js — an iOS quota blowout evicts localStorage, which is
// the only copy of a player's progress), and bundling means the dex works
// offline. At ~1.3 KB a sprite the whole set is smaller than world.svg.
//
// The script is restartable: it checkpoints raw API responses to .cache/ and
// skips sprites already on disk, so a rate-limit or a dropped connection costs
// only the work not yet done.

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'pokeapi');
const SPRITE_DIR = path.join(ROOT, 'assets', 'pokemon');
const DATA_DIR = path.join(ROOT, 'data');

const API = 'https://pokeapi.co/api/v2';
const SPRITE_CDN = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

const SPECIES_COUNT = 1025;   // through Pecharunt (gen 9)
const CONCURRENCY = 8;        // be a polite API citizen
const TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison',
  'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark',
  'steel', 'fairy',
];

const GEN_ROMAN = {
  'generation-i': 1, 'generation-ii': 2, 'generation-iii': 3,
  'generation-iv': 4, 'generation-v': 5, 'generation-vi': 6,
  'generation-vii': 7, 'generation-viii': 8, 'generation-ix': 9,
};

// ---- plumbing ----------------------------------------------------------------

/** Fetch with retry + exponential backoff. Returns parsed JSON. */
async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'worldly-pokedex-build' } });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 5) throw new Error(`giving up on ${url}: ${err.message}`);
    const wait = 500 * 2 ** attempt;
    process.stderr.write(`  retry ${attempt + 1} in ${wait}ms — ${url}\n`);
    await new Promise((r) => setTimeout(r, wait));
    return getJson(url, attempt + 1);
  }
}

/** getJson, but memoised on disk so a re-run costs no network. */
async function getJsonCached(url, key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    await access(file);
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    const body = await getJson(url);
    await writeFile(file, JSON.stringify(body));
    return body;
  }
}

/** Run `fn` over `items` with a bounded number in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- extraction --------------------------------------------------------------

/**
 * Pick an English Pokédex entry and normalise it for display.
 *
 * The API's flavour text is wrapped for the original cartridge screens, so it
 * arrives full of hard newlines, form feeds and soft hyphens. Later entries are
 * preferred: they are written in modern, less clipped prose.
 */
function pickFlavorText(species) {
  const en = species.flavor_text_entries.filter((e) => e.language.name === 'en');
  if (!en.length) return '';
  const entry = en[en.length - 1];
  return entry.flavor_text
    .replace(/\u00AD/g, '')   // soft hyphen left over from cartridge line-wrapping
    .replace(/\u000C/g, ' ')  // form feed used as a page break
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The English genus, e.g. "Mouse Pokémon". */
function pickGenus(species) {
  const g = species.genera.find((x) => x.language.name === 'en');
  return g ? g.genus : '';
}

/** Title-case an API slug: "lightning-rod" -> "Lightning Rod". */
function titleCase(slug) {
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Species display name.
 *
 * The species endpoint carries a proper English name (with the punctuation the
 * slug loses: Farfetch'd, Mr. Mime, Type: Null, Ho-Oh), so prefer it over
 * title-casing the slug.
 */
function displayName(species) {
  const en = species.names.find((n) => n.language.name === 'en');
  return en ? en.name : titleCase(species.name);
}

async function buildSpecies(id) {
  const species = await getJsonCached(`${API}/pokemon-species/${id}`, `species-${id}`);
  const mon = await getJsonCached(`${API}/pokemon/${id}`, `pokemon-${id}`);

  const stats = {};
  const STAT_KEY = {
    hp: 'hp', attack: 'atk', defense: 'def',
    'special-attack': 'spa', 'special-defense': 'spd', speed: 'spe',
  };
  for (const s of mon.stats) {
    const key = STAT_KEY[s.stat.name];
    if (key) stats[key] = s.base_stat;
  }

  return {
    id,
    name: displayName(species),
    slug: species.name,
    types: mon.types.slice().sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    gen: GEN_ROMAN[species.generation.name] || 0,
    species: pickGenus(species),
    dex: pickFlavorText(species),
    height: mon.height,   // decimetres, as the API reports
    weight: mon.weight,   // hectograms
    stats,
    abilities: mon.abilities
      .filter((a) => !a.is_hidden)
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((a) => titleCase(a.ability.name)),
    evolvesFrom: species.evolves_from_species ? species.evolves_from_species.name : null,
    legendary: species.is_legendary,
    mythical: species.is_mythical,
  };
}

/**
 * Build the type chart as multipliers: chart[attacker][defender] = 0 | 0.5 | 1 | 2.
 *
 * Derived from each type's damage_relations rather than hand-written, because an
 * 18x18 table typed by hand is 324 chances to be quietly wrong.
 */
async function buildTypeChart() {
  const chart = {};
  for (const t of TYPES) chart[t] = Object.fromEntries(TYPES.map((d) => [d, 1]));
  await mapLimit(TYPES, CONCURRENCY, async (t) => {
    const data = await getJsonCached(`${API}/type/${t}`, `type-${t}`);
    const rel = data.damage_relations;
    for (const d of rel.double_damage_to) chart[t][d.name] = 2;
    for (const d of rel.half_damage_to) chart[t][d.name] = 0.5;
    for (const d of rel.no_damage_to) chart[t][d.name] = 0;
  });
  return chart;
}

async function downloadSprite(id) {
  const file = path.join(SPRITE_DIR, `${id}.png`);
  if (existsSync(file)) return true;
  const res = await fetch(`${SPRITE_CDN}/${id}.png`);
  if (!res.ok) {
    process.stderr.write(`  !! sprite ${id}: HTTP ${res.status}\n`);
    return false;
  }
  await writeFile(file, new Uint8Array(await res.arrayBuffer()));
  return true;
}

// ---- main --------------------------------------------------------------------

async function main() {
  for (const dir of [CACHE_DIR, SPRITE_DIR, DATA_DIR]) await mkdir(dir, { recursive: true });

  const ids = Array.from({ length: SPECIES_COUNT }, (_, i) => i + 1);

  process.stdout.write(`Fetching ${SPECIES_COUNT} species…\n`);
  let done = 0;
  const dex = await mapLimit(ids, CONCURRENCY, async (id) => {
    const rec = await buildSpecies(id);
    if (++done % 100 === 0) process.stdout.write(`  ${done}/${SPECIES_COUNT}\n`);
    return rec;
  });

  // evolvesTo is the reverse of evolvesFrom. Deriving it here avoids fetching
  // ~550 evolution-chain documents to learn something the species records
  // already imply between them.
  const byslug = new Map(dex.map((p) => [p.slug, p]));
  for (const p of dex) p.evolvesTo = [];
  for (const p of dex) {
    if (!p.evolvesFrom) continue;
    const parent = byslug.get(p.evolvesFrom);
    if (parent) parent.evolvesTo.push(p.name);
  }
  // Store the parent's display name, not its slug, so the UI never re-looks-up.
  for (const p of dex) {
    if (!p.evolvesFrom) continue;
    const parent = byslug.get(p.evolvesFrom);
    p.evolvesFrom = parent ? parent.name : titleCase(p.evolvesFrom);
  }

  process.stdout.write('Fetching type chart…\n');
  const chart = await buildTypeChart();

  process.stdout.write('Downloading sprites into assets/pokemon/…\n');
  let sprites = 0;
  const ok = await mapLimit(ids, CONCURRENCY, async (id) => {
    const good = await downloadSprite(id);
    if (++sprites % 200 === 0) process.stdout.write(`  ${sprites}/${SPECIES_COUNT}\n`);
    return good;
  });
  const missing = ids.filter((_, i) => !ok[i]);

  await writeFile(path.join(DATA_DIR, 'pokemon.json'), `${JSON.stringify(dex)}\n`);
  await writeFile(path.join(DATA_DIR, 'pokemon_types.json'), `${JSON.stringify(chart)}\n`);

  process.stdout.write(`\nWrote data/pokemon.json (${dex.length} entries)\n`);
  process.stdout.write(`Wrote data/pokemon_types.json (${TYPES.length} types)\n`);
  if (missing.length) process.stderr.write(`Missing sprites: ${missing.join(', ')}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
