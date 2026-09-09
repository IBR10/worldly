// main.js — application controller. Owns routing between screens, renders the
// HUD, runs a quiz session, and reacts to answers (scoring, XP, achievements).

import { loadData, loadDataset, getData, getContinents, getSubregions, getRegions, flagUrl, historicFlagUrl, stateFlagUrl, symbolImageUrl, loadMap } from './data.js';
import {
  loadProfile, getProfile, saveProfile, resetProfile, importProfile, levelProgress, accuracy,
  recordAnswer, recordStudyTime, recordPerfectQuiz, markDailyComplete,
  dailyDoneToday, addLeaderboard, setTheme, setName, setOnboarded, localDateStr,
} from './state.js';
import { track, tag, loadAnalytics, analyticsOptedOut, setAnalyticsOptOut } from './analytics.js';
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches, challengeMultiplier, sessionQuestionXp, seededRng, dateSeed } from './quiz.js';
import { buildMapPool, makeMapQuestion, MAP_MODES, ALL_MAP_MODES } from './maps.js';
import { createMapView } from './mapview.js';
import { regionClassesFor, familyLegend, languageLegend } from './languages.js';
import { datasetKeyForRegion, cultureFor, cultureSections, initialsFor } from './culture.js';
import { pickWeighted, weakCount } from './srs.js';
import { checkAchievements, achievementStatus, levelTitle } from './achievements.js';
import { createRouter } from './router.js';
import { icon } from './icons.js';
import { countryMastery, masteryClasses, discoveryStats, continentClass } from './progressmap.js';
import { initPokedex, showPokedex, showPokemonDetail, startPokeQuizByKey } from './pokedexview.js';

// Combined category label lookup (quiz modes + map modes) for HUD/stats.
const catLabel = (k) => MODES[k]?.label || MAP_MODES[k]?.label || k;

// The four map modes backed by the world SVG — the only ones a continent
// filter/zoom makes sense for (US/MX state modes have no continent variation).
const WORLD_MAP_MODES = ALL_MAP_MODES.filter((m) => MAP_MODES[m].svg === 'world');

const app = document.getElementById('app');
const hud = document.getElementById('hud');
const toastBox = document.getElementById('toasts');
const navrail = document.getElementById('navrail');
const tabbar = document.getElementById('tabbar');

// The primary destinations, rendered into both the header rail (wide viewports)
// and the bottom bar (narrow ones). Only one of the two is ever displayed, and
// `display: none` also takes the other out of the accessibility tree, so a
// screen reader is never offered the same four links twice.
//
// These are the four things a player comes back for. Everything else — the quiz
// and map modes, the leaderboard, the profile — is reachable from Home or the
// header, which is where it belongs: a nav bar that lists twenty screens is a
// sitemap, not navigation.
const NAV = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/country', icon: 'map', label: 'Countries' },
  { href: '/flags', icon: 'flag', label: 'Flags' },
  { href: '/stats', icon: 'gauge', label: 'Stats' },
];

/** Fill both navs once, at boot. Plain <a href="/…"> — router.js already
 *  intercepts internal absolute links, so no click handler is needed here. */
function renderNav() {
  navrail.innerHTML = NAV.map((n) =>
    `<a class="navlink" href="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`).join('');
  tabbar.innerHTML = NAV.map((n) =>
    `<a class="tabbar-link" href="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`).join('');
  document.getElementById('brandMark').innerHTML = icon('globe');
  document.getElementById('helpBtn').innerHTML = icon('help');
  document.getElementById('leaderboardBtn').innerHTML = icon('trophy');
}

// Screens that are mostly map or mostly grid get the wide measure; everything
// else keeps the reading column. Prefix matching, so /map/:mode and
// /country/:slug inherit their section's width.
// Exact paths, not prefixes: /country is a grid of 198 cards and wants the room,
// while /country/:slug is a page you read and would be worse for it.
const WIDE_ROUTES = ['/', '/flags', '/country', '/languages', '/hello', '/stats', '/achievements', '/pokedex'];
// …with one prefix, because every map mode is a map.
const WIDE_PREFIXES = ['/map/'];

/** Nav state and column width for a path. Runs immediately BEFORE the screen
 *  renders, so the measure is already correct when the content lands rather
 *  than snapping a frame later. */
function applyChrome(path) {
  syncNav(path);
  const wide = WIDE_ROUTES.includes(path) || WIDE_PREFIXES.some((r) => path.startsWith(r));
  app.classList.toggle('app-wide', wide);
}

/** Mark the destination the current URL belongs to. Detail routes count as
 *  their section (/country/japan lights Countries), so the bar never goes blank
 *  three clicks deep. */
function syncNav(path) {
  for (const a of document.querySelectorAll('.navlink, .tabbar-link')) {
    const href = a.getAttribute('href');
    const on = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// Active quiz session (null when not playing).
let S = null;
// Bumped every time the player leaves whatever screen/session was active.
// Async work that outlives its screen (e.g. a slow map SVG fetch) checks this
// before touching S/#app, so a late response can never hijack a screen the
// user has already navigated away from.
let sessionGen = 0;
function leaveSession() { S = null; sessionGen += 1; }

// ---- routing -----------------------------------------------------------------
// The router owns the URL; every screen below is just a renderer it calls. The
// instance is built in boot() (once every render function is defined); until
// then navigate() is a no-op, which is safe because nothing can fire a handler
// before the first render. Route table and starters live near boot().
let router = null;
function navigate(to, opts) { if (router) return router.navigate(to, opts); }

// A URL-safe slug for a content entry (crisis title, phrase/music country).
// Deterministic and reversible-enough: the detail routes look an entry up by
// re-slugifying every candidate and comparing, so we never store the slug.
function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// Which home tab is selected (persists while navigating in and out of home).
let homeTab = 'play';
// Which crises period (current vs. historical) and coverage tab are selected
// (persists while browsing crisis details).
let crisesPeriod = 'current';
let crisesTab = 'underreported';
// Which leaderboard tab is selected (persists while browsing the leaderboard).
let leaderboardTab = 'challenge';

// ---- tiny helpers ------------------------------------------------------------
/** Newest `asOf` ("September 2026") among the current crisis entries, or ''.
 *  Lets the Crises screen state how fresh its curated background actually is,
 *  rather than leaving the reader to guess. */
function newestAsOf(entries) {
  let best = '', bestT = -Infinity;
  for (const e of entries) {
    if ((e.period || 'current') !== 'current' || !e.asOf) continue;
    const t = Date.parse(`1 ${e.asOf}`);
    if (Number.isFinite(t) && t > bestT) { bestT = t; best = e.asOf; }
  }
  return best;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// URLs interpolated into an href need more than esc(): a `javascript:` URL is
// perfectly valid HTML and CSP does not block it on navigation. Link targets
// come from data/*.json, which README invites corrections to, so an untrusted
// scheme is a realistic path rather than a hypothetical one. Anything that is
// not http(s) collapses to '#'.
function safeUrl(raw) {
  try {
    const parsed = new URL(String(raw), location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? esc(parsed.href) : '#';
  } catch {
    return '#';
  }
}

// Speak text aloud via the browser's built-in speech synthesis (free, offline,
// no dependency). `lang` is a BCP-47 tag (e.g. 'ja-JP') so the OS can pick a
// matching voice. Silently no-ops where the Web Speech API is unavailable.
//
// `lang` on the utterance is only a hint: if the OS/browser has no installed
// voice for that language, most engines silently substitute an unrelated
// default voice (usually an English one). Fed non-Latin script it can't read,
// that fallback voice often spells out individual letters/characters instead
// of pronouncing the word — the bug reports as "it's naming the Greek letters,
// not saying the word." So we look for an actual matching voice first; if none
// is installed, we speak `fallbackText` (the romanized pronunciation, which
// any voice can read as real words) instead of feeding native script to a
// voice that can't handle it.
const ttsAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
let voicesCache = [];
function refreshVoices() {
  if (ttsAvailable()) voicesCache = window.speechSynthesis.getVoices();
}
if (ttsAvailable()) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}
function pickVoice(lang) {
  if (!lang || !voicesCache.length) return null;
  const target = lang.toLowerCase();
  const exact = voicesCache.find((v) => v.lang.toLowerCase() === target);
  if (exact) return exact;
  const primary = target.split('-')[0];
  return voicesCache.find((v) => v.lang.toLowerCase().split('-')[0] === primary) || null;
}
function speak(text, lang, fallbackText) {
  if (!ttsAvailable() || !text) return;
  try {
    window.speechSynthesis.cancel();
    if (!voicesCache.length) refreshVoices(); // some browsers populate the list lazily
    const voice = pickVoice(lang);
    const u = new SpeechSynthesisUtterance(voice || !fallbackText ? text : fallbackText);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else if (lang) {
      u.lang = lang;
    }
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch { /* ignore — audio is a nice-to-have */ }
}

// A top-of-screen navigation row (mirrors the bottom Back/Home buttons). Returns
// markup; call wireNav() after render to bind the buttons. `back` is an optional
// { id, label } for a screen-specific back target (Home is always present).
function topNav(back = null) {
  return `<div class="top-nav">
    ${back ? `<button class="btn ghost" id="${back.id}">${esc(back.label)}</button>` : ''}
    <button class="btn ghost" data-topnav="home">${icon('back')}Home</button>
  </div>`;
}
function wireNav() {
  app.querySelectorAll('[data-topnav="home"]').forEach((b) => b.addEventListener('click', () => navigate('/')));
  focusTitle();
}

// Move keyboard/screen-reader focus to the new screen's heading after a render,
// so assistive tech isn't stranded on a removed element.
//
// Suppressed for the very first render: on load the document order is already
// correct and focus belongs at the top of the page. Pulling it into the <h1>
// pushed the entire header past the page content -- measured, Home /
// Leaderboard / Theme became tab stops 12-14, reachable only after cycling
// every card and footer link.
let allowFocusTitle = false;
function focusTitle() {
  if (!allowFocusTitle) return;
  const h = app.querySelector('.screen-title, .q-prompt');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}

// Accessible tab bar shared by Home and Crises: click + Arrow/Home/End keys,
// roving tabindex. `onChange(id)` persists the selection. `root` scopes the
// tab/panel lookup so a screen can host more than one independent tab group.
function wireTabs(onChange, root = app) {
  const tabs = [...root.querySelectorAll('.tab')];
  const activate = (id, focus = false) => {
    onChange(id);
    tabs.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    root.querySelectorAll('.tab-panel').forEach((pl) => pl.classList.toggle('active', pl.dataset.panel === id));
  };
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => activate(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      const n = tabs.length;
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % n;
      else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = n - 1;
      if (j != null) { e.preventDefault(); activate(tabs[j].dataset.tab, true); }
    });
  });
}
/**
 * Run `fn` once a burst of calls has stopped.
 *
 * Used by the live searches on the Flag Key and the country index, which filter
 * several hundred already-rendered cards by toggling a class. Typing "uni" fired
 * three full passes and three layouts over a 251-card grid; one pass after the
 * burst is both faster and smoother, and 110ms is short enough that the list
 * still feels like it is tracking the keystrokes.
 */
function debounce(fn, ms = 110) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const fmtTime = (ms) => {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
};

// Local calendar date: the daily rolls over at the player's midnight, and the
// same date string yields the same seeded set for everyone playing locally.
// (The server-verified path uses its own UTC date instead — see startQuiz.)
function dailySeed() {
  return dateSeed(localDateStr());
}

/**
 * A transient message. `name` is a key from js/icons.js, not a glyph — an
 * unknown name simply draws nothing, which is a safer failure than the old
 * signature's unescaped interpolation of whatever it was handed.
 */
function toast(name, title, sub) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="ic">${icon(name)}</div><div><div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</div>`;
  toastBox.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ---- HUD ---------------------------------------------------------------------
function renderHUD() {
  const p = getProfile();
  const lp = levelProgress(p.xp);
  // The level sits inside its own XP arc rather than beside a separate bar:
  // one reading instead of two, which is what buys the room for the nav rail.
  hud.innerHTML = `
    <button class="chip chip-name hide-sm" id="hudName" title="View profile">${icon('person')}<strong>${esc(p.name)}</strong></button>
    <div class="chip" title="${esc(levelTitle(p.xp))} — level ${lp.level}, ${lp.pct}% to the next">
      <span class="gauge"><span class="gauge-n">${lp.level}</span></span>
      <span class="xpbar hide-sm"><span></span></span></div>
    <div class="chip hide-sm" title="Total XP">XP <strong>${p.xp}</strong></div>
    <div class="chip" title="Current streak">${icon('flame')}<strong>${p.currentStreak}</strong></div>
    <div class="chip hide-sm" title="Overall accuracy">${icon('target')}<strong>${accuracy()}%</strong></div>`;
  // Widths and the gauge's arc are set via CSSOM (not inline style attributes)
  // so the CSP can stay free of style-src 'unsafe-inline'.
  hud.querySelector('.xpbar > span').style.width = lp.pct + '%';
  hud.querySelector('.gauge').style.setProperty('--arc', String(lp.pct));
  hud.querySelector('#hudName').addEventListener('click', () => navigate('/profile'));
}

// ---- theme -------------------------------------------------------------------
/** The OS preference, used when the player has not chosen explicitly. */
function systemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Resolve `null` (follow the OS) to a concrete palette and apply it. */
function applyTheme(theme) {
  const resolved = theme === 'light' || theme === 'dark' ? theme : systemTheme();
  document.documentElement.setAttribute('data-theme', resolved);
  // The button offers the theme you would switch TO, which is why dark mode
  // shows a sun. Drawn, so it takes the brass on hover like every other control.
  const btn = document.getElementById('themeToggle');
  btn.innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon');
  btn.title = resolved === 'dark' ? 'Switch to light' : 'Switch to dark';
  return resolved;
}

// ============================================================================
//  HOME
// ============================================================================
// The World Religions quiz bundles the religion-topic modes into one session.
const RELIGION_MODES = ['religion_founder', 'religion_text', 'religion_holiday', 'religion_symbol', 'religion_place', 'religion_origin'];

const MODE_CARDS = [
  { key: 'capital', icon: 'city', title: 'Country → Capital', desc: 'Name the capital city.' },
  { key: 'country', icon: 'pin', title: 'Capital → Country', desc: 'Which country is this the capital of?' },
  { key: 'religion', icon: 'dove', title: 'Largest Religion', desc: 'The most practiced faith.' },
  { key: 'language', icon: 'speech', title: 'Primary Language', desc: 'The most widely spoken language.' },
  { key: 'currency', icon: 'coin', title: 'Currency', desc: 'The official currency used.' },
  { key: 'population', icon: 'people', title: 'Population', desc: 'How many people live there.' },
  // Windows has no flag-emoji font (🇺🇸 renders as "US"), so these two cards use
  // real flag images from flagcdn instead of a regional-indicator emoji.
  { key: 'us_capital', flagIso: 'US', title: 'US States → Capitals', desc: 'All 50 state capitals.' },
  { key: 'mx_capital', flagIso: 'MX', title: 'Mexico States → Capitals', desc: 'All 32 state capitals.' },
  { key: 'ca_capital', flagIso: 'CA', title: 'Canada Provinces → Capitals', desc: 'All 13 provinces & territories.' },
  { key: 'flag', icon: 'flag', title: 'Flag Mode', desc: 'Identify the country from its flag.' },
  { key: 'historic_flag', icon: 'banner', title: 'Historic Flags', desc: 'Identify the nation from a flag of the past.' },
  { key: 'similar_flag', icon: 'flags', title: 'Similar Flags', desc: 'Tell look-alike flags apart (France vs Netherlands…).' },
];

// Interactive click-the-map modes (each is its own SVG-backed session).
const MAP_CARDS = [
  // Unlike the cards below (which start a specific MAP_MODES key directly),
  // this opens a chooser screen — so it overrides the tab's default attr.
  { key: 'map_regions', attr: 'data-go', icon: 'globe', title: 'Regions & Continents', desc: 'Pick a continent or region — the map zooms in so you only see that part of the world.' },
  // Grouped by entity (world, US, Mexico, Canada) so each pair of forward/
  // reverse modes for the same place sits next to each other.
  { key: 'map_country', icon: 'crosshair', title: 'Find the Country', desc: 'Click the country on a world map.' },
  { key: 'map_country_reverse', icon: 'search', title: 'Name the Country', desc: 'A country is highlighted — name it.' },
  { key: 'map_flag_country', icon: 'flag', title: 'Flag → Map', desc: 'See a flag — click its country on the map.' },
  { key: 'map_country_flag', icon: 'flags', title: 'Map → Flag', desc: 'A country is highlighted — pick its flag.' },
  { key: 'map_us', flagIso: 'US', title: 'Find the US State', desc: 'Click the state on a US map.' },
  { key: 'map_us_reverse', flagIso: 'US', title: 'Name the US State', desc: 'A state is highlighted — name it.' },
  { key: 'map_mx', flagIso: 'MX', title: 'Find the Mexican State', desc: 'Click the state on a Mexico map.' },
  { key: 'map_mx_reverse', flagIso: 'MX', title: 'Name the Mexican State', desc: 'A state is highlighted — name it.' },
  { key: 'map_ca', flagIso: 'CA', title: 'Find the Canadian Province', desc: 'Click the province on a Canada map.' },
  { key: 'map_ca_reverse', flagIso: 'CA', title: 'Name the Canadian Province', desc: 'A province is highlighted — name it.' },
];

// Card markup shared by every home tab. `attr` is the routing attribute
// (data-go / data-mode / data-map) the click handlers below listen on; a card
// can override it with its own `m.attr` (e.g. a map card that opens a chooser
// screen instead of starting a mode directly).
function homeCard(attr, m) {
  // A real flag where the card is about one place, a drawn mark everywhere else.
  // `mark` rather than `icon`, so it does not shadow the imported icon().
  const mark = m.flagIso
    ? `<img decoding="async" class="emoji-flag" alt="" src="${flagUrl(m.flagIso, 'w80')}">`
    : `<span class="emoji">${icon(m.icon)}</span>`;
  // Every field is escaped even though the mode list is a static constant
  // today. The point isn't the current data — it's that the day someone makes
  // card titles data-driven, the unescaped version becomes an XSS, and nobody
  // reviewing *that* change would think to look in here.
  return `
    <button class="card" ${m.attr || attr}="${esc(m.key)}">
      ${mark}
      <span class="card-title">${esc(m.title)}</span>
      <span class="card-desc">${esc(m.desc)}</span>
    </button>`;
}

/**
 * The hero: the world map, coloured with the countries this player actually
 * knows, and the screen's title set in a cartouche over it.
 *
 * A printed chart puts its title in an inset panel over open water, which is
 * exactly the shape this needs — the map is the content, so the words have to
 * sit on it rather than push it down the page. The colouring is derived from
 * the SRS boxes the profile already keeps (js/progressmap.js), so it has been
 * true of every profile since the day it was created; nothing new is tracked.
 *
 * The map is display-only. Making 256 country paths focusable would put the
 * whole world between the header and the first card in the tab order, which is
 * a worse deal than it sounds: the way in to a country is the Countries screen,
 * which has search and a region filter.
 */
function heroMarkup(p, dailyDone) {
  const lp = levelProgress(p.xp);
  const countries = getData().countries || [];
  const stats = discoveryStats(countryMastery(p.srs, countries), countries);
  const fresh = p.totalAnswered === 0;

  const readout = fresh
    ? `<p class="hero-sub m-0">Nothing on the map yet — answer one question and the first country lights up.</p>`
    : `<dl class="hero-readout">
        <div class="readout"><dt>Level</dt><dd>${lp.level} <span class="readout-note">${esc(levelTitle(p.xp))}</span></dd></div>
        <div class="readout"><dt>Streak</dt><dd>${p.currentStreak} <span class="readout-note">best ${p.bestStreak}</span></dd></div>
        <div class="readout"><dt>World found</dt><dd>${stats.pct}% <span class="readout-note">${stats.known} of ${stats.total}</span></dd></div>
      </dl>`;

  return `
    <section class="hero">
      <div class="hero-map" id="heroMap"><div class="map-holder skel"></div></div>
      <div class="hero-cartouche">
        <h1 class="screen-title hero-title">Explore the world</h1>
        <p class="hero-sub">Places, cultures, faiths, languages, music &amp; current events — learned by
          active recall, so the map fills in as you go.</p>
        <div class="hero-actions">
          <button class="btn primary" data-go="${dailyDone ? 'mixed' : 'daily'}">${dailyDone ? 'Play a mixed round' : "Play today's set"}</button>
          <button class="btn" data-go="countries">Browse all 198 countries</button>
        </div>
        ${readout}
      </div>
    </section>`;
}

/**
 * Run `fn` when the browser has nothing better to do, and no later than `wait`.
 *
 * requestIdleCallback where it exists, a timeout everywhere else. Used for work
 * that improves a screen but must never compete with what the player is
 * actually doing on it.
 */
function whenIdle(fn, wait = 400) {
  // window-qualified because eslint's browser globals do not yet include
  // requestIdleCallback, and the feature detection has to survive its absence.
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: wait });
  else setTimeout(fn, 0);
}

/**
 * Paint the hero map in, once its SVG has arrived.
 *
 * Deliberately after the screen has rendered, not before: world.svg is 1.2 MB,
 * and blocking the whole home screen on it would trade a fast, useful page for
 * a slow, prettier one. Guarded by the session counter so a slow fetch that
 * lands after the player has navigated away cannot write into someone else's
 * screen.
 */
async function mountHeroMap(gen) {
  // Checked before the fetch as well as after it. The `await` below is a 1.2 MB
  // download; a player who taps straight through to a quiz should not still be
  // paying for a picture of a screen they have left, and the later guard alone
  // would only stop the write, not the transfer.
  if (gen !== sessionGen) return;
  const mount = app.querySelector('#heroMap');
  if (!mount) return;
  let map;
  try {
    map = await loadMap('world');
  } catch {
    mount.remove(); // offline or blocked: the cartouche stands on its own
    return;
  }
  if (gen !== sessionGen || !app.contains(mount)) return;
  const p = getProfile();
  const countries = getData().countries || [];
  const view = createMapView({
    svgText: map.svgText,
    interactive: false,
    // Region classes without the choropleth modifier: this is a progress map,
    // not an eleven-hue categorical one, so it keeps the plain map styling.
    paintClass: null,
    regionClasses: masteryClasses(countryMastery(p.srs, countries)),
    onPick: () => {},
  });
  mount.replaceChildren(view.el);
}

function showHome() {
  clearTimer(); // a challenge timer must never outlive its screen (crash-loop otherwise)
  leaveSession();
  const p = getProfile();
  const dailyDone = dailyDoneToday();
  const missedCount = reviewableMissedIds().length;
  const quickCards = [
    { key: 'mixed', icon: 'dice', title: 'Mixed Quiz', desc: 'A bit of everything.' },
    { key: 'challenge', icon: 'stopwatch', title: 'Challenge Mode', desc: 'Beat the clock for a high score.' },
    { key: 'daily', icon: 'calendar', title: `Daily Challenge${dailyDone ? ' ✓' : ''}`, desc: 'Same set for everyone, once a day.' },
    { key: 'religions', icon: 'temple', title: 'World Religions', desc: 'Founders, texts & holidays — pick a faith.' },
    { key: 'review', icon: 'repeat', title: `Review Missed (${missedCount})`, desc: 'Practice what you got wrong.' },
  ];
  const journeyCards = [
    { key: 'phrases', icon: 'speech', title: 'Phrases', desc: 'Common phrases & local sayings around the world.' },
    { key: 'flagkey', icon: 'flag', title: 'Flag Key', desc: 'Browse every country, US state, Mexican state & Canadian province by flag and name.' },
    { key: 'languages', icon: 'map', title: 'Language Map', desc: 'The world coloured by what it speaks.' },
    { key: 'hello', icon: 'wave', title: 'Say Hello', desc: 'Tap any country to learn its greeting.' },
    { key: 'countries', icon: 'globe', title: 'Country Guides', desc: 'People, events & culture, country by country.' },
    { key: 'music', icon: 'note', title: 'Music', desc: 'Songs that represent each country.' },
    { key: 'crises', icon: 'news', title: 'Crises & Events', desc: 'Background on major ongoing world situations.' },
    { key: 'custom', icon: 'sliders', title: 'Custom Study', desc: 'Choose topics, continents, difficulty & input.' },
    { key: 'stats', icon: 'gauge', title: 'Statistics', desc: 'Accuracy, weak areas & study time.' },
    { key: 'achievements', icon: 'trophy', title: 'Achievements', desc: 'Badges & milestones.' },
    { key: 'profile', icon: 'compass', title: 'Profile', desc: 'Name & reset.' },
    { key: 'pokedex', icon: 'bolt', title: 'Pokédex', desc: 'All 1025 Pokémon, plus practice modes. A fun corner — kept separate from your Worldly progress.' },
    { key: 'about', icon: 'info', title: 'About', desc: 'Credits, data sources & privacy.' },
  ];
  // Each category is its own tab instead of one long scrolling page.
  const tabs = [
    { id: 'play', label: 'Play', attr: 'data-go', cards: quickCards },
    { id: 'quizzes', label: 'Quizzes', attr: 'data-mode', cards: MODE_CARDS },
    { id: 'maps', label: 'Maps', attr: 'data-map', cards: MAP_CARDS },
    { id: 'explore', label: 'Explore', attr: 'data-go', cards: journeyCards },
  ];
  if (!tabs.some((t) => t.id === homeTab)) homeTab = 'play';

  // First-visit explainer — dismissed once, never shown again.
  const onboarding = !p.onboarded ? `
    <div class="callout" role="note">
      <strong>New here?</strong> Every answer teaches a real fact, and anything you get wrong
      comes back until it sticks. Play a set each day to keep a streak going — the world map
      above fills in with every country you get right.
      <div class="btn-row mt-10">
        <button class="btn primary" id="onboardGotIt">Got it</button>
        <button class="btn ghost" id="onboardMore">Learn more</button>
      </div>
    </div>` : '';

  app.innerHTML = `
    ${heroMarkup(p, dailyDone)}
    ${onboarding}
    <div class="tabs" role="tablist" aria-label="What to play">
      ${tabs.map((t) => `<button class="tab ${t.id === homeTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === homeTab}" tabindex="${t.id === homeTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    ${tabs.map((t) => `
      <div class="tab-panel ${t.id === homeTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
        <div class="grid">${t.cards.map((m) => homeCard(t.attr, m)).join('')}</div>
      </div>`).join('')}`;

  wireTabs((id) => { homeTab = id; });
  focusTitle(); // home doesn't use wireNav, so focus explicitly
  // world.svg is 1.2 MB. Kicking the fetch off during idle time rather than
  // immediately keeps it from competing with the first thing the player does —
  // tapping a tab or opening a mode — on the one screen where they are most
  // likely to do it straight away. data.js caches the parsed SVG, so this cost
  // is paid once per session at most.
  const gen = sessionGen;
  whenIdle(() => mountHeroMap(gen));
  const gotIt = app.querySelector('#onboardGotIt');
  if (gotIt) {
    gotIt.addEventListener('click', () => { setOnboarded(); app.querySelector('.callout').remove(); });
    app.querySelector('#onboardMore').addEventListener('click', () => { setOnboarded(); navigate('/about'); });
  }

  // Every card is a link now: clicking it changes the URL, and the route table
  // (see boot) turns that URL back into this same screen. Quiz/map cards carry a
  // mode key; the Play/Explore cards carry a data-go key mapped by GO_ROUTES.
  app.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => navigate('/quiz/' + b.dataset.mode)));
  app.querySelectorAll('[data-map]').forEach((b) =>
    b.addEventListener('click', () => navigate('/map/' + b.dataset.map)));
  app.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => navigate(GO_ROUTES[b.dataset.go] || '/')));
}

// Home Play/Explore cards (and the map-regions chooser) use short data-go keys;
// this is the one place they map to real URLs.
const GO_ROUTES = {
  mixed: '/quiz/mixed', challenge: '/quiz/challenge', daily: '/quiz/daily', review: '/quiz/review',
  religions: '/religions', map_regions: '/regions',
  phrases: '/phrases', flagkey: '/flags', music: '/music', crises: '/crises',
  languages: '/languages', hello: '/hello', countries: '/country',
  custom: '/custom', stats: '/stats', achievements: '/achievements', profile: '/profile', about: '/about',
  pokedex: '/pokedex',
};

// Start a quiz from a `/quiz/:mode` URL. Both a Home card and a direct deep link
// land here, so the key→options mapping lives in exactly one place.
function startQuizByKey(mode) {
  if (mode === 'mixed') return startQuiz({ title: 'Mixed Quiz', modes: ALL_MODES, total: 12 });
  if (mode === 'challenge') return startQuiz({ title: 'Challenge Mode', modes: ALL_MODES, total: 15, challenge: true });
  if (mode === 'daily') return startDaily();
  if (mode === 'review') return startReview();
  if (MODES[mode]) return startQuiz({ title: MODES[mode].label, modes: [mode], total: 10 });
  return navigate('/404', { replace: true });
}

// Start a click-the-map quiz from a `/map/:mode` URL, or open the region chooser
// at /map/regions (kept as an alias of /regions).
function startMapByKey(mode) {
  if (mode === 'regions') return showMapRegions();
  if (MAP_MODES[mode]) return startMapQuiz({ title: MAP_MODES[mode].label, mode, total: 10 });
  return navigate('/404', { replace: true });
}

// Client-rendered not-found. Without SSR the server returns the app shell at 200
// for any unmatched path (Cloudflare SPA fallback), so the router tags this view
// noindex (see router.js) rather than pretending it is a real 404 response.
function showNotFound() {
  leaveSession();
  clearTimer();
  app.innerHTML = `
    ${topNav()}
    <div class="question-card center-block">
      <span class="score">404</span>
      <p class="screen-sub">That page fell off the map.</p>
      <div class="btn-row mt-18"><a class="btn primary" href="/">${icon('back')}Back to Worldly</a></div>
    </div>`;
  wireNav();
}

// Detail routes (/phrases/:slug, /music/:slug, /crises/:slug). Each ensures its
// lazy dataset is loaded, finds the entry by re-slugifying its natural key, and
// renders the existing detail view — or falls back to the list (replace, so the
// dud slug does not linger in history) when a slug matches nothing.
async function routePhraseDetail(slug) {
  if (!(await ensureDataset('phrases'))) return;
  const entry = (getData().phrases || []).find((e) => slugify(e.country) === slug);
  if (!entry) return navigate('/phrases', { replace: true });
  document.title = `${entry.country} phrases — Worldly`;
  renderPhraseDetail(entry);
}
async function routeMusicDetail(slug) {
  if (!(await ensureDataset('music'))) return;
  const entry = (getData().music || []).find((e) => slugify(e.country) === slug);
  if (!entry) return navigate('/music', { replace: true });
  document.title = `${entry.country} music — Worldly`;
  renderMusicDetail(entry);
}
async function routeCrisisDetail(slug) {
  if (!(await ensureDataset('crises'))) return;
  const entry = (getData().crises || []).find((e) => slugify(e.title) === slug);
  if (!entry) return navigate('/crises', { replace: true });
  document.title = `${entry.title} — Worldly`;
  renderCrisisDetail(entry);
}

// ============================================================================
//  ABOUT  (credits, data sources, disclaimers, privacy)
// ============================================================================
function showAbout() {
  leaveSession();
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">About Worldly ℹ️</h1>
    <p class="screen-sub">A free, open-source learning game. Built with plain HTML, CSS and JavaScript — no accounts, no ads.</p>

    <div class="form-block">
      <h2>Privacy</h2>
      <p class="screen-sub">Your progress is stored only in this browser (localStorage) — Worldly has no accounts.
      We use Microsoft Clarity for anonymous usage analytics, which records how screens are used, to improve the game;
      no names, quiz answers or saved progress are ever sent. You can turn this off in
      <strong>Profile → Privacy</strong>, and it is off automatically if your browser sends a Do Not Track or Global
      Privacy Control signal. Flag images load from flagcdn.com, historic flags from
      Wikimedia Commons, and music plays through YouTube's privacy-enhanced player, which sets cookies only if you
      play a video.</p>
    </div>

    <div class="form-block">
      <h2>Credits &amp; data sources</h2>
      <ul class="about-list">
        <li>Interactive map SVGs adapted from the <a href="https://github.com/VictorCazanave/svg-maps" target="_blank" rel="noopener">@svg-maps</a> project by Victor Cazanave and contributors — world, Mexico and Canada maps are CC BY 4.0; the USA map is CC BY-NC 4.0 (non-commercial).</li>
        <li>Flag images served by <a href="https://flagcdn.com" target="_blank" rel="noopener">flagcdn.com</a>.</li>
        <li>Historic flag images from <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a>.</li>
        <li>Facts curated from public reference sources, including <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a> and the <a href="https://www.cia.gov/the-world-factbook/" target="_blank" rel="noopener">CIA World Factbook</a>.</li>
        <li>Music plays via embedded YouTube; all rights remain with the artists and labels.</li>
        <li>Pokédex data and sprites from <a href="https://pokeapi.co" target="_blank" rel="noopener">PokéAPI</a> and its
        <a href="https://github.com/PokeAPI/sprites" target="_blank" rel="noopener">sprite collection</a>.
        Pokémon and Pokémon character names are trademarks of Nintendo, Creatures Inc. and GAME FREAK Inc.
        The Pokédex here is an unofficial, non-commercial fan feature and is not affiliated with or endorsed by them.</li>
      </ul>
    </div>

    <div class="form-block">
      <h2>Feedback &amp; requests</h2>
      <p class="screen-sub">Found a bug, spotted a wrong fact, or want a new mode?
      <a href="https://github.com/IBR10/worldly/issues/new" target="_blank" rel="noopener">Open an issue on GitHub ↗</a>
      — data corrections are especially welcome.</p>
    </div>

    <div class="form-block">
      <h2>Editorial notes</h2>
      <ul class="about-list">
        <li>"Primary language" and "largest religion" are deliberate simplifications of plural realities — they reflect the single most common answer for quiz purposes, not the full picture.</li>
        <li>Historic flags are shown for educational context only and imply no endorsement of any regime or movement.</li>
        <li>Crises &amp; Events summaries are curated background written at a point in time (dated on each entry), not live reporting — follow the linked sources for current developments.</li>
        <li>Spotted an error? Everything lives in open JSON data files — corrections are welcome on GitHub.</li>
      </ul>
    </div>

    <div class="btn-row"><button class="btn ghost" id="backHome">${icon('back')}Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  QUIZ
// ============================================================================

// Builds a fully-local question engine (real .answer/.funFact/.learnMore on
// every question) from the same opts a quiz was started with. Used both for
// the normal local-only path below, and to swap a remote Challenge/Daily
// session onto genuinely-answerable questions if the connection drops
// mid-run (the remaining pre-fetched remote questions never carry answers —
// that data only exists server-side — so there is nothing to "fall back to"
// in that array once the server round trip has failed).
function buildLocalEngine(opts) {
  const { modes, continents = 'all', difficulty = 'medium', daily = false, reviewIds = null, seed = null, religionFilter = null } = opts;
  const data = getData();
  const rng = seed != null ? seededRng(seed) : Math.random;
  const config = { modes, continents, difficulty, choices: 4, rng, religionFilter };
  // Daily uses plain seeded picking (same for everyone); other modes use SRS
  // weighting so forgotten/missed items resurface more often.
  const pick = daily ? null : (pool, srsMap) => pickWeighted(pool, srsMap, rng);
  return createQuiz({ data, config, srsMap: getProfile().srs, reviewIds, pick, rng });
}

async function startQuiz(opts) {
  // Only the fields this function itself reads are destructured; the pool
  // options (modes/continents/difficulty/reviewIds/seed/religionFilter) are
  // consumed by buildLocalEngine(opts) below, which re-reads them from `opts`
  // and applies its own defaults.
  const { title, total = 10, challenge = false, daily = false, input = 'mcq' } = opts;

  // Every call — sync or async — stamps its own generation up front, so a
  // synchronous call (e.g. Mixed Quiz) correctly invalidates an earlier
  // still-in-flight async Challenge/Daily attempt when it later resolves.
  const myGen = ++sessionGen;

  // Challenge/Daily attempt a server-verified session first, so the score is
  // eligible for the global leaderboard. Everything else (and any failure
  // below) uses the existing fully-local engine, unchanged.
  if (challenge) {
    let remote = null;
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: daily ? 'daily' : 'challenge' }),
      });
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) remote = parsed;
      }
    } catch {
      remote = null;
    }
    if (myGen !== sessionGen) return; // player already navigated away

    if (remote) {
      track('quiz_started');
      track(daily ? 'daily_challenge_started' : 'challenge_started');
      tag('mode', title);
      let nextIndex = 0;
      const engine = {
        size: remote.questions.length,
        next() { return nextIndex < remote.questions.length ? remote.questions[nextIndex++] : null; },
      };
      S = {
        title, engine, total: remote.questions.length, challenge, daily, input, lastOpts: opts,
        index: 0, correct: 0, runStreak: 0, runBest: 0, xpRun: 0,
        missed: [], startTime: Date.now(), phase: 'answer', current: null,
        timer: null, multiplier: 1,
        remote: true, sessionId: remote.sessionId,
      };
      renderQuestion();
      return;
    }
    // Fall through to the fully-local path below on any failure.
  }

  const engine = buildLocalEngine(opts);

  if (engine.size === 0) {
    toast('warning', 'Nothing to quiz', 'That selection has no questions yet.');
    return;
  }

  track('quiz_started');
  if (challenge) track(daily ? 'daily_challenge_started' : 'challenge_started');
  tag('mode', title);

  S = {
    title, engine, total: Math.min(total, engine.size), challenge, daily, input, lastOpts: opts,
    index: 0, correct: 0, runStreak: 0, runBest: 0, xpRun: 0,
    missed: [], startTime: Date.now(), phase: 'answer', current: null,
    timer: null, multiplier: 1,
    remote: false, sessionId: null,
  };
  renderQuestion();
}

function startDaily() {
  startQuiz({ title: 'Daily Challenge', modes: ALL_MODES, total: 10, challenge: true, daily: true, seed: dailySeed() });
}

function startReview() {
  const ids = reviewableMissedIds();
  if (ids.length === 0) {
    toast('check', 'No missed questions', 'Great — your review pile is empty!');
    return;
  }
  track('review_missed_used');
  startQuiz({ title: 'Review Missed', modes: ALL_MODES, total: Math.min(ids.length, 20), reviewIds: ids });
}

// World Religions chooser: study every faith, or focus on a single one.
function showReligions() {
  leaveSession();
  const faiths = (getData().religions || []).map((r) => r.name);
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">World Religions</h1>
    <p class="screen-sub">Founders, sacred texts and major holidays. Study every faith, or focus on just one.</p>
    <div class="form-block">
      <h2>Choose a faith</h2>
      <select id="faithSel" class="select">
        <option value="">All faiths</option>
        ${faiths.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
      </select>
    </div>
    <div class="btn-row">
      <button class="btn primary" id="startRel">▶ Start</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelector('#startRel').addEventListener('click', () => {
    const val = app.querySelector('#faithSel').value;
    startQuiz({
      title: val ? `World Religions — ${val}` : 'World Religions',
      modes: RELIGION_MODES, total: 10, religionFilter: val || null,
    });
  });
}

// Regions & Continents chooser: pick a continent or a finer subregion (e.g.
// "Middle East", "Central America") + a world-map mode, then play it zoomed
// into just that area (see startMapQuiz's `continent` handling).
function showMapRegions() {
  leaveSession();
  const continents = getContinents();
  const subregions = getSubregions();
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Regions &amp; Continents</h1>
    <p class="screen-sub">Pick a continent or region — the map zooms in so you're only looking at that part of the world.</p>
    <div class="form-block">
      <h2>Continent / Region</h2>
      <select id="contSel" class="select">
        <optgroup label="Continents">
          ${continents.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </optgroup>
        <optgroup label="Regions">
          ${subregions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        </optgroup>
      </select>
    </div>
    <div class="form-block">
      <h2>Mode</h2>
      <select id="modeSel" class="select">
        ${WORLD_MAP_MODES.map((m) => `<option value="${m}">${esc(MAP_MODES[m].label)}</option>`).join('')}
      </select>
    </div>
    <div class="btn-row">
      <button class="btn primary" id="startRegion">▶ Start</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelector('#startRegion').addEventListener('click', () => {
    const continent = app.querySelector('#contSel').value;
    const mode = app.querySelector('#modeSel').value;
    startMapQuiz({ title: `${MAP_MODES[mode].label} — ${continent}`, mode, continent, total: 10 });
  });
}

// ============================================================================
//  MAP QUIZ (click-the-map modes)
// ============================================================================
async function startMapQuiz(opts) {
  const { title, mode, total = 10, continent = null } = opts;
  const svgName = MAP_MODES[mode]?.svg;
  if (!svgName) return;

  // Starting a map quiz supersedes whatever screen/session was active. The SVG
  // fetch below can take a while, so we stamp this attempt with the current
  // generation and re-check it after every await — if the player has since
  // left (Home, another mode, etc.) sessionGen will have moved on and this
  // stale load must NOT hijack whatever screen they're looking at now.
  const myGen = ++sessionGen;
  app.innerHTML = '<p class="screen-sub">Loading the map…</p>';
  let map;
  try {
    map = await loadMap(svgName);
  } catch (err) {
    if (myGen !== sessionGen) return; // player already navigated away
    toast('warning', "Couldn't load the map", err.message);
    return navigate('/', { replace: true });
  }
  if (myGen !== sessionGen) return; // player already navigated away

  const data = getData();
  const pool = buildMapPool(data, { [svgName]: map.regions }, { modes: [mode], continent });
  if (pool.length === 0) {
    toast('warning', 'Nothing to quiz', 'That map has no questions yet.');
    return navigate('/', { replace: true });
  }

  // Zoom the map view to the chosen area's countries (a broad continent like
  // "Asia" or a finer subregion like "Middle East"). Only meaningful for
  // country-sourced (world map) modes — US/MX/CA state modes have no continent.
  const focusIds = (continent && MAP_MODES[mode]?.source === 'country')
    ? data.countries.filter((c) => (c.region === continent || c.subregion === continent) && c.iso2 && map.regions[c.iso2.toLowerCase()])
        .map((c) => c.iso2.toLowerCase())
    : null;

  track('map_mode_started');
  tag('mode', title);

  // Inline SRS-weighted engine mirroring createQuiz's interface. Uses the shared
  // no-repeat sampler so a map session never asks the same region twice.
  const state = { asked: new Set(), lastId: null };
  const engine = {
    size: pool.length,
    next() {
      const item = drawWithoutRepeat(pool, state, { pick: (p) => pickWeighted(p, getProfile().srs, Math.random) });
      return item ? makeMapQuestion(item, { data, rng: Math.random }) : null;
    },
  };

  S = {
    kind: 'map', title, engine, total: Math.min(total, pool.length), challenge: false, daily: false,
    lastOpts: opts, index: 0, correct: 0, runStreak: 0, runBest: 0, xpRun: 0,
    missed: [], startTime: Date.now(), phase: 'answer', current: null, timer: null, multiplier: 1,
    svgText: map.svgText, mapView: null, focusIds,
  };
  renderQuestion();
}

// The progress header for every question renderer (MCQ, typed, click-the-map,
// reverse map). It used to be duplicated in all four, which is why the progress
// bug below had to be fixed in four places -- and so never was.
function quizChrome() {
  const multiPill = S.challenge
    ? `<span class="pill" title="Score multiplier">×<strong class="accent">${S.multiplier.toFixed(1)}</strong></span>`
    : '';
  return `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Quit quiz" aria-label="Quit quiz">${icon('close')}</button>
      <div class="progress"><span></span></div>
      <span class="pill" title="Question ${S.index + 1} of ${S.total}"><strong>${S.index + 1}</strong>/${S.total}</span>
      <span class="pill fire" title="Streak this run">${icon('flame')}<strong>${S.runStreak}</strong></span>
      ${multiPill}
      <span class="pill" title="XP this run">XP <strong>${S.xpRun}</strong></span>
    </div>`;
}

// S.index counts ANSWERED questions -- answer() increments it before calling
// renderFeedback() -- so S.index/S.total is the right fraction at both phases.
// The bug was never the formula: the width was only ever set while rendering a
// *question*, so the bar sat at 0% through the whole first question, still read
// 0% on its feedback screen, and could never reach 100%. renderFeedback() now
// calls this too.
function syncQuizProgress() {
  const bar = app.querySelector('.progress > span');
  if (bar) bar.style.width = Math.round((S.index / S.total) * 100) + '%';
}

function renderMapQuestion(q) {
  app.innerHTML = `
    ${quizChrome()}
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${q.flagIso ? `<img decoding="async" class="q-flag" alt="Flag to locate" src="${flagUrl(q.flagIso)}">` : ''}
      <h1 class="q-prompt">${esc(q.prompt)}</h1>
      <div id="mapMount" class="map-mount"></div>
      <div id="feedback" role="status"></div>
    </div>`;

  syncQuizProgress();
  app.querySelector('#quitBtn').addEventListener('click', () => navigate('/'));
  wireFlagFallback();
  S.mapView = createMapView({ svgText: S.svgText, onPick: (id) => mapAnswer(id), focusIds: S.focusIds });
  app.querySelector('#mapMount').appendChild(S.mapView.el);
  renderHUD();
}

function mapAnswer(clickedId) {
  if (S.phase !== 'answer') return;
  S.phase = 'feedback';
  const q = S.current;
  const correct = clickedId === q.targetId;
  S.mapView.reveal(clickedId, q.targetId);

  const res = recordAnswer(q, correct, {});
  track('map_guess_made');
  track('question_answered');
  S.index += 1;
  if (correct) {
    S.correct += 1;
    S.runStreak += 1;
    S.runBest = Math.max(S.runBest, S.runStreak);
    S.xpRun += res.xpGained;
  } else {
    S.runStreak = 0;
    S.missed.push(q);
  }

  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  if (res.levelledUp) toast('levelUp', `Level ${res.level}!`, levelTitle(getProfile().xp));
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  renderFeedback(correct, q, res.xpGained);
  renderHUD();
}

// Reverse map mode: the target region is highlighted on a display-only map and
// the player picks its name from multiple choice (reuses the MCQ answer flow).
function renderReverseMapQuestion(q) {
  app.innerHTML = `
    ${quizChrome()}
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      <h1 class="q-prompt">${esc(q.prompt)}</h1>
      <div id="mapMount" class="map-mount"></div>
      <div class="choices" id="choices">
        ${q.choices.map((c, i) => q.flagChoices
          ? `<button class="choice choice-flag" data-val="${esc(c)}" aria-label="Flag of ${esc(c)}">
               <span class="key">${i + 1}</span><img decoding="async" src="${flagUrl(q.flagByName[c], 'w160')}" alt="Flag of ${esc(c)}">
             </button>`
          : `<button class="choice" data-val="${esc(c)}">
               <span class="key">${i + 1}</span><span>${esc(c)}</span>
             </button>`).join('')}
      </div>
      <div id="feedback" role="status"></div>
    </div>`;
  syncQuizProgress();
  app.querySelector('#quitBtn').addEventListener('click', () => navigate('/'));
  if (q.flagChoices) wireFlagFallback('.choice-flag img');
  S.mapView = createMapView({ svgText: S.svgText, highlightId: q.highlightId, interactive: false, focusIds: S.focusIds });
  app.querySelector('#mapMount').appendChild(S.mapView.el);
  app.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => answer(b.dataset.val)));
  renderHUD();
}

// Dispatcher: pulls the next question and routes to the right renderer for the
// session kind (multiple-choice quiz vs. click-the-map).
function renderQuestion() {
  if (S.index >= S.total) return finishQuiz();
  const q = S.engine.next();
  if (!q) return finishQuiz();
  S.current = q;
  S.phase = 'answer';
  if (S.kind === 'map') { q.reverse ? renderReverseMapQuestion(q) : renderMapQuestion(q); }
  else if (S.input === 'type') { renderTypedQuestion(q); return; } // keeps focus on the input
  else renderMcqQuestion(q);
  focusTitle(); // announce the new question to assistive tech
}

function renderMcqQuestion(q) {
  const flagSrc = q.flagIso ? flagUrl(q.flagIso) : (q.flagImg ? historicFlagUrl(q.flagImg) : null);
  const flag = flagSrc ? `<img decoding="async" class="q-flag" alt="Flag to identify" src="${flagSrc}">` : '';

  app.innerHTML = `
    ${quizChrome()}
    ${S.challenge ? '<div class="timer" id="timer"><span></span></div>' : ''}
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${flag}
      <h1 class="q-prompt">${esc(q.prompt)}</h1>
      <div class="choices" id="choices">
        ${q.choices.map((c, i) => `
          <button class="choice" data-val="${esc(c)}">
            <span class="key">${i + 1}</span><span>${esc(c)}</span>
          </button>`).join('')}
      </div>
      <div id="feedback" role="status"></div>
    </div>`;

  syncQuizProgress();
  app.querySelector('#quitBtn').addEventListener('click', () => navigate('/'));
  app.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => answer(b.dataset.val)));
  wireFlagFallback();

  if (S.challenge) startTimer();
  renderHUD();
}

function startTimer() {
  const seconds = 10;
  const bar = document.getElementById('timer');
  const span = bar.querySelector('span');
  S.timeLeft = seconds * 1000;
  const tick = 100;
  // Faster answers / longer streaks in challenge mode earn a bigger multiplier.
  S.multiplier = 1 + Math.min(2, S.runStreak * 0.2);
  S.timer = setInterval(() => {
    S.timeLeft -= tick;
    const pct = Math.max(0, (S.timeLeft / (seconds * 1000)) * 100);
    span.style.width = pct + '%';
    bar.classList.toggle('low', pct < 30);
    if (S.timeLeft <= 0) {
      clearTimer();
      answer(null); // timed out → counts as wrong
    }
  }, tick);
}
function clearTimer() {
  if (S && S.timer) { clearInterval(S.timer); S.timer = null; }
}

// A flag question is unanswerable without its image (e.g. flagcdn unreachable),
// so on load failure show an explicit message instead of silently hiding it.
function wireFlagFallback(selector = '.q-flag') {
  app.querySelectorAll(selector).forEach((img) => {
    img.addEventListener('error', () => {
      const d = document.createElement('div');
      d.className = 'q-flag-missing';
      d.textContent = "The flag image couldn't load — check your connection, then try the next question.";
      img.replaceWith(d);
    });
  });
}

// Review sessions rebuild questions through the MCQ engine, which only knows
// quiz modes. Map-mode misses (ids like "map_us:Texas") are practiced by
// replaying the map modes instead, so they're excluded from Review Missed.
/**
 * Make sure an on-demand Explore dataset is present before rendering a screen
 * that needs it. Shows a placeholder while fetching and, like startMapQuiz,
 * checks the session generation afterwards so a slow response can never
 * overwrite a screen the player has already moved on from.
 * @returns {Promise<boolean>} false when the caller should stop rendering.
 */
async function ensureDataset(name) {
  // Most datasets are arrays, but pokemon_types.json is a keyed object (the
  // type-effectiveness chart), and `?.length` on an object is undefined — which
  // reads as "not loaded", so the Loading… placeholder reappeared and
  // sessionGen was bumped on every single visit to the screen.
  const loaded = getData()[name];
  if (Array.isArray(loaded) ? loaded.length > 0 : !!loaded) return true;
  const myGen = ++sessionGen;
  app.innerHTML = '<p class="screen-sub">Loading…</p>';
  try {
    await loadDataset(name);
  } catch (err) {
    if (myGen !== sessionGen) return false;
    toast('warning', "Couldn't load that section", err.message);
    navigate('/', { replace: true });
    return false;
  }
  return myGen === sessionGen;
}

function reviewableMissedIds() {
  return Object.keys(getProfile().missed).filter((id) => MODES[id.split(':')[0]]);
}

async function answer(value) {
  if (S.phase !== 'answer') return;
  clearTimer();
  S.phase = 'feedback';
  const q = S.current;
  const myGen = sessionGen;

  let correct, xpGained;
  if (S.remote) {
    try {
      const res = await fetch('/api/session/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: S.sessionId, questionId: q.id, value }),
      });
      if (myGen !== sessionGen) return; // player already navigated away
      if (!res.ok) throw new Error('grade_failed');
      const graded = await res.json();
      correct = graded.correct;
      q.answer = graded.correctAnswer;
      q.funFact = graded.funFact;
      q.history = graded.history;
      q.symbolImg = graded.symbolImg;
      q.learnMore = graded.learnMore;
      xpGained = graded.xpGained;
    } catch {
      if (myGen !== sessionGen) return; // player already navigated away
      S.remote = false;
      correct = false; // this one question's grade is lost with the dropped request
      xpGained = 0;
      // The server never sent this question's answer/fact/links (that's the
      // whole security point), and the request that would have revealed them
      // just failed — fill in safe placeholders so the feedback screen can
      // still render instead of crashing on an undefined field.
      q.answer = q.answer ?? '(connection lost — not graded)';
      q.funFact = q.funFact ?? "This question wasn't graded — the connection dropped before the server could reveal it.";
      q.learnMore = q.learnMore ?? [];
      // The remaining pre-fetched remote questions have no answer data (and
      // never will — the server never sends it), so the rest of this run
      // must come from a fresh, genuinely-answerable local pool instead of
      // continuing to pull from that array.
      S.engine = buildLocalEngine(S.lastOpts);
      toast('signalOff', 'Connection lost', "Switched to local scoring — this run won't count for the global board.");
    }
  } else {
    correct = value === q.answer;
    xpGained = S.challenge ? sessionQuestionXp(S.runStreak, correct) : 0;
  }

  const multiplier = S.challenge ? challengeMultiplier(S.runStreak) : 1;
  // visually mark choices
  app.querySelectorAll('.choice').forEach((b) => {
    b.disabled = true;
    if (b.dataset.val === q.answer) b.classList.add('correct');
    else if (b.dataset.val === value) b.classList.add('wrong');
  });

  const res = recordAnswer(q, correct, { multiplier });
  S.index += 1;
  if (correct) {
    S.correct += 1;
    S.runStreak += 1;
    S.runBest = Math.max(S.runBest, S.runStreak);
  } else {
    S.runStreak = 0;
    S.missed.push(q);
  }
  S.xpRun += S.challenge ? xpGained : res.xpGained;

  // achievements & level-ups
  track('question_answered');
  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  if (res.levelledUp) toast('levelUp', `Level ${res.level}!`, levelTitle(getProfile().xp));
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  renderFeedback(correct, q, S.challenge ? xpGained : res.xpGained);
  renderHUD();
}

// Typed-answer mode: same questions as MCQ, but the player types the answer and
// it's checked with accent/case-insensitive matching (answerMatches).
function renderTypedQuestion(q) {
  const flagSrc = q.flagIso ? flagUrl(q.flagIso) : (q.flagImg ? historicFlagUrl(q.flagImg) : null);
  const flag = flagSrc ? `<img decoding="async" class="q-flag" alt="Flag to identify" src="${flagSrc}">` : '';
  app.innerHTML = `
    ${quizChrome()}
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${flag}
      <h1 class="q-prompt" id="qPrompt">${esc(q.prompt)}</h1>
      <form class="type-form" id="typeForm" autocomplete="off">
        <input class="type-input" id="typeInput" type="text" placeholder="Type your answer…"
               aria-labelledby="qPrompt" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <button class="btn primary" type="submit">Submit</button>
      </form>
      <div id="feedback" role="status"></div>
    </div>`;
  syncQuizProgress();
  app.querySelector('#quitBtn').addEventListener('click', () => navigate('/'));
  wireFlagFallback();
  const form = app.querySelector('#typeForm');
  const inp = app.querySelector('#typeInput');
  form.addEventListener('submit', (e) => { e.preventDefault(); answerTyped(inp.value); });
  inp.focus();
  renderHUD();
}

// MCQ-only: typed input never coexists with challenge:true (Custom Study is
// the only caller, and it never sets challenge). Remote/session-verified
// scoring lives entirely in answer() — if a typed Challenge mode is ever
// added, that logic needs to be ported here too, not assumed to apply.
function answerTyped(value) {
  if (S.phase !== 'answer') return;
  clearTimer();
  S.phase = 'feedback';
  const q = S.current;
  const correct = answerMatches(value, q.answer);
  const inp = document.getElementById('typeInput');
  if (inp) { inp.disabled = true; inp.classList.add(correct ? 'correct' : 'wrong'); }

  const res = recordAnswer(q, correct, {});
  track('question_answered');
  S.index += 1;
  if (correct) {
    S.correct += 1;
    S.runStreak += 1;
    S.runBest = Math.max(S.runBest, S.runStreak);
    S.xpRun += res.xpGained;
  } else {
    S.runStreak = 0;
    S.missed.push(q);
  }

  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  if (res.levelledUp) toast('levelUp', `Level ${res.level}!`, levelTitle(getProfile().xp));
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  renderFeedback(correct, q, res.xpGained);
  renderHUD();
}

function renderFeedback(correct, q, xpGained) {
  const fb = document.getElementById('feedback');
  const links = q.learnMore.filter((l) => l.url)
    .map((l) => `<a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  fb.className = `feedback ${correct ? 'ok' : 'no'} pop`;
  const symbol = q.symbolImg
    ? `<div class="symbol-img-wrap"><img decoding="async" src="${symbolImageUrl(q.symbolImg)}" alt="${esc(q.answer)} symbol"></div>`
    : '';
  fb.innerHTML = `
    <h2>${correct ? `✓ Correct! +${xpGained} XP` : `✗ The answer is ${esc(q.answer)}`}</h2>
    ${symbol}
    <div class="fact"><strong>Fun fact:</strong> ${esc(q.funFact)}</div>
    ${q.history ? `<div class="fact"><strong>History:</strong> ${esc(q.history)}</div>` : ''}
    ${q.source?.note ? `<div class="fact muted">${esc(q.source.note)}</div>` : ''}
    <div><span class="muted-note">Learn more:</span>
      <div class="learn-more">${links}</div></div>
    <div class="btn-row mt-14">
      <button class="btn primary" id="nextBtn">${S.index >= S.total ? 'See results' : 'Next question'}</button>
    </div>`;
  // The question just answered now counts toward progress. Without this the bar
  // only ever moved when the NEXT question rendered, so it read 0% for the
  // whole of question 1 and never reached 100%.
  syncQuizProgress();
  const nextBtn = document.getElementById('nextBtn');
  nextBtn.addEventListener('click', renderQuestion);
  nextBtn.focus({ preventScroll: true });
  // On the tall click-the-map screens the result can sit below the fold; make
  // sure the "answer + Next" panel is scrolled into view so the flow is obvious.
  fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function finishQuiz() {
  clearTimer();
  recordStudyTime(Date.now() - S.startTime);
  const acc = S.total ? Math.round((S.correct / S.total) * 100) : 0;
  const score = S.xpRun;
  const perfect = S.total >= 10 && S.correct === S.total;
  if (perfect) recordPerfectQuiz();
  if (S.daily) markDailyComplete(score);
  else if (S.challenge) addLeaderboard(score, 'Challenge');
  track('quiz_completed');
  if (S.daily) track('daily_challenge_completed');
  else if (S.challenge) track('challenge_completed');
  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  const missedList = S.missed.length
    ? `<div class="section-h">Worth another look</div>
       <ul class="weak-list">${S.missed.map((q) => `<li><span>${esc(q.prompt)}</span><span class="ans">${esc(q.answer)}</span></li>`).join('')}</ul>`
    : `<p class="screen-sub">A flawless run — nothing to review.</p>`;

  const lastOpts = S.lastOpts;
  const wasMap = S.kind === 'map';
  const wasRemote = S.remote && S.challenge;
  const sessionId = S.sessionId;
  app.innerHTML = `
    ${topNav()}
    <div class="question-card result-hero">
      <span class="score">${S.correct}/${S.total}</span>
      <div class="sub">${acc}% accuracy · +${score} XP · best streak ${S.runBest}${perfect ? ' · perfect round' : ''}</div>
      ${wasRemote ? '<div class="screen-sub" id="globalSyncNote">Syncing to the global leaderboard…</div>' : ''}
    </div>
    ${missedList}
    <div class="btn-row mt-18">
      <button class="btn primary" id="againBtn">Play again</button>
      ${S.missed.length ? '<button class="btn" id="reviewBtn">Review these now</button>' : ''}
      <button class="btn ghost" id="homeBtn">${icon('back')}Home</button>
    </div>`;

  wireNav();
  document.getElementById('againBtn').addEventListener('click', () => (wasMap ? startMapQuiz(lastOpts) : startQuiz(lastOpts)));
  document.getElementById('homeBtn').addEventListener('click', () => navigate('/'));
  const rb = document.getElementById('reviewBtn');
  if (rb) rb.addEventListener('click', () => navigate('/quiz/review'));
  renderHUD();

  if (wasRemote) submitToGlobalLeaderboard(sessionId);
  submitLifetimeXp();
}

// Background sync of the player's lifetime XP total (every quiz mode, not
// just Challenge/Daily — see functions/api/xp.js for why this can't be
// verified server-side the way the other leaderboard tabs are). Best-effort:
// no UI feedback, silent on failure.
let lastSyncedXp = null;
function submitLifetimeXp() {
  const p = getProfile();
  // A player who has not scored yet has nothing to place on the board, and a
  // zero-XP row is a write spent to say nothing.
  if (!p.xp) return Promise.resolve(false);
  // Nothing to report when the total has not moved (a run with no correct
  // answers, say). Every skipped call is one fewer write against the free tier.
  if (p.xp === lastSyncedXp) return Promise.resolve(false);
  lastSyncedXp = p.xp;
  return fetch('/api/xp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: p.playerId, name: p.name, xp: p.xp }),
  })
    .then((res) => res.ok)
    .catch(() => { lastSyncedXp = null; return false; }); // allow the next run to retry
}

async function submitToGlobalLeaderboard(sessionId) {
  const myGen = sessionGen;
  const note = document.getElementById('globalSyncNote');
  try {
    const res = await fetch('/api/session/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, name: getProfile().name }),
    });
    if (myGen !== sessionGen) return; // player already left the results screen
    if (!res.ok) throw new Error('finish_failed');
    const result = await res.json();
    if (note) note.textContent = `Synced — you're #${result.rank} of ${result.total} globally.`;
  } catch {
    if (myGen === sessionGen && note) note.textContent = '';
  }
}

// ============================================================================
//  CUSTOM STUDY
// ============================================================================
function showCustom() {
  leaveSession();
  const continents = getContinents();
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Custom Study</h1>
    <p class="screen-sub">Tailor a session to exactly what you want to practice.</p>

    <div class="form-block">
      <h2>Question types</h2>
      <div class="checks" id="modeChecks">
        ${ALL_MODES.map((m) => `<label class="check"><input type="checkbox" value="${m}" checked>${esc(MODES[m].label)}</label>`).join('')}
      </div>
    </div>

    <div class="form-block">
      <h2>Continents <span class="muted-note">(country modes only)</span></h2>
      <div class="checks" id="contChecks">
        ${continents.map((c) => `<label class="check"><input type="checkbox" value="${esc(c)}" checked>${esc(c)}</label>`).join('')}
      </div>
    </div>

    <div class="form-block">
      <h2>Difficulty</h2>
      <div class="seg" id="diffSeg">
        <button data-d="easy">Easy</button>
        <button data-d="medium" class="active">Medium</button>
        <button data-d="hard">Hard</button>
      </div>
      <h2 class="mt-16">Length</h2>
      <div class="seg" id="lenSeg">
        <button data-n="10" class="active">10</button>
        <button data-n="20">20</button>
        <button data-n="30">30</button>
      </div>
      <h2 class="mt-16">Answer input</h2>
      <div class="seg" id="inputSeg">
        <button data-i="mcq" class="active">Multiple choice</button>
        <button data-i="type">Type it</button>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn primary" id="startCustom">▶ Start session</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();

  let difficulty = 'medium', length = 10, input = 'mcq';
  app.querySelectorAll('#diffSeg button').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('#diffSeg button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); difficulty = b.dataset.d;
  }));
  app.querySelectorAll('#lenSeg button').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('#lenSeg button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); length = parseInt(b.dataset.n, 10);
  }));
  app.querySelectorAll('#inputSeg button').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('#inputSeg button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); input = b.dataset.i;
  }));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelector('#startCustom').addEventListener('click', () => {
    const modes = [...app.querySelectorAll('#modeChecks input:checked')].map((i) => i.value);
    const conts = [...app.querySelectorAll('#contChecks input:checked')].map((i) => i.value);
    if (modes.length === 0) return toast('warning', 'Pick at least one question type');
    startQuiz({ title: 'Custom Study', modes, continents: conts.length ? conts : 'all', difficulty, total: length, input });
  });
}

// ============================================================================
//  FLAG KEY  (browsable reference: every country / US state / Mexican state,
//  with its flag and name — not a quiz, just a legend to look things up in)
// ============================================================================
let flagKeyTab = 'countries';
const flagKeySearch = { countries: '', us: '', mx: '', ca: '' };
const flagKeyRegion = { countries: '', us: '', mx: '', ca: '' };

function showFlagKey() {
  leaveSession();
  const data = getData();
  const groups = [
    { id: 'countries', label: 'Countries', list: data.countries, flagFn: (x) => flagUrl(x.iso2, 'w80') },
    { id: 'us', label: 'US States', list: data.usStates, flagFn: (x) => stateFlagUrl(x.flag) },
    { id: 'mx', label: 'Mexican States', list: data.mxStates, flagFn: (x) => stateFlagUrl(x.flag) },
    { id: 'ca', label: 'Canadian Provinces', list: data.caStates, flagFn: (x) => stateFlagUrl(x.flag) },
  ];
  if (!groups.some((g) => g.id === flagKeyTab)) flagKeyTab = 'countries';

  // Controls only — the grid starts empty and is filled by populate() for the
  // active tab alone. Building all four grids up front (and hiding three with
  // display:none) still downloads every image: 251 requests on open.
  const panelFor = (g) => {
    const regions = getRegions(g.list);
    const region = flagKeyRegion[g.id];
    return `
      <div class="form-block filter-bar">
        <input type="text" class="type-input flagkey-search" data-group="${g.id}" placeholder="Search ${esc(g.label.toLowerCase())}…" value="${esc(flagKeySearch[g.id])}">
        <select class="select flagkey-region" data-group="${g.id}" aria-label="Filter by region">
          <option value="">All regions</option>
          ${regions.map((r) => `<option value="${esc(r)}"${r === region ? ' selected' : ''}>${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div class="grid flagkey-grid" data-group="${g.id}"></div>
      <p class="screen-sub flagkey-empty hidden" data-group="${g.id}">No matches.</p>`;
  };

  // Search/region state lives on the card as data-*, so filtering is a class
  // toggle rather than a rebuild. Rebuilding discarded and recreated up to 251
  // <img> elements per keystroke, which is what made typing cost ~1.6s.
  const cardFor = (g, x) => `
    <div class="card flagkey-card" data-name="${esc(String(x.name).toLowerCase())}" data-region="${esc(x.region || '')}">
      <img class="emoji-flag" alt="" loading="lazy" decoding="async" src="${g.flagFn(x)}">
      <span class="card-title">${esc(x.name)}</span>
      <span class="card-desc">${esc(x.capital)}</span>
    </div>`;

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Flag Key</h1>
    <p class="screen-sub">A browsable reference — every country, US state, Mexican state and Canadian province, by flag and name. Not a quiz.</p>

    <div class="tabs" role="tablist">
      ${groups.map((g) => `<button class="tab ${g.id === flagKeyTab ? 'active' : ''}" role="tab" id="tab-${g.id}" aria-controls="panel-${g.id}" aria-selected="${g.id === flagKeyTab}" tabindex="${g.id === flagKeyTab ? 0 : -1}" data-tab="${g.id}">${esc(g.label)}</button>`).join('')}
    </div>

    ${groups.map((g) => `
      <div class="tab-panel ${g.id === flagKeyTab ? 'active' : ''}" data-panel="${g.id}" id="panel-${g.id}" role="tabpanel" aria-labelledby="tab-${g.id}">
        ${panelFor(g)}
      </div>`).join('')}

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;

  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));

  const panelOf = (id) => app.querySelector(`.tab-panel[data-panel="${id}"]`);

  /** Build a tab's cards once, the first time that tab is shown. */
  function populate(id) {
    const grid = panelOf(id).querySelector('.flagkey-grid');
    if (grid.childElementCount) return;
    const g = groups.find((x) => x.id === id);
    grid.innerHTML = g.list.map((x) => cardFor(g, x)).join('');
    // A flag Commons/flagcdn cannot serve would otherwise render as a broken
    // image icon. This replaces an inline onerror= handler, which never ran:
    // the CSP has no unsafe-inline, so inline handlers are dead on arrival.
    grid.querySelectorAll('img').forEach((img) =>
      img.addEventListener('error', () => img.classList.add('hidden')));
    applyFilter(id);
  }

  /** Show/hide already-rendered cards. No markup is regenerated. */
  function applyFilter(id) {
    const panel = panelOf(id);
    const term = flagKeySearch[id].trim().toLowerCase();
    const region = flagKeyRegion[id];
    let shown = 0;
    panel.querySelectorAll('.flagkey-card').forEach((card) => {
      const match = (!term || card.dataset.name.includes(term))
        && (!region || card.dataset.region === region);
      card.classList.toggle('hidden', !match);
      if (match) shown++;
    });
    panel.querySelector('.flagkey-empty').classList.toggle('hidden', shown > 0);
  }

  groups.forEach((g) => {
    const panel = panelOf(g.id);
    const runFilter = debounce(() => applyFilter(g.id));
    panel.querySelector('.flagkey-search').addEventListener('input', (e) => {
      flagKeySearch[g.id] = e.target.value;
      runFilter();
    });
    panel.querySelector('.flagkey-region').addEventListener('change', (e) => {
      flagKeyRegion[g.id] = e.target.value;
      applyFilter(g.id);
    });
  });

  wireTabs((id) => { flagKeyTab = id; populate(id); });
  populate(flagKeyTab);
}

// ============================================================================
//  PHRASES  (browse common phrases & popular local sayings by country)
// ============================================================================
async function showPhrases() {
  leaveSession();
  if (!(await ensureDataset('phrases'))) return;
  const entries = getData().phrases || [];
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Phrases</h1>
    <p class="screen-sub">Pick a country to learn a few common phrases — and the sayings locals actually use. Tap the speaker to hear them.</p>
    <div class="grid">
      ${entries.map((e) => `
        <button class="card" data-country="${esc(e.country)}">
          <img decoding="async" class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
          <span class="card-title">${esc(e.country)}</span>
          <span class="card-desc">${esc(e.language)}</span>
        </button>`).join('')}
    </div>
    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelectorAll('[data-country]').forEach((b) =>
    b.addEventListener('click', () => navigate('/phrases/' + slugify(b.dataset.country))));
}

// A small speaker button that speaks `text` in the entry's language (hidden when the
// Web Speech API is unavailable). `fallback` is the romanized pronunciation,
// used when no voice for `lang` is installed (see speak() above). Wired via
// [data-speak] after render.
// Foreign-language text tagged with its BCP-47 code, so a screen reader speaks
// it with a matching voice instead of reading e.g. Japanese with an English
// one. The tag wraps only the phrase -- not the adjacent pronunciation button,
// whose label is English.
function localText(text, lang) {
  return lang ? `<span lang="${esc(lang)}">${esc(text)}</span>` : esc(text);
}

function speakBtn(text, lang, fallback) {
  if (!ttsAvailable() || !text) return '';
  return `<button class="spk" type="button" data-speak="${esc(text)}" data-lang="${esc(lang || '')}" data-fallback="${esc(fallback || '')}" title="Hear it" aria-label="Hear pronunciation">${icon('speaker')}</button>`;
}

// nativeCountry.pron mixes a romanized name with a bracketed simple phonetic
// for non-Latin-script entries, e.g. "Zhōngguó (jong-gwoh)" — the bracketed
// part alone is what we want a mismatched-voice TTS fallback to read.
const phoneticOf = (pron) => (/\(([^)]+)\)/.exec(pron || '') || [null, pron])[1];

function renderPhraseDetail(entry) {
  if (!entry) return navigate('/phrases', { replace: true });
  const lang = entry.langCode || '';
  const native = entry.nativeCountry
    ? `<div class="native-name">${localText(entry.nativeCountry.local, lang)} ${speakBtn(entry.nativeCountry.local, lang, phoneticOf(entry.nativeCountry.pron))}
         <span class="say-pron">${esc(entry.nativeCountry.pron)}</span></div>`
    : '';
  app.innerHTML = `
    ${topNav({ id: 'backPhrasesTop', label: '← All countries' })}
    <div class="phrase-head">
      <img decoding="async" class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
      <div>
        <h1 class="screen-title m-0">${esc(entry.country)}</h1>
        <p class="screen-sub m-tight">${esc(entry.language)}</p>
        ${native}
      </div>
    </div>

    <div class="section-h">Common phrases</div>
    <div class="phrase-list">
      ${entry.phrases.map((p) => `
        <div class="phrase-row">
          <span class="ph-en">${esc(p.en)}</span>
          <span class="ph-local">${localText(p.local, lang)} ${speakBtn(p.local, lang, p.pron)}</span>
          <span class="ph-pron">${esc(p.pron)}</span>
        </div>`).join('')}
    </div>

    <div class="section-h">Popular sayings</div>
    <div class="saying-list">
      ${entry.sayings.map((s) => `
        <div class="saying">
          <div class="say-local">${localText(s.local, lang)} ${speakBtn(s.local, lang, s.pron)} <span class="say-pron">${esc(s.pron)}</span></div>
          <div class="say-meaning">${esc(s.meaning)}</div>
        </div>`).join('')}
    </div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backPhrases">${icon('back')}All countries</button>
      <button class="btn ghost" id="backHome">${icon('back')}Home</button>
    </div>`;
  wireNav();
  const bpt = app.querySelector('#backPhrasesTop');
  if (bpt) bpt.addEventListener('click', () => navigate('/phrases'));
  app.querySelector('#backPhrases').addEventListener('click', () => navigate('/phrases'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelectorAll('[data-speak]').forEach((b) =>
    b.addEventListener('click', () => speak(b.dataset.speak, b.dataset.lang, b.dataset.fallback)));
}

// ============================================================================
//  MUSIC  (songs that represent each country — embedded YouTube player)
// ============================================================================
async function showMusic() {
  leaveSession();
  if (!(await ensureDataset('music'))) return;
  const entries = getData().music || [];
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Music</h1>
    <p class="screen-sub">Pick a country and play songs that represent it. Powered by embedded YouTube.</p>
    <div class="grid">
      ${entries.map((e) => `
        <button class="card" data-country="${esc(e.country)}">
          <img decoding="async" class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
          <span class="card-title">${esc(e.country)}</span>
          <span class="card-desc">${e.songs.length} songs</span>
        </button>`).join('')}
    </div>
    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelectorAll('[data-country]').forEach((b) =>
    b.addEventListener('click', () => navigate('/music/' + slugify(b.dataset.country))));
}

function renderMusicDetail(entry) {
  if (!entry) return navigate('/music', { replace: true });
  const first = entry.songs[0];
  app.innerHTML = `
    ${topNav({ id: 'backMusicTop', label: '← All countries' })}
    <div class="phrase-head">
      <img decoding="async" class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
      <div>
        <h1 class="screen-title m-0">${esc(entry.country)}</h1>
        <p class="screen-sub m-tight">Songs that represent ${esc(entry.country)}</p>
      </div>
    </div>

    <div class="yt-frame">
      <iframe id="ytPlayer" src="https://www.youtube-nocookie.com/embed/${esc(first.youtubeId)}"
        title="YouTube player" frameborder="0" allowfullscreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
    </div>

    <div class="section-h">Playlist</div>
    <div class="track-list">
      ${entry.songs.map((s, i) => `
        <button class="track ${i === 0 ? 'active' : ''}" data-yt="${esc(s.youtubeId)}">
          <span class="tk-num">${i + 1}</span>
          <span class="tk-title">${esc(s.title)}</span>
          <span class="tk-artist">${esc(s.artist)}</span>
          ${s.why ? `<span class="tk-why">${esc(s.why)}</span>` : ''}
        </button>`).join('')}
    </div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backMusic">${icon('back')}All countries</button>
      <button class="btn ghost" id="backHome">${icon('back')}Home</button>
    </div>`;
  wireNav();
  const bmt = app.querySelector('#backMusicTop');
  if (bmt) bmt.addEventListener('click', () => navigate('/music'));
  app.querySelector('#backMusic').addEventListener('click', () => navigate('/music'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  const player = app.querySelector('#ytPlayer');
  app.querySelectorAll('.track').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('.track').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    player.src = `https://www.youtube-nocookie.com/embed/${b.dataset.yt}?autoplay=1`;
  }));
}

// ============================================================================
//  LANGUAGE MAP  (Explore -> /languages)
// ============================================================================
// Which colouring the map is showing. Module-level, like crisesTab, so the
// choice survives navigating away and back.
let languageMapMode = 'family';
// The isolated bucket key, or null for "show everything". Isolating is the
// relief the palette needs: several slots sit under 3:1 against the page, so
// nobody should have to tell eleven hues apart at once.
let languageMapIsolated = null;

/** Load greetings + the world SVG, guarding against a stale slow fetch. */
async function loadWorldGreetings() {
  if (!(await ensureDataset('greetings'))) return null;
  const myGen = ++sessionGen;
  app.innerHTML = '<p class="screen-sub">Loading the map…</p>';
  let map;
  try {
    map = await loadMap('world');
  } catch (err) {
    if (myGen !== sessionGen) return null;
    toast('warning', "Couldn't load the map", err.message);
    navigate('/', { replace: true });
    return null;
  }
  // The SVG is ~400 KB gzipped; if the player left while it was in flight,
  // rendering now would hijack whatever screen they are looking at.
  if (myGen !== sessionGen) return null;
  return { map, rows: getData().greetings || [] };
}

function legendMarkup(items) {
  return `<ul class="map-legend">
    ${items.map((it) => `<li><button type="button" class="legend-item" data-bucket="${esc(it.key)}"
      aria-pressed="${it.key === languageMapIsolated}"
      title="Show only ${esc(it.label)}"><span class="legend-swatch ${esc(it.className)}" aria-hidden="true"></span>
      <span>${esc(it.label)}</span> <span class="legend-count">${it.count}</span></button></li>`).join('')}
  </ul>`;
}

async function showLanguageMap() {
  leaveSession();
  const loaded = await loadWorldGreetings();
  if (!loaded) return;
  const { map, rows } = loaded;

  const modes = [
    { id: 'family', label: 'By language family', blurb: 'Grouped into eleven families — the shape of who is related to whom.' },
    { id: 'language', label: 'By language', blurb: 'The ten most widespread languages by number of countries, and everything else.' },
  ];
  if (!modes.some((m) => m.id === languageMapMode)) languageMapMode = 'family';
  const mode = modes.find((m) => m.id === languageMapMode);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Language Map</h1>
    <p class="screen-sub">What the world actually speaks. Tap a country for its greeting and culture, or tap a
      key below to show only that group.</p>

    <div class="tabs" id="langModeTabs" role="tablist" aria-label="Colour the map by">
      ${modes.map((m) => `<button class="tab ${m.id === languageMapMode ? 'active' : ''}" role="tab" id="langmode-${m.id}" aria-selected="${m.id === languageMapMode}" tabindex="${m.id === languageMapMode ? 0 : -1}" data-tab="${m.id}">${m.label}</button>`).join('')}
    </div>
    <p class="screen-sub">${esc(mode.blurb)}</p>

    <div id="mapMount" class="map-mount"></div>
    <div id="legendMount"></div>
    <p class="muted-note mt-10">One language per country — the one most widely spoken. Most countries speak many
      more, and across much of Africa, the Americas and the Pacific the language shown is a colonial one layered
      over indigenous languages that are still spoken at home.</p>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="toHello">Say Hello map</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();

  const view = createMapView({
    svgText: map.svgText,
    repeat: true,
    regionClasses: regionClassesFor(rows, languageMapMode),
    onPick: (id) => {
      const row = rows.find((r) => r.iso2.toLowerCase() === id);
      const country = getData().countries.find((c) => c.iso2.toLowerCase() === id);
      // Territories have a greeting but no country page, so they announce in
      // place rather than navigating to a dead end.
      if (country) return navigate('/country/' + slugify(country.name));
      if (row) toast('globe', row.name, row.uninhabited ? 'No permanent population.' : `${row.language} — ${row.hello} (${row.pron})`);
    },
  });
  app.querySelector('#mapMount').append(view.el);

  const legendMount = app.querySelector('#legendMount');
  const svg = view.el.querySelector('svg');

  /** Repaint, rebuild the key, and re-apply whichever bucket is isolated. */
  function refresh() {
    const classes = regionClassesFor(rows, languageMapMode);
    view.paint(classes);
    const items = languageMapMode === 'family' ? familyLegend(rows) : languageLegend(rows);
    if (!items.some((i) => i.key === languageMapIsolated)) languageMapIsolated = null;
    legendMount.innerHTML = legendMarkup(items);
    legendMount.querySelectorAll('[data-bucket]').forEach((b) => b.addEventListener('click', () => {
      languageMapIsolated = languageMapIsolated === b.dataset.bucket ? null : b.dataset.bucket;
      refresh();
    }));
    applyIsolate(items, classes);
  }

  /** Dim every region outside the isolated bucket. */
  function applyIsolate(items, classes) {
    const target = items.find((i) => i.key === languageMapIsolated);
    for (const path of svg.querySelectorAll('path[id]')) {
      path.classList.toggle('region-dim', !!target && classes[path.id] !== target.className);
    }
  }

  refresh();
  wireTabs((id) => { languageMapMode = id; refresh(); }, app.querySelector('#langModeTabs'));
  app.querySelector('#toHello').addEventListener('click', () => navigate('/hello'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  SAY HELLO MAP  (Explore -> /hello)
// ============================================================================
/**
 * The greeting card for one region. Shared by /hello and the country pages.
 * `heading` is false on a country page, which already has the flag and the
 * name in its own header — repeating both reads as a rendering bug.
 */
function greetingMarkup(row, { heading = true } = {}) {
  if (!row) return '';
  if (row.uninhabited) {
    return `<div class="hello-panel"><div class="hello-body">
      <h2 class="m-0">${esc(row.name)}</h2>
      <p class="screen-sub m-tight">No permanent population — nobody to greet.</p>
    </div></div>`;
  }
  const lang = row.langCode || '';
  const also = (row.alsoTry || []).map((p) => `
    <div class="phrase-row">
      <span class="ph-en">${esc(p.en)}</span>
      <span class="ph-local">${localText(p.local, lang)} ${speakBtn(p.local, lang, p.pron)}</span>
      <span class="ph-pron">${esc(p.pron)}</span>
    </div>`).join('');
  return `
    <div class="hello-panel">
      ${heading ? `<img decoding="async" class="hello-flag" alt="" src="${flagUrl(row.iso2, 'w160')}">` : ''}
      <div class="hello-body">
        ${heading ? `<h2 class="m-0">${esc(row.name)}</h2>
        <p class="screen-sub m-tight">${esc(row.language)}${row.territoryOf ? ' · part of ' + esc(row.territoryOf) : ''}</p>`
        : `<p class="screen-sub m-0">How to greet someone in ${esc(row.language)}</p>`}
        <p class="hello-word">${localText(row.hello, lang)} ${speakBtn(row.hello, lang, phoneticOf(row.pron))}</p>
        <p class="hello-pron m-0">${esc(row.pron)}${row.literal ? ' · literally “' + esc(row.literal) + '”' : ''}</p>
        ${row.greetingNote ? `<p class="callout mt-10">${esc(row.greetingNote)}</p>` : ''}
        ${also ? `<div class="section-h">Two more worth knowing</div><div class="phrase-list">${also}</div>` : ''}
      </div>
    </div>`;
}

async function showHelloMap() {
  leaveSession();
  const loaded = await loadWorldGreetings();
  if (!loaded) return;
  const { map, rows } = loaded;
  const byId = new Map(rows.map((r) => [r.iso2.toLowerCase(), r]));
  const sorted = [...rows].filter((r) => !r.uninhabited).sort((a, b) => a.name.localeCompare(b.name));

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Say Hello</h1>
    <p class="screen-sub">Tap any country to learn how to greet someone from it — then tap the speaker to hear it said.</p>

    <div class="form-block">
      <label for="helloPick" class="muted-note">Or pick from the list</label>
      <select class="select mt-10" id="helloPick">
        <option value="">Choose a country…</option>
        ${sorted.map((r) => `<option value="${esc(r.iso2.toLowerCase())}">${esc(r.name)}</option>`).join('')}
      </select>
    </div>

    <div id="mapMount" class="map-mount"></div>
    <div id="helloPanel" aria-live="polite"><p class="hello-empty">No country picked yet.</p></div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="toLanguages">Language map</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();

  const panel = app.querySelector('#helloPanel');
  const picker = app.querySelector('#helloPick');

  /** Render into the panel only — re-rendering the screen would remount the
   *  1.2 MB SVG and throw away the player's pan/zoom. */
  const svg = () => app.querySelector('.map-svg');

  function show(id) {
    const row = byId.get(id);
    if (!row) return;
    // Keep the chosen country marked, so the map and the panel agree about
    // what you are looking at after you scroll or pan.
    svg().querySelectorAll('path.region-highlight').forEach((p) => p.classList.remove('region-highlight'));
    svg().querySelector(`#${CSS.escape(id)}`)?.classList.add('region-highlight');
    panel.innerHTML = greetingMarkup(row) + (getData().countries.some((c) => c.iso2.toLowerCase() === id)
      ? `<div class="btn-row mt-14"><button class="btn" data-country-page="${esc(id)}">Read about ${esc(row.name)}</button></div>`
      : '');
    panel.querySelectorAll('[data-speak]').forEach((b) =>
      b.addEventListener('click', () => speak(b.dataset.speak, b.dataset.lang, b.dataset.fallback)));
    const go = panel.querySelector('[data-country-page]');
    if (go) go.addEventListener('click', () => {
      const c = getData().countries.find((x) => x.iso2.toLowerCase() === go.dataset.countryPage);
      if (c) navigate('/country/' + slugify(c.name));
    });
    if (picker.value !== id) picker.value = id;
  }

  const view = createMapView({ svgText: map.svgText, repeat: true, onPick: (id) => show(id) });
  view.el.querySelector('svg').classList.add('map-picker');
  app.querySelector('#mapMount').append(view.el);
  picker.addEventListener('change', () => { if (picker.value) show(picker.value); });
  app.querySelector('#toLanguages').addEventListener('click', () => navigate('/languages'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  COUNTRY GUIDES  (Explore -> /country, /country/:slug)
// ============================================================================
const countrySearch = { term: '', region: '', sort: 'name' };

// Ways to order the country index. The file order is grouped by region and then
// by nothing in particular, which reads as random the moment you are looking for
// a specific country -- so A-Z is the default and the rest are opt-in.
// Each comparator is total (every tie falls through to the name) so the order is
// stable no matter how the browser sorts.
const COUNTRY_SORTS = {
  name: { label: 'A – Z', cmp: (a, b) => a.name.localeCompare(b.name) },
  nameDesc: { label: 'Z – A', cmp: (a, b) => b.name.localeCompare(a.name) },
  population: {
    label: 'Population',
    cmp: (a, b) => (Number(b.population) || 0) - (Number(a.population) || 0) || a.name.localeCompare(b.name),
  },
  region: {
    label: 'Region',
    cmp: (a, b) => String(a.region).localeCompare(String(b.region))
      || String(a.subregion).localeCompare(String(b.subregion))
      || a.name.localeCompare(b.name),
  },
};

/** The culture deep dive for one country, or null. Regions are authored one at
 *  a time, so "not written yet" is a normal state, never an error. */
async function ensureCulture(country) {
  const key = datasetKeyForRegion(country.region);
  if (!key) return null;
  if (!getData()[key]?.length) {
    try {
      await loadDataset(key);
    } catch {
      return null; // the page still renders; it just has no deep dive
    }
  }
  return cultureFor(getData()[key] || [], country.iso2);
}

async function showCountryIndex() {
  leaveSession();
  if (!(await ensureDataset('greetings'))) return;
  const countries = getData().countries;
  const greetings = new Map((getData().greetings || []).map((g) => [g.iso2.toLowerCase(), g]));
  const regions = getRegions(countries);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Country Guides</h1>
    <p class="screen-sub">Every country: how to greet someone from it, five people it is known for, the events that
      shaped it, and what its culture is actually like.</p>

    <div class="form-block filter-bar">
      <input type="text" class="type-input" id="countrySearch" placeholder="Search countries…" value="${esc(countrySearch.term)}">
      <select class="select" id="countryRegion" aria-label="Filter by region">
        <option value="">All regions</option>
        ${regions.map((r) => `<option value="${esc(r)}"${r === countrySearch.region ? ' selected' : ''}>${esc(r)}</option>`).join('')}
      </select>
      <select class="select" id="countrySort" aria-label="Sort countries">
        ${Object.entries(COUNTRY_SORTS).map(([k, v]) =>
          `<option value="${esc(k)}"${k === countrySearch.sort ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select>
    </div>

    <div class="grid" id="countryGrid"></div>
    <p class="screen-sub hidden" id="countryEmpty">No matches.</p>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="toHello">Say Hello map</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();

  const grid = app.querySelector('#countryGrid');
  const empty = app.querySelector('#countryEmpty');

  // Built once. Filtering then toggles .hidden on existing cards rather than
  // regenerating markup — rebuilding ~200 <img> per keystroke is the exact
  // regression the Flag Key screen exists to document.
  const sorted = [...countries].sort(COUNTRY_SORTS[countrySearch.sort].cmp);
  grid.innerHTML = sorted.map((c) => {
    const g = greetings.get(c.iso2.toLowerCase());
    return `<button class="card" data-slug="${esc(slugify(c.name))}"
      data-name="${esc(c.name.toLowerCase())}" data-region="${esc(c.region)}">
      <img class="emoji-flag" alt="" loading="lazy" decoding="async" src="${flagUrl(c.iso2, 'w80')}">
      <span class="card-title">${esc(c.name)}</span>
      <span class="card-desc">${g ? esc(g.hello) + ' · ' + esc(c.language) : esc(c.language)}</span>
    </button>`;
  }).join('');
  // No inline onerror — the CSP has no unsafe-inline, so it would never run.
  grid.querySelectorAll('img').forEach((img) =>
    img.addEventListener('error', () => img.classList.add('hidden')));

  // Re-ordering moves the cards that already exist rather than rebuilding them:
  // append() on an element already in the document relocates it, so no <img> is
  // discarded and none is requested a second time.
  function applySort() {
    const cards = new Map([...grid.children].map((el) => [el.dataset.slug, el]));
    grid.append(...countries
      .slice()
      .sort(COUNTRY_SORTS[countrySearch.sort].cmp)
      .map((c) => cards.get(slugify(c.name)))
      .filter(Boolean));
  }

  function applyFilter() {
    const term = countrySearch.term.trim().toLowerCase();
    let shown = 0;
    grid.querySelectorAll('.card').forEach((card) => {
      const match = (!term || card.dataset.name.includes(term))
        && (!countrySearch.region || card.dataset.region === countrySearch.region);
      card.classList.toggle('hidden', !match);
      if (match) shown++;
    });
    empty.classList.toggle('hidden', shown > 0);
  }
  applyFilter();

  const runFilter = debounce(applyFilter);
  app.querySelector('#countrySearch').addEventListener('input', (e) => {
    countrySearch.term = e.target.value;
    runFilter();
  });
  app.querySelector('#countryRegion').addEventListener('change', (e) => {
    countrySearch.region = e.target.value;
    applyFilter();
  });
  app.querySelector('#countrySort').addEventListener('change', (e) => {
    countrySearch.sort = COUNTRY_SORTS[e.target.value] ? e.target.value : 'name';
    applySort();
  });
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('[data-slug]');
    if (card) navigate('/country/' + card.dataset.slug);
  });
  app.querySelector('#toHello').addEventListener('click', () => navigate('/hello'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

async function routeCountryDetail(slug) {
  leaveSession();
  if (!(await ensureDataset('greetings'))) return;
  const country = getData().countries.find((c) => slugify(c.name) === slug);
  if (!country) return navigate('/country', { replace: true });
  document.title = `${country.name} — Worldly`;
  // A country whose region has no culture file yet still gets a real page.
  const culture = await ensureCulture(country);
  const greeting = (getData().greetings || []).find((g) => g.iso2 === country.iso2);
  renderCountryDetail(country, greeting, culture);
}

function renderCountryDetail(country, greeting, culture) {
  const { people, events, culture: rows, talkAbout, avoid, note } = cultureSections(culture);
  const hasPhrases = (getData().phrases || []).some((p) => p.iso2 === country.iso2);

  const peopleBlock = people.length ? `
    <div class="section-h">Five people it is known for</div>
    <div class="people-list">
      ${people.map((p) => `
        <div class="person">
          <span class="person-initials" aria-hidden="true">${esc(initialsFor(p.name))}</span>
          <div class="person-body">
            <div class="person-name">${esc(p.name)}${p.native ? ` <span class="person-native">${esc(p.native)}</span>` : ''}</div>
            <div class="person-meta">${esc(p.field || '')}${p.years ? ' · ' + esc(p.years) : ''}</div>
            <div class="person-why">${esc(p.why)}</div>
            ${p.wiki ? `<a class="person-link" href="${safeUrl(p.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
          </div>
        </div>`).join('')}
    </div>` : '';

  const eventsBlock = events.length ? `
    <div class="section-h">Moments that shaped it</div>
    <div class="event-list">
      ${events.map((e) => `
        <div class="event">
          <span class="event-year">${esc(e.year)}</span>
          <div>
            <div class="event-title">${esc(e.title)}</div>
            <div class="event-what">${esc(e.what)}</div>
          </div>
          ${e.wiki ? `<a class="event-link" href="${safeUrl(e.wiki)}" target="_blank" rel="noopener" aria-label="${esc(e.title)} on Wikipedia">↗</a>` : ''}
        </div>`).join('')}
    </div>` : '';

  const cultureBlock = rows.length ? `
    <div class="section-h">Its culture, briefly</div>
    <div class="culture-grid">
      ${rows.map((r) => `
        <div class="culture-cell">
          <div class="culture-label">${esc(r.label)}</div>
          <div>${esc(r.text)}</div>
        </div>`).join('')}
    </div>` : '';

  const talkBlock = talkAbout.length ? `
    <div class="section-h">Worth bringing up</div>
    <ul class="talk-list">${talkAbout.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';

  const stub = (!people.length && !events.length && !rows.length)
    ? `<p class="callout mt-14">The deep dive for ${esc(country.name)} is still being written. The greeting above is
        complete, and the facts below come from the main dataset.</p>` : '';

  app.innerHTML = `
    ${topNav({ id: 'backCountriesTop', label: 'All countries' })}
    <div class="country-masthead">
      <img decoding="async" class="country-flagfill" alt="" src="${flagUrl(country.iso2, 'w320')}">
      <div class="country-mast-body">
        <span class="badge ${continentClass(country.region)}">${esc(country.region)}</span>
        <h1 class="screen-title">${esc(country.name)}</h1>
        <p class="country-mast-meta">${esc(country.subregion)}</p>
      </div>
      <img decoding="async" class="country-flag-plate" alt="Flag of ${esc(country.name)}" src="${flagUrl(country.iso2, 'w320')}">
    </div>

    ${greeting ? greetingMarkup(greeting, { heading: false }) : ''}
    ${stub}

    <div class="section-h">Fast facts</div>
    <div class="stat-grid">
      <div class="stat"><span class="big">${esc(country.capital)}</span><span class="lbl">Capital</span></div>
      <div class="stat"><span class="big">${Number(country.population).toLocaleString()}</span><span class="lbl">Population</span></div>
      <div class="stat"><span class="big">${esc(country.language)}</span><span class="lbl">Main language</span></div>
      <div class="stat"><span class="big">${esc(country.currency)}</span><span class="lbl">Currency</span></div>
    </div>
    <!-- The facts that do not fit four equal tiles. A definition list because
         that is what it is, and because it keeps the tile count at the four the
         layout (and the country-page test) is built around. -->
    <dl class="facts-list">
      <dt>Largest faith</dt><dd>${esc(country.religion)}</dd>
      <dt>Region</dt><dd>${esc(country.subregion)} · ${esc(country.region)}</dd>
      ${country.note ? `<dt>Note</dt><dd>${esc(country.note)}</dd>` : ''}
    </dl>

    ${peopleBlock}
    ${eventsBlock}
    ${cultureBlock}
    ${talkBlock}
    ${avoid ? `<div class="section-h">Tread carefully</div><p class="callout callout-warn">${esc(avoid)}</p>` : ''}

    <div class="section-h">Also worth knowing</div>
    <div class="crisis-body">
      <p>${esc(country.funFact)}</p>
      <p>${esc(country.history)}</p>
      ${note ? `<p class="muted-note">${esc(note)}</p>` : ''}
      <div><span class="muted-note">Learn more:</span>
        <div class="learn-more">
          <a href="${safeUrl(country.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>
          ${hasPhrases ? `<a href="/phrases/${esc(slugify(country.name))}" data-link>More phrases →</a>` : ''}
        </div>
      </div>
    </div>

    <div class="btn-row mt-18">
      <button class="btn" id="backCountries">All countries</button>
      <button class="btn ghost" id="toHelloFromCountry">Say Hello map</button>
      <button class="btn ghost" id="backHome">${icon('back')}Home</button>
    </div>`;
  wireNav();
  app.querySelectorAll('[data-speak]').forEach((b) =>
    b.addEventListener('click', () => speak(b.dataset.speak, b.dataset.lang, b.dataset.fallback)));
  const top = app.querySelector('#backCountriesTop');
  if (top) top.addEventListener('click', () => navigate('/country'));
  app.querySelector('#backCountries').addEventListener('click', () => navigate('/country'));
  app.querySelector('#toHelloFromCountry').addEventListener('click', () => navigate('/hello'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  CRISES & CURRENT EVENTS  (curated background + live-source links)
// ============================================================================
async function showCrises() {
  leaveSession();
  if (!(await ensureDataset('crises'))) return;
  const entries = getData().crises || [];
  // Two independent axes: which time period (current vs. historical), and
  // which coverage tier within it (underreported vs. famous) — four pages total.
  const periods = [
    { id: 'current', label: 'Current' },
    { id: 'historical', label: 'Historical' },
  ];
  const tiers = [
    { id: 'underreported', label: 'Underreported', blurb: 'Crises that receive far less attention than their scale deserves.' },
    { id: 'famous', label: 'Famous', blurb: 'The largest or most widely known crises, regardless of how heavily they are covered.' },
  ];
  if (!periods.some((p) => p.id === crisesPeriod)) crisesPeriod = 'current';
  if (!tiers.some((t) => t.id === crisesTab)) crisesTab = 'underreported';
  const cardsFor = (tier) => entries.filter((e) =>
    (e.period || 'current') === crisesPeriod && (e.tier || 'underreported') === tier);
  // The file carries no metadata object — it is a bare array the render walks —
  // so freshness is derived from the newest asOf among the current entries.
  const reviewed = newestAsOf(entries);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Crises &amp; Events</h1>
    <p class="screen-sub">${crisesPeriod === 'historical'
      ? 'Famous and underreported crises from history — what happened, and why it still matters.'
      : 'Background on ongoing world situations, with links to live sources. Curated context — not real-time reporting.'}</p>
    ${crisesPeriod === 'current' && reviewed ? `<p class="muted-note">Current entries reviewed ${esc(reviewed)}.</p>` : ''}

    <div class="tabs" id="periodTabs" role="tablist" aria-label="Time period">
      ${periods.map((p) => `<button class="tab ${p.id === crisesPeriod ? 'active' : ''}" role="tab" id="period-${p.id}" aria-selected="${p.id === crisesPeriod}" tabindex="${p.id === crisesPeriod ? 0 : -1}" data-tab="${p.id}">${p.label}</button>`).join('')}
    </div>

    <div id="tierSection">
      <div class="tabs" role="tablist" aria-label="Coverage">
        ${tiers.map((t) => `<button class="tab ${t.id === crisesTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === crisesTab}" tabindex="${t.id === crisesTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>

      ${tiers.map((t) => `
        <div class="tab-panel ${t.id === crisesTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
          <p class="screen-sub">${esc(t.blurb)}</p>
          <div class="grid">
            ${cardsFor(t.id).map((e) => `
              <button class="card" data-crisis="${esc(e.title)}">
                <img decoding="async" class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
                <span class="card-title">${esc(e.title)}</span>
                <span class="card-desc">${esc(e.country)}</span>
              </button>`).join('')}
          </div>
        </div>`).join('')}
    </div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  wireNav();
  wireTabs(async (id) => {
    crisesPeriod = id;
    // showCrises() replaces the whole screen, so the tab to focus does not
    // exist until it has finished -- awaiting matters now that it is async.
    await showCrises();
    app.querySelector(`#period-${id}`)?.focus();
  }, app.querySelector('#periodTabs'));
  wireTabs((id) => { crisesTab = id; }, app.querySelector('#tierSection'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelectorAll('[data-crisis]').forEach((b) =>
    b.addEventListener('click', () => navigate('/crises/' + slugify(b.dataset.crisis))));
}

function renderCrisisDetail(entry) {
  if (!entry) return navigate('/crises', { replace: true });
  const links = (entry.links || []).filter((l) => l.url)
    .map((l) => `<a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  // `summary` is an array of paragraphs (older single-string entries still work).
  const paragraphs = Array.isArray(entry.summary) ? entry.summary : [entry.summary];
  app.innerHTML = `
    ${topNav({ id: 'backCrisesTop', label: '← All crises' })}
    <div class="phrase-head">
      <img decoding="async" class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
      <div>
        <h1 class="screen-title m-0">${esc(entry.title)}</h1>
        <p class="screen-sub m-tight">${esc(entry.country)}${entry.region ? ' · ' + esc(entry.region) : ''}${entry.era ? ' · ' + esc(entry.era) : ''}</p>
      </div>
    </div>

    <div class="crisis-body">
      ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
      ${entry.asOf ? `<p class="muted-note">Background written as of ${esc(entry.asOf)} — follow the live sources below for current developments.</p>` : ''}
      <div><span class="muted-note">${entry.period === 'historical' ? 'Learn more' : 'Follow the latest'}:</span>
        <div class="learn-more">${links}</div></div>
    </div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backCrises">${icon('back')}All crises</button>
      <button class="btn ghost" id="backHome">${icon('back')}Home</button>
    </div>`;
  wireNav();
  const bct = app.querySelector('#backCrisesTop');
  if (bct) bct.addEventListener('click', () => navigate('/crises'));
  app.querySelector('#backCrises').addEventListener('click', () => navigate('/crises'));
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  STATISTICS
// ============================================================================
/**
 * Paint the dashboard's discovery map, once its SVG has arrived. Same
 * derivation and the same session guard as the home hero — this is the same
 * picture at reference size, so the two can never disagree.
 */
async function mountDiscoveryMap(gen) {
  const mount = app.querySelector('#discoveryMap');
  if (!mount) return;
  let map;
  try {
    map = await loadMap('world');
  } catch {
    mount.replaceChildren();
    return;
  }
  if (gen !== sessionGen || !app.contains(mount)) return;
  const p = getProfile();
  const countries = getData().countries || [];
  const view = createMapView({
    svgText: map.svgText,
    interactive: false,
    paintClass: null,
    regionClasses: masteryClasses(countryMastery(p.srs, countries)),
    onPick: () => {},
  });
  mount.replaceChildren(view.el);
}

function showStats() {
  leaveSession();
  const p = getProfile();
  const lp = levelProgress(p.xp);
  const countries = getData().countries || [];
  const found = discoveryStats(countryMastery(p.srs, countries), countries);
  const cats = Object.entries(p.perCategory);
  const regs = Object.entries(p.perRegion);
  const bar = (label, c, tint = '') => {
    const pct = c.answered ? Math.round((c.correct / c.answered) * 100) : 0;
    return `<div class="bar-row ${tint}"><span class="name">${esc(label)}</span>
      <div class="bar-track"><span data-w="${pct}"></span></div>
      <span class="pct">${pct}%</span></div>`;
  };
  const missed = Object.entries(p.missed).sort((a, b) => b[1].wrong - a[1].wrong).slice(0, 12);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Statistics</h1>
    <p class="screen-sub">How far you have got, where you are strong, and what to work on next.</p>

    <div class="console">
      <div class="console-card">
        <span class="ring"><span class="ring-n">${lp.level}</span><span class="ring-lbl">Level</span></span>
        <div class="console-body">
          <p class="console-title">${esc(levelTitle(p.xp))}</p>
          <p class="console-note">${p.xp} XP · ${Math.max(0, lp.span - lp.into)} to level ${lp.level + 1}</p>
          <div class="bar-track"><span data-w="${lp.pct}"></span></div>
        </div>
      </div>
      <div class="console-card">
        <span class="ring"><span class="ring-n">${found.pct}<span class="ring-lbl">%</span></span></span>
        <div class="console-body">
          <p class="console-title">World found</p>
          <p class="console-note">${found.known} of ${found.total} countries answered right at least once${found.mastered ? ` · ${found.mastered} mastered` : ''}</p>
          <div class="bar-track"><span data-w="${found.pct}"></span></div>
        </div>
      </div>
    </div>

    <div class="section-h">The world you have found</div>
    <div class="discovery">
      <div class="map-mount" id="discoveryMap"><div class="map-holder skel"></div></div>
      <ul class="continent-list">
        ${found.byRegion.map((r) => `
          <li class="continent ${continentClass(r.region)}">
            <span class="c-name">${esc(r.region)}</span>
            <span class="c-count">${r.known}/${r.total}</span>
            <span class="c-track"><span data-w="${r.pct}"></span></span>
          </li>`).join('')}
      </ul>
    </div>

    <div class="stat-grid mt-18">
      <div class="stat"><span class="big">${accuracy()}%</span><span class="lbl">Accuracy</span></div>
      <div class="stat"><span class="big">${p.totalAnswered}</span><span class="lbl">Questions</span></div>
      <div class="stat"><span class="big">${p.totalCorrect}</span><span class="lbl">Correct</span></div>
      <div class="stat"><span class="big">${p.bestStreak}</span><span class="lbl">Best streak</span></div>
      <div class="stat"><span class="big">${fmtTime(p.studyTimeMs)}</span><span class="lbl">Study time</span></div>
      <div class="stat"><span class="big">${weakCount(p.srs)}</span><span class="lbl">Weak items</span></div>
      <div class="stat"><span class="big">${Object.keys(p.achievements).length}</span><span class="lbl">Badges</span></div>
      <div class="stat"><span class="big">${p.dailyCompleted}</span><span class="lbl">Daily sets</span></div>
    </div>

    <div class="section-h">Performance by category</div>
    ${cats.length ? cats.map(([k, v]) => bar(catLabel(k), v)).join('') : '<p class="screen-sub">Play a round to see this.</p>'}

    <div class="section-h">Performance by region</div>
    ${regs.length ? regs.map(([k, v]) => bar(k, v, `tinted ${continentClass(k)}`)).join('') : '<p class="screen-sub">No regional data yet.</p>'}

    <div class="section-h">Weak areas (most missed)</div>
    ${missed.length ? `<ul class="weak-list">${missed.map(([, m]) => `<li><span>${esc(m.label)}</span><span class="ans">${esc(m.answer)} · missed ${m.wrong}×</span></li>`).join('')}</ul>` : '<p class="screen-sub">Nothing missed yet. Play a round and anything you get wrong collects here.</p>'}

    <div class="btn-row mt-18">
      <button class="btn primary" id="reviewW" ${missed.length ? '' : 'disabled'}>Practice weak areas</button>
      <button class="btn ghost" id="backHome">${icon('back')}Back</button>
    </div>`;
  app.querySelectorAll('[data-w]').forEach((s) => { s.style.width = s.dataset.w + '%'; });
  app.querySelectorAll('.ring').forEach((r, i) => r.style.setProperty('--arc', String(i === 0 ? lp.pct : found.pct)));
  wireNav();
  mountDiscoveryMap(sessionGen);
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  const rw = app.querySelector('#reviewW');
  if (missed.length) rw.addEventListener('click', () => navigate('/quiz/review'));
}

// ============================================================================
//  ACHIEVEMENTS
// ============================================================================
function showAchievements() {
  leaveSession();
  const list = achievementStatus(getProfile());
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Achievements</h1>
    <p class="screen-sub">${list.filter((a) => a.unlocked).length} of ${list.length} earned. Each one is a stamp
      in the book — the outlines are the ones still to collect.</p>
    <div class="ach-grid">
      ${list.map((a) => `
        <div class="ach ${a.unlocked ? '' : 'locked'} ${a.region ? continentClass(a.region) : ''}">
          <div class="ic">${icon(a.icon)}</div>
          <div class="nm">${esc(a.name)}</div>
          <div class="ds">${esc(a.desc)}</div>
          <div class="mini"><span data-w="${a.pct}"></span></div>
          <div class="lbl ach-lbl">${a.unlocked ? 'Earned' : `${a.current}/${a.threshold}`}</div>
        </div>`).join('')}
    </div>
    <div class="btn-row mt-18"><button class="btn ghost" id="backHome">${icon('back')}Back</button></div>`;
  app.querySelectorAll('[data-w]').forEach((s) => { s.style.width = s.dataset.w + '%'; });
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
}

// ============================================================================
//  LEADERBOARD
// ============================================================================
function showLeaderboard() {
  leaveSession();
  const lb = getProfile().leaderboard;
  const tiers = [
    { id: 'challenge', label: 'Challenge' },
    { id: 'daily', label: 'Daily' },
    { id: 'xp', label: 'Level/XP' },
  ];
  if (!tiers.some((t) => t.id === leaderboardTab)) leaderboardTab = 'challenge';

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Leaderboard</h1>

    <div class="section-h">Global</div>
    <div class="tabs" role="tablist">
      ${tiers.map((t) => `<button class="tab ${t.id === leaderboardTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === leaderboardTab}" tabindex="${t.id === leaderboardTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    ${tiers.map((t) => `
      <div class="tab-panel ${t.id === leaderboardTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
        ${t.id === 'xp' ? '<p class="screen-sub mb-10">Lifetime XP across every quiz mode, synced from your device — self-reported, unlike the Challenge &amp; Daily tabs.</p>' : ''}
        <div class="form-block" id="globalList-${t.id}">
          <div class="skel skel-block" role="status" aria-label="Loading the global leaderboard"></div>
          <div class="skel skel-block"></div>
          <div class="skel skel-block"></div>
        </div>
      </div>`).join('')}

    <div class="section-h">Your personal bests</div>
    <div class="form-block">
      ${lb.length ? `<ul class="weak-list">${lb.map((e, i) => `<li><span>#${i + 1} · ${esc(e.mode)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>` : '<p class="screen-sub">Play Challenge or Daily to set a high score.</p>'}
    </div>

    <div class="btn-row mt-18"><button class="btn ghost" id="backHome">${icon('back')}Back</button></div>`;
  wireNav();
  wireTabs((id) => { leaderboardTab = id; });
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  // Push the player's lifetime total before reading the board back. Syncing
  // only at the end of a quiz meant anyone who had earned XP and then came to
  // look was absent from the Level/XP tab -- it read "No scores yet" to a
  // player sitting on thousands of XP, which made the tab look broken. The
  // lastSyncedXp guard in submitLifetimeXp still collapses this to one write
  // per change, so repeat visits cost nothing.
  const synced = submitLifetimeXp();
  tiers.forEach((t) => loadGlobalLeaderboard(t.id));
  // The XP read carries max-age=60, and the fetch above races the write
  // anyway, so the first render can miss the player. Re-read that one tab once
  // the write has landed, bypassing the cache, so a returning player sees
  // themselves now rather than on their next visit.
  const myGen = sessionGen;
  synced.then((wrote) => {
    if (wrote && myGen === sessionGen) loadGlobalLeaderboard('xp', { fresh: true });
  });
}

async function loadGlobalLeaderboard(mode, { fresh = false } = {}) {
  const myGen = sessionGen;
  const target = document.getElementById(`globalList-${mode}`);
  try {
    const res = await fetch(`/api/leaderboard?mode=${mode}`, fresh ? { cache: 'no-store' } : undefined);
    if (myGen !== sessionGen || !target) return; // player already navigated away
    if (!res.ok) throw new Error('load_failed');
    const { entries } = await res.json();
    target.innerHTML = entries.length
      ? `<ul class="weak-list">${entries.map((e, i) => `<li><span>#${i + 1} · ${esc(e.name)}</span><span class="ans">${mode === 'xp' ? `Lvl ${levelProgress(e.score).level} · ` : ''}${e.score} XP</span></li>`).join('')}</ul>`
      : '<p class="screen-sub">No scores yet — be the first!</p>';
  } catch {
    if (myGen === sessionGen && target) {
      target.innerHTML = '<p class="screen-sub">Couldn\'t reach the global leaderboard — check your connection.</p>';
    }
  }
}

// ============================================================================
//  PROFILE
// ============================================================================
function showProfile() {
  leaveSession();
  const p = getProfile();
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Profile</h1>
    <div class="form-block">
      <h2>Display name</h2>
      <div class="btn-row">
        <input id="nameInput" class="btn name-input" value="${esc(p.name)}" maxlength="20">
        <button class="btn primary" id="saveName">Save</button>
      </div>
    </div>
    <div class="form-block">
      <h2>Backup &amp; transfer</h2>
      <p class="screen-sub mb-10">Progress lives only in this browser. Export it as a file to back it up or move it to another device / the web version.</p>
      <div class="btn-row">
        <button class="btn" id="exportBtn">Export progress</button>
        <button class="btn" id="importBtn">Import progress</button>
        <input type="file" id="importFile" accept="application/json,.json" class="hidden">
      </div>
    </div>
    <div class="form-block">
      <h2>Privacy</h2>
      <p class="screen-sub mb-10">Worldly uses Microsoft Clarity for anonymous usage analytics, which records how
      screens are used. No names, quiz answers or saved progress are ever sent. Turning this off stops the analytics
      script from loading at all.</p>
      <label class="check">
        <input type="checkbox" id="analyticsOptOut" ${analyticsOptedOut() ? 'checked' : ''}>
        Don't send anonymous usage analytics
      </label>
      <p class="screen-sub mt-10 muted-note" id="dntNote"></p>
    </div>
    <div class="form-block">
      <h2>Danger zone</h2>
      <p class="screen-sub mb-10">Reset all progress, stats and achievements. This cannot be undone.</p>
      <button class="btn danger" id="resetBtn">Reset all progress</button>
    </div>
    <div class="btn-row"><button class="btn ghost" id="backHome">${icon('back')}Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', () => navigate('/'));
  app.querySelector('#saveName').addEventListener('click', () => {
    setName(app.querySelector('#nameInput').value);
    toast('check', 'Name saved', getProfile().name);
  });
  app.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(getProfile(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worldly-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('download', 'Progress exported', 'Keep the file safe — import it anywhere.');
  });
  const importFile = app.querySelector('#importFile');
  app.querySelector('#importBtn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    if (!file) return;
    try {
      const p = importProfile(JSON.parse(await file.text()));
      applyTheme(p.theme);
      renderHUD();
      toast('check', 'Progress imported', `Welcome back, ${p.name} — level ${levelProgress(p.xp).level}!`);
      showProfile();
    } catch (e) {
      toast('warning', "Couldn't import that file", e.message);
    }
  });
  const optOutBox = app.querySelector('#analyticsOptOut');
  const dntNote = app.querySelector('#dntNote');
  // A browser-level signal already decides this; say so rather than letting the
  // checkbox look like it is being ignored.
  const browserSignal = analyticsOptedOut() && localStorage.getItem('worldly_analytics_optout') !== '1';
  if (browserSignal) {
    optOutBox.disabled = true;
    dntNote.textContent = 'Your browser sends a Do Not Track / Global Privacy Control signal, so analytics are already off.';
  }
  optOutBox.addEventListener('change', () => {
    setAnalyticsOptOut(optOutBox.checked);
    if (optOutBox.checked) toast('bellOff', 'Analytics off', 'Nothing further will be sent from this browser.');
    else { loadAnalytics(); toast('gauge', 'Analytics on', 'Thanks — it helps show which modes get used.'); }
  });

  app.querySelector('#resetBtn').addEventListener('click', () => {
    if (confirm('Really reset ALL progress? This cannot be undone.')) {
      resetProfile();
      renderHUD();
      toast('reset', 'Progress reset', 'A fresh start!');
      navigate('/');
    }
  });
}

// ============================================================================
//  GLOBAL EVENTS + BOOT
// ============================================================================
function onKeydown(e) {
  if (!S) return;
  if (S.phase === 'answer') {
    // Number-key shortcuts need real MCQ choices to key against. Click-only
    // forward map questions never set `choices` (checked below), so this also
    // correctly covers them without excluding reverse map modes, which DO
    // render numbered .choice buttons just like any other MCQ.
    if (S.input === 'type' || !S.current?.choices) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= S.current.choices.length) {
      const btn = app.querySelectorAll('.choice')[n - 1];
      if (btn) answer(btn.dataset.val);
    }
  } else if (S.phase === 'feedback') {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      const nb = document.getElementById('nextBtn');
      if (nb) nb.click();
    }
  }
}

async function boot() {
  const p = loadProfile();
  applyTheme(p.theme);
  // Gated rather than loaded on import: Clarity records sessions, so it must
  // not fetch at all when the visitor has signalled otherwise (GPC / DNT /
  // the Profile opt-out).
  loadAnalytics();
  document.getElementById('themeToggle').addEventListener('click', () => {
    // Toggling is always an explicit choice, so it stops following the OS.
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  });
  // Track the OS while the player has no explicit preference of their own.
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!getProfile().theme) applyTheme(null);
    });
  } catch { /* older engines: the initial resolution still applies */ }
  // #brand is a real <button>, so Enter/Space activation is handled natively.
  document.getElementById('brand').addEventListener('click', () => navigate('/'));
  document.getElementById('helpBtn').addEventListener('click', () => navigate('/about'));
  document.getElementById('leaderboardBtn').addEventListener('click', () => navigate('/leaderboard'));
  document.addEventListener('keydown', onKeydown);

  // Surface storage failures once per session instead of losing progress silently.
  let warnedSave = false;
  window.addEventListener('worldly:save-failed', () => {
    if (warnedSave) return;
    warnedSave = true;
    toast('warning', "Progress can't be saved", 'Browser storage may be full or blocked (private mode).');
  });

  app.innerHTML = '<p class="screen-sub">Loading the world…</p>';
  try {
    await loadData();
  } catch (err) {
    const isFile = location.protocol === 'file:';
    app.innerHTML = `<div class="question-card"><h2>Couldn't load the world data</h2>
      <p class="screen-sub">${esc(err.message)}</p>
      ${isFile
        ? `<p>Worldly must be served over HTTP (browsers block <code>fetch</code> on <code>file://</code>).
           From the <code>Worldly/</code> folder run <code>python -m http.server</code> and open
           <code>http://localhost:8000</code>.</p>`
        : `<p>Please check your internet connection and try again.</p>
           <div class="btn-row"><button class="btn primary" id="retryBtn">Try again</button></div>`}
      </div>`;
    const retry = document.getElementById('retryBtn');
    if (retry) retry.addEventListener('click', () => location.reload());
    return;
  }
  renderHUD();
  renderNav();

  // The Pokédex screens live in their own module so this file does not grow by
  // another 500 lines. They need the same UI helpers every screen here uses, and
  // those are module-private — so hand them over once instead of exporting them,
  // which would make pokedexview.js and main.js import each other.
  initPokedex({
    app, esc, safeUrl, topNav, wireNav, wireTabs, toast,
    navigate, focusTitle, leaveSession, ensureDataset, getData,
  });

  // The route table: URL → screen. Titles are set here for the static screens
  // (detail routes set their own from the entry). Order matters only in that the
  // first match wins; the patterns here are mutually exclusive, so it doesn't.
  // Every route is wrapped so the nav highlight and the column width are set on
  // entry, whichever way the screen was reached: an in-app click, Back/Forward,
  // or a deep link on first load. Doing it here rather than inside router.js
  // keeps that module screen-agnostic, which is what makes matchPath() testable
  // without a DOM.
  const withChrome = (r) => ({ ...r, render: (params) => { applyChrome(location.pathname); return r.render(params); } });

  router = createRouter({
    routes: [
      { path: '/', title: 'Worldly — World Knowledge & Culture', render: showHome },
      { path: '/about', title: 'About — Worldly', render: showAbout },
      { path: '/flags', title: 'Flag Key — Worldly', render: showFlagKey },
      { path: '/phrases', title: 'Phrases — Worldly', render: showPhrases },
      { path: '/phrases/:slug', render: (p) => routePhraseDetail(p.slug) },
      { path: '/music', title: 'Music — Worldly', render: showMusic },
      { path: '/music/:slug', render: (p) => routeMusicDetail(p.slug) },
      { path: '/languages', title: 'Language Map — Worldly', render: showLanguageMap },
      { path: '/hello', title: 'Say Hello — Worldly', render: showHelloMap },
      { path: '/country', title: 'Country Guides — Worldly', render: showCountryIndex },
      { path: '/country/:slug', render: (p) => routeCountryDetail(p.slug) },
      { path: '/crises', title: 'Crises & Events — Worldly', render: showCrises },
      { path: '/crises/:slug', render: (p) => routeCrisisDetail(p.slug) },
      { path: '/leaderboard', title: 'Leaderboard — Worldly', render: showLeaderboard },
      { path: '/stats', title: 'Statistics — Worldly', render: showStats },
      { path: '/achievements', title: 'Achievements — Worldly', render: showAchievements },
      { path: '/profile', title: 'Profile — Worldly', render: showProfile },
      { path: '/custom', title: 'Custom Study — Worldly', render: showCustom },
      { path: '/religions', title: 'World Religions — Worldly', render: showReligions },
      { path: '/regions', title: 'Regions & Continents — Worldly', render: showMapRegions },
      { path: '/quiz/:mode', render: (p) => startQuizByKey(p.mode) },
      { path: '/map/:mode', render: (p) => startMapByKey(p.mode) },
      { path: '/pokedex', title: 'Pokédex — Worldly', render: showPokedex },
      { path: '/pokedex/quiz/:mode', render: (p) => startPokeQuizByKey(p.mode) },
      { path: '/pokedex/:slug', render: (p) => showPokemonDetail(p.slug) },
    ].map(withChrome),
    fallback: withChrome({ title: 'Page not found — Worldly', noindex: true, render: showNotFound }),
    onError: (err) => {
      // A screen renderer throwing must not leave the app blank.
      app.innerHTML = `<div class="question-card"><h2>Something went wrong</h2>
        <p class="screen-sub">${esc(err && err.message || String(err))}</p>
        <div class="btn-row mt-18"><a class="btn primary" href="/">Back to home</a></div></div>`;
    },
  });

  // start() renders whatever URL the app was opened on (Cloudflare's SPA fallback
  // serves the shell for any deep link), so `/leaderboard` opens the leaderboard,
  // not the home screen. The initial render must not steal focus into the <h1>
  // (that pushed the header past the content — see focusTitle), so enable that
  // only once the first render has completed.
  await router.start();
  allowFocusTitle = true;

  // Offline resilience: cache app shell + seen flags (see sw.js). Feature-
  // detected and fire-and-forget — a failure must never affect the app.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  }
}

boot();
