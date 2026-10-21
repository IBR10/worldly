// pokedexview.js — the Pokédex screens.
//
// main.js is already ~100 KB and its UI helpers (esc, topNav, wireTabs, toast…)
// are module-private, so rather than grow that file or extract a shared ui.js in
// a change that is not about refactoring, main.js hands this module the helpers
// it needs once, in boot(), via initPokedex(). That keeps main.js's growth to a
// handful of lines and avoids an import cycle.
//
// CSP notes that apply to everything below: no inline style= and no on*=
// attributes (the policy has no unsafe-inline, so both are silently dead).
// Widths go through the data-w + CSSOM pattern used elsewhere in the app, and
// every handler is addEventListener.

import { icon } from './icons.js';
import {
  POKE_MODES, ALL_POKE_MODES, GENERATIONS, GEN_REGION, STAT_LABELS, TYPES,
  PRACTICE_SCOPES, createPokeQuiz, typingOf, typeLabel, filterDex,
  defaultFilter, parsePracticeFilter, practiceFilterQuery, filterLabel,
} from './pokedex.js';

import {
  getPoke, savePoke, recordPokeAnswer, isRegistered, isMastered,
  dexProgress, trainerRank, nextRank, accuracy, weakSpecies, resetPokedex,
} from './pokestate.js';

// Helpers injected by main.js.
let ctx = null;

/** Called once from boot(). */
export function initPokedex(helpers) {
  ctx = helpers;
}

// Screen-local state, deliberately module-level like main.js's homeTab/flagKeyTab.
let dexTab = 'dex';
let dexGen = 1;
let dexSearch = '';
let dexType = '';
let session = null;

const spriteUrl = (id) => `/assets/pokemon/${id}.png`;
const padId = (id) => `#${String(id).padStart(4, '0')}`;

/** The loaded datasets, or null until ensureDataset has run. */
function datasets() {
  const data = ctx.getData();
  return { dex: data.pokemon, chart: data.pokemonTypes };
}

// ---- hub ---------------------------------------------------------------------

export async function showPokedex() {
  ctx.leaveSession();
  session = null;
  if (!(await ctx.ensureDataset('pokemon'))) return;
  if (!(await ctx.ensureDataset('pokemonTypes'))) return;
  loadPracticeFilter();
  renderHub();
}

function renderHub() {
  const { app, esc } = ctx;
  const { dex } = datasets();
  const store = getPoke();
  const prog = dexProgress(store, dex);

  const tabs = [
    { id: 'dex', label: 'Dex' },
    { id: 'practice', label: 'Practice' },
    { id: 'progress', label: 'Progress' },
  ];
  if (!tabs.some((t) => t.id === dexTab)) dexTab = 'dex';

  app.innerHTML = `
    ${ctx.topNav()}
    <h1 class="screen-title">Pokédex</h1>
    <p class="screen-sub">All ${dex.length} Pokémon, and practice modes to learn them.
      Identify one correctly and it is registered to your dex — ${esc(prog.registered)} of
      ${esc(prog.total)} so far (${esc(prog.pct)}%), rank <strong>${esc(trainerRank(prog.pct))}</strong>.</p>

    <div class="tabs" role="tablist">
      ${tabs.map((t) => `<button class="tab ${t.id === dexTab ? 'active' : ''}" role="tab"
        id="ptab-${t.id}" aria-controls="ppanel-${t.id}" aria-selected="${t.id === dexTab}"
        tabindex="${t.id === dexTab ? 0 : -1}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>

    ${tabs.map((t) => `<div class="tab-panel ${t.id === dexTab ? 'active' : ''}" data-panel="${t.id}"
      id="ppanel-${t.id}" role="tabpanel" aria-labelledby="ptab-${t.id}">
      ${t.id === 'dex' ? dexPanel() : t.id === 'practice' ? practicePanel() : progressPanel()}
    </div>`).join('')}

    <div class="btn-row mt-18">
      <button class="btn ghost" data-topnav="home">${icon('back')}Back</button>
    </div>`;

  ctx.wireNav();
  ctx.wireTabs((id) => { dexTab = id; if (id === 'dex') populateGen(dexGen); });
  wireDexPanel();
  wirePracticePanel();
  wireProgressPanel();
  if (dexTab === 'dex') populateGen(dexGen);
  applyBars();
}

/** Set every [data-w] element's width from its attribute (no inline style=). */
function applyBars() {
  ctx.app.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
}

/**
 * Bind the screen-specific back button that topNav() renders.
 *
 * wireNav() only binds the Home button; a topNav({ id, label }) back target is
 * the caller's to wire, which is why every screen below calls this after it.
 */
function wireBackToDex() {
  const back = ctx.app.querySelector('#toPokedexTop');
  if (back) back.addEventListener('click', () => ctx.navigate('/pokedex'));
}

// ---- dex tab -----------------------------------------------------------------

function dexPanel() {
  const { esc } = ctx;
  const store = getPoke();
  return `
    <div class="form-block filter-bar">
      <input type="text" class="type-input" id="dexSearch" placeholder="Search all Pokémon by name…"
        value="${esc(dexSearch)}" aria-label="Search Pokémon by name">
      <select class="select" id="dexType" aria-label="Filter by type">
        <option value="">All types</option>
        ${TYPES.map((t) => `<option value="${t}"${t === dexType ? ' selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}
      </select>
      <label class="check">
        <input type="checkbox" id="dexReveal"${store.reveal ? ' checked' : ''}>
        <span>Reveal Pokémon I haven't registered yet</span>
      </label>
    </div>

    <div class="tabs gen-tabs" role="tablist" id="genTabs">
      ${GENERATIONS.map((g) => `<button class="gen-tab ${g === dexGen ? 'active' : ''}" role="tab"
        aria-selected="${g === dexGen}" tabindex="${g === dexGen ? 0 : -1}"
        data-gen="${g}">Gen ${g}<span class="hide-sm"> · ${esc(GEN_REGION[g])}</span></button>`).join('')}
    </div>

    <div class="dex-grid" id="dexGrid"></div>
    <div class="btn-row mt-14" id="dexMoreRow"></div>
    <p class="screen-sub hidden" id="dexEmpty">No matches.</p>`;
}

/**
 * Render one card.
 *
 * Unregistered species are silhouetted and unnamed unless the reveal toggle is
 * on — that is the collection the practice modes fill in. The sprite is still
 * the real image (masked in CSS) rather than a placeholder, so revealing costs
 * no second request.
 */
function dexCard(p, store, reveal) {
  const { esc } = ctx;
  const known = reveal || isRegistered(store, p.id);
  const mastered = isMastered(store, p.id);
  const cls = ['dex-card'];
  if (!known) cls.push('unseen');
  if (mastered) cls.push('mastered');
  return `
    <button class="${cls.join(' ')}" data-slug="${esc(p.slug)}"
      data-name="${esc(p.name.toLowerCase())}" data-types="${esc(p.types.join(' '))}"
      ${known ? '' : 'aria-label="Unregistered Pokémon"'}>
      <img class="dex-sprite" alt="" loading="lazy" decoding="async" src="${spriteUrl(p.id)}">
      <span class="dex-num">${esc(padId(p.id))}</span>
      <span class="dex-name">${known ? esc(p.name) : '???'}</span>
      ${known ? `<span class="dex-types">${p.types.map((t) => `<span class="type-chip t-${esc(t)}">${esc(typeLabel(t))}</span>`).join('')}</span>` : ''}
      ${mastered ? '<span class="dex-star" aria-hidden="true">★</span>' : ''}
    </button>`;
}

/** Species rendered per page. See populateGen for why this is capped at all. */
const DEX_PAGE = 60;
let dexShown = DEX_PAGE;

/** The species matching the current generation/search/type filters. */
function filteredList(gen) {
  const { dex } = datasets();
  const term = dexSearch.trim().toLowerCase();
  let list = term ? dex : dex.filter((p) => p.gen === gen);
  if (term) list = list.filter((p) => p.name.toLowerCase().includes(term));
  if (dexType) list = list.filter((p) => p.types.includes(dexType));
  return list;
}

/**
 * Fill the grid for the current filters.
 *
 * A name search runs across the whole dex, not just the open generation —
 * looking up "char" should find Charizard without knowing it is Gen 1.
 *
 * Rendering is paged rather than relying on loading="lazy" alone. Measured in
 * Chromium, a full 151-species generation issued all 151 image requests on
 * open: the sprites are small and the grid dense, so every card landed inside
 * the browser's lazy-load threshold and nothing was actually deferred. That
 * blows the same kind of image budget the Flag Key screen is held to. Paging at
 * 60 bounds the initial cost no matter the viewport, and lazy loading still
 * trims it further on short screens.
 */
function populateGen(gen) {
  const grid = ctx.app.querySelector('#dexGrid');
  if (!grid) return;
  const store = getPoke();
  const reveal = !!store.reveal;

  const list = filteredList(gen);
  const page = list.slice(0, dexShown);

  grid.innerHTML = page.map((p) => dexCard(p, store, reveal)).join('');
  grid.querySelectorAll('img').forEach((img) =>
    img.addEventListener('error', () => img.classList.add('hidden')));
  grid.querySelectorAll('.dex-card').forEach((card) =>
    card.addEventListener('click', () => ctx.navigate(`/pokedex/${card.dataset.slug}`)));

  const remaining = list.length - page.length;
  const more = ctx.app.querySelector('#dexMoreRow');
  more.innerHTML = remaining > 0
    ? `<button class="btn ghost" id="dexMore">Show ${Math.min(remaining, DEX_PAGE)} more (${remaining} left)</button>`
    : '';
  const moreBtn = more.querySelector('#dexMore');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      dexShown += DEX_PAGE;
      populateGen(gen);
    });
  }

  ctx.app.querySelector('#dexEmpty').classList.toggle('hidden', page.length > 0);
  ctx.app.querySelector('#genTabs').classList.toggle('hidden', !!dexSearch.trim());
}

/** Any filter change starts the paging over. */
function resetPaging() {
  dexShown = DEX_PAGE;
}

function wireDexPanel() {
  const { app } = ctx;
  const search = app.querySelector('#dexSearch');
  if (!search) return;

  search.addEventListener('input', () => { dexSearch = search.value; resetPaging(); populateGen(dexGen); });
  app.querySelector('#dexType').addEventListener('change', (e) => {
    dexType = e.target.value;
    resetPaging();
    populateGen(dexGen);
  });
  app.querySelector('#dexReveal').addEventListener('change', (e) => {
    getPoke().reveal = e.target.checked;
    savePoke();
    populateGen(dexGen);
  });
  app.querySelectorAll('.gen-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      dexGen = Number(btn.dataset.gen);
      resetPaging();
      app.querySelectorAll('.gen-tab').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      populateGen(dexGen);
    });
  });
}

// ---- practice tab ------------------------------------------------------------

/**
 * The filter the Practice tab is currently set to.
 *
 * Kept module-level like dexGen/dexSearch, but also written through to the
 * progress store: learning one generation is a project that spans many visits,
 * so re-picking "Gen 1" every time you open the app would be the wrong default.
 */
let practice = defaultFilter();

/** Restore the saved filter, ignoring anything a stale store may hold. */
function loadPracticeFilter() {
  const saved = getPoke().filter;
  practice = saved ? parsePracticeFilter(practiceFilterQuery(saved)) : defaultFilter();
}

function savePracticeFilter() {
  getPoke().filter = practice;
  savePoke();
}

/**
 * The extra predicate behind the non-`all` scopes.
 *
 * Reads the store once and closes over it, so a session's set is fixed at the
 * moment it starts: registering a Pokémon mid-session must not shrink the pool
 * underneath the questions still to come.
 */
function scopeFilter(scope) {
  const store = getPoke();
  if (scope === 'unregistered') return (p) => !isRegistered(store, p.id);
  if (scope === 'missed') return (p) => !!store.e[p.id] && store.e[p.id].w > 0;
  return null;
}

/** True when the filter narrows anything at all. */
function isFiltered(filter) {
  return filter.gens !== 'all' || filter.types !== 'all' || filter.scope !== 'all';
}

/** A filter as the config buildPokePool takes. */
function poolConfig(filter) {
  return { gens: filter.gens, types: filter.types, include: scopeFilter(filter.scope) };
}

function practicePanel() {
  const { esc } = ctx;
  const { dex } = datasets();
  const set = filterDex(dex, poolConfig(practice));
  const prog = dexProgress(getPoke(), set);
  const gens = practice.gens === 'all' ? '' : String(practice.gens[0]);
  const type = practice.types === 'all' ? '' : practice.types[0];

  return `
    <div class="form-block filter-bar">
      <select class="select" id="pracGen" aria-label="Generation to practice">
        <option value=""${gens === '' ? ' selected' : ''}>All generations</option>
        ${GENERATIONS.map((g) => `<option value="${g}"${String(g) === gens ? ' selected' : ''}>Gen ${g} · ${esc(GEN_REGION[g])}</option>`).join('')}
      </select>
      <select class="select" id="pracType" aria-label="Type to practice">
        <option value=""${type === '' ? ' selected' : ''}>All types</option>
        ${TYPES.map((t) => `<option value="${t}"${t === type ? ' selected' : ''}>${esc(typeLabel(t))}</option>`).join('')}
      </select>
      <select class="select" id="pracScope" aria-label="Narrow the set by what you already know">
        ${Object.entries(PRACTICE_SCOPES).map(([key, label]) =>
    `<option value="${esc(key)}"${key === practice.scope ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
    </div>

    <p class="screen-sub" id="pracSummary">${esc(practiceSummary(set, prog))}</p>

    <div class="grid">
      ${ALL_POKE_MODES.map((key) => {
    const m = POKE_MODES[key];
    return `<button class="card" data-poke-mode="${esc(key)}">
          <span class="emoji" aria-hidden="true">${icon(m.icon)}</span>
          <span class="card-title">${esc(m.label)}</span>
          <span class="card-desc">${esc(m.desc)}</span>
        </button>`;
  }).join('')}
    </div>`;
}

/**
 * The one line under the filters: what you picked, how big it is, how far in you
 * are. This is the whole feedback loop for "learn every Gen 1 Pokémon" — the
 * number has to move every session or the project has no shape.
 */
function practiceSummary(set, prog) {
  const label = filterLabel(practice);
  if (!set.length) return `${label} — nothing matches. Widen the filters to start practicing.`;
  // The registered count only means something for the whole set; under the
  // `unregistered` scope it is zero by definition and under `missed` it is noise.
  const registered = practice.scope === 'all' ? `, ${prog.registered} registered` : '';
  return `${label} — ${set.length} Pokémon${registered}.`
    + ' Get one right and it is registered; three in a row and it is mastered ★.';
}

function wirePracticePanel() {
  const { app } = ctx;
  const gen = app.querySelector('#pracGen');
  if (!gen) return;

  // Re-render only the summary, not the panel: replacing the <select> the user
  // just used would drop focus and close the native picker mid-choice.
  const refresh = () => {
    savePracticeFilter();
    const { dex } = datasets();
    const set = filterDex(dex, poolConfig(practice));
    app.querySelector('#pracSummary').textContent = practiceSummary(set, dexProgress(getPoke(), set));
  };

  gen.addEventListener('change', (e) => {
    practice.gens = e.target.value ? [Number(e.target.value)] : 'all';
    refresh();
  });
  app.querySelector('#pracType').addEventListener('change', (e) => {
    practice.types = e.target.value ? [e.target.value] : 'all';
    refresh();
  });
  app.querySelector('#pracScope').addEventListener('change', (e) => {
    practice.scope = e.target.value;
    refresh();
  });

  app.querySelectorAll('[data-poke-mode]').forEach((btn) =>
    btn.addEventListener('click', () =>
      ctx.navigate(`/pokedex/quiz/${btn.dataset.pokeMode}${practiceFilterQuery(practice)}`)));
}

// ---- progress tab ------------------------------------------------------------

function progressPanel() {
  const { esc } = ctx;
  const { dex } = datasets();
  const store = getPoke();
  const prog = dexProgress(store, dex);
  const next = nextRank(prog.pct);
  const weak = weakSpecies(store, dex, 10);

  return `
    <div class="stat-grid">
      <div class="stat"><div class="big">${esc(prog.registered)}</div><div class="lbl">Registered</div></div>
      <div class="stat"><div class="big">${esc(prog.mastered)}</div><div class="lbl">Mastered ★</div></div>
      <div class="stat"><div class="big">${esc(accuracy(store))}%</div><div class="lbl">Accuracy</div></div>
      <div class="stat"><div class="big">${esc(store.bestStreak)}</div><div class="lbl">Best streak</div></div>
    </div>

    <div class="callout mt-18">
      <strong>${esc(trainerRank(prog.pct))}</strong>
      ${next ? ` — ${esc(next.remaining)}% more of the dex to reach ${esc(next.title)}.`
    : ' — you have registered every Pokémon. Nothing left to catch.'}
    </div>

    <h2 class="mt-18">By generation</h2>
    ${prog.byGen.map((g) => `
      <div class="bar-row">
        <span class="name">Gen ${esc(g.gen)} · ${esc(GEN_REGION[g.gen])}</span>
        <div class="bar-track"><span data-w="${Math.round((g.registered / g.total) * 100)}"></span></div>
        <span class="pct">${esc(g.registered)}/${esc(g.total)}</span>
      </div>`).join('')}

    ${weak.length ? `
      <h2 class="mt-18">Keep practicing</h2>
      <p class="screen-sub">You have missed these more often than you have got them right.</p>
      <div class="dex-grid">
        ${weak.map((p) => dexCard(p, getPoke(), true)).join('')}
      </div>` : ''}

    <div class="btn-row mt-18">
      <button class="btn danger" id="dexReset">Reset Pokédex progress</button>
    </div>
    <p class="muted-note">Only your Pokédex. Your Worldly XP, level, streak and achievements are stored
      separately and are not affected.</p>`;
}

function wireProgressPanel() {
  const btn = ctx.app.querySelector('#dexReset');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!window.confirm('Reset all Pokédex progress? Your Worldly profile is not affected.')) return;
    resetPokedex();
    ctx.toast('reset', 'Pokédex reset', 'Every entry is unregistered again.');
    renderHub();
  });
  ctx.app.querySelectorAll('.dex-grid .dex-card').forEach((card) =>
    card.addEventListener('click', () => ctx.navigate(`/pokedex/${card.dataset.slug}`)));
}

// ---- detail ------------------------------------------------------------------

export async function showPokemonDetail(slug) {
  ctx.leaveSession();
  session = null;
  if (!(await ctx.ensureDataset('pokemon'))) return;
  if (!(await ctx.ensureDataset('pokemonTypes'))) return;

  const { app, esc } = ctx;
  const { dex } = datasets();
  const p = dex.find((x) => x.slug === slug);
  if (!p) return ctx.navigate('/404', { replace: true });

  const store = getPoke();
  const registered = isRegistered(store, p.id);
  const mastered = isMastered(store, p.id);
  const rec = store.e[p.id];

  document.title = `${p.name} — Pokédex — Worldly`;

  const statRows = Object.entries(STAT_LABELS).map(([key, label]) => `
    <div class="bar-row">
      <span class="name">${esc(label)}</span>
      <div class="bar-track"><span data-w="${Math.round((p.stats[key] / 255) * 100)}"></span></div>
      <span class="pct">${esc(p.stats[key])}</span>
    </div>`).join('');

  app.innerHTML = `
    ${ctx.topNav({ id: 'toPokedexTop', label: '← Pokédex' })}
    <div class="dex-detail">
      <img class="dex-hero" alt="${esc(p.name)}" src="${spriteUrl(p.id)}" decoding="async">
      <div>
        <p class="dex-num-big">${esc(padId(p.id))}</p>
        <h1 class="screen-title m-tight">${esc(p.name)}${mastered ? ' <span class="dex-star">★</span>' : ''}</h1>
        <p class="screen-sub">${esc(p.species)} · Generation ${esc(p.gen)} (${esc(GEN_REGION[p.gen])})</p>
        <p class="dex-types">${p.types.map((t) => `<span class="type-chip t-${esc(t)}">${esc(typeLabel(t))}</span>`).join('')}</p>
        <p class="pill ${registered ? 'ok' : ''}">${registered ? 'Registered to your dex' : 'Not yet registered — identify it in Practice'}</p>
      </div>
    </div>

    ${p.dex ? `<p class="callout mt-18">${esc(p.dex)}</p>` : ''}

    <h2 class="mt-18">Base stats</h2>
    ${statRows}

    <h2 class="mt-18">Details</h2>
    <div class="stat-grid">
      <div class="stat"><div class="big">${esc((p.height / 10).toFixed(1))} m</div><div class="lbl">Height</div></div>
      <div class="stat"><div class="big">${esc((p.weight / 10).toFixed(1))} kg</div><div class="lbl">Weight</div></div>
      <div class="stat"><div class="big">${esc(p.abilities.join(', ') || '—')}</div><div class="lbl">Abilities</div></div>
      <div class="stat"><div class="big">${esc(rec ? `${rec.c}/${rec.c + rec.w}` : '—')}</div><div class="lbl">Your answers</div></div>
    </div>

    ${(p.evolvesFrom || p.evolvesTo.length) ? `
      <h2 class="mt-18">Evolution</h2>
      <p class="screen-sub">
        ${p.evolvesFrom ? `Evolves from <strong>${esc(p.evolvesFrom)}</strong>. ` : ''}
        ${p.evolvesTo.length ? `Evolves into <strong>${esc(p.evolvesTo.join(', '))}</strong>.` : ''}
      </p>` : ''}

    <div class="btn-row mt-18">
      <button class="btn ghost" data-topnav="home">${icon('back')}Home</button>
      <button class="btn primary" id="toDex">Back to the Pokédex</button>
    </div>`;

  ctx.wireNav();
  wireBackToDex();
  app.querySelector('#toDex').addEventListener('click', () => ctx.navigate('/pokedex'));
  applyBars();
  ctx.focusTitle();
}

// ---- practice session --------------------------------------------------------

/** How many questions a full session runs to. */
const SESSION_LENGTH = 10;

export async function startPokeQuizByKey(mode) {
  ctx.leaveSession();
  if (!POKE_MODES[mode]) return ctx.navigate('/404', { replace: true });
  if (!(await ctx.ensureDataset('pokemon'))) return;
  if (!(await ctx.ensureDataset('pokemonTypes'))) return;

  // The URL is the session's filter, so a deep link, a reload and Back all open
  // the same set. The Practice tab's own selection follows it, which is what
  // makes "End practice" land you back on the filters you just used.
  practice = parsePracticeFilter(location.search);
  savePracticeFilter();

  const { dex, chart } = datasets();
  const quiz = createPokeQuiz({ dex, chart, config: { modes: [mode], ...poolConfig(practice) } });

  // A narrow filter can leave a mode with nothing to ask — "what does it evolve
  // into" over the Fire types you have already registered may be an empty set.
  // Say so, rather than opening a session that finishes on question zero.
  if (!quiz.size) return renderEmptySet(mode);

  document.title = `${POKE_MODES[mode].label} — Pokédex — Worldly`;
  session = {
    mode,
    // Short sets run to their own length instead of stalling at "question 7 of
    // 10" with nothing left to draw.
    total: Math.min(SESSION_LENGTH, quiz.size),
    index: 0,
    score: 0,
    registered: [],
    quiz,
    current: null,
  };
  nextQuestion();
}

function renderEmptySet(mode) {
  const { app, esc } = ctx;
  session = null;
  document.title = `${POKE_MODES[mode].label} — Pokédex — Worldly`;

  app.innerHTML = `
    ${ctx.topNav({ id: 'toPokedexTop', label: '← Pokédex' })}
    <h1 class="screen-title">Nothing to practice</h1>
    <p class="screen-sub">${esc(filterLabel(practice))} — no Pokémon in this set can be asked about
      under <strong>${esc(POKE_MODES[mode].label)}</strong>. Widen the filters or pick another mode.</p>
    <div class="btn-row mt-18">
      <button class="btn primary" id="backPoke">Back to the Pokédex</button>
    </div>`;

  ctx.wireNav();
  wireBackToDex();
  app.querySelector('#backPoke').addEventListener('click', () => ctx.navigate('/pokedex'));
  ctx.focusTitle();
}

function nextQuestion() {
  if (!session) return;
  if (session.index >= session.total) return finishPokeQuiz();
  session.current = session.quiz.next();
  if (!session.current) return finishPokeQuiz();
  renderQuestion();
}

function renderQuestion() {
  const { app, esc } = ctx;
  const q = session.current;

  app.innerHTML = `
    ${ctx.topNav({ id: 'toPokedexTop', label: '← Pokédex' })}
    <div class="quiz-head">
      <span class="pill">${esc(POKE_MODES[session.mode].label)}</span>
      ${isFiltered(practice) ? `<span class="pill">${esc(filterLabel(practice))}</span>` : ''}
      <span class="pill">Question ${esc(session.index + 1)} / ${esc(session.total)}</span>
      <span class="pill">Score ${esc(session.score)}</span>
    </div>

    <div class="question-card">
      ${q.sprite ? `<img class="dex-quiz-sprite${q.silhouette ? ' silhouette' : ''}" alt="" decoding="async" src="${spriteUrl(q.sprite)}">` : ''}
      <h1 class="screen-title">${esc(q.prompt)}</h1>
      ${q.body ? `<p class="callout">${esc(q.body)}</p>` : ''}
    </div>

    <div class="choices" id="pokeChoices">
      ${q.choices.map((c) => `<button class="choice" data-choice="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>

    <div id="pokeReveal" aria-live="polite"></div>

    <div class="btn-row mt-18">
      <button class="btn ghost" id="quitPoke">End practice</button>
    </div>`;

  ctx.wireNav();
  wireBackToDex();
  app.querySelector('#quitPoke').addEventListener('click', () => ctx.navigate('/pokedex'));
  app.querySelectorAll('[data-choice]').forEach((btn) =>
    btn.addEventListener('click', () => answer(btn.dataset.choice)));
  ctx.focusTitle();
}

function answer(choice) {
  const { app, esc } = ctx;
  const q = session.current;
  const correct = choice === q.answer;
  if (correct) session.score += 1;

  const { newlyRegistered, newlyMastered } = recordPokeAnswer(q.monId, correct);
  const { dex } = datasets();
  const mon = q.monId ? dex.find((p) => p.id === q.monId) : null;
  if (newlyRegistered && mon) session.registered.push(mon.name);

  app.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.disabled = true;
    if (btn.dataset.choice === q.answer) btn.classList.add('correct');
    else if (btn.dataset.choice === choice) btn.classList.add('wrong');
  });

  // Who's That Pokémon: color the silhouette in once the guess is in.
  app.querySelector('.dex-quiz-sprite.silhouette')?.classList.remove('silhouette');

  app.querySelector('#pokeReveal').innerHTML = `
    <div class="callout mt-14">
      <p class="m-0"><strong>${correct ? 'Correct' : 'Not quite'}</strong> — the answer is ${esc(q.answer)}.</p>
      ${mon ? `<p class="mt-10 m-0">${esc(mon.name)} · ${esc(typingOf(mon))} · Gen ${esc(mon.gen)}${mon.dex ? ` — ${esc(mon.dex)}` : ''}</p>` : ''}
      ${newlyRegistered ? '<p class="mt-10 m-0 ok">Registered to your Pokédex.</p>' : ''}
      ${newlyMastered ? '<p class="mt-10 m-0 ok">★ Mastered.</p>' : ''}
      ${q.learnMore.length ? `<div class="learn-more">${q.learnMore.map((l) => `<a href="${ctx.safeUrl(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join('')}</div>` : ''}
    </div>
    <div class="btn-row mt-14">
      <button class="btn primary" id="pokeNext">${session.index + 1 >= session.total ? 'See results' : 'Next'}</button>
    </div>`;

  const next = app.querySelector('#pokeNext');
  next.addEventListener('click', () => { session.index += 1; nextQuestion(); });
  // Focus Next so Enter advances, but don't scroll the page down to it — the
  // picture and the answer reveal should stay in view.
  next.focus({ preventScroll: true });
}

function finishPokeQuiz() {
  const { app, esc } = ctx;
  const { dex } = datasets();
  const store = getPoke();
  const prog = dexProgress(store, dex);
  const done = session;
  session = null;

  // When a filter is on, the headline number people care about is that set's
  // completion, not the full 1025 — "learn Gen 1" needs a 151 to count against.
  // The scope filters are left out: "38 of 38 unregistered" is a tautology.
  const scoped = isFiltered(practice) && practice.scope === 'all'
    ? dexProgress(store, filterDex(dex, poolConfig(practice)))
    : null;

  app.innerHTML = `
    ${ctx.topNav({ id: 'toPokedexTop', label: '← Pokédex' })}
    <h1 class="screen-title">Practice complete</h1>
    <p class="screen-sub">${esc(done.score)} of ${esc(done.index)} correct${isFiltered(practice) ? ` — ${esc(filterLabel(practice))}` : ''}.</p>

    <div class="stat-grid">
      <div class="stat"><div class="big">${esc(done.registered.length)}</div><div class="lbl">Newly registered</div></div>
      ${scoped ? `<div class="stat"><div class="big">${esc(scoped.registered)}/${esc(scoped.total)}</div><div class="lbl">This set</div></div>` : ''}
      <div class="stat"><div class="big">${esc(prog.registered)}/${esc(prog.total)}</div><div class="lbl">Dex</div></div>
      <div class="stat"><div class="big">${esc(trainerRank(prog.pct))}</div><div class="lbl">Rank</div></div>
    </div>

    ${done.registered.length ? `<p class="callout mt-18">Added to your dex: ${esc(done.registered.join(', '))}.</p>` : ''}

    <div class="btn-row mt-18">
      <button class="btn primary" id="againPoke">Practice again</button>
      <button class="btn ghost" id="backPoke">Back to the Pokédex</button>
    </div>`;

  ctx.wireNav();
  wireBackToDex();
  app.querySelector('#againPoke').addEventListener('click', () => startPokeQuizByKey(done.mode));
  app.querySelector('#backPoke').addEventListener('click', () => ctx.navigate('/pokedex'));
  ctx.focusTitle();
}
