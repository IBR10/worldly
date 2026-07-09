# Global Cross-Device Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players compare Challenge Mode and Daily Challenge scores against other players, with the score itself verified server-side so it can't be fabricated from devtools.

**Architecture:** Cloudflare Pages Functions (`functions/api/...`) co-located with the existing static site, deployed by the same `npx wrangler pages deploy . --project-name=playworldly` command already in use — no separate Worker, no CORS. A D1 database holds the durable leaderboard table; a KV namespace holds ephemeral in-progress session state (question keys + running score) and a rate-limit counter. The server reuses `js/quiz.js` (already pure, already unit-tested, zero DOM) unmodified to generate and grade questions, so the server's scoring is not an approximation of the client's — it's the same code.

**Tech Stack:** Vanilla JS (ES modules), Cloudflare Pages Functions, D1 (SQLite), KV, Wrangler 4.107.0 (already authenticated in this environment as `Isaacrubio19@gmail.com's Account`, account ID `905c4e4e89353790f73be55fdd903f94`).

## Global Constraints

- Every task that touches `js/quiz.js` or `js/main.js` must end with `npm test` passing all 56 existing cases in `tests/engine.test.mjs` (and `tests/maps.test.mjs`) — this feature must not change behavior for any non-Challenge/Daily mode.
- No accounts/login of any kind. Freeform display name, collisions allowed.
- Each session is single-use: `/api/session/finish` deletes it from KV; a second call gets `410`.
- Each question within a session is graded exactly once: a repeat `/api/session/answer` call for the same `questionId` gets `409`.
- Name is sanitized server-side independent of the client (trim, 20-char cap, strip control characters, empty → `"Explorer"`).
- `/api/session/start` is rate-limited per IP: a KV fixed-window counter, max 20 starts per 10-minute window, `429` past that.
- Challenge Mode's server-generated sessions are **uniform-random** (no SRS/missed-item weighting) — this is a deliberate, documented behavior change for fairness across players. Practice/review modes are untouched.
- Daily Challenge's authoritative "day" is the **server's UTC date**, computed as `new Date().toISOString().slice(0, 10)` — not the client's `localDateStr()`.
- The leaderboard score is a **new, session-only formula** (`sessionQuestionXp`/`challengeMultiplier` in `js/quiz.js`), not `state.js:recordAnswer`'s lifetime-streak-influenced XP. Profile XP/level/lifetime streak/achievements/SRS continue to be updated via the existing `recordAnswer` exactly as today — completely separate from the leaderboard score.
- Offline / network-failure fallback: if a Challenge/Daily session can't reach the server (at start, or partway through), it falls back to exactly today's fully-local flow. That run is saved to the local personal-best list as always, but is never submitted to the global board.

---

### Task 1: Session-only score formula in `js/quiz.js`, plus `dateSeed`/`seededRng` extraction

**Files:**
- Modify: `js/quiz.js` (add exports near the top, pure-logic section)
- Modify: `js/main.js:148-166` (remove local `seededRng`/`dailySeed`, import from quiz.js instead)
- Test: `tests/engine.test.mjs`

**Interfaces:**
- Produces: `challengeMultiplier(runStreakBeforeQuestion: number): number`, `sessionQuestionXp(runStreakBeforeQuestion: number, correct: boolean): number`, `seededRng(seed: number): () => number`, `dateSeed(dateStr: string): number` — all pure, exported from `js/quiz.js`. Later tasks (server endpoints and the client refactor) import these by these exact names from `../../../js/quiz.js` (server) or `./quiz.js` (client).

- [ ] **Step 1: Write the failing tests**

Add to `tests/engine.test.mjs` (append near the end, after the existing tests):

```js
test('challengeMultiplier grows with streak, capped at 3x', () => {
  assert.equal(challengeMultiplier(0), 1);
  assert.equal(challengeMultiplier(5), 2);
  assert.equal(challengeMultiplier(10), 3);
  assert.equal(challengeMultiplier(50), 3); // capped
});

test('sessionQuestionXp is 0 for a wrong answer regardless of streak', () => {
  assert.equal(sessionQuestionXp(7, false), 0);
});

test('sessionQuestionXp matches the documented formula for a correct answer', () => {
  // streak 0 -> after=1, bonus=floor(1/2)=0, multiplier=1 -> round(10*1)=10
  assert.equal(sessionQuestionXp(0, true), 10);
  // streak 3 -> after=4, bonus=floor(4/2)=2, multiplier=1+min(2,3*0.2)=1.6 -> round(12*1.6)=19
  assert.equal(sessionQuestionXp(3, true), 19);
  // streak 20 -> after=21, bonus=min(10,floor(21/2))=10, multiplier capped at 3 -> round(20*3)=60
  assert.equal(sessionQuestionXp(20, true), 60);
});

test('seededRng is deterministic for a given seed', () => {
  const a = seededRng(42);
  const b = seededRng(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('dateSeed is deterministic for a given date string and differs across dates', () => {
  assert.equal(dateSeed('2026-07-09'), dateSeed('2026-07-09'));
  assert.notEqual(dateSeed('2026-07-09'), dateSeed('2026-07-10'));
});
```

Add the new names to the existing import line at the top of `tests/engine.test.mjs`:

```js
import { buildPool, makeQuestion, createQuiz, shuffle, geoDistractors, ALL_MODES, drawWithoutRepeat, answerMatches, challengeMultiplier, sessionQuestionXp, seededRng, dateSeed } from '../js/quiz.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/github/worldly && npm test`
Expected: FAIL — `challengeMultiplier is not defined` (or a module export error), since none of the four new names exist yet in `js/quiz.js`.

- [ ] **Step 3: Add the four pure functions to `js/quiz.js`**

Open `js/quiz.js` and add this block right after the `shuffle` export (near the top, alongside the other small pure helpers like `sampleDistinct`):

```js
// ---- Challenge/Daily session scoring (server + client share this exactly) --

/** Speed/streak multiplier for the question about to be answered, given the
 *  in-session streak going INTO it. Capped at 3x. Session-only — never uses
 *  the player's lifetime streak, so it's safe for a server to recompute. */
export function challengeMultiplier(runStreakBeforeQuestion) {
  return 1 + Math.min(2, runStreakBeforeQuestion * 0.2);
}

/** XP earned for one question in a Challenge/Daily session, given the streak
 *  going INTO the question and whether it was answered correctly. Mirrors the
 *  shape of state.js's lifetime-XP formula but is entirely self-contained —
 *  no dependency on private profile state — so client and server always agree. */
export function sessionQuestionXp(runStreakBeforeQuestion, correct) {
  if (!correct) return 0;
  const streakAfter = runStreakBeforeQuestion + 1;
  const bonus = Math.min(10, Math.floor(streakAfter / 2));
  return Math.round((10 + bonus) * challengeMultiplier(runStreakBeforeQuestion));
}

// ---- Seeded RNG (mulberry32) — moved here from main.js so the server can ----
// ---- import the exact same implementation the client uses. -----------------

/** Deterministic RNG from a numeric seed, so the Daily Challenge is identical
 *  for everyone who plays it (client and server alike). */
export function seededRng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Numeric seed from a "yyyy-mm-dd" date string — same date string always
 *  yields the same seed. The caller decides which date string to use (the
 *  client passes its local date; the server passes its own UTC date). */
export function dateSeed(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) | 0;
  return h;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/github/worldly && npm test`
Expected: all new tests pass, plus the original 56 still pass (total 61).

- [ ] **Step 5: Update `js/main.js` to use the moved `seededRng`/`dateSeed` instead of its own copies**

Current code (`js/main.js:148-166`):

```js
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
```

Replace with:

```js
// Local calendar date: the daily rolls over at the player's midnight, and the
// same date string yields the same seeded set for everyone playing locally.
// (The server-verified path uses its own UTC date instead — see startQuiz.)
function dailySeed() {
  return dateSeed(localDateStr());
}
```

Update the import at the top of `js/main.js` (currently line 11):

```js
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches } from './quiz.js';
```

to:

```js
import { createQuiz, MODES, ALL_MODES, drawWithoutRepeat, answerMatches, challengeMultiplier, sessionQuestionXp, seededRng, dateSeed } from './quiz.js';
```

- [ ] **Step 6: Run the full test suite and syntax-check main.js**

Run: `cd ~/github/worldly && node --check js/main.js && npm test`
Expected: no syntax errors; all 61 tests pass.

- [ ] **Step 7: Commit**

```bash
cd ~/github/worldly
git add js/quiz.js js/main.js tests/engine.test.mjs
git commit -m "Add session-only Challenge Score formula, share seededRng/dateSeed"
```

---

### Task 2: Provision D1 + KV, write `wrangler.toml`, apply the schema, verify bindings locally

**Files:**
- Create: `wrangler.toml`
- Create: `migrations/0001_leaderboard.sql`

**Interfaces:**
- Produces: a `DB` (D1) binding and a `SESSIONS_KV` (KV) binding, both resolvable via `context.env.DB` / `context.env.SESSIONS_KV` inside any Pages Function — every later API-endpoint task depends on these binding names existing exactly as written.

- [ ] **Step 1: Create the D1 database**

Run: `cd ~/github/worldly && npx wrangler d1 create worldly-leaderboard`

Expected output (the UUID will differ — copy it, you'll need it in Step 3):
```
✅ Successfully created DB 'worldly-leaderboard'

[[d1_databases]]
binding = "DB"
database_name = "worldly-leaderboard"
database_id = "00000000-0000-0000-0000-000000000000"
```

- [ ] **Step 2: Create the KV namespace**

Run: `cd ~/github/worldly && npx wrangler kv namespace create worldly-sessions`

Expected output (the ID will differ — copy it, you'll need it in Step 3):
```
🌀 Creating namespace with title "worldly-sessions"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "worldly_sessions"
id = "0000000000000000000000000000000"
```

- [ ] **Step 3: Write `wrangler.toml`**

Create `/home/isaac/github/worldly/wrangler.toml`, using the real `database_id` from Step 1 and the real `id` from Step 2 in place of the placeholders below:

```toml
name = "playworldly"
pages_build_output_dir = "."
compatibility_date = "2026-07-09"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "worldly-leaderboard"
database_id = "PASTE_DATABASE_ID_FROM_STEP_1"

[[kv_namespaces]]
binding = "SESSIONS_KV"
id = "PASTE_NAMESPACE_ID_FROM_STEP_2"
```

- [ ] **Step 4: Write the schema migration**

Create `/home/isaac/github/worldly/migrations/0001_leaderboard.sql`:

```sql
CREATE TABLE leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('challenge', 'daily')),
  score INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leaderboard_mode_score ON leaderboard (mode, score DESC);
CREATE INDEX idx_leaderboard_mode_date ON leaderboard (mode, date, score DESC);
```

- [ ] **Step 5: Apply the migration locally**

Run: `cd ~/github/worldly && npx wrangler d1 execute worldly-leaderboard --local --file=migrations/0001_leaderboard.sql`
Expected: `🚣 Executed X commands in Y.YYms` with no errors.

- [ ] **Step 6: Smoke-test that both bindings resolve, before writing any endpoint on top of them**

Create a throwaway probe file `/home/isaac/github/worldly/functions/api/_probe.js`:

```js
export async function onRequestGet(context) {
  await context.env.SESSIONS_KV.put('probe', 'ok', { expirationTtl: 60 });
  const kvValue = await context.env.SESSIONS_KV.get('probe');
  const d1 = await context.env.DB.prepare('SELECT COUNT(*) as n FROM leaderboard').first();
  return new Response(JSON.stringify({ kvValue, d1Count: d1.n }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

Run: `cd ~/github/worldly && npx wrangler pages dev . --port 8788 &` then, after a couple seconds:

```bash
curl -s http://localhost:8788/api/_probe
```

Expected: `{"kvValue":"ok","d1Count":0}`. Then stop the dev server: `kill %1`.

- [ ] **Step 7: Remove the probe file (it was only to verify bindings, not part of the API surface)**

```bash
rm /home/isaac/github/worldly/functions/api/_probe.js
```

- [ ] **Step 8: Commit**

```bash
cd ~/github/worldly
git add wrangler.toml migrations/0001_leaderboard.sql
git commit -m "Provision D1 leaderboard database and KV session namespace"
```

(`wrangler.toml` contains resource IDs, not secrets — D1/KV IDs are not sensitive, they're meaningless without the account's API token, which stays in `~/.config/.wrangler` and is never committed.)

---

### Task 3: `POST /api/session/start`

**Files:**
- Create: `functions/api/session/start.js`

**Interfaces:**
- Consumes: `buildPool`, `createQuiz`, `ALL_MODES`, `seededRng`, `dateSeed` from `../../../js/quiz.js` (Task 1); `DB`/`SESSIONS_KV` bindings (Task 2); the 7 data JSON files under `data/`.
- Produces: the `session:<sessionId>` KV record shape `{ mode, date, questions: [{id, answer, funFact, learnMore}], answered: {}, runStreak: 0, runningScore: 0 }` that Tasks 4 and 5 read/write.

- [ ] **Step 1: Write the endpoint**

Create `/home/isaac/github/worldly/functions/api/session/start.js`:

```js
import { createQuiz, ALL_MODES, seededRng, dateSeed } from '../../../js/quiz.js';
import countries from '../../../data/countries.json';
import usStates from '../../../data/us_states.json';
import mxStates from '../../../data/mexico_states.json';
import caStates from '../../../data/canada_provinces.json';
import historicFlags from '../../../data/historic_flags.json';
import similarFlags from '../../../data/similar_flags.json';
import religions from '../../../data/religions.json';

const DATA = { countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions };

const RATE_LIMIT_WINDOW_SECONDS = 600;
const RATE_LIMIT_MAX = 20;
const SESSION_TTL_SECONDS = 3600;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const mode = body?.mode;
  if (mode !== 'challenge' && mode !== 'daily') return json({ error: 'invalid_mode' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const rlKey = `ratelimit:${ip}:${bucket}`;
  const countStr = await env.SESSIONS_KV.get(rlKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return json({ error: 'rate_limited' }, 429);
  await env.SESSIONS_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });

  const total = mode === 'daily' ? 10 : 15;
  let date = null;
  let rng;
  if (mode === 'daily') {
    date = new Date().toISOString().slice(0, 10);
    rng = seededRng(dateSeed(date));
  } else {
    rng = seededRng(crypto.getRandomValues(new Uint32Array(1))[0]);
  }

  const config = { modes: ALL_MODES, continents: 'all', difficulty: 'medium', choices: 4, rng };
  const engine = createQuiz({ data: DATA, config, rng });
  if (engine.size === 0) return json({ error: 'empty_pool' }, 500);

  const full = [];
  for (let i = 0; i < total && full.length < engine.size; i++) {
    const q = engine.next();
    if (!q) break;
    full.push(q);
  }

  const sessionId = crypto.randomUUID();
  const stored = {
    mode,
    date,
    questions: full.map((q) => ({ id: q.id, answer: q.answer, funFact: q.funFact, learnMore: q.learnMore })),
    answered: {},
    runStreak: 0,
    runningScore: 0,
  };
  await env.SESSIONS_KV.put(`session:${sessionId}`, JSON.stringify(stored), { expirationTtl: SESSION_TTL_SECONDS });

  const safeQuestions = full.map((q) => ({
    id: q.id, category: q.category, region: q.region, prompt: q.prompt,
    choices: q.choices, flagIso: q.flagIso, flagImg: q.flagImg,
  }));
  return json({ sessionId, questions: safeQuestions });
}
```

- [ ] **Step 2: Verify the data JSON imports actually bundle**

This is the one genuinely uncertain piece of this task — Wrangler's Pages Functions bundler is esbuild-based and esbuild supports JSON imports by default, but confirm it in this exact project before relying on it:

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
sleep 3
curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"challenge"}'
```

Expected: a JSON response with a `sessionId` (a UUID) and a `questions` array of 15 objects, each with `id`/`category`/`prompt`/`choices` and no `answer` field anywhere in the response.

**If this fails with a bundling/import error instead:** the JSON-import approach isn't supported in this Wrangler version. Fall back to fetching the files from the site's own deployed static assets instead of importing them: replace the seven `import ... from '../../../data/*.json'` lines and the `DATA` constant with:

```js
async function loadData(request) {
  const base = new URL(request.url).origin;
  const files = ['countries', 'us_states', 'mexico_states', 'canada_provinces', 'historic_flags', 'similar_flags', 'religions'];
  const [countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions] = await Promise.all(
    files.map((f) => fetch(`${base}/data/${f}.json`).then((r) => r.json()))
  );
  return { countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions };
}
```

and call `const DATA = await loadData(request);` as the first line inside `onRequestPost`, before the rate-limit check. Re-run the same `curl` verification after switching approaches.

- [ ] **Step 3: Confirm a daily session is stable across repeated calls on the same day**

```bash
curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"daily"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).questions.length, JSON.parse(d).questions[0].prompt))"
curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"daily"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).questions.length, JSON.parse(d).questions[0].prompt))"
```

Expected: both calls print `10` and the exact same first-question prompt (different `sessionId`s are fine and expected — only the question *set* must be identical).

- [ ] **Step 4: Confirm the rate limit trips**

```bash
for i in $(seq 1 21); do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"challenge"}'; done
```

Expected: the first 20 lines print `200`, the 21st prints `429`. Then stop the dev server: `kill %1`.

- [ ] **Step 5: Regression check**

Run: `cd ~/github/worldly && npm test`
Expected: all 61 tests still pass (this task adds a new file, doesn't modify `js/quiz.js`/`js/main.js`).

- [ ] **Step 6: Commit**

```bash
cd ~/github/worldly
git add functions/api/session/start.js
git commit -m "Add POST /api/session/start endpoint"
```

---

### Task 4: `POST /api/session/answer`

**Files:**
- Create: `functions/api/session/answer.js`

**Interfaces:**
- Consumes: `sessionQuestionXp` from `../../../js/quiz.js` (Task 1); the `session:<sessionId>` KV record written by Task 3.
- Produces: mutates the stored session's `runStreak`/`runningScore`/`answered` map in place — Task 5 (`finish`) reads the final `runningScore` and requires every question to be present in `answered`.

- [ ] **Step 1: Write the endpoint**

Create `/home/isaac/github/worldly/functions/api/session/answer.js`:

```js
import { sessionQuestionXp } from '../../../js/quiz.js';

const SESSION_TTL_SECONDS = 3600;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const { sessionId, questionId, value } = body || {};
  if (!sessionId || !questionId) return json({ error: 'invalid_body' }, 400);

  const raw = await env.SESSIONS_KV.get(`session:${sessionId}`);
  if (!raw) return json({ error: 'session_not_found' }, 404);
  const session = JSON.parse(raw);

  if (session.answered[questionId]) return json({ error: 'already_answered' }, 409);
  const q = session.questions.find((x) => x.id === questionId);
  if (!q) return json({ error: 'unknown_question' }, 409);

  const correct = value === q.answer;
  const xpGained = sessionQuestionXp(session.runStreak, correct);
  session.runStreak = correct ? session.runStreak + 1 : 0;
  session.runningScore += xpGained;
  session.answered[questionId] = true;

  await env.SESSIONS_KV.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });

  return json({
    correct,
    correctAnswer: q.answer,
    funFact: q.funFact,
    learnMore: q.learnMore,
    xpGained,
    runningScore: session.runningScore,
    runningStreak: session.runStreak,
  });
}
```

- [ ] **Step 2: Manual verification — correct then repeat then unknown**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
sleep 3
RESP=$(curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"challenge"}')
SID=$(node -e "console.log(JSON.parse(process.argv[1]).sessionId)" "$RESP")
QID=$(node -e "console.log(JSON.parse(process.argv[1]).questions[0].id)" "$RESP")
CHOICE=$(node -e "console.log(JSON.parse(process.argv[1]).questions[0].choices[0])" "$RESP")

curl -s -X POST http://localhost:8788/api/session/answer -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"questionId\":\"$QID\",\"value\":\"$CHOICE\"}"
echo
curl -s -o /dev/null -w "repeat->%{http_code}\n" -X POST http://localhost:8788/api/session/answer -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"questionId\":\"$QID\",\"value\":\"$CHOICE\"}"
curl -s -o /dev/null -w "unknown-question->%{http_code}\n" -X POST http://localhost:8788/api/session/answer -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"questionId\":\"nope:nope\",\"value\":\"x\"}"
curl -s -o /dev/null -w "unknown-session->%{http_code}\n" -X POST http://localhost:8788/api/session/answer -H 'content-type: application/json' \
  -d "{\"sessionId\":\"not-a-real-session\",\"questionId\":\"$QID\",\"value\":\"x\"}"
```

Expected: the first call returns JSON with `"correct":true` (or `false` if the first choice happened not to be correct — either is fine, just confirm the shape: `correct`, `correctAnswer`, `funFact`, `learnMore`, `xpGained`, `runningScore`, `runningStreak` are all present) and if `correct:true`, `xpGained` equals `10` (streak-before-this-question is 0, so `sessionQuestionXp(0, true) === 10`, matching Task 1's test). Then: `repeat->409`, `unknown-question->409`, `unknown-session->404`. Stop the dev server: `kill %1`.

- [ ] **Step 3: Regression check**

Run: `cd ~/github/worldly && npm test`
Expected: all 61 tests still pass.

- [ ] **Step 4: Commit**

```bash
cd ~/github/worldly
git add functions/api/session/answer.js
git commit -m "Add POST /api/session/answer endpoint"
```

---

### Task 5: `POST /api/session/finish`

**Files:**
- Create: `functions/api/session/finish.js`

**Interfaces:**
- Consumes: the `session:<sessionId>` KV record (Task 3/4); the `DB` D1 binding (Task 2)'s `leaderboard` table.
- Produces: a new row in the `leaderboard` D1 table; deletes the KV session. Response shape `{ score, rank, total, top: [{name, score}] }` that the client (Task 9) displays.

- [ ] **Step 1: Write the endpoint**

Create `/home/isaac/github/worldly/functions/api/session/finish.js`:

```js
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function sanitizeName(raw) {
  const cleaned = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 20);
  return cleaned || 'Explorer';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const { sessionId } = body || {};
  if (!sessionId) return json({ error: 'invalid_body' }, 400);

  const raw = await env.SESSIONS_KV.get(`session:${sessionId}`);
  if (!raw) return json({ error: 'session_not_found' }, 410);
  const session = JSON.parse(raw);

  const allAnswered = session.questions.every((q) => session.answered[q.id]);
  if (!allAnswered) return json({ error: 'incomplete' }, 409);

  const name = sanitizeName(body.name);
  const date = session.date || new Date().toISOString().slice(0, 10);

  await env.DB.prepare('INSERT INTO leaderboard (name, mode, score, date) VALUES (?, ?, ?, ?)')
    .bind(name, session.mode, session.runningScore, date)
    .run();
  await env.SESSIONS_KV.delete(`session:${sessionId}`);

  const higherQuery = session.mode === 'daily'
    ? env.DB.prepare('SELECT COUNT(*) as n FROM leaderboard WHERE mode = ? AND date = ? AND score > ?').bind('daily', date, session.runningScore)
    : env.DB.prepare('SELECT COUNT(*) as n FROM leaderboard WHERE mode = ? AND score > ?').bind('challenge', session.runningScore);
  const totalQuery = session.mode === 'daily'
    ? env.DB.prepare('SELECT COUNT(*) as n FROM leaderboard WHERE mode = ? AND date = ?').bind('daily', date)
    : env.DB.prepare('SELECT COUNT(*) as n FROM leaderboard WHERE mode = ?').bind('challenge');
  const topQuery = session.mode === 'daily'
    ? env.DB.prepare('SELECT name, score FROM leaderboard WHERE mode = ? AND date = ? ORDER BY score DESC LIMIT 20').bind('daily', date)
    : env.DB.prepare('SELECT name, score FROM leaderboard WHERE mode = ? ORDER BY score DESC LIMIT 20').bind('challenge');

  const [{ n: higher }, { n: total }, { results: top }] = await Promise.all([
    higherQuery.first(), totalQuery.first(), topQuery.all(),
  ]);

  return json({ score: session.runningScore, rank: higher + 1, total, top });
}
```

- [ ] **Step 2: Manual verification — full flow start → answer all → finish → repeat finish**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
sleep 3
RESP=$(curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"challenge"}')
SID=$(node -e "console.log(JSON.parse(process.argv[1]).sessionId)" "$RESP")
node -e "
const r = $RESP;
console.log(JSON.stringify(r.questions.map(q => q.id)));
" > /tmp/qids.json
cat /tmp/qids.json
```

Answer every question (any value — wrong answers are fine, this just verifies the completion gate and D1 write):

```bash
node -e "
const r = $RESP;
r.questions.forEach(async () => {});
console.log(r.questions.length);
"
```

Then loop the answer calls (bash, reading the ids back out of `$RESP`):

```bash
node --input-type=module -e "
const r = $RESP;
for (const q of r.questions) {
  const res = await fetch('http://localhost:8788/api/session/answer', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ sessionId: '$SID', questionId: q.id, value: q.choices[0] }),
  });
  console.log(q.id, res.status);
}
"
```

Expected: 15 lines, each ending `200`. Then finish:

```bash
curl -s -X POST http://localhost:8788/api/session/finish -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"name\":\"Test Player\"}"
echo
curl -s -o /dev/null -w "repeat-finish->%{http_code}\n" -X POST http://localhost:8788/api/session/finish -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"name\":\"Test Player\"}"
```

Expected: the first call returns `{"score":N,"rank":1,"total":1,"top":[{"name":"Test Player","score":N}]}` (rank/total are `1` since this is the only row in a fresh local D1); the second call returns `repeat-finish->410`.

- [ ] **Step 3: Verify the incomplete-session gate**

```bash
RESP2=$(curl -s -X POST http://localhost:8788/api/session/start -H 'content-type: application/json' -d '{"mode":"daily"}')
SID2=$(node -e "console.log(JSON.parse(process.argv[1]).sessionId)" "$RESP2")
curl -s -o /dev/null -w "incomplete-finish->%{http_code}\n" -X POST http://localhost:8788/api/session/finish -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID2\",\"name\":\"Nope\"}"
```

Expected: `incomplete-finish->409` (no questions were answered). Then stop the dev server: `kill %1`.

- [ ] **Step 4: Verify name sanitization directly**

```js
// throwaway node check, not part of the codebase
const sanitizeName = (raw) => String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 20) || 'Explorer';
console.log(sanitizeName('   '));                     // -> Explorer
console.log(sanitizeName('A'.repeat(30)));             // -> 20 A's
console.log(sanitizeName('Bob'));                // -> Bob
```
Run: `node -e "$(cat <<'EOF'
const sanitizeName = (raw) => String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 20) || 'Explorer';
console.log(sanitizeName('   '));
console.log(sanitizeName('A'.repeat(30)));
console.log(sanitizeName('Bob'));
EOF
)"`
Expected: `Explorer`, `AAAAAAAAAAAAAAAAAAAA` (20 chars), `Bob`.

- [ ] **Step 5: Regression check**

Run: `cd ~/github/worldly && npm test`
Expected: all 61 tests still pass.

- [ ] **Step 6: Commit**

```bash
cd ~/github/worldly
git add functions/api/session/finish.js
git commit -m "Add POST /api/session/finish endpoint"
```

---

### Task 6: `GET /api/leaderboard`

**Files:**
- Create: `functions/api/leaderboard.js`

**Interfaces:**
- Consumes: the `DB` D1 binding's `leaderboard` table (Task 2/5).
- Produces: `{ entries: [{name, score, date}] }` — consumed by the client's `showLeaderboard()` (Task 10).

- [ ] **Step 1: Write the endpoint**

Create `/home/isaac/github/worldly/functions/api/leaderboard.js`:

```js
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'challenge' && mode !== 'daily') return json({ error: 'invalid_mode' }, 400);

  const query = mode === 'daily'
    ? env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? AND date = ? ORDER BY score DESC LIMIT 20')
        .bind('daily', new Date().toISOString().slice(0, 10))
    : env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? ORDER BY score DESC LIMIT 20')
        .bind('challenge');

  const { results } = await query.all();
  return json({ entries: results });
}
```

- [ ] **Step 2: Manual verification**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
sleep 3
curl -s "http://localhost:8788/api/leaderboard?mode=challenge"
echo
curl -s "http://localhost:8788/api/leaderboard?mode=daily"
echo
curl -s -o /dev/null -w "bad-mode->%{http_code}\n" "http://localhost:8788/api/leaderboard?mode=nonsense"
```

Expected: the first two return `{"entries":[...]}` (populated if Task 5's manual test rows are still in the local D1, otherwise `{"entries":[]}` — either is fine, this just confirms the shape and that querying works); the third returns `bad-mode->400`. Stop the dev server: `kill %1`.

- [ ] **Step 3: Regression check**

Run: `cd ~/github/worldly && npm test`
Expected: all 61 tests still pass.

- [ ] **Step 4: Commit**

```bash
cd ~/github/worldly
git add functions/api/leaderboard.js
git commit -m "Add GET /api/leaderboard endpoint"
```

---

### Task 7: Client — `startQuiz`/`startDaily` become remote-aware with local fallback

**Files:**
- Modify: `js/main.js:400-431` (`startQuiz`, `startDaily`)

**Interfaces:**
- Consumes: `POST /api/session/start` (Task 3).
- Produces: `S.remote` (boolean) and `S.sessionId` (string|null) on the session-state object `S` — Task 8 (`answer`/`answerTyped`) and Task 9 (`finishQuiz`) branch on these.

- [ ] **Step 1: Rewrite `startQuiz`**

Current code (`js/main.js:400-427`):

```js
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
```

Replace with:

```js
async function startQuiz(opts) {
  const { title, modes, continents = 'all', difficulty = 'medium', total = 10, challenge = false, daily = false, reviewIds = null, seed = null, religionFilter = null, input = 'mcq' } = opts;

  // Challenge/Daily attempt a server-verified session first, so the score is
  // eligible for the global leaderboard. Everything else (and any failure
  // below) uses the existing fully-local engine, unchanged.
  if (challenge) {
    const myGen = ++sessionGen;
    let remote = null;
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: daily ? 'daily' : 'challenge' }),
      });
      if (res.ok) remote = await res.json();
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
    title, engine, total: Math.min(total, engine.size), challenge, daily, input, lastOpts: opts,
    index: 0, correct: 0, runStreak: 0, runBest: 0, xpRun: 0,
    missed: [], startTime: Date.now(), phase: 'answer', current: null,
    timer: null, multiplier: 1,
    remote: false, sessionId: null,
  };
  renderQuestion();
}
```

- [ ] **Step 2: Update `startDaily`**

Current code (`js/main.js:429-431`):

```js
function startDaily() {
  startQuiz({ title: 'Daily Challenge', modes: ALL_MODES, total: 10, challenge: true, daily: true, seed: dailySeed() });
}
```

No change needed to this function itself — `startQuiz` already handles the remote-vs-local branch internally, and `seed: dailySeed()` is still the correct fallback seed for the local path. Confirm it reads exactly as above (it's unchanged) and move on.

- [ ] **Step 3: Every other `startQuiz` caller must tolerate it now being async**

`js/main.js` currently calls `startQuiz(...)` from several `addEventListener` callbacks (mixed quiz, challenge, review, again-button) without awaiting it — that's fine, since none of those callers depend on `startQuiz` having finished before continuing (it fully manages its own UI via `renderQuestion()`). Confirm this by searching for callers:

```bash
cd ~/github/worldly && grep -n "startQuiz(" js/main.js
```

Expected: every call site is a bare `startQuiz(...)` inside an event handler or `finishQuiz`'s "Play again" button, none of them `await` it or use its return value — no changes needed at those call sites.

- [ ] **Step 4: Syntax-check and regression test**

Run: `cd ~/github/worldly && node --check js/main.js && npm test`
Expected: no syntax errors; all 61 tests still pass (this task doesn't touch `js/quiz.js`).

- [ ] **Step 5: Manual verification**

Serve the site locally and confirm Challenge Mode still starts and plays through normally when there's no backend running (`python3 -m http.server 8000`, no Pages Functions available at that port) — this exercises the fetch-failure fallback path:

```bash
cd ~/github/worldly && python3 -m http.server 8000 &
```
Open `http://localhost:8000`, start Challenge Mode, confirm a question renders (proving the local-fallback branch engaged since `/api/session/start` doesn't exist on this plain static server). Stop the server: `kill %1`.

- [ ] **Step 6: Commit**

```bash
cd ~/github/worldly
git add js/main.js
git commit -m "startQuiz/startDaily attempt a server-verified session, fall back to local"
```

---

### Task 8: Client — `answer`/`answerTyped` become remote-aware, using the new session score

**Files:**
- Modify: `js/main.js:765-802` (`answer`)
- Modify: `js/main.js:839-869` (`answerTyped`)

**Interfaces:**
- Consumes: `POST /api/session/answer` (Task 4); `sessionQuestionXp` (Task 1); `S.remote`/`S.sessionId` (Task 7).
- Produces: sets `S.remote = false` if a mid-quiz call fails, which Task 9's `finishQuiz` checks before calling `/api/session/finish`.

- [ ] **Step 1: Rewrite `answer`**

Current code (`js/main.js:765-802`):

```js
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
```

Replace with:

```js
async function answer(value) {
  if (S.phase !== 'answer') return;
  clearTimer();
  S.phase = 'feedback';
  const q = S.current;
  const myGen = sessionGen;

  let correct;
  let xpGained;
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
      q.learnMore = graded.learnMore;
      xpGained = graded.xpGained;
    } catch {
      // Connection dropped mid-quiz: finish this run fully locally from here on.
      // The already-graded prefix simply never gets submitted to the server.
      S.remote = false;
      correct = value === q.answer; // q.answer is still undefined here on a
      // freshly-dropped remote question with no local answer key — see Step 2.
    }
  }
  if (!S.remote) {
    correct = value === q.answer;
    xpGained = sessionQuestionXp(S.runStreak, correct);
  }

  const multiplier = challengeMultiplier(S.runStreak);
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
```

This has a real gap flagged inline (a remote question that drops mid-flight has no local `q.answer` to fall back on for *that specific question*) — fix it properly in the next step rather than leaving the comment as the answer.

- [ ] **Step 2: Fix the mid-flight-drop gap**

The problem: if `S.remote` was true and the fetch to `/api/session/answer` throws, `q` is one of the *safe* question objects from `/api/session/start` — it never had `.answer` set, so `value === q.answer` is always false, incorrectly scoring that one question as wrong. There is no way to know the right answer for a question whose grading request just failed (that's the whole point of not sending it up front). Accept and handle this explicitly instead of silently mis-scoring: when the in-flight grade request fails, treat *that* question as unscored-but-shown, tell the player plainly, and continue the rest of the run locally (which works normally, since local questions come from the local engine with real `.answer` fields).

Replace the `catch` block from Step 1 with:

```js
    } catch {
      S.remote = false;
      correct = false; // this one question's grade is lost with the dropped request
      xpGained = 0;
      toast('📡', 'Connection lost', "Switched to local scoring — this run won't count for the global board.");
    }
```

And remove the now-unnecessary `if (!S.remote) { correct = value === q.answer; ... }` block that followed it in Step 1 for *this* question — that block is only correct for questions that started out local. Restructure so the branch is computed once, cleanly:

```js
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
      q.learnMore = graded.learnMore;
      xpGained = graded.xpGained;
    } catch {
      S.remote = false;
      correct = false; // this one question's grade is lost with the dropped request
      xpGained = 0;
      toast('📡', 'Connection lost', "Switched to local scoring — this run won't count for the global board.");
    }
  } else {
    correct = value === q.answer;
    xpGained = S.challenge ? sessionQuestionXp(S.runStreak, correct) : 0;
  }

  const multiplier = S.challenge ? challengeMultiplier(S.runStreak) : 1;
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

  track('question_answered');
  const newly = checkAchievements(getProfile());
  saveProfile();
  if (newly.length) track('achievement_unlocked');
  if (res.levelledUp) toast('⬆️', `Level ${res.level}!`, levelTitle(getProfile().xp));
  newly.forEach((a) => toast(a.icon, `Achievement: ${a.name}`, a.desc));

  renderFeedback(correct, q, S.challenge ? xpGained : res.xpGained);
  renderHUD();
}
```

Note `multiplier` (used only for `recordAnswer`'s lifetime-XP side-effect, unrelated to the leaderboard score) is gated on `S.challenge` — non-challenge modes keep multiplier `1`, matching today's behavior exactly (`S.multiplier` was previously only ever set by `startTimer()`, which only runs when `S.challenge` is true). `xpGained` is likewise `0` for non-challenge local answers, which is harmless: `S.xpRun += S.challenge ? xpGained : res.xpGained` (further down) never reads `xpGained` at all in the non-challenge case.

- [ ] **Step 3: Rewrite `answerTyped`**

Current code (`js/main.js:839-869`):

```js
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
```

Typed input is never used by Challenge/Daily (`S.challenge` sessions always render MCQ via `renderMcqQuestion`/`renderQuestion`'s `S.input === 'type'` branch, which Custom Study uses, not Challenge Mode — confirm this is genuinely unreachable for remote sessions):

```bash
cd ~/github/worldly && grep -n "input: 'type'\|input,$\|challenge: true" js/main.js | head -20
```

Expected: `challenge: true` call sites (`startQuiz({..., challenge: true, ...})` for Challenge Mode, and `startDaily`) never pass `input: 'type'` — typed input is only reachable via Custom Study, which never sets `challenge: true`. Given that, `answerTyped` never runs with `S.remote` true, so **no functional change is needed here** — leave `answerTyped` exactly as it is. Confirm this by re-reading the function afterward and moving on without editing it.

- [ ] **Step 4: Syntax-check and regression test**

Run: `cd ~/github/worldly && node --check js/main.js && npm test`
Expected: no syntax errors; all 61 tests still pass.

- [ ] **Step 5: Manual verification against local `wrangler pages dev`**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
```
Open `http://localhost:8788`, play a full Challenge Mode round. Confirm: instant per-question feedback (fun fact, correct-answer highlight) still appears exactly as before; the "+N XP" shown matches `sessionQuestionXp`'s values (first correct answer in a run should show "+10 XP", matching Task 1's test). Then open browser devtools, go offline (Network tab → Offline), answer another question, confirm the "📡 Connection lost" toast appears and the quiz keeps working locally afterward. Stop the dev server: `kill %1`.

- [ ] **Step 6: Commit**

```bash
cd ~/github/worldly
git add js/main.js
git commit -m "answer() grades remotely for verified sessions, using the session-only score"
```

---

### Task 9: Client — `finishQuiz` submits to the global board in the background

**Files:**
- Modify: `js/main.js:893-936` (`finishQuiz`)
- Modify: `js/main.js:1428-1441` (`showLeaderboard` — score-summary copy only; full rewrite is Task 10)

**Interfaces:**
- Consumes: `POST /api/session/finish` (Task 5); `S.remote`/`S.sessionId` (Tasks 7-8).
- Produces: nothing new consumed elsewhere — this is the terminal step of a run.

- [ ] **Step 1: Update `finishQuiz`**

Current code (`js/main.js:893-936`):

```js
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
```

Replace with (adds a `<div id="globalSyncNote">` placeholder filled in once the background submission resolves, and fires that submission after rendering so it never blocks the results screen):

```js
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
```

- [ ] **Step 2: Syntax-check and regression test**

Run: `cd ~/github/worldly && node --check js/main.js && npm test`
Expected: no syntax errors; all 61 tests still pass.

- [ ] **Step 3: Manual verification**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
```
Open `http://localhost:8788`, play a full Challenge Mode round to completion. Confirm the results screen shows "🌍 Syncing to the global leaderboard…" immediately, then updates to "🌍 Synced — you're #N of M globally." within a second or two, without ever blocking the results screen from appearing. Then play a Mixed Quiz (non-challenge) round and confirm no sync note appears at all (it's `challenge`-only). Stop the dev server: `kill %1`.

- [ ] **Step 4: Commit**

```bash
cd ~/github/worldly
git add js/main.js
git commit -m "finishQuiz submits verified runs to the global leaderboard in the background"
```

---

### Task 10: `showLeaderboard()` — global tabs + personal bests

**Files:**
- Modify: `js/main.js:1428-1441` (`showLeaderboard`)
- Modify: `css/styles.css` (reuse existing `.tabs`/`.tab`/`.tab-panel` rules — no new CSS needed, confirm in Step 3)

**Interfaces:**
- Consumes: `GET /api/leaderboard` (Task 6); `wireTabs()` (existing, `js/main.js:115`); `getProfile().leaderboard` (existing, local personal bests).

- [ ] **Step 1: Add a module-level tab-state variable**

Near the other tab-state variables (`js/main.js:37-39`):

```js
let homeTab = 'play';
```
```js
let crisesTab = 'underreported';
```

Add, right after `crisesTab`:

```js
let leaderboardTab = 'challenge';
```

- [ ] **Step 2: Rewrite `showLeaderboard`**

Current code (`js/main.js:1428-1441`):

```js
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

Replace with:

```js
function showLeaderboard() {
  leaveSession();
  const lb = getProfile().leaderboard;
  const tiers = [
    { id: 'challenge', label: '⏱️ Challenge' },
    { id: 'daily', label: '📅 Daily' },
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
      ? `<ul class="weak-list">${entries.map((e, i) => `<li><span>#${i + 1} · ${esc(e.name)}</span><span class="ans">${e.score} XP</span></li>`).join('')}</ul>`
      : '<p class="screen-sub">No scores yet — be the first!</p>';
  } catch {
    if (myGen === sessionGen && target) {
      target.innerHTML = '<p class="screen-sub">Couldn\'t reach the global leaderboard — check your connection.</p>';
    }
  }
}
```

- [ ] **Step 3: Confirm no new CSS is needed**

```bash
cd ~/github/worldly && grep -n "^\.tabs\b\|^\.tab\b\|^\.tab-panel\b\|^\.tab\." css/styles.css
```

Expected: existing rules from the Crises & Events screen (Task references `js/main.js:showCrises`) already cover `.tabs`, `.tab`, `.tab.active`, `.tab-panel`, `.tab-panel.active` — no edits to `css/styles.css` needed. If any of these selectors are missing, stop and report back rather than guessing new CSS.

- [ ] **Step 4: Syntax-check and regression test**

Run: `cd ~/github/worldly && node --check js/main.js && npm test`
Expected: no syntax errors; all 61 tests still pass.

- [ ] **Step 5: Manual verification**

```bash
cd ~/github/worldly && npx wrangler pages dev . --port 8788 &
```
Open `http://localhost:8788`, navigate Explore → Leaderboard. Confirm: the Challenge/Daily tab toggle works (click each, content switches, matches the existing Crises & Events tab feel); each tab shows either real entries or "No scores yet — be the first!"; the "📱 Your personal bests" section below still shows local history unchanged. Then go offline and reload the Leaderboard screen — confirm the "Couldn't reach the global leaderboard" message appears instead of an infinite "Loading…". Stop the dev server: `kill %1`.

- [ ] **Step 6: Commit**

```bash
cd ~/github/worldly
git add js/main.js
git commit -m "Leaderboard screen shows global Challenge/Daily boards alongside personal bests"
```

---

### Task 11: Production deploy and live end-to-end verification

**Files:** none (deployment + verification only).

**Interfaces:** none — this is the final integration of every prior task's output.

- [ ] **Step 1: Apply the D1 migration to the real (remote) database**

```bash
cd ~/github/worldly && npx wrangler d1 execute worldly-leaderboard --remote --file=migrations/0001_leaderboard.sql
```
Expected: `🚣 Executed X commands in Y.YYms` with no errors. This is idempotent-unsafe (re-running `CREATE TABLE` on an already-migrated database errors) — only run this once against `--remote`; if it's already been applied, `wrangler` will report a "table already exists" error, which means skip this step, not retry it.

- [ ] **Step 2: Deploy**

```bash
cd ~/github/worldly && npx wrangler pages deploy . --project-name=playworldly
```
Expected: `✨ Deployment complete!` with a live URL. Cloudflare Pages automatically wires the D1/KV bindings declared in `wrangler.toml` to the production deployment — no separate "production provisioning" step is needed since Tasks 2-6 already used the same (only) D1 database and KV namespace for both local dev and production; `wrangler pages dev` and `wrangler pages deploy` both read bindings from the same `wrangler.toml`, and D1/KV resources themselves aren't environment-scoped by default in this setup.

- [ ] **Step 3: Verify the live API end-to-end**

```bash
SITE=https://playworldly.pages.dev
RESP=$(curl -s -X POST "$SITE/api/session/start" -H 'content-type: application/json' -d '{"mode":"challenge"}')
echo "$RESP" | node -e "process.stdin.on('data', d => { const r = JSON.parse(d); console.log('questions:', r.questions.length, 'has sessionId:', !!r.sessionId, 'answer field leaked:', 'answer' in (r.questions[0]||{})); })"
```
Expected: `questions: 15 has sessionId: true answer field leaked: false`.

```bash
SID=$(echo "$RESP" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).sessionId))")
node --input-type=module -e "
const r = $RESP;
for (const q of r.questions) {
  const res = await fetch('$SITE/api/session/answer', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ sessionId: '$SID', questionId: q.id, value: q.choices[0] }),
  });
  const j = await res.json();
  console.log(q.id, res.status, j.correct);
}
"
```
Expected: 15 lines, each `200` with `true` or `false` for `correct` (whichever the random first choice happens to be).

```bash
curl -s -X POST "$SITE/api/session/finish" -H 'content-type: application/json' -d "{\"sessionId\":\"$SID\",\"name\":\"E2E Test\"}"
echo
curl -s "$SITE/api/leaderboard?mode=challenge" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).entries.some(e => e.name === 'E2E Test')))"
```
Expected: the `finish` call returns a JSON object with `score`/`rank`/`total`/`top`; the final line prints `true` — the row genuinely landed in the live leaderboard and is visible via the public read endpoint.

- [ ] **Step 4: Verify the live site itself**

```bash
curl -s https://playworldly.pages.dev/js/main.js | grep -c "session/start\|session/answer\|session/finish\|leaderboardTab"
```
Expected: a non-zero count, confirming the deployed `main.js` includes this feature's client code (not a stale cached copy).

- [ ] **Step 5: Clean up the E2E test data**

The `"E2E Test"` row from Step 3 is real data in the production leaderboard. Remove it so the live board doesn't start with test noise:

```bash
cd ~/github/worldly && npx wrangler d1 execute worldly-leaderboard --remote --command "DELETE FROM leaderboard WHERE name = 'E2E Test'"
```
Expected: confirms one row deleted.

- [ ] **Step 6: Final full regression check**

Run: `cd ~/github/worldly && npm test`
Expected: all 61 tests pass.

- [ ] **Step 7: Push (if any commits are still local-only) and confirm**

```bash
cd ~/github/worldly && git status --short && git push
```
Expected: clean working tree, everything pushed, `origin/main` matches local `main`.
