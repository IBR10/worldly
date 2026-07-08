# Global (cross-device) leaderboard for Challenge & Daily

## Problem

The leaderboard added earlier this session (`showLeaderboard()`) only shows
scores from the current browser's `localStorage`. The user wants to compare
scores against other people, on other devices — which the current
architecture cannot do, since Worldly is explicitly a no-backend, no-accounts
static site (per its own README). This requires introducing a small
server-side piece.

## Scope decisions (confirmed with the user)

- **Audience:** public — anyone playing `playworldly.pages.dev`, not a private circle.
- **Score integrity:** real protection against fabricated scores is required,
  not just a trust-based submission. A client can currently call
  `addLeaderboard(999999, 'Challenge')` from devtools with zero gameplay;
  that must not be possible for the *global* board.
- **Ranking:** one global leaderboard per mode (Challenge, Daily), not
  per-continent/per-difficulty breakdowns.
- **Identity:** no accounts/login. Freeform display name, same as today.
  Name collisions between two different people are accepted as a harmless
  cosmetic ambiguity.
- **Only Challenge Mode and Daily Challenge feed the leaderboard** — this is
  already true today (`finishQuiz()` in `js/main.js` only calls
  `addLeaderboard`/`markDailyComplete` for these two). No other quiz or map
  mode is affected by this change.

## Why real anti-cheat is actually feasible here

Score calculation was traced end-to-end in `js/main.js`/`js/state.js`:
- Challenge Mode's per-question XP is `Math.round((10 + streakBonus) * multiplier)`
  (`state.js:169`), where `multiplier = 1 + min(2, runStreak * 0.2)`
  (`main.js:729`) — a pure function of the *sequence of correct/incorrect
  answers*. The 10-second-per-question timer only ever produces a timeout
  that counts as wrong (`main.js:735-737`); no raw timing value ever feeds
  the score formula.
- This means a server that independently knows (a) the question set and (b)
  each submitted answer can recompute the *exact* final score — not an
  approximation, a bit-for-bit match with what the client would compute.
- `js/quiz.js` (`buildPool`, `makeQuestion`, `createQuiz`, `learnMoreFor`) is
  pure — no DOM, no `window`, already unit-tested via plain `node --test`.
  It can run unmodified inside a Cloudflare Worker/Pages Function.

## Architecture

**Cloudflare Pages Functions**, not a separate Worker project. Reasoning:
the site already deploys via `npx wrangler pages deploy . --project-name=playworldly`;
Pages Functions live in a `functions/` directory at the repo root, deploy
with that exact same command, run on the exact same domain
(`playworldly.pages.dev/api/...`) so there's **no CORS to configure**, and
support D1/KV bindings identically to a standalone Worker. This is strictly
simpler than standing up and CORS-wiring a second service, for the same
capability. (The unrelated, already-documented "legacy Cloudflare Worker"
check on GitHub is untouched by this — that's a separate, dormant git
integration, not reused here.)

**Storage:**
- **D1** (`worldly` database) — the leaderboard itself. Structured,
  durable, supports `ORDER BY score DESC LIMIT N` cleanly; avoids the
  read-modify-write race a KV-blob-of-JSON approach would have under
  concurrent writes.
- **KV** (`SESSIONS_KV` namespace) — ephemeral in-progress session state
  (the question set + correct answers + running score for a session that
  hasn't finished yet) and a lightweight rate-limit counter. Both benefit
  from KV's native TTL/auto-expiry; neither belongs in durable storage.

**Data files:** the Worker imports `data/countries.json`,
`us_states.json`, `mexico_states.json`, `canada_provinces.json`,
`historic_flags.json`, `similar_flags.json`, `religions.json` directly as
ES module JSON imports (bundled at deploy time) — the same files the
client fetches, just loaded a different way. `phrases/music/crises` aren't
used by `quiz.js`'s modes and aren't needed server-side.

## Why per-question round trips (not one batch submit)

A generated question's full shape (`js/quiz.js` `makeQuestion`, line
~379-391) is:
```
{ id, category, region, prompt, answer, choices, flagIso, flagImg, funFact, learnMore, source }
```
`answer`, `funFact`, `learnMore`, and `source` (the raw country record —
which usually contains the answer directly, e.g. `source.capital`) all have
to be withheld until *after* that specific question has been answered, or a
player could simply read the answer out of the network response before
picking. But the app's core teaching mechanic is showing the fun
fact/answer/links **immediately after every question** — that's not
optional flavor, it's called out in the README as a pillar ("every answer
teaches something").

Resolution (confirmed with the user): grade each answer live, one at a
time. The client calls the server right when an answer is submitted, gets
back correctness + the fun fact + links immediately — pixel-for-pixel the
same feel as today — and the server has already locked in that grade before
revealing anything. This trades a chattier protocol (~N+2 requests per
quiz instead of 2) for zero UX compromise; each request is a small,
sub-50ms-typical edge request, and quizzes are 10-15 questions.

## API

All under `/api/` on the same origin as the site.

### `POST /api/session/start`
Request: `{ "mode": "challenge" | "daily" }`

Server generates the question sequence:
- **Challenge:** uniform-random pool draw (`createQuiz` with a
  `crypto`-seeded `rng`, no SRS weighting — see behavior-change note below).
- **Daily:** deterministic from the **server's own UTC date** (not the
  client's `localDateStr()`), so the set really is identical for everyone
  and can't be replayed by changing the device clock (today's client-only
  implementation is spoofable this way; this closes that too).

Stores `{ mode, date?, questions: [{id, answer, funFact, learnMore, source}], runStreak: 0, runningScore: 0, answered: 0 }`
in KV under `session:<sessionId>`, TTL 1 hour.

Response: `{ sessionId, questions: [{ id, category, region, prompt, choices, flagIso, flagImg }, ...] }`
— note `answer`/`funFact`/`learnMore`/`source` are stripped.

Errors: `400` invalid mode, `429` rate-limited (see Abuse handling).

### `POST /api/session/answer`
Request: `{ sessionId, questionId, value }` (`value` may be `null` for a timeout, matching today's `answer(null)` on timeout)

Server looks up the session, finds the matching question by `questionId`,
grades it (`value === stored.answer`), advances the stored `runStreak` /
computes this question's `multiplier` and XP exactly as
`state.js:recordAnswer` does today, adds to `runningScore`, marks the
question answered (rejects a second grade attempt for the same
`questionId` — one grade per question, no retries-until-correct).

Response: `{ correct, correctAnswer, funFact, learnMore, xpGained, runningScore, runningStreak }`

Errors: `404` unknown/expired session, `409` question already answered or
not part of this session, `400` malformed body.

### `POST /api/session/finish`
Request: `{ sessionId, name }`

Requires every question in the session to have been answered (else `409`).
Server trims/caps `name` to 20 chars server-side (mirrors
`state.js:setName`'s existing client-side rule — must not rely on the
client having done this), rejects empty → `"Explorer"` default, same as
today. Inserts one row into D1 `leaderboard` (`name, mode, score, date`),
deletes the KV session (single-use — a second `finish` call gets `410`),
returns the fresh top list so the results screen can show "you're #4
globally" immediately.

Response: `{ score, rank, total: <count of entries this mode/day>, top: [{ name, score }, ...] }`

### `GET /api/leaderboard?mode=challenge|daily`
- `mode=challenge` → top 20 all-time rows (`ORDER BY score DESC LIMIT 20`).
- `mode=daily` → top 20 rows **for today's UTC date only** — this is the
  meaningful comparison, since only players of *today's* identical set are
  comparable to each other. (All-time daily history isn't discarded; it's
  just not what this view shows. Out of scope: a calendar/archive view of
  past days.)

Response: `{ entries: [{ name, score, date }, ...] }`

## D1 schema

```sql
CREATE TABLE leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('challenge', 'daily')),
  score INTEGER NOT NULL,
  date TEXT NOT NULL,        -- UTC yyyy-mm-dd, the day the score was earned
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leaderboard_mode_score ON leaderboard (mode, score DESC);
CREATE INDEX idx_leaderboard_mode_date ON leaderboard (mode, date, score DESC);
```

## Client changes (`js/main.js`, `js/state.js`)

- `startQuiz()` / `startDaily()`, for `challenge`/`daily` only: attempt
  `POST /api/session/start` first.
  - **On success:** session runs in "remote" mode — `S.remote = true`,
    `S.sessionId` stored. Questions come from the response (no local
    `createQuiz` pool for this run).
  - **On failure/offline (fetch throws, or the app is offline per the
    existing service-worker/offline handling):** fall back to exactly
    today's fully-local `createQuiz` flow. `S.remote = false`. This is not
    a degraded experience — it's the *current* app, unchanged. The only
    difference: a locally-scored run is never eligible for the global
    board.
- `answer()` / `answerTyped()`: when `S.remote`, become async — call
  `POST /api/session/answer`, use the response's `correct`/`funFact`/
  `learnMore`/`xpGained` to drive the exact same `renderFeedback()` UI as
  today. The player's own profile progression (XP, level, streaks,
  achievements, SRS) is still updated locally via the existing
  `recordAnswer(q, correct, opts)` — using the server-confirmed `correct`
  boolean instead of a locally-computed one. That keeps all
  profile/achievement logic exactly as it is today; only the
  leaderboard-eligible *score number* is server-authoritative.
  - If a mid-quiz `session/answer` call fails (connection drops), fall
    back for the *rest of that run*: grade remaining questions locally
    (matching today's logic) and don't call `session/finish` — the
    already-graded prefix simply doesn't get submitted anywhere; the
    player still finishes their quiz normally and it's saved to their
    local personal-best list as it is today.
- `finishQuiz()`: if the run was remote and fully server-graded, call
  `POST /api/session/finish` with the player's `profile.name` in the
  background (fire-and-forget relative to showing results — the client
  already knows its own final score from the running local computation,
  which is guaranteed to match the server's by construction, so there's no
  need to block the results screen on this call). On success, show a
  small "🌍 Synced — you're #N globally" note; on failure, no error
  shown, it just doesn't appear on the global board this time.
  `addLeaderboard(score, mode)` (existing local personal-best list) is
  called exactly as it is today, in **all** cases — remote or local-fallback.

## Behavior changes (flagged explicitly, not silent)

1. **Challenge Mode's question selection stops using your personal
   SRS/missed-item weighting** when played as a verified (online) session
   — it becomes uniform-random, same distribution for every player. This
   is arguably more correct for a competitive leaderboard (nobody gets an
   easier or harder set based on their own history), and only applies to
   Challenge; every practice/review mode is untouched.
2. **Daily Challenge's "day" is now the server's UTC date**, not the
   device's local date. This closes a pre-existing clock-spoofing replay
   gap and means the global Daily board is genuinely one-set-per-day for
   everyone. (The player's local streak/`dailyDoneToday()` logic, which
   uses local date for *when the button greys out on your device*, is
   unaffected — this only changes which question set is authoritative.)

## Abuse handling (kept intentionally light)

- Each session is single-use: `session/finish` deletes it from KV; a
  second call returns `410`.
- Each question within a session can only be graded once (`409` on
  repeat) — no retry-until-correct.
- Name is capped/sanitized server-side (trim, 20-char cap, control
  characters stripped, empty → "Explorer") — never trusts the client's own
  validation.
- A simple fixed-window rate limit on `session/start`: a KV counter keyed
  by `ratelimit:<ip>:<10-minute bucket>`, capped around 20 starts per
  window, `429` past that. This stops trivial spam-scripting of the
  leaderboard without building a full abuse-detection system — explicitly
  not trying to stop a determined, sophisticated attacker, which is out of
  scope for a small educational trivia site.

## Leaderboard screen (`showLeaderboard()`)

Two sections, stacked:
1. **🌍 Global** — top 20 for the selected mode, fetched from
   `GET /api/leaderboard`. A small Challenge/Daily toggle (reusing the
   existing `.tab`/`wireTabs()` pattern already used elsewhere in the app,
   e.g. Crises & Events). Loading/offline states: a plain "Couldn't reach
   the global leaderboard — check your connection" message, non-fatal.
2. **📱 Your personal bests** — the existing local `profile.leaderboard`
   list, unchanged, renamed from "Local leaderboard" for clarity now that
   there's a global one too.

## Testing

- **Pure grading logic** (the per-question correctness/multiplier/XP
  recompute, and the Challenge/Daily pool generation given a seed) is
  extracted into a small server-side module that is itself framework-free
  and testable with plain `node --test`, following the exact pattern of
  `tests/quiz.test.mjs` — this is new test coverage, not a gap, since it's
  the piece carrying the actual security property.
- **API endpoints**: manual verification against a local
  `wrangler pages dev` instance (Cloudflare's local emulator, which
  supports local D1/KV bindings) — start a session, answer all questions
  correctly and incorrectly, confirm scores match what the equivalent
  local play would have produced, confirm a tampered `questionId`/replayed
  `finish` is rejected.
- **Existing 56 `node --test` cases**: must keep passing unmodified — this
  feature doesn't change `quiz.js`, `srs.js`, or `maps.js` behavior for any
  non-Challenge/Daily mode.
- **Manual browser verification** (matching this session's established
  pattern for `main.js`, which has no unit coverage): full Challenge Mode
  run online, full Daily run online, a run with the network killed
  mid-quiz (confirms graceful local fallback), and the Leaderboard
  screen's Global tab against real submitted data.

## Out of scope

- Accounts/login/auth of any kind.
- Timing-based anti-cheat (already established scoring has no timing
  input, so there's nothing to protect there).
- Profanity/moderation filtering on names beyond length/character
  sanitization.
- A historical/archive view of past daily leaderboards.
- Per-continent/per-difficulty leaderboard breakdowns.
- Any change to map-mode quizzes, practice modes, or review sessions —
  none of them touch the leaderboard today and none will after this change.
