// main.js — application controller. Owns routing between screens, renders the
// HUD, runs a quiz session, and reacts to answers (scoring, XP, achievements).

import { loadData, getData, getContinents, getRegions, flagUrl, historicFlagUrl, stateFlagUrl, loadMap } from './data.js';
import {
  loadProfile, getProfile, saveProfile, resetProfile, importProfile, levelProgress, accuracy,
  recordAnswer, recordStudyTime, recordPerfectQuiz, markDailyComplete,
  dailyDoneToday, addLeaderboard, setTheme, setName, setOnboarded, localDateStr,
} from './state.js';
import { track, tag } from './analytics.js';
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches } from './quiz.js';
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
// Which crises tab is selected (persists while browsing crisis details).
let crisesTab = 'underreported';

// ---- tiny helpers ------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
function focusTitle() {
  const h = app.querySelector('.screen-title, .q-prompt');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}

// Accessible tab bar shared by Home and Crises: click + Arrow/Home/End keys,
// roving tabindex. `onChange(id)` persists the selection.
function wireTabs(onChange) {
  const tabs = [...app.querySelectorAll('.tab')];
  const activate = (id, focus = false) => {
    onChange(id);
    tabs.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    app.querySelectorAll('.tab-panel').forEach((pl) => pl.classList.toggle('active', pl.dataset.panel === id));
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

// Seeded RNG (mulberry32) so the Daily Challenge is identical for everyone.
function seededRng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function dailySeed() {
  // Local calendar date: the daily rolls over at the player's midnight, and the
  // same date string yields the same seeded set for everyone.
  const d = localDateStr();
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) | 0;
  return h;
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
    <div class="chip" title="${esc(levelTitle(p.xp))}">Lvl <strong>${lp.level}</strong>
      <span class="xpbar"><span></span></span></div>
    <div class="chip hide-sm">XP <strong>${p.xp}</strong></div>
    <div class="chip" title="Current streak">🔥 <strong>${p.currentStreak}</strong></div>
    <div class="chip hide-sm" title="Overall accuracy">🎯 <strong>${accuracy()}%</strong></div>`;
  // Widths are set via CSSOM (not inline style attributes) so the CSP can stay
  // free of style-src 'unsafe-inline'.
  hud.querySelector('.xpbar > span').style.width = lp.pct + '%';
}

// ---- theme -------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'dark' ? '🌙' : '☀️';
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
  { key: 'map_country', emoji: '🌍', title: 'Find the Country', desc: 'Click the country on a world map.' },
  { key: 'map_us', flagIso: 'US', title: 'Find the US State', desc: 'Click the state on a US map.' },
  { key: 'map_mx', flagIso: 'MX', title: 'Find the Mexican State', desc: 'Click the state on a Mexico map.' },
  { key: 'map_ca', flagIso: 'CA', title: 'Find the Canadian Province', desc: 'Click the province on a Canada map.' },
  { key: 'map_country_reverse', emoji: '🔎', title: 'Name the Country', desc: 'A country is highlighted — name it.' },
  { key: 'map_us_reverse', flagIso: 'US', title: 'Name the US State', desc: 'A state is highlighted — name it.' },
  { key: 'map_mx_reverse', flagIso: 'MX', title: 'Name the Mexican State', desc: 'A state is highlighted — name it.' },
  { key: 'map_ca_reverse', flagIso: 'CA', title: 'Name the Canadian Province', desc: 'A province is highlighted — name it.' },
  { key: 'map_flag_country', emoji: '🚩', title: 'Flag → Map', desc: 'See a flag — click its country on the map.' },
  { key: 'map_country_flag', emoji: '🎏', title: 'Map → Flag', desc: 'A country is highlighted — pick its flag.' },
  // Unlike the cards above (which start a specific MAP_MODES key directly),
  // this opens a chooser screen — so it overrides the tab's default attr.
  { key: 'map_regions', attr: 'data-go', emoji: '🌍', title: 'Regions & Continents', desc: 'Pick a continent — the map zooms in so you only see that part of the world.' },
];

// Card markup shared by every home tab. `attr` is the routing attribute
// (data-go / data-mode / data-map) the click handlers below listen on; a card
// can override it with its own `m.attr` (e.g. a map card that opens a chooser
// screen instead of starting a mode directly).
function homeCard(attr, m) {
  const icon = m.flagIso
    ? `<img class="emoji-flag" alt="" src="${flagUrl(m.flagIso, 'w80')}">`
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
    { key: 'profile', emoji: '🧭', title: 'Profile', desc: 'Name, leaderboard & reset.' },
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
      <h3>Privacy</h3>
      <p class="screen-sub">Your progress is stored only in this browser (localStorage) — Worldly has no accounts.
      We use Microsoft Clarity for anonymous usage analytics (which screens and modes get used) to improve the game;
      no names, quiz answers or saved progress are ever sent. Flag images load from flagcdn.com, historic flags from
      Wikimedia Commons, and music plays through YouTube's privacy-enhanced player, which sets cookies only if you
      play a video.</p>
    </div>

    <div class="form-block">
      <h3>Credits &amp; data sources</h3>
      <ul class="about-list">
        <li>Interactive map SVGs adapted from the <a href="https://github.com/VictorCazanave/svg-maps" target="_blank" rel="noopener">@svg-maps</a> project (MIT License) by Victor Cazanave and contributors.</li>
        <li>Flag images served by <a href="https://flagcdn.com" target="_blank" rel="noopener">flagcdn.com</a>.</li>
        <li>Historic flag images from <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a>.</li>
        <li>Facts curated from public reference sources, including <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a> and the <a href="https://www.cia.gov/the-world-factbook/" target="_blank" rel="noopener">CIA World Factbook</a>.</li>
        <li>Music plays via embedded YouTube; all rights remain with the artists and labels.</li>
      </ul>
    </div>

    <div class="form-block">
      <h3>Feedback &amp; requests</h3>
      <p class="screen-sub">Found a bug, spotted a wrong fact, or want a new mode?
      <a href="https://github.com/IBR10/worldly/issues/new" target="_blank" rel="noopener">Open an issue on GitHub ↗</a>
      — data corrections are especially welcome.</p>
    </div>

    <div class="form-block">
      <h3>Editorial notes</h3>
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
function startQuiz(opts) {
  const { title, modes, continents = 'all', difficulty = 'medium', total = 10, challenge = false, daily = false, reviewIds = null, seed = null, religionFilter = null, input = 'mcq' } = opts;
  const data = getData();
  const rng = seed != null ? seededRng(seed) : Math.random;
  const config = { modes, continents, difficulty, choices: 4, rng, religionFilter };
  // Daily uses plain seeded picking (same for everyone); other modes use SRS
  // weighting so forgotten/missed items resurface more often.
  const pick = daily ? null : (pool, srsMap) => pickWeighted(pool, srsMap, rng);
  const engine = createQuiz({ data, config, srsMap: getProfile().srs, reviewIds, pick, rng });

  if (engine.size === 0) {
    toast('🤷', 'Nothing to quiz', 'That selection has no questions yet.');
    return;
  }

  track('quiz_started');
  if (challenge) track(daily ? 'daily_challenge_started' : 'challenge_started');
  tag('mode', title);

  S = {
    // Clamp to the number of unique questions so a session never has to repeat.
    title, engine, total: Math.min(total, engine.size), challenge, daily, input, lastOpts: opts,
    index: 0, correct: 0, runStreak: 0, runBest: 0, xpRun: 0,
    missed: [], startTime: Date.now(), phase: 'answer', current: null,
    timer: null, multiplier: 1,
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
      <h3>Choose a faith</h3>
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

// Regions & Continents chooser: pick a continent + a world-map mode, then play
// it zoomed into just that continent (see startMapQuiz's `continent` handling).
function showMapRegions() {
  leaveSession();
  const continents = getContinents();
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Regions &amp; Continents 🌍</h1>
    <p class="screen-sub">Pick a continent — the map zooms in so you're only looking at that part of the world.</p>
    <div class="form-block">
      <h3>Continent</h3>
      <select id="contSel" class="select">
        ${continents.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="form-block">
      <h3>Mode</h3>
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

  // Zoom the map view to the chosen continent's countries. Only meaningful for
  // country-sourced (world map) modes — US/MX state modes have no continent.
  const focusIds = (continent && MAP_MODES[mode]?.source === 'country')
    ? data.countries.filter((c) => c.region === continent && c.iso2 && map.regions[c.iso2.toLowerCase()])
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

function renderMapQuestion(q) {
  const progressPct = Math.round((S.index / S.total) * 100);
  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${q.flagIso ? `<img class="q-flag" alt="Flag to locate" src="${flagUrl(q.flagIso)}">` : ''}
      <div class="q-prompt">${esc(q.prompt)}</div>
      <div id="mapMount" class="map-mount"></div>
      <div id="feedback" role="status" aria-live="assertive"></div>
    </div>`;

  app.querySelector('.progress > span').style.width = progressPct + '%';
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
  const progressPct = Math.round((S.index / S.total) * 100);
  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      <div class="q-prompt">${esc(q.prompt)}</div>
      <div id="mapMount" class="map-mount"></div>
      <div class="choices" id="choices">
        ${q.choices.map((c, i) => q.flagChoices
          ? `<button class="choice choice-flag" data-val="${esc(c)}" aria-label="Flag of ${esc(c)}">
               <span class="key">${i + 1}</span><img src="${flagUrl(q.flagByName[c], 'w160')}" alt="Flag of ${esc(c)}">
             </button>`
          : `<button class="choice" data-val="${esc(c)}">
               <span class="key">${i + 1}</span><span>${esc(c)}</span>
             </button>`).join('')}
      </div>
      <div id="feedback" role="status" aria-live="assertive"></div>
    </div>`;
  app.querySelector('.progress > span').style.width = progressPct + '%';
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
  const progressPct = Math.round((S.index / S.total) * 100);
  const multiPill = S.challenge ? `<span class="pill">✖️<span class="accent">${S.multiplier.toFixed(1)}</span></span>` : '';
  const flagSrc = q.flagIso ? flagUrl(q.flagIso) : (q.flagImg ? historicFlagUrl(q.flagImg) : null);
  const flag = flagSrc ? `<img class="q-flag" alt="Flag to identify" src="${flagSrc}">` : '';

  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      ${multiPill}
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    ${S.challenge ? '<div class="timer" id="timer"><span></span></div>' : ''}
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${flag}
      <div class="q-prompt">${esc(q.prompt)}</div>
      <div class="choices" id="choices">
        ${q.choices.map((c, i) => `
          <button class="choice" data-val="${esc(c)}">
            <span class="key">${i + 1}</span><span>${esc(c)}</span>
          </button>`).join('')}
      </div>
      <div id="feedback" role="status" aria-live="assertive"></div>
    </div>`;

  app.querySelector('.progress > span').style.width = progressPct + '%';
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
// quiz modes. Map-mode misses (ids like "map_us:Texas") are practised by
// replaying the map modes instead, so they're excluded from Review Missed.
function reviewableMissedIds() {
  return Object.keys(getProfile().missed).filter((id) => MODES[id.split(':')[0]]);
}

function answer(value) {
  if (S.phase !== 'answer') return;
  clearTimer();
  S.phase = 'feedback';
  const q = S.current;
  const correct = value === q.answer;
  const multiplier = S.challenge ? S.multiplier : 1;

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
    S.xpRun += res.xpGained;
  } else {
    S.runStreak = 0;
    S.missed.push(q);
  }

  // achievements & level-ups
  track('question_answered');
  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  renderFeedback(correct, q, res.xpGained);
  renderHUD();
}

// Typed-answer mode: same questions as MCQ, but the player types the answer and
// it's checked with accent/case-insensitive matching (answerMatches).
function renderTypedQuestion(q) {
  const progressPct = Math.round((S.index / S.total) * 100);
  const flagSrc = q.flagIso ? flagUrl(q.flagIso) : (q.flagImg ? historicFlagUrl(q.flagImg) : null);
  const flag = flagSrc ? `<img class="q-flag" alt="Flag to identify" src="${flagSrc}">` : '';
  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${flag}
      <div class="q-prompt" id="qPrompt">${esc(q.prompt)}</div>
      <form class="type-form" id="typeForm" autocomplete="off">
        <input class="type-input" id="typeInput" type="text" placeholder="Type your answer…"
               aria-labelledby="qPrompt" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <button class="btn primary" type="submit">Submit</button>
      </form>
      <div id="feedback" role="status" aria-live="assertive"></div>
    </div>`;
  app.querySelector('.progress > span').style.width = progressPct + '%';
  app.querySelector('#quitBtn').addEventListener('click', showHome);
  wireFlagFallback();
  const form = app.querySelector('#typeForm');
  const inp = app.querySelector('#typeInput');
  form.addEventListener('submit', (e) => { e.preventDefault(); answerTyped(inp.value); });
  inp.focus();
  renderHUD();
}

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
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  fb.className = `feedback ${correct ? 'ok' : 'no'} pop`;
  fb.innerHTML = `
    <h3>${correct ? `✓ Correct! +${xpGained} XP` : `✗ The answer is ${esc(q.answer)}`}</h3>
    <div class="fact">💡 <strong>Fun fact:</strong> ${esc(q.funFact)}</div>
    ${q.source?.note ? `<div class="fact muted">ℹ️ ${esc(q.source.note)}</div>` : ''}
    <div><span class="muted-note">Learn more:</span>
      <div class="learn-more">${links}</div></div>
    <div class="btn-row mt-14">
      <button class="btn primary" id="nextBtn">${S.index >= S.total ? 'See results →' : 'Next →'}</button>
    </div>`;
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
  app.innerHTML = `
    ${topNav()}
    <div class="question-card result-hero">
      <div class="score">${S.correct}/${S.total}</div>
      <div class="sub">${acc}% accuracy · +${score} XP · best streak ${S.runBest}${perfect ? ' · 💯 perfect!' : ''}</div>
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
      <h3>Question types</h3>
      <div class="checks" id="modeChecks">
        ${ALL_MODES.map((m) => `<label class="check"><input type="checkbox" value="${m}" checked>${esc(MODES[m].label)}</label>`).join('')}
      </div>
    </div>

    <div class="form-block">
      <h3>Continents <span class="muted-note">(country modes only)</span></h3>
      <div class="checks" id="contChecks">
        ${continents.map((c) => `<label class="check"><input type="checkbox" value="${esc(c)}" checked>${esc(c)}</label>`).join('')}
      </div>
    </div>

    <div class="form-block">
      <h3>Difficulty</h3>
      <div class="seg" id="diffSeg">
        <button data-d="easy">Easy</button>
        <button data-d="medium" class="active">Medium</button>
        <button data-d="hard">Hard</button>
      </div>
      <h3 class="mt-16">Length</h3>
      <div class="seg" id="lenSeg">
        <button data-n="10" class="active">10</button>
        <button data-n="20">20</button>
        <button data-n="30">30</button>
      </div>
      <h3 class="mt-16">Answer input</h3>
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
let flagKeySearch = { countries: '', us: '', mx: '', ca: '' };
let flagKeyRegion = { countries: '', us: '', mx: '', ca: '' };

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

  const panelFor = (g) => {
    const regions = getRegions(g.list);
    const term = flagKeySearch[g.id].toLowerCase();
    const region = flagKeyRegion[g.id];
    const visible = g.list.filter((x) =>
      (!term || x.name.toLowerCase().includes(term)) && (!region || x.region === region));
    return `
      <div class="form-block">
        <input type="text" class="type-input flagkey-search" data-group="${g.id}" placeholder="Search ${esc(g.label.toLowerCase())}…" value="${esc(flagKeySearch[g.id])}">
        <select class="select mt-10 flagkey-region" data-group="${g.id}">
          <option value="">All regions</option>
          ${regions.map((r) => `<option value="${esc(r)}" ${r === region ? 'selected' : ''}>${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div class="grid flagkey-grid" data-group="${g.id}">
        ${visible.map((x) => `
          <div class="card flagkey-card">
            <img class="emoji-flag" alt="" src="${g.flagFn(x)}" onerror="this.style.display='none'">
            <span class="card-title">${esc(x.name)}</span>
            <span class="card-desc">${esc(x.capital)}</span>
          </div>`).join('')}
      </div>
      ${visible.length === 0 ? '<p class="screen-sub">No matches.</p>' : ''}`;
  };

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
  wireTabs((id) => { flagKeyTab = id; });
  app.querySelector('#backHome').addEventListener('click', showHome);

  // Re-render just the active panel's grid on every search/region change,
  // without losing focus or rebuilding the whole screen.
  const rerenderGroup = (id) => {
    const g = groups.find((x) => x.id === id);
    app.querySelector(`.tab-panel[data-panel="${id}"]`).innerHTML = panelFor(g);
    wireFlagKeyControls(id);
  };
  function wireFlagKeyControls(id) {
    const panel = app.querySelector(`.tab-panel[data-panel="${id}"]`);
    panel.querySelector('.flagkey-search').addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      flagKeySearch[id] = e.target.value;
      rerenderGroup(id);
      const newInput = panel.querySelector('.flagkey-search');
      newInput.focus();
      newInput.setSelectionRange(pos, pos);
    });
    panel.querySelector('.flagkey-region').addEventListener('change', (e) => {
      flagKeyRegion[id] = e.target.value;
      rerenderGroup(id);
    });
  }
  groups.forEach((g) => wireFlagKeyControls(g.id));
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
          <img class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
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
function speakBtn(text, lang, fallback) {
  if (!ttsAvailable() || !text) return '';
  return `<button class="spk" type="button" data-speak="${esc(text)}" data-lang="${esc(lang || '')}" data-fallback="${esc(fallback || '')}" title="Hear it" aria-label="Hear pronunciation">🔊</button>`;
}

// nativeCountry.pron mixes a romanized name with a bracketed simple phonetic
// for non-Latin-script entries, e.g. "Zhōngguó (jong-gwoh)" — the bracketed
// part alone is what we want a mismatched-voice TTS fallback to read.
const phoneticOf = (pron) => (/\(([^)]+)\)/.exec(pron || '') || [, pron])[1];

function renderPhraseDetail(entry) {
  if (!entry) return showPhrases();
  const lang = entry.langCode || '';
  const native = entry.nativeCountry
    ? `<div class="native-name">${esc(entry.nativeCountry.local)} ${speakBtn(entry.nativeCountry.local, lang, phoneticOf(entry.nativeCountry.pron))}
         <span class="say-pron">${esc(entry.nativeCountry.pron)}</span></div>`
    : '';
  app.innerHTML = `
    ${topNav({ id: 'backPhrasesTop', label: '← All countries' })}
    <div class="phrase-head">
      <img class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
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
          <span class="ph-local">${esc(p.local)} ${speakBtn(p.local, lang, p.pron)}</span>
          <span class="ph-pron">${esc(p.pron)}</span>
        </div>`).join('')}
    </div>

    <div class="section-h">Popular sayings</div>
    <div class="saying-list">
      ${entry.sayings.map((s) => `
        <div class="saying">
          <div class="say-local">${esc(s.local)} ${speakBtn(s.local, lang, s.pron)} <span class="say-pron">${esc(s.pron)}</span></div>
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
          <img class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
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
      <img class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
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
  // Two curated tiers: crises the world under-covers, and the largest ongoing
  // conflicts regardless of how heavily they are reported.
  const tiers = [
    { id: 'underreported', label: '🔦 Underreported', blurb: 'Major crises that receive far less attention than their scale deserves.' },
    { id: 'major', label: '🌐 Major Conflicts', blurb: 'The largest ongoing conflicts, regardless of how widely they are covered.' },
  ];
  if (!tiers.some((t) => t.id === crisesTab)) crisesTab = 'underreported';
  const cardsFor = (tier) => entries.filter((e) => (e.tier || 'underreported') === tier);

  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Crises &amp; Events 📰</h1>
    <p class="screen-sub">Background on ongoing world situations, with links to live sources. Curated context — not real-time reporting.</p>

    <div class="tabs" role="tablist">
      ${tiers.map((t) => `<button class="tab ${t.id === crisesTab ? 'active' : ''}" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${t.id === crisesTab}" tabindex="${t.id === crisesTab ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>

    ${tiers.map((t) => `
      <div class="tab-panel ${t.id === crisesTab ? 'active' : ''}" data-panel="${t.id}" id="panel-${t.id}" role="tabpanel" aria-labelledby="tab-${t.id}">
        <p class="screen-sub">${esc(t.blurb)}</p>
        <div class="grid">
          ${cardsFor(t.id).map((e) => `
            <button class="card" data-crisis="${esc(e.title)}">
              <img class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
              <span class="card-title">${esc(e.title)}</span>
              <span class="card-desc">${esc(e.country)}</span>
            </button>`).join('')}
        </div>
      </div>`).join('')}

    <div class="btn-row mt-18">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  wireTabs((id) => { crisesTab = id; });
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-crisis]').forEach((b) =>
    b.addEventListener('click', () => renderCrisisDetail(entries.find((e) => e.title === b.dataset.crisis))));
}

function renderCrisisDetail(entry) {
  if (!entry) return showCrises();
  const links = (entry.links || []).filter((l) => l.url)
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
  app.innerHTML = `
    ${topNav({ id: 'backCrisesTop', label: '← All crises' })}
    <div class="phrase-head">
      <img class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
      <div>
        <h1 class="screen-title m-0">${esc(entry.title)}</h1>
        <p class="screen-sub m-tight">${esc(entry.country)}${entry.region ? ' · ' + esc(entry.region) : ''}</p>
      </div>
    </div>

    <div class="crisis-body">
      <p>${esc(entry.summary)}</p>
      ${entry.asOf ? `<p class="muted-note">Background written as of ${esc(entry.asOf)} — follow the live sources below for current developments.</p>` : ''}
      <div><span class="muted-note">Follow the latest:</span>
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
//  PROFILE
// ============================================================================
function showProfile() {
  leaveSession();
  const p = getProfile();
  const lb = p.leaderboard;
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Profile 🧭</h1>
    <div class="form-block">
      <h3>Display name</h3>
      <div class="btn-row">
        <input id="nameInput" class="btn name-input" value="${esc(p.name)}" maxlength="20">
        <button class="btn primary" id="saveName">Save</button>
      </div>
    </div>
    <div class="form-block">
      <h3>Local leaderboard (best scores)</h3>
      ${lb.length ? `<ul class="weak-list">${lb.map((e, i) => `<li><span>#${i + 1} · ${esc(e.mode)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>` : '<p class="screen-sub">Play Challenge or Daily to set a high score.</p>'}
    </div>
    <div class="form-block">
      <h3>Backup &amp; transfer</h3>
      <p class="screen-sub mb-10">Progress lives only in this browser. Export it as a file to back it up or move it to another device / the web version.</p>
      <div class="btn-row">
        <button class="btn" id="exportBtn">⬇️ Export progress</button>
        <button class="btn" id="importBtn">⬆️ Import progress</button>
        <input type="file" id="importFile" accept="application/json,.json" class="hidden">
      </div>
    </div>
    <div class="form-block">
      <h3>Danger zone</h3>
      <p class="screen-sub mb-10">Reset all progress, stats and achievements. This cannot be undone.</p>
      <button class="btn" id="resetBtn" class="btn danger">Reset all progress</button>
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
  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  });
  const brand = document.getElementById('brand');
  brand.addEventListener('click', showHome);
  brand.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showHome(); }
  });
  document.getElementById('helpBtn').addEventListener('click', showAbout);
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

  // Offline resilience: cache app shell + seen flags (see sw.js). Feature-
  // detected and fire-and-forget — a failure must never affect the app.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  }
}

boot();
