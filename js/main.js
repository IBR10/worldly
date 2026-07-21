// main.js — application controller. Owns routing between screens, renders the
// HUD, runs a quiz session, and reacts to answers (scoring, XP, achievements).

import { loadData, getData, getContinents, getSubregions, getRegions, flagUrl, historicFlagUrl, stateFlagUrl, symbolImageUrl, loadMap } from './data.js';
import {
  loadProfile, getProfile, saveProfile, resetProfile, importProfile, levelProgress, accuracy,
  recordAnswer, recordStudyTime, recordPerfectQuiz, markDailyComplete,
  dailyDoneToday, addLeaderboard, setTheme, setName, setOnboarded, localDateStr,
} from './state.js';
import { track, tag, loadAnalytics, analyticsOptedOut, setAnalyticsOptOut } from './analytics.js';
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches, challengeMultiplier, sessionQuestionXp, seededRng, dateSeed } from './quiz.js';
import { buildMapPool, makeMapQuestion, MAP_MODES, ALL_MAP_MODES } from './maps.js';
import { createMapView } from './mapview.js';
import { pickWeighted, weakCount } from './srs.js';
import { checkAchievements, achievementStatus, levelTitle } from './achievements.js';

// Combined category label lookup (quiz modes + map modes) for HUD/stats.
const catLabel = (k) => MODES[k]?.label || MAP_MODES[k]?.label || k;

// The four map modes backed by the world SVG — the only ones a continent
// filter/zoom makes sense for (US/MX state modes have no continent variation).
const WORLD_MAP_MODES = ALL_MAP_MODES.filter((m) => MAP_MODES[m].svg === 'world');

const app = document.getElementById('app');
const hud = document.getElementById('hud');
const toastBox = document.getElementById('toasts');

// Active quiz session (null when not playing).
let S = null;
// Bumped every time the player leaves whatever screen/session was active.
// Async work that outlives its screen (e.g. a slow map SVG fetch) checks this
// before touching S/#app, so a late response can never hijack a screen the
// user has already navigated away from.
let sessionGen = 0;
function leaveSession() { S = null; sessionGen += 1; }
// Which home tab is selected (persists while navigating in and out of home).
let homeTab = 'play';
// Which crises period (current vs. historical) and coverage tab are selected
// (persists while browsing crisis details).
let crisesPeriod = 'current';
let crisesTab = 'underreported';
// Which leaderboard tab is selected (persists while browsing the leaderboard).
let leaderboardTab = 'challenge';

// ---- tiny helpers ------------------------------------------------------------
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
    <button class="btn ghost" data-topnav="home">🏠 Home</button>
  </div>`;
}
function wireNav() {
  app.querySelectorAll('[data-topnav="home"]').forEach((b) => b.addEventListener('click', showHome));
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

function toast(icon, title, sub) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="ic">${icon}</div><div><div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</div>`;
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
  hud.innerHTML = `
    <button class="chip chip-name hide-sm" id="hudName" title="View profile">👤 <strong>${esc(p.name)}</strong></button>
    <div class="chip" title="${esc(levelTitle(p.xp))}">Lvl <strong>${lp.level}</strong>
      <span class="xpbar"><span></span></span></div>
    <div class="chip hide-sm">XP <strong>${p.xp}</strong></div>
    <div class="chip" title="Current streak">🔥 <strong>${p.currentStreak}</strong></div>
    <div class="chip hide-sm" title="Overall accuracy">🎯 <strong>${accuracy()}%</strong></div>`;
  // Widths are set via CSSOM (not inline style attributes) so the CSP can stay
  // free of style-src 'unsafe-inline'.
  hud.querySelector('.xpbar > span').style.width = lp.pct + '%';
  hud.querySelector('#hudName').addEventListener('click', showProfile);
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
  document.getElementById('themeToggle').textContent = resolved === 'dark' ? '🌙' : '☀️';
  return resolved;
}

// ============================================================================
//  HOME
// ============================================================================
// The World Religions quiz bundles the religion-topic modes into one session.
const RELIGION_MODES = ['religion_founder', 'religion_text', 'religion_holiday', 'religion_symbol', 'religion_place', 'religion_origin'];

const MODE_CARDS = [
  { key: 'capital', emoji: '🏙️', title: 'Country → Capital', desc: 'Name the capital city.' },
  { key: 'country', emoji: '📍', title: 'Capital → Country', desc: 'Which country is this the capital of?' },
  { key: 'religion', emoji: '🕊️', title: 'Largest Religion', desc: 'The most practiced faith.' },
  { key: 'language', emoji: '🗣️', title: 'Primary Language', desc: 'The most widely spoken language.' },
  { key: 'currency', emoji: '💱', title: 'Currency', desc: 'The official currency used.' },
  { key: 'population', emoji: '👥', title: 'Population', desc: 'How many people live there.' },
  // Windows has no flag-emoji font (🇺🇸 renders as "US"), so these two cards use
  // real flag images from flagcdn instead of a regional-indicator emoji.
  { key: 'us_capital', flagIso: 'US', title: 'US States → Capitals', desc: 'All 50 state capitals.' },
  { key: 'mx_capital', flagIso: 'MX', title: 'Mexico States → Capitals', desc: 'All 32 state capitals.' },
  { key: 'ca_capital', flagIso: 'CA', title: 'Canada Provinces → Capitals', desc: 'All 13 provinces & territories.' },
  { key: 'flag', emoji: '🚩', title: 'Flag Mode', desc: 'Identify the country from its flag.' },
  { key: 'historic_flag', emoji: '🏴', title: 'Historic Flags', desc: 'Identify the nation from a flag of the past.' },
  { key: 'similar_flag', emoji: '🎌', title: 'Similar Flags', desc: 'Tell look-alike flags apart (France vs Netherlands…).' },
];

// Interactive click-the-map modes (each is its own SVG-backed session).
const MAP_CARDS = [
  // Unlike the cards below (which start a specific MAP_MODES key directly),
  // this opens a chooser screen — so it overrides the tab's default attr.
  { key: 'map_regions', attr: 'data-go', emoji: '🌍', title: 'Regions & Continents', desc: 'Pick a continent or region — the map zooms in so you only see that part of the world.' },
  // Grouped by entity (world, US, Mexico, Canada) so each pair of forward/
  // reverse modes for the same place sits next to each other.
  { key: 'map_country', emoji: '🌍', title: 'Find the Country', desc: 'Click the country on a world map.' },
  { key: 'map_country_reverse', emoji: '🔎', title: 'Name the Country', desc: 'A country is highlighted — name it.' },
  { key: 'map_flag_country', emoji: '🚩', title: 'Flag → Map', desc: 'See a flag — click its country on the map.' },
  { key: 'map_country_flag', emoji: '🎏', title: 'Map → Flag', desc: 'A country is highlighted — pick its flag.' },
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
  const icon = m.flagIso
    ? `<img decoding="async" class="emoji-flag" alt="" src="${flagUrl(m.flagIso, 'w80')}">`
    : `<span class="emoji">${m.emoji}</span>`;
  return `
    <button class="card" ${m.attr || attr}="${m.key}">
      ${icon}
      <span class="card-title">${m.title}</span>
      <span class="card-desc">${m.desc}</span>
    </button>`;
}

function showHome() {
  clearTimer(); // a challenge timer must never outlive its screen (crash-loop otherwise)
  leaveSession();
  const p = getProfile();
  const dailyDone = dailyDoneToday();
  const missedCount = reviewableMissedIds().length;
  const quickCards = [
    { key: 'mixed', emoji: '🎲', title: 'Mixed Quiz', desc: 'A bit of everything.' },
    { key: 'challenge', emoji: '⏱️', title: 'Challenge Mode', desc: 'Beat the clock for a high score.' },
    { key: 'daily', emoji: '📅', title: `Daily Challenge${dailyDone ? ' ✓' : ''}`, desc: 'Same set for everyone, once a day.' },
    { key: 'religions', emoji: '🕌', title: 'World Religions', desc: 'Founders, texts & holidays — pick a faith.' },
    { key: 'review', emoji: '🔁', title: `Review Missed (${missedCount})`, desc: 'Practice what you got wrong.' },
  ];
  const journeyCards = [
    { key: 'phrases', emoji: '🗣️', title: 'Phrases', desc: 'Common phrases & local sayings around the world.' },
    { key: 'flagkey', emoji: '🚩', title: 'Flag Key', desc: 'Browse every country, US state, Mexican state & Canadian province by flag and name.' },
    { key: 'music', emoji: '🎵', title: 'Music', desc: 'Songs that represent each country.' },
    { key: 'crises', emoji: '📰', title: 'Crises & Events', desc: 'Background on major ongoing world situations.' },
    { key: 'custom', emoji: '🛠️', title: 'Custom Study', desc: 'Choose topics, continents, difficulty & input.' },
    { key: 'stats', emoji: '📊', title: 'Statistics', desc: 'Accuracy, weak areas & study time.' },
    { key: 'achievements', emoji: '🏆', title: 'Achievements', desc: 'Badges & milestones.' },
    { key: 'profile', emoji: '🧭', title: 'Profile', desc: 'Name & reset.' },
    { key: 'about', emoji: 'ℹ️', title: 'About', desc: 'Credits, data sources & privacy.' },
  ];
  // Each category is its own tab instead of one long scrolling page.
  const tabs = [
    { id: 'play', label: '🎮 Play', attr: 'data-go', cards: quickCards },
    { id: 'quizzes', label: '🧠 Quizzes', attr: 'data-mode', cards: MODE_CARDS },
    { id: 'maps', label: '🗺️ Maps', attr: 'data-map', cards: MAP_CARDS },
    { id: 'explore', label: '🌐 Explore', attr: 'data-go', cards: journeyCards },
  ];
  if (!tabs.some((t) => t.id === homeTab)) homeTab = 'play';

  // First-visit explainer — dismissed once, never shown again.
  const onboarding = !p.onboarded ? `
    <div class="callout" role="note">
      <strong>👋 New here?</strong> Every answer teaches a real fact · missed questions
      come back until you know them (that's spaced repetition) · build 🔥 streaks with
      the 📅 Daily Challenge.
      <div class="btn-row mt-10">
        <button class="btn primary" id="onboardGotIt">Got it</button>
        <button class="btn ghost" id="onboardMore">Learn more</button>
      </div>
    </div>` : '';

  app.innerHTML = `
    <h1 class="screen-title">Explore the world 🌍</h1>
    <p class="screen-sub">Places, cultures, faiths, languages, music &amp; current events — learn it all through active recall.</p>
    ${onboarding}
    <div class="tabs" role="tablist">
      ${tabs.map((t) => `<button class="tab ${t.id === homeTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === homeTab}" tabindex="${t.id === homeTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    ${tabs.map((t) => `
      <div class="tab-panel ${t.id === homeTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
        <div class="grid">${t.cards.map((m) => homeCard(t.attr, m)).join('')}</div>
      </div>`).join('')}`;

  wireTabs((id) => { homeTab = id; });
  focusTitle(); // home doesn't use wireNav, so focus explicitly
  const gotIt = app.querySelector('#onboardGotIt');
  if (gotIt) {
    gotIt.addEventListener('click', () => { setOnboarded(); app.querySelector('.callout').remove(); });
    app.querySelector('#onboardMore').addEventListener('click', () => { setOnboarded(); showAbout(); });
  }

  app.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => startQuiz({ title: MODES[b.dataset.mode].label, modes: [b.dataset.mode], total: 10 })));
  app.querySelectorAll('[data-map]').forEach((b) =>
    b.addEventListener('click', () => startMapQuiz({ title: MAP_MODES[b.dataset.map].label, mode: b.dataset.map, total: 10 })));
  app.querySelector('[data-go="map_regions"]').addEventListener('click', showMapRegions);
  app.querySelector('[data-go="mixed"]').addEventListener('click', () => startQuiz({ title: 'Mixed Quiz', modes: ALL_MODES, total: 12 }));
  app.querySelector('[data-go="challenge"]').addEventListener('click', () => startQuiz({ title: 'Challenge Mode', modes: ALL_MODES, total: 15, challenge: true }));
  app.querySelector('[data-go="daily"]').addEventListener('click', startDaily);
  app.querySelector('[data-go="religions"]').addEventListener('click', showReligions);
  app.querySelector('[data-go="review"]').addEventListener('click', startReview);
  app.querySelector('[data-go="phrases"]').addEventListener('click', showPhrases);
  app.querySelector('[data-go="flagkey"]').addEventListener('click', showFlagKey);
  app.querySelector('[data-go="music"]').addEventListener('click', showMusic);
  app.querySelector('[data-go="crises"]').addEventListener('click', showCrises);
  app.querySelector('[data-go="custom"]').addEventListener('click', showCustom);
  app.querySelector('[data-go="stats"]').addEventListener('click', showStats);
  app.querySelector('[data-go="achievements"]').addEventListener('click', showAchievements);
  app.querySelector('[data-go="profile"]').addEventListener('click', showProfile);
  app.querySelector('[data-go="about"]').addEventListener('click', showAbout);
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

    <div class="btn-row"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
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
    toast('🤷', 'Nothing to quiz', 'That selection has no questions yet.');
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
    toast('✅', 'No missed questions', 'Great — your review pile is empty!');
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
    <h1 class="screen-title">World Religions 🕌</h1>
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
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
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
    <h1 class="screen-title">Regions &amp; Continents 🌍</h1>
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
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
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
    toast('🗺️', "Couldn't load the map", err.message);
    return showHome();
  }
  if (myGen !== sessionGen) return; // player already navigated away

  const data = getData();
  const pool = buildMapPool(data, { [svgName]: map.regions }, { modes: [mode], continent });
  if (pool.length === 0) {
    toast('🤷', 'Nothing to quiz', 'That map has no questions yet.');
    return showHome();
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
    ? `<span class="pill">✖️<span class="accent">${S.multiplier.toFixed(1)}</span></span>`
    : '';
  return `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Quit quiz" aria-label="Quit quiz">✕</button>
      <div class="progress"><span></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      ${multiPill}
      <span class="pill">⭐ ${S.xpRun}</span>
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
  app.querySelector('#quitBtn').addEventListener('click', showHome);
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
  if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
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
  app.querySelector('#quitBtn').addEventListener('click', showHome);
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
  app.querySelector('#quitBtn').addEventListener('click', showHome);
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
      d.textContent = "🚩 The flag image couldn't load — check your connection, then try the next question.";
      img.replaceWith(d);
    });
  });
}

// Review sessions rebuild questions through the MCQ engine, which only knows
// quiz modes. Map-mode misses (ids like "map_us:Texas") are practiced by
// replaying the map modes instead, so they're excluded from Review Missed.
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
      toast('📡', 'Connection lost', "Switched to local scoring — this run won't count for the global board.");
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
  if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
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
  app.querySelector('#quitBtn').addEventListener('click', showHome);
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
  if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
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
    <div class="fact">💡 <strong>Fun fact:</strong> ${esc(q.funFact)}</div>
    ${q.history ? `<div class="fact">📜 <strong>History:</strong> ${esc(q.history)}</div>` : ''}
    ${q.source?.note ? `<div class="fact muted">ℹ️ ${esc(q.source.note)}</div>` : ''}
    <div><span class="muted-note">Learn more:</span>
      <div class="learn-more">${links}</div></div>
    <div class="btn-row mt-14">
      <button class="btn primary" id="nextBtn">${S.index >= S.total ? 'See results →' : 'Next →'}</button>
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
    : `<p class="screen-sub">Flawless run — nothing to review. 🌟</p>`;

  const lastOpts = S.lastOpts;
  const wasMap = S.kind === 'map';
  const wasRemote = S.remote && S.challenge;
  const sessionId = S.sessionId;
  app.innerHTML = `
    ${topNav()}
    <div class="question-card result-hero">
      <div class="score">${S.correct}/${S.total}</div>
      <div class="sub">${acc}% accuracy · +${score} XP · best streak ${S.runBest}${perfect ? ' · 💯 perfect!' : ''}</div>
      ${wasRemote ? '<div class="screen-sub" id="globalSyncNote">🌍 Syncing to the global leaderboard…</div>' : ''}
    </div>
    ${missedList}
    <div class="btn-row mt-18">
      <button class="btn primary" id="againBtn">↻ Play again</button>
      ${S.missed.length ? '<button class="btn" id="reviewBtn">🔁 Review these now</button>' : ''}
      <button class="btn ghost" id="homeBtn">🏠 Home</button>
    </div>`;

  wireNav();
  document.getElementById('againBtn').addEventListener('click', () => (wasMap ? startMapQuiz(lastOpts) : startQuiz(lastOpts)));
  document.getElementById('homeBtn').addEventListener('click', showHome);
  const rb = document.getElementById('reviewBtn');
  if (rb) rb.addEventListener('click', startReview);
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
  // Nothing to report when the total has not moved (a run with no correct
  // answers, say). Every skipped call is one fewer write against the free tier.
  if (p.xp === lastSyncedXp) return;
  lastSyncedXp = p.xp;
  fetch('/api/xp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: p.playerId, name: p.name, xp: p.xp }),
  }).catch(() => { lastSyncedXp = null; }); // allow the next run to retry
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
    if (note) note.textContent = `🌍 Synced — you're #${result.rank} of ${result.total} globally.`;
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
    <h1 class="screen-title">Custom Study 🛠️</h1>
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
      <button class="btn ghost" id="backHome">← Back</button>
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
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelector('#startCustom').addEventListener('click', () => {
    const modes = [...app.querySelectorAll('#modeChecks input:checked')].map((i) => i.value);
    const conts = [...app.querySelectorAll('#contChecks input:checked')].map((i) => i.value);
    if (modes.length === 0) return toast('⚠️', 'Pick at least one question type');
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
      <div class="form-block">
        <input type="text" class="type-input flagkey-search" data-group="${g.id}" placeholder="Search ${esc(g.label.toLowerCase())}…" value="${esc(flagKeySearch[g.id])}">
        <select class="select mt-10 flagkey-region" data-group="${g.id}">
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
    <h1 class="screen-title">Flag Key 🚩</h1>
    <p class="screen-sub">A browsable reference — every country, US state, Mexican state and Canadian province, by flag and name. Not a quiz.</p>

    <div class="tabs" role="tablist">
      ${groups.map((g) => `<button class="tab ${g.id === flagKeyTab ? 'active' : ''}" role="tab" id="tab-${g.id}" aria-controls="panel-${g.id}" aria-selected="${g.id === flagKeyTab}" tabindex="${g.id === flagKeyTab ? 0 : -1}" data-tab="${g.id}">${esc(g.label)}</button>`).join('')}
    </div>

    ${groups.map((g) => `
      <div class="tab-panel ${g.id === flagKeyTab ? 'active' : ''}" data-panel="${g.id}" id="panel-${g.id}" role="tabpanel" aria-labelledby="tab-${g.id}">
        ${panelFor(g)}
      </div>`).join('')}

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;

  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);

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
    panel.querySelector('.flagkey-search').addEventListener('input', (e) => {
      flagKeySearch[g.id] = e.target.value;
      applyFilter(g.id);
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
function showPhrases() {
  leaveSession();
  const entries = getData().phrases || [];
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Phrases 🗣️</h1>
    <p class="screen-sub">Pick a country to learn a few common phrases — and the sayings locals actually use. Tap 🔊 to hear them.</p>
    <div class="grid">
      ${entries.map((e) => `
        <button class="card" data-country="${esc(e.country)}">
          <img decoding="async" class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
          <span class="card-title">${esc(e.country)}</span>
          <span class="card-desc">${esc(e.language)}</span>
        </button>`).join('')}
    </div>
    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-country]').forEach((b) =>
    b.addEventListener('click', () => renderPhraseDetail(entries.find((e) => e.country === b.dataset.country))));
}

// A small 🔊 button that speaks `text` in the entry's language (hidden when the
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
  return `<button class="spk" type="button" data-speak="${esc(text)}" data-lang="${esc(lang || '')}" data-fallback="${esc(fallback || '')}" title="Hear it" aria-label="Hear pronunciation">🔊</button>`;
}

// nativeCountry.pron mixes a romanized name with a bracketed simple phonetic
// for non-Latin-script entries, e.g. "Zhōngguó (jong-gwoh)" — the bracketed
// part alone is what we want a mismatched-voice TTS fallback to read.
const phoneticOf = (pron) => (/\(([^)]+)\)/.exec(pron || '') || [null, pron])[1];

function renderPhraseDetail(entry) {
  if (!entry) return showPhrases();
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
      <button class="btn ghost" id="backPhrases">← All countries</button>
      <button class="btn ghost" id="backHome">🏠 Home</button>
    </div>`;
  wireNav();
  const bpt = app.querySelector('#backPhrasesTop');
  if (bpt) bpt.addEventListener('click', showPhrases);
  app.querySelector('#backPhrases').addEventListener('click', showPhrases);
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-speak]').forEach((b) =>
    b.addEventListener('click', () => speak(b.dataset.speak, b.dataset.lang, b.dataset.fallback)));
}

// ============================================================================
//  MUSIC  (songs that represent each country — embedded YouTube player)
// ============================================================================
function showMusic() {
  leaveSession();
  const entries = getData().music || [];
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Music 🎵</h1>
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
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-country]').forEach((b) =>
    b.addEventListener('click', () => renderMusicDetail(entries.find((e) => e.country === b.dataset.country))));
}

function renderMusicDetail(entry) {
  if (!entry) return showMusic();
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
      <button class="btn ghost" id="backMusic">← All countries</button>
      <button class="btn ghost" id="backHome">🏠 Home</button>
    </div>`;
  wireNav();
  const bmt = app.querySelector('#backMusicTop');
  if (bmt) bmt.addEventListener('click', showMusic);
  app.querySelector('#backMusic').addEventListener('click', showMusic);
  app.querySelector('#backHome').addEventListener('click', showHome);
  const player = app.querySelector('#ytPlayer');
  app.querySelectorAll('.track').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('.track').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    player.src = `https://www.youtube-nocookie.com/embed/${b.dataset.yt}?autoplay=1`;
  }));
}

// ============================================================================
//  CRISES & CURRENT EVENTS  (curated background + live-source links)
// ============================================================================
function showCrises() {
  leaveSession();
  const entries = getData().crises || [];
  // Two independent axes: which time period (current vs. historical), and
  // which coverage tier within it (underreported vs. famous) — four pages total.
  const periods = [
    { id: 'current', label: '📰 Current' },
    { id: 'historical', label: '🏺 Historical' },
  ];
  const tiers = [
    { id: 'underreported', label: '🔦 Underreported', blurb: 'Crises that receive far less attention than their scale deserves.' },
    { id: 'famous', label: '🌐 Famous', blurb: 'The largest or most widely known crises, regardless of how heavily they are covered.' },
  ];
  if (!periods.some((p) => p.id === crisesPeriod)) crisesPeriod = 'current';
  if (!tiers.some((t) => t.id === crisesTab)) crisesTab = 'underreported';
  const cardsFor = (tier) => entries.filter((e) =>
    (e.period || 'current') === crisesPeriod && (e.tier || 'underreported') === tier);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Crises &amp; Events 📰</h1>
    <p class="screen-sub">${crisesPeriod === 'historical'
      ? 'Famous and underreported crises from history — what happened, and why it still matters.'
      : 'Background on ongoing world situations, with links to live sources. Curated context — not real-time reporting.'}</p>

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
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  wireTabs((id) => {
    crisesPeriod = id;
    showCrises();
    app.querySelector(`#period-${id}`)?.focus();
  }, app.querySelector('#periodTabs'));
  wireTabs((id) => { crisesTab = id; }, app.querySelector('#tierSection'));
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-crisis]').forEach((b) =>
    b.addEventListener('click', () => renderCrisisDetail(entries.find((e) => e.title === b.dataset.crisis))));
}

function renderCrisisDetail(entry) {
  if (!entry) return showCrises();
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
      <button class="btn ghost" id="backCrises">← All crises</button>
      <button class="btn ghost" id="backHome">🏠 Home</button>
    </div>`;
  wireNav();
  const bct = app.querySelector('#backCrisesTop');
  if (bct) bct.addEventListener('click', showCrises);
  app.querySelector('#backCrises').addEventListener('click', showCrises);
  app.querySelector('#backHome').addEventListener('click', showHome);
}

// ============================================================================
//  STATISTICS
// ============================================================================
function showStats() {
  leaveSession();
  const p = getProfile();
  const cats = Object.entries(p.perCategory);
  const regs = Object.entries(p.perRegion);
  const bar = (label, c) => {
    const pct = c.answered ? Math.round((c.correct / c.answered) * 100) : 0;
    return `<div class="bar-row"><span class="name">${esc(label)}</span>
      <div class="bar-track"><span data-w="${pct}"></span></div>
      <span class="pct">${pct}%</span></div>`;
  };
  const missed = Object.entries(p.missed).sort((a, b) => b[1].wrong - a[1].wrong).slice(0, 12);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Statistics 📊</h1>
    <p class="screen-sub">Where you're strong, and where to focus next.</p>
    <div class="stat-grid">
      <div class="stat"><div class="big">${accuracy()}%</div><div class="lbl">Accuracy</div></div>
      <div class="stat"><div class="big">${p.totalAnswered}</div><div class="lbl">Questions</div></div>
      <div class="stat"><div class="big">${p.totalCorrect}</div><div class="lbl">Correct</div></div>
      <div class="stat"><div class="big">${p.bestStreak}</div><div class="lbl">Best streak</div></div>
      <div class="stat"><div class="big">${levelProgress(p.xp).level}</div><div class="lbl">Level · ${esc(levelTitle(p.xp))}</div></div>
      <div class="stat"><div class="big">${fmtTime(p.studyTimeMs)}</div><div class="lbl">Study time</div></div>
      <div class="stat"><div class="big">${weakCount(p.srs)}</div><div class="lbl">Weak items</div></div>
      <div class="stat"><div class="big">${Object.keys(p.achievements).length}</div><div class="lbl">Badges</div></div>
    </div>

    <div class="section-h">Performance by category</div>
    ${cats.length ? cats.map(([k, v]) => bar(catLabel(k), v)).join('') : '<p class="screen-sub">Play a round to see this.</p>'}

    <div class="section-h">Performance by region</div>
    ${regs.length ? regs.map(([k, v]) => bar(k, v)).join('') : '<p class="screen-sub">No regional data yet.</p>'}

    <div class="section-h">Weak areas (most missed)</div>
    ${missed.length ? `<ul class="weak-list">${missed.map(([, m]) => `<li><span>${esc(m.label)}</span><span class="ans">${esc(m.answer)} · missed ${m.wrong}×</span></li>`).join('')}</ul>` : '<p class="screen-sub">Nothing missed — keep it up!</p>'}

    <div class="btn-row mt-18">
      <button class="btn" id="reviewW" ${missed.length ? '' : 'disabled'}>🔁 Practice weak areas</button>
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  app.querySelectorAll('[data-w]').forEach((s) => { s.style.width = s.dataset.w + '%'; });
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  const rw = app.querySelector('#reviewW');
  if (missed.length) rw.addEventListener('click', startReview);
}

// ============================================================================
//  ACHIEVEMENTS
// ============================================================================
function showAchievements() {
  leaveSession();
  const list = achievementStatus(getProfile());
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Achievements 🏆</h1>
    <p class="screen-sub">${list.filter((a) => a.unlocked).length} of ${list.length} unlocked.</p>
    <div class="ach-grid">
      ${list.map((a) => `
        <div class="ach ${a.unlocked ? '' : 'locked'}">
          <div class="ic">${a.icon}</div>
          <div class="nm">${esc(a.name)}</div>
          <div class="ds">${esc(a.desc)}</div>
          <div class="mini"><span data-w="${a.pct}"></span></div>
          <div class="lbl ach-lbl">${a.current}/${a.threshold}</div>
        </div>`).join('')}
    </div>
    <div class="btn-row mt-18"><button class="btn ghost" id="backHome">← Back</button></div>`;
  app.querySelectorAll('[data-w]').forEach((s) => { s.style.width = s.dataset.w + '%'; });
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
}

// ============================================================================
//  LEADERBOARD
// ============================================================================
function showLeaderboard() {
  leaveSession();
  const lb = getProfile().leaderboard;
  const tiers = [
    { id: 'challenge', label: '⏱️ Challenge' },
    { id: 'daily', label: '📅 Daily' },
    { id: 'xp', label: '🎖️ Level/XP' },
  ];
  if (!tiers.some((t) => t.id === leaderboardTab)) leaderboardTab = 'challenge';

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Leaderboard 🏆</h1>

    <div class="section-h">🌍 Global</div>
    <div class="tabs" role="tablist">
      ${tiers.map((t) => `<button class="tab ${t.id === leaderboardTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === leaderboardTab}" tabindex="${t.id === leaderboardTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    ${tiers.map((t) => `
      <div class="tab-panel ${t.id === leaderboardTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
        ${t.id === 'xp' ? '<p class="screen-sub mb-10">Lifetime XP across every quiz mode, synced from your device — self-reported, unlike the Challenge &amp; Daily tabs.</p>' : ''}
        <div class="form-block" id="globalList-${t.id}"><p class="screen-sub">Loading…</p></div>
      </div>`).join('')}

    <div class="section-h">📱 Your personal bests</div>
    <div class="form-block">
      ${lb.length ? `<ul class="weak-list">${lb.map((e, i) => `<li><span>#${i + 1} · ${esc(e.mode)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>` : '<p class="screen-sub">Play Challenge or Daily to set a high score.</p>'}
    </div>

    <div class="btn-row mt-18"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  wireTabs((id) => { leaderboardTab = id; });
  app.querySelector('#backHome').addEventListener('click', showHome);
  tiers.forEach((t) => loadGlobalLeaderboard(t.id));
}

async function loadGlobalLeaderboard(mode) {
  const myGen = sessionGen;
  const target = document.getElementById(`globalList-${mode}`);
  try {
    const res = await fetch(`/api/leaderboard?mode=${mode}`);
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
    <h1 class="screen-title">Profile 🧭</h1>
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
        <button class="btn" id="exportBtn">⬇️ Export progress</button>
        <button class="btn" id="importBtn">⬆️ Import progress</button>
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
    <div class="btn-row"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelector('#saveName').addEventListener('click', () => {
    setName(app.querySelector('#nameInput').value);
    toast('✅', 'Name saved', getProfile().name);
  });
  app.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(getProfile(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worldly-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('⬇️', 'Progress exported', 'Keep the file safe — import it anywhere.');
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
      toast('✅', 'Progress imported', `Welcome back, ${p.name} — level ${levelProgress(p.xp).level}!`);
      showProfile();
    } catch (e) {
      toast('⚠️', "Couldn't import that file", e.message);
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
    if (optOutBox.checked) toast('🔕', 'Analytics off', 'Nothing further will be sent from this browser.');
    else { loadAnalytics(); toast('📊', 'Analytics on', 'Thanks — it helps show which modes get used.'); }
  });

  app.querySelector('#resetBtn').addEventListener('click', () => {
    if (confirm('Really reset ALL progress? This cannot be undone.')) {
      resetProfile();
      renderHUD();
      toast('🧹', 'Progress reset', 'A fresh start!');
      showHome();
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
  document.getElementById('brand').addEventListener('click', showHome);
  document.getElementById('helpBtn').addEventListener('click', showAbout);
  document.getElementById('leaderboardBtn').addEventListener('click', showLeaderboard);
  document.addEventListener('keydown', onKeydown);

  // Surface storage failures once per session instead of losing progress silently.
  let warnedSave = false;
  window.addEventListener('worldly:save-failed', () => {
    if (warnedSave) return;
    warnedSave = true;
    toast('⚠️', "Progress can't be saved", 'Browser storage may be full or blocked (private mode).');
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
           <div class="btn-row"><button class="btn primary" id="retryBtn">↻ Retry</button></div>`}
      </div>`;
    const retry = document.getElementById('retryBtn');
    if (retry) retry.addEventListener('click', () => location.reload());
    return;
  }
  renderHUD();
  showHome();
  // Every render from here on is a navigation, where moving focus is correct.
  allowFocusTitle = true;

  // Offline resilience: cache app shell + seen flags (see sw.js). Feature-
  // detected and fire-and-forget — a failure must never affect the app.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  }
}

boot();
