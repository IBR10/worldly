// main.js — application controller. Owns routing between screens, renders the
// HUD, runs a quiz session, and reacts to answers (scoring, XP, achievements).

import { loadData, getData, getContinents, flagUrl, historicFlagUrl, loadMap } from './data.js';
import {
  loadProfile, getProfile, saveProfile, resetProfile, levelProgress, accuracy,
  recordAnswer, recordStudyTime, recordPerfectQuiz, markDailyComplete,
  dailyDoneToday, addLeaderboard, setTheme, setName,
} from './state.js';
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches } from './quiz.js';
import { buildMapPool, makeMapQuestion, MAP_MODES, ALL_MAP_MODES } from './maps.js';
import { createMapView } from './mapview.js';
import { pickWeighted, weakCount } from './srs.js';
import { checkAchievements, achievementStatus, levelTitle } from './achievements.js';

// Combined category label lookup (quiz modes + map modes) for HUD/stats.
const catLabel = (k) => MODES[k]?.label || MAP_MODES[k]?.label || k;

const app = document.getElementById('app');
const hud = document.getElementById('hud');
const toastBox = document.getElementById('toasts');

// Active quiz session (null when not playing).
let S = null;

// ---- tiny helpers ------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Speak text aloud via the browser's built-in speech synthesis (free, offline,
// no dependency). `lang` is a BCP-47 tag (e.g. 'ja-JP') so the OS can pick a
// matching voice. Silently no-ops where the Web Speech API is unavailable.
const ttsAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
function speak(text, lang) {
  if (!ttsAvailable() || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
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
  const d = new Date().toISOString().slice(0, 10);
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
      <span class="xpbar"><span style="width:${lp.pct}%"></span></span></div>
    <div class="chip hide-sm">XP <strong>${p.xp}</strong></div>
    <div class="chip" title="Current streak">🔥 <strong>${p.currentStreak}</strong></div>
    <div class="chip hide-sm" title="Overall accuracy">🎯 <strong>${accuracy()}%</strong></div>`;
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
const RELIGION_MODES = ['religion_founder', 'religion_text', 'religion_holiday'];

const MODE_CARDS = [
  { key: 'capital', emoji: '🏙️', title: 'Country → Capital', desc: 'Name the capital city.' },
  { key: 'country', emoji: '📍', title: 'Capital → Country', desc: 'Which country is this the capital of?' },
  { key: 'religion', emoji: '🕊️', title: 'Largest Religion', desc: 'The most practiced faith.' },
  { key: 'language', emoji: '🗣️', title: 'Primary Language', desc: 'The most widely spoken language.' },
  // Windows has no flag-emoji font (🇺🇸 renders as "US"), so these two cards use
  // real flag images from flagcdn instead of a regional-indicator emoji.
  { key: 'us_capital', flagIso: 'US', title: 'US States → Capitals', desc: 'All 50 state capitals.' },
  { key: 'mx_capital', flagIso: 'MX', title: 'Mexico States → Capitals', desc: 'All 32 state capitals.' },
  { key: 'flag', emoji: '🚩', title: 'Flag Mode', desc: 'Identify the country from its flag.' },
  { key: 'historic_flag', emoji: '🏴', title: 'Historic Flags', desc: 'Identify the nation from a flag of the past.' },
  { key: 'similar_flag', emoji: '🎌', title: 'Similar Flags', desc: 'Tell look-alike flags apart (France vs Netherlands…).' },
];

// Interactive click-the-map modes (each is its own SVG-backed session).
const MAP_CARDS = [
  { key: 'map_country', emoji: '🌍', title: 'Find the Country', desc: 'Click the country on a world map.' },
  { key: 'map_us', flagIso: 'US', title: 'Find the US State', desc: 'Click the state on a US map.' },
  { key: 'map_mx', flagIso: 'MX', title: 'Find the Mexican State', desc: 'Click the state on a Mexico map.' },
  { key: 'map_country_reverse', emoji: '🔎', title: 'Name the Country', desc: 'A country is highlighted — name it.' },
  { key: 'map_us_reverse', flagIso: 'US', title: 'Name the US State', desc: 'A state is highlighted — name it.' },
  { key: 'map_mx_reverse', flagIso: 'MX', title: 'Name the Mexican State', desc: 'A state is highlighted — name it.' },
];

function showHome() {
  S = null;
  const p = getProfile();
  const dailyDone = dailyDoneToday();
  const missedCount = Object.keys(p.missed).length;
  const quickCards = [
    { key: 'mixed', emoji: '🎲', title: 'Mixed Quiz', desc: 'A bit of everything.' },
    { key: 'challenge', emoji: '⏱️', title: 'Challenge Mode', desc: 'Beat the clock for a high score.' },
    { key: 'daily', emoji: '📅', title: `Daily Challenge${dailyDone ? ' ✓' : ''}`, desc: 'Same set for everyone, once a day.' },
    { key: 'religions', emoji: '🕌', title: 'World Religions', desc: 'Founders, texts & holidays — pick a faith.' },
    { key: 'review', emoji: '🔁', title: `Review Missed (${missedCount})`, desc: 'Practice what you got wrong.' },
  ];
  app.innerHTML = `
    <h1 class="screen-title">Explore the world 🌍</h1>
    <p class="screen-sub">Places, cultures, faiths, languages, music &amp; current events — learn it all through active recall.</p>

    <div class="section-h">Quick play</div>
    <div class="grid">
      ${quickCards.map((m) => `
        <button class="card" data-go="${m.key}">
          <span class="emoji">${m.emoji}</span>
          <span class="card-title">${m.title}</span>
          <span class="card-desc">${m.desc}</span>
        </button>`).join('')}
    </div>

    <div class="section-h">Single-topic modes</div>
    <div class="grid">
      ${MODE_CARDS.map((m) => `
        <button class="card" data-mode="${m.key}">
          ${m.flagIso
            ? `<img class="emoji-flag" alt="" src="${flagUrl(m.flagIso, 'w80')}">`
            : `<span class="emoji">${m.emoji}</span>`}
          <span class="card-title">${m.title}</span>
          <span class="card-desc">${m.desc}</span>
        </button>`).join('')}
    </div>

    <div class="section-h">Interactive maps</div>
    <div class="grid">
      ${MAP_CARDS.map((m) => `
        <button class="card" data-map="${m.key}">
          ${m.flagIso
            ? `<img class="emoji-flag" alt="" src="${flagUrl(m.flagIso, 'w80')}">`
            : `<span class="emoji">${m.emoji}</span>`}
          <span class="card-title">${m.title}</span>
          <span class="card-desc">${m.desc}</span>
        </button>`).join('')}
    </div>

    <div class="section-h">Your journey</div>
    <div class="grid">
      <button class="card" data-go="phrases"><span class="emoji">🗣️</span><span class="card-title">Phrases</span><span class="card-desc">Common phrases & local sayings around the world.</span></button>
      <button class="card" data-go="music"><span class="emoji">🎵</span><span class="card-title">Music</span><span class="card-desc">Songs that represent each country.</span></button>
      <button class="card" data-go="crises"><span class="emoji">📰</span><span class="card-title">Crises & Events</span><span class="card-desc">Background on major ongoing world situations.</span></button>
      <button class="card" data-go="custom"><span class="emoji">🛠️</span><span class="card-title">Custom Study</span><span class="card-desc">Choose topics, continents, difficulty & input.</span></button>
      <button class="card" data-go="stats"><span class="emoji">📊</span><span class="card-title">Statistics</span><span class="card-desc">Accuracy, weak areas & study time.</span></button>
      <button class="card" data-go="achievements"><span class="emoji">🏆</span><span class="card-title">Achievements</span><span class="card-desc">Badges & milestones.</span></button>
      <button class="card" data-go="profile"><span class="emoji">🧭</span><span class="card-title">Profile</span><span class="card-desc">Name, leaderboard & reset.</span></button>
    </div>`;

  app.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => startQuiz({ title: MODES[b.dataset.mode].label, modes: [b.dataset.mode], total: 10 })));
  app.querySelectorAll('[data-map]').forEach((b) =>
    b.addEventListener('click', () => startMapQuiz({ title: MAP_MODES[b.dataset.map].label, mode: b.dataset.map, total: 10 })));
  app.querySelector('[data-go="mixed"]').addEventListener('click', () => startQuiz({ title: 'Mixed Quiz', modes: ALL_MODES, total: 12 }));
  app.querySelector('[data-go="challenge"]').addEventListener('click', () => startQuiz({ title: 'Challenge Mode', modes: ALL_MODES, total: 15, challenge: true }));
  app.querySelector('[data-go="daily"]').addEventListener('click', startDaily);
  app.querySelector('[data-go="religions"]').addEventListener('click', showReligions);
  app.querySelector('[data-go="review"]').addEventListener('click', startReview);
  app.querySelector('[data-go="phrases"]').addEventListener('click', showPhrases);
  app.querySelector('[data-go="music"]').addEventListener('click', showMusic);
  app.querySelector('[data-go="crises"]').addEventListener('click', showCrises);
  app.querySelector('[data-go="custom"]').addEventListener('click', showCustom);
  app.querySelector('[data-go="stats"]').addEventListener('click', showStats);
  app.querySelector('[data-go="achievements"]').addEventListener('click', showAchievements);
  app.querySelector('[data-go="profile"]').addEventListener('click', showProfile);
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
  const ids = Object.keys(getProfile().missed);
  if (ids.length === 0) {
    toast('✅', 'No missed questions', 'Great — your review pile is empty!');
    return;
  }
  startQuiz({ title: 'Review Missed', modes: ALL_MODES, total: Math.min(ids.length, 20), reviewIds: ids });
}

// World Religions chooser: study every faith, or focus on a single one.
function showReligions() {
  S = null;
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

// ============================================================================
//  MAP QUIZ (click-the-map modes)
// ============================================================================
async function startMapQuiz(opts) {
  const { title, mode, total = 10 } = opts;
  const svgName = MAP_MODES[mode]?.svg;
  if (!svgName) return;

  app.innerHTML = '<p class="screen-sub">Loading the map…</p>';
  let map;
  try {
    map = await loadMap(svgName);
  } catch (err) {
    toast('🗺️', "Couldn't load the map", err.message);
    return showHome();
  }

  const data = getData();
  const pool = buildMapPool(data, { [svgName]: map.regions }, { modes: [mode] });
  if (pool.length === 0) {
    toast('🤷', 'Nothing to quiz', 'That map has no questions yet.');
    return showHome();
  }

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
    svgText: map.svgText, mapView: null,
  };
  renderQuestion();
}

function renderMapQuestion(q) {
  const progressPct = Math.round((S.index / S.total) * 100);
  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span style="width:${progressPct}%"></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      <div class="q-prompt">${esc(q.prompt)}</div>
      <div id="mapMount" class="map-mount"></div>
      <div id="feedback"></div>
    </div>`;

  app.querySelector('#quitBtn').addEventListener('click', showHome);
  S.mapView = createMapView({ svgText: S.svgText, onPick: (id) => mapAnswer(id) });
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
      <div class="progress"><span style="width:${progressPct}%"></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      <div class="q-prompt">${esc(q.prompt)}</div>
      <div id="mapMount" class="map-mount"></div>
      <div class="choices" id="choices">
        ${q.choices.map((c, i) => `
          <button class="choice" data-val="${esc(c)}">
            <span class="key">${i + 1}</span><span>${esc(c)}</span>
          </button>`).join('')}
      </div>
      <div id="feedback"></div>
    </div>`;
  app.querySelector('#quitBtn').addEventListener('click', showHome);
  S.mapView = createMapView({ svgText: S.svgText, highlightId: q.highlightId, interactive: false });
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
  if (S.kind === 'map') return q.reverse ? renderReverseMapQuestion(q) : renderMapQuestion(q);
  if (S.input === 'type') return renderTypedQuestion(q);
  return renderMcqQuestion(q);
}

function renderMcqQuestion(q) {
  const progressPct = Math.round((S.index / S.total) * 100);
  const multiPill = S.challenge ? `<span class="pill">✖️<span class="accent">${S.multiplier.toFixed(1)}</span></span>` : '';
  const flagSrc = q.flagIso ? flagUrl(q.flagIso) : (q.flagImg ? historicFlagUrl(q.flagImg) : null);
  const flag = flagSrc ? `<img class="q-flag" alt="Flag to identify" src="${flagSrc}" onerror="this.style.display='none'">` : '';

  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span style="width:${progressPct}%"></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      ${multiPill}
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    ${S.challenge ? '<div class="timer" id="timer"><span style="width:100%"></span></div>' : ''}
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
      <div id="feedback"></div>
    </div>`;

  app.querySelector('#quitBtn').addEventListener('click', () => { clearTimer(); showHome(); });
  app.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => answer(b.dataset.val)));

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
  const newly = checkAchievements(getProfile());
  saveProfile();
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
  const flag = flagSrc ? `<img class="q-flag" alt="Flag to identify" src="${flagSrc}" onerror="this.style.display='none'">` : '';
  app.innerHTML = `
    <div class="quiz-top">
      <button class="btn ghost" id="quitBtn" title="Back to home">✕</button>
      <div class="progress"><span style="width:${progressPct}%"></span></div>
      <span class="pill">${S.index + 1}/${S.total}</span>
      <span class="pill fire">🔥 ${S.runStreak}</span>
      <span class="pill">⭐ ${S.xpRun}</span>
    </div>
    <div class="question-card">
      <div class="q-cat">${esc(catLabel(q.category))}</div>
      ${flag}
      <div class="q-prompt">${esc(q.prompt)}</div>
      <form class="type-form" id="typeForm" autocomplete="off">
        <input class="type-input" id="typeInput" type="text" placeholder="Type your answer…"
               autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <button class="btn primary" type="submit">Submit</button>
      </form>
      <div id="feedback"></div>
    </div>`;
  app.querySelector('#quitBtn').addEventListener('click', () => { clearTimer(); showHome(); });
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
    <div><span style="color:var(--muted);font-size:.85rem">Learn more:</span>
      <div class="learn-more">${links}</div></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" id="nextBtn">${S.index >= S.total ? 'See results →' : 'Next →'}</button>
    </div>`;
  document.getElementById('nextBtn').addEventListener('click', renderQuestion);
  document.getElementById('nextBtn').focus();
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
  const newly = checkAchievements(getProfile());
  saveProfile();
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
    <div class="btn-row" style="margin-top:18px">
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
  S = null;
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
      <h3>Continents <span style="color:var(--muted);font-weight:400;font-size:.85rem">(country modes only)</span></h3>
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
      <h3 style="margin-top:16px">Length</h3>
      <div class="seg" id="lenSeg">
        <button data-n="10" class="active">10</button>
        <button data-n="20">20</button>
        <button data-n="30">30</button>
      </div>
      <h3 style="margin-top:16px">Answer input</h3>
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
//  PHRASES  (browse common phrases & popular local sayings by country)
// ============================================================================
function showPhrases() {
  S = null;
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
    <div class="btn-row" style="margin-top:18px">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-country]').forEach((b) =>
    b.addEventListener('click', () => renderPhraseDetail(entries.find((e) => e.country === b.dataset.country))));
}

// A small 🔊 button that speaks `text` in the entry's language (hidden when the
// Web Speech API is unavailable). Wired via [data-speak] after render.
function speakBtn(text, lang) {
  if (!ttsAvailable() || !text) return '';
  return `<button class="spk" type="button" data-speak="${esc(text)}" data-lang="${esc(lang || '')}" title="Hear it" aria-label="Hear pronunciation">🔊</button>`;
}

function renderPhraseDetail(entry) {
  if (!entry) return showPhrases();
  const lang = entry.langCode || '';
  const native = entry.nativeCountry
    ? `<div class="native-name">${esc(entry.nativeCountry.local)} ${speakBtn(entry.nativeCountry.local, lang)}
         <span class="say-pron">${esc(entry.nativeCountry.pron)}</span></div>`
    : '';
  app.innerHTML = `
    ${topNav({ id: 'backPhrasesTop', label: '← All countries' })}
    <div class="phrase-head">
      <img class="phrase-flag" alt="" src="${flagUrl(entry.iso2, 'w160')}">
      <div>
        <h1 class="screen-title" style="margin:0">${esc(entry.country)}</h1>
        <p class="screen-sub" style="margin:2px 0 0">${esc(entry.language)}</p>
        ${native}
      </div>
    </div>

    <div class="section-h">Common phrases</div>
    <div class="phrase-list">
      ${entry.phrases.map((p) => `
        <div class="phrase-row">
          <span class="ph-en">${esc(p.en)}</span>
          <span class="ph-local">${esc(p.local)} ${speakBtn(p.local, lang)}</span>
          <span class="ph-pron">${esc(p.pron)}</span>
        </div>`).join('')}
    </div>

    <div class="section-h">Popular sayings</div>
    <div class="saying-list">
      ${entry.sayings.map((s) => `
        <div class="saying">
          <div class="say-local">${esc(s.local)} ${speakBtn(s.local, lang)} <span class="say-pron">${esc(s.pron)}</span></div>
          <div class="say-meaning">${esc(s.meaning)}</div>
        </div>`).join('')}
    </div>

    <div class="btn-row" style="margin-top:18px">
      <button class="btn ghost" id="backPhrases">← All countries</button>
      <button class="btn ghost" id="backHome">🏠 Home</button>
    </div>`;
  wireNav();
  const bpt = app.querySelector('#backPhrasesTop');
  if (bpt) bpt.addEventListener('click', showPhrases);
  app.querySelector('#backPhrases').addEventListener('click', showPhrases);
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelectorAll('[data-speak]').forEach((b) =>
    b.addEventListener('click', () => speak(b.dataset.speak, b.dataset.lang)));
}

// ============================================================================
//  MUSIC  (songs that represent each country — embedded YouTube player)
// ============================================================================
function showMusic() {
  S = null;
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
    <div class="btn-row" style="margin-top:18px">
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
        <h1 class="screen-title" style="margin:0">${esc(entry.country)}</h1>
        <p class="screen-sub" style="margin:2px 0 0">Songs that represent ${esc(entry.country)}</p>
      </div>
    </div>

    <div class="yt-frame">
      <iframe id="ytPlayer" src="https://www.youtube.com/embed/${esc(first.youtubeId)}"
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
        </button>`).join('')}
    </div>

    <div class="btn-row" style="margin-top:18px">
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
    player.src = `https://www.youtube.com/embed/${b.dataset.yt}?autoplay=1`;
  }));
}

// ============================================================================
//  CRISES & CURRENT EVENTS  (curated background + live-source links)
// ============================================================================
function showCrises() {
  S = null;
  const entries = getData().crises || [];
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Crises &amp; Events 📰</h1>
    <p class="screen-sub">Background on major ongoing world situations, with links to live sources. Curated context — not real-time reporting.</p>
    <div class="grid">
      ${entries.map((e) => `
        <button class="card" data-crisis="${esc(e.title)}">
          <img class="emoji-flag" alt="" src="${flagUrl(e.iso2, 'w80')}">
          <span class="card-title">${esc(e.title)}</span>
          <span class="card-desc">${esc(e.country)}</span>
        </button>`).join('')}
    </div>
    <div class="btn-row" style="margin-top:18px">
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
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
        <h1 class="screen-title" style="margin:0">${esc(entry.title)}</h1>
        <p class="screen-sub" style="margin:2px 0 0">${esc(entry.country)}${entry.region ? ' · ' + esc(entry.region) : ''}</p>
      </div>
    </div>

    <div class="crisis-body">
      <p>${esc(entry.summary)}</p>
      <div><span style="color:var(--muted);font-size:.85rem">Follow the latest:</span>
        <div class="learn-more">${links}</div></div>
    </div>

    <div class="btn-row" style="margin-top:18px">
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
  S = null;
  const p = getProfile();
  const cats = Object.entries(p.perCategory);
  const regs = Object.entries(p.perRegion);
  const bar = (label, c) => {
    const pct = c.answered ? Math.round((c.correct / c.answered) * 100) : 0;
    return `<div class="bar-row"><span class="name">${esc(label)}</span>
      <div class="bar-track"><span style="width:${pct}%"></span></div>
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

    <div class="btn-row" style="margin-top:18px">
      <button class="btn" id="reviewW" ${missed.length ? '' : 'disabled'}>🔁 Practice weak areas</button>
      <button class="btn ghost" id="backHome">← Back</button>
    </div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  const rw = app.querySelector('#reviewW');
  if (missed.length) rw.addEventListener('click', startReview);
}

// ============================================================================
//  ACHIEVEMENTS
// ============================================================================
function showAchievements() {
  S = null;
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
          <div class="mini"><span style="width:${a.pct}%"></span></div>
          <div class="lbl" style="color:var(--muted);font-size:.75rem;margin-top:4px">${a.current}/${a.threshold}</div>
        </div>`).join('')}
    </div>
    <div class="btn-row" style="margin-top:18px"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
}

// ============================================================================
//  PROFILE
// ============================================================================
function showProfile() {
  S = null;
  const p = getProfile();
  const lb = p.leaderboard;
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Profile 🧭</h1>
    <div class="form-block">
      <h3>Display name</h3>
      <div class="btn-row">
        <input id="nameInput" class="btn" style="min-width:200px" value="${esc(p.name)}" maxlength="20">
        <button class="btn primary" id="saveName">Save</button>
      </div>
    </div>
    <div class="form-block">
      <h3>Local leaderboard (best scores)</h3>
      ${lb.length ? `<ul class="weak-list">${lb.map((e, i) => `<li><span>#${i + 1} · ${esc(e.mode)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>` : '<p class="screen-sub">Play Challenge or Daily to set a high score.</p>'}
    </div>
    <div class="form-block">
      <h3>Danger zone</h3>
      <p class="screen-sub" style="margin-bottom:10px">Reset all progress, stats and achievements. This cannot be undone.</p>
      <button class="btn" id="resetBtn" style="border-color:var(--bad);color:var(--bad)">Reset all progress</button>
    </div>
    <div class="btn-row"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
  app.querySelector('#saveName').addEventListener('click', () => {
    setName(app.querySelector('#nameInput').value);
    toast('✅', 'Name saved', getProfile().name);
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
    // Click-only (map) and type-only modes don't use number-key shortcuts.
    if (S.kind === 'map' || S.input === 'type' || !S.current?.choices) return;
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
  document.getElementById('brand').addEventListener('click', showHome);
  document.addEventListener('keydown', onKeydown);

  app.innerHTML = '<p class="screen-sub">Loading the world…</p>';
  try {
    await loadData();
  } catch (err) {
    app.innerHTML = `<div class="question-card"><h2>Couldn't load data</h2>
      <p class="screen-sub">${esc(err.message)}</p>
      <p>Worldly must be served over HTTP (browsers block <code>fetch</code> on <code>file://</code>).
      From the <code>Worldly/</code> folder run <code>python -m http.server</code> and open
      <code>http://localhost:8000</code>.</p></div>`;
    return;
  }
  renderHUD();
  showHome();
}

boot();
