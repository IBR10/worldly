# Profile Name & Leaderboard Header Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the player's name in the header and add a one-tap way to view the local leaderboard, then normalize the project's spelling to American English and ship everything.

**Architecture:** Vanilla JS, no build step, no framework. `js/main.js` is a single controller file: functions render HTML strings into `#app`/`#hud`, then wire `addEventListener` calls onto the freshly-inserted DOM. `js/state.js` owns `localStorage`-backed profile state (`name`, `leaderboard` already exist — no new state needed). New screens follow the existing pattern seen in `showAchievements()`: `topNav()` + `screen-title` + content + back button + `wireNav()`.

**Tech Stack:** Plain HTML/CSS/ES modules, `node --test` for the pure engine files only (not applicable here), Cloudflare Pages (`wrangler pages deploy`) for hosting.

## Global Constraints

- No new dependencies, no build step — keep editing the existing static files directly.
- `js/main.js` and `index.html` have **no unit test coverage** in this repo (only `quiz.js`, `srs.js`, `maps.js` do — see `tests/*.test.mjs`). Verify every UI change manually in a browser; do not invent DOM tests that don't match the project's existing convention.
- Keep the CSP intact: never add inline `style="..."` attributes or inline `<script>` — widths/behavior go through CSSOM/`addEventListener` as the rest of the file already does.
- American spelling throughout docs and comments (this plan's Task 4), except inside verbatim proper nouns / quoted names (e.g. "People's Defence Forces" in `data/crises.json` — a real organization name, must NOT be changed).
- Final deploy command (from README "Deployment (Cloudflare)"): `npx wrangler pages deploy . --project-name=playworldly`. Pushing to `main` alone does **not** publish the live site.

---

### Task 1: Header markup — add the leaderboard trophy button

**Files:**
- Modify: `index.html:26-30`

**Interfaces:**
- Produces: a `<button id="leaderboardBtn">` element that Task 3 will wire to `showLeaderboard()`.

- [ ] **Step 1: Add the button to the header**

In `index.html`, the header currently reads:

```html
  <header class="topbar">
    <div class="brand" id="brand" role="button" tabindex="0" title="Home">
      <span class="brand-globe">🌍</span><span class="brand-name">Worldly</span>
    </div>
    <div class="hud" id="hud"><!-- level / xp / streak injected here --></div>
    <button id="helpBtn" class="icon-btn" title="About & help" aria-label="About and help">❓</button>
    <button id="themeToggle" class="icon-btn" title="Toggle light / dark" aria-label="Toggle theme">🌙</button>
  </header>
```

Change it to:

```html
  <header class="topbar">
    <div class="brand" id="brand" role="button" tabindex="0" title="Home">
      <span class="brand-globe">🌍</span><span class="brand-name">Worldly</span>
    </div>
    <div class="hud" id="hud"><!-- level / xp / streak injected here --></div>
    <button id="helpBtn" class="icon-btn" title="About & help" aria-label="About and help">❓</button>
    <button id="leaderboardBtn" class="icon-btn" title="Leaderboard" aria-label="Leaderboard">🏆</button>
    <button id="themeToggle" class="icon-btn" title="Toggle light / dark" aria-label="Toggle theme">🌙</button>
  </header>
```

- [ ] **Step 2: Verify it renders (no JS wired yet, so it's inert)**

```bash
cd ~/github/worldly && python3 -m http.server 8000 &
curl -s http://localhost:8000/ | grep leaderboardBtn
```

Expected: the `<button id="leaderboardBtn" ...>🏆</button>` line prints. Kill the server after (`kill %1`).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add leaderboard button to header"
```

---

### Task 2: Clickable name chip in the HUD

**Files:**
- Modify: `js/main.js:180-192` (`renderHUD`)
- Modify: `css/styles.css` (near `.hud .chip` rules, ~line 92-94)

**Interfaces:**
- Consumes: `getProfile().name` (`js/state.js`, already exported and populated), `showProfile` (defined later in `js/main.js`; safe to reference here because it's a hoisted `function` declaration).
- Produces: nothing new consumed elsewhere — this is a leaf UI change.

- [ ] **Step 1: Add the chip markup and click handler**

Current code:

```js
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
```

Replace with:

```js
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
```

- [ ] **Step 2: Reset default `<button>` styling so the name chip matches the other chips**

In `css/styles.css`, find:

```css
.hud .chip { display: flex; align-items: center; gap: 6px; font-size: .9rem; color: var(--muted); }
.hud .chip strong { color: var(--text); }
```

Add immediately after it:

```css
.hud .chip.chip-name { background: none; border: none; padding: 0; font: inherit; cursor: pointer; }
.hud .chip.chip-name:hover strong, .hud .chip.chip-name:focus-visible strong { color: var(--accent); }
```

- [ ] **Step 3: Manual verification in the browser**

```bash
cd ~/github/worldly && python3 -m http.server 8000 &
```

Open `http://localhost:8000` (or use the Playwright script pattern from the earlier screenshot task). Confirm:
- A `👤 Explorer` chip appears at the far left of the HUD (before Lvl).
- Clicking it navigates to the Profile screen.
- On a narrow viewport (e.g. resize to 500px wide) the chip disappears along with the other `hide-sm` chips instead of overflowing.

Kill the server (`kill %1`) when done.

- [ ] **Step 4: Commit**

```bash
git add js/main.js css/styles.css
git commit -m "Show player name as a clickable chip in the header HUD"
```

---

### Task 3: Extract the leaderboard into its own screen, wire the header button

**Files:**
- Modify: `js/main.js` — `showHome()` card list (~line 277), new `showLeaderboard()` function (insert after `showAchievements()`, ~line 1421), `showProfile()` (~lines 1426-1458), `boot()` (~line 1537)

**Interfaces:**
- Consumes: `getProfile()`, `esc()`, `topNav()`, `wireNav()`, `leaveSession()`, `showHome` — all already defined earlier in `js/main.js`.
- Produces: `showLeaderboard()` — a new top-level function in `js/main.js`, called from `boot()`'s `leaderboardBtn` listener.

- [ ] **Step 1: Update the Explore card description**

Current (`js/main.js` ~line 277):

```js
    { key: 'profile', emoji: '🧭', title: 'Profile', desc: 'Name, leaderboard & reset.' },
```

Change to:

```js
    { key: 'profile', emoji: '🧭', title: 'Profile', desc: 'Name & reset.' },
```

- [ ] **Step 2: Add the new `showLeaderboard()` function**

Insert immediately after `showAchievements()`'s closing brace (the function ending with `app.querySelector('#backHome').addEventListener('click', showHome);` at ~line 1421, right before the `// PROFILE` section comment):

```js
// ============================================================================
//  LEADERBOARD
// ============================================================================
function showLeaderboard() {
  leaveSession();
  const lb = getProfile().leaderboard;
  app.innerHTML = `
    ${topNav()}
    <h1 class="screen-title">Leaderboard 🏆</h1>
    <p class="screen-sub">Your best local scores from Challenge and Daily runs.</p>
    <div class="form-block">
      ${lb.length ? `<ul class="weak-list">${lb.map((e, i) => `<li><span>#${i + 1} · ${esc(e.mode)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>` : '<p class="screen-sub">Play Challenge or Daily to set a high score.</p>'}
    </div>
    <div class="btn-row mt-18"><button class="btn ghost" id="backHome">← Back</button></div>`;
  wireNav();
  app.querySelector('#backHome').addEventListener('click', showHome);
}
```

- [ ] **Step 3: Remove the leaderboard block from `showProfile()`**

Current `showProfile()` (~lines 1426-1443):

```js
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
```

Change to (drop the unused `lb` local and the whole "Local leaderboard" `form-block`):

```js
function showProfile() {
  leaveSession();
  const p = getProfile();
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
      <h3>Backup &amp; transfer</h3>
```

The rest of `showProfile()` (export/import/reset/back-button wiring) is unchanged.

- [ ] **Step 4: Wire the header button in `boot()`**

Current (`js/main.js` ~line 1537):

```js
  document.getElementById('helpBtn').addEventListener('click', showAbout);
```

Change to:

```js
  document.getElementById('helpBtn').addEventListener('click', showAbout);
  document.getElementById('leaderboardBtn').addEventListener('click', showLeaderboard);
```

- [ ] **Step 5: Syntax-check the file**

```bash
cd ~/github/worldly && node --check js/main.js
```

Expected: no output (exit code 0).

- [ ] **Step 6: Manual verification in the browser**

```bash
cd ~/github/worldly && python3 -m http.server 8000 &
```

Confirm in the browser (or via the Playwright script pattern used earlier for screenshots):
- The 🏆 header button opens a "Leaderboard 🏆" screen showing "Play Challenge or Daily to set a high score." on a fresh profile.
- Explore → Profile no longer shows a "Local leaderboard" section, and its Explore-tab card now reads "Name & reset."
- Explore → Profile still lets you rename, export, import, and reset.

Kill the server (`kill %1`) when done.

- [ ] **Step 7: Run the existing test suite (regression check)**

```bash
cd ~/github/worldly && npm test
```

Expected: all 48 tests pass (this change touches no engine logic, so this just confirms nothing broke).

- [ ] **Step 8: Commit**

```bash
git add js/main.js
git commit -m "Extract leaderboard into its own screen, reachable from the header"
```

---

### Task 4: American spelling pass

**Files:**
- Modify: `README.md:48`, `ROADMAP.md:58`, `js/mapview.js:167`, `js/mapview.js:218`, `js/main.js:757`

**Interfaces:** None — comment/copy-only text changes, no code behavior changes.

- [ ] **Step 1: Confirm the full list of British spellings in the repo**

```bash
cd ~/github/worldly && grep -rniE "\b(colour|favour|organis|practise|practised|practising|licence|centre|behaviour|analyse|customis|recognis|categoris|apologis|travelling|travelled|modelling|modelled|labelled|programme|defence|offence|honour|neighbour|neighbours|grey|fulfil|artefact|whilst|amongst)\b" --include="*.md" --include="*.js" --include="*.html" --include="*.json" --include="*.css" .
```

Expected output (5 lines — the `data/crises.json` "Defence Forces" match, if any, is a proper noun and must be left alone; confirm it's not in this list before proceeding, since the grep above doesn't include "defence forces" as a standalone match target beyond generic `defence`):

```
README.md:48:| **Review Missed** | Practise exactly what you got wrong |
ROADMAP.md:58:- [ ] Per-country deep-dive study pages (population, currency, neighbours…).
js/mapview.js:167:  // larger neighbour (e.g. DC under Maryland, Andorra under France, Guanajuato
js/mapview.js:218:  // a region, Enter/Space picks it, mirroring the click/hit-test behaviour.
js/main.js:757:// quiz modes. Map-mode misses (ids like "map_us:Texas") are practised by
```

If `data/crises.json`'s "People's Defence Forces" also matches your grep, exclude it manually — do not edit that file. It's a real organization's proper name, not a spelling style choice.

- [ ] **Step 2: Fix `README.md`**

Change line 48 from:

```
| **Review Missed** | Practise exactly what you got wrong |
```

to:

```
| **Review Missed** | Practice exactly what you got wrong |
```

- [ ] **Step 3: Fix `ROADMAP.md`**

Change line 58 from:

```
- [ ] Per-country deep-dive study pages (population, currency, neighbours…).
```

to:

```
- [ ] Per-country deep-dive study pages (population, currency, neighbors…).
```

- [ ] **Step 4: Fix `js/mapview.js`**

Change line 167 from:

```
  // larger neighbour (e.g. DC under Maryland, Andorra under France, Guanajuato
```

to:

```
  // larger neighbor (e.g. DC under Maryland, Andorra under France, Guanajuato
```

Change line 218 from:

```
  // a region, Enter/Space picks it, mirroring the click/hit-test behaviour.
```

to:

```
  // a region, Enter/Space picks it, mirroring the click/hit-test behavior.
```

- [ ] **Step 5: Fix `js/main.js`**

Change line 757 from:

```
// quiz modes. Map-mode misses (ids like "map_us:Texas") are practised by
```

to:

```
// quiz modes. Map-mode misses (ids like "map_us:Texas") are practiced by
```

- [ ] **Step 6: Re-run the grep to confirm only the proper noun remains (if it matched at all)**

```bash
cd ~/github/worldly && grep -rniE "\b(colour|favour|organis|practise|practised|practising|licence|centre|behaviour|analyse|customis|recognis|categoris|apologis|travelling|travelled|modelling|modelled|labelled|programme|defence|offence|honour|neighbour|neighbours|grey|fulfil|artefact|whilst|amongst)\b" --include="*.md" --include="*.js" --include="*.html" --include="*.json" --include="*.css" .
```

Expected: either no output, or only the `data/crises.json` "Defence Forces" line (untouched).

- [ ] **Step 7: Run the test suite (regression check — these are comment/copy-only edits, but confirm nothing else broke)**

```bash
cd ~/github/worldly && npm test
```

Expected: all 48 tests pass.

- [ ] **Step 8: Commit**

```bash
git add README.md ROADMAP.md js/mapview.js js/main.js
git commit -m "Normalize to American spelling across docs and comments"
```

---

### Task 5: Refresh the README screenshot, push, and deploy

**Files:**
- Modify: `assets/screenshot-home.png`

**Interfaces:** None — this is the final packaging/shipping step, run after Tasks 1-4 are all committed.

- [ ] **Step 1: Serve the updated site locally**

```bash
cd ~/github/worldly && python3 -m http.server 8000 &
```

- [ ] **Step 2: Recapture the home screenshot**

Reuse the Playwright script pattern from the prior screenshot update (1280×560 viewport, `deviceScaleFactor: 2`, dismiss the "Got it" onboarding tip if present, blur focus, `page.screenshot()`), saving over `assets/screenshot-home.png`. This ensures the screenshot shows the new 👤 name chip and 🏆 leaderboard button in the header.

Verify dimensions match the existing file so the README layout doesn't shift:

```bash
file assets/screenshot-home.png
```

Expected: `PNG image data, 2560 x 1120, ...` (same as before).

- [ ] **Step 3: Stop the local server**

```bash
kill %1
```

- [ ] **Step 4: Commit the screenshot**

```bash
cd ~/github/worldly && git add assets/screenshot-home.png
git commit -m "Update README screenshot to show header name chip and leaderboard button"
```

- [ ] **Step 5: Push everything to `main`**

```bash
git push
```

- [ ] **Step 6: Deploy the live site**

Per README "Deployment (Cloudflare)" — pushing to `main` does **not** publish `playworldly.pages.dev`; it must be deployed explicitly:

```bash
npx wrangler pages deploy . --project-name=playworldly
```

Expected: wrangler prints a deployment URL ending in `.playworldly.pages.dev` and reports success. If wrangler prompts for Cloudflare auth interactively, stop and surface that to the user rather than guessing credentials.

- [ ] **Step 7: Verify the live deployment**

```bash
curl -s https://playworldly.pages.dev/ | grep -o 'leaderboardBtn'
```

Expected: `leaderboardBtn` prints, confirming the deployed `index.html` includes the new button (cache-busted since `_headers` sets `index.html` to `max-age=0, must-revalidate`).
