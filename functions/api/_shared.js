// Shared helpers for the Pages Functions.
//
// Files under functions/ whose name starts with `_` are not routed, so this is
// a module rather than an endpoint.

export const SESSION_TTL_SECONDS = 3600;
export const RATE_LIMIT_WINDOW_SECONDS = 600;
export const RATE_LIMIT_MAX = 20;

export const nowSec = () => Math.floor(Date.now() / 1000);

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** JSON body, or null when the request carries something else. */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Display names are rendered publicly; strip control characters and cap length. */
export function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 20);
  return cleaned || 'Explorer';
}

/**
 * Fixed-window per-IP rate limit.
 *
 * A single INSERT .. ON CONFLICT DO UPDATE .. RETURNING, so the read and the
 * increment are one atomic statement. The previous implementation read a KV
 * key and then wrote count+1, which meant N concurrent requests all read the
 * same value and all passed -- the limit only held against strictly serial
 * traffic, and KV's eventual consistency made even that unreliable.
 *
 * @returns {Promise<boolean>} true when the request is within budget.
 */
export async function withinRateLimit(env, scope, request, max = RATE_LIMIT_MAX) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(nowSec() / window);
  const key = `${scope}:${ip}:${bucket}`;

  const row = await env.DB.prepare(
    `INSERT INTO rate_limit (bucket_key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, (bucket + 1) * window)
    .first();

  // D1 has no TTL and Pages has no Cron Triggers, so expired rows are swept
  // opportunistically. The predicate is indexed and usually matches nothing,
  // so this costs no row writes; sampling keeps it off the hot path.
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM rate_limit WHERE expires_at < ?').bind(nowSec()).run();
  }

  return (row?.count ?? 1) <= max;
}

/** Load a live session, or null when it is missing or expired. */
export async function readSession(env, id) {
  const row = await env.DB.prepare('SELECT * FROM session WHERE id = ? AND expires_at > ?')
    .bind(id, nowSec())
    .first();
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    date: row.date,
    questions: JSON.parse(row.questions),
    answered: JSON.parse(row.answered),
    runStreak: row.run_streak,
    runningScore: row.running_score,
  };
}

export async function createSession(env, session) {
  await env.DB.prepare(
    `INSERT INTO session (id, mode, date, questions, answered, run_streak, running_score, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      session.id,
      session.mode,
      session.date,
      JSON.stringify(session.questions),
      JSON.stringify(session.answered),
      session.runStreak,
      session.runningScore,
      nowSec() + SESSION_TTL_SECONDS,
    )
    .run();
}

export async function updateSessionProgress(env, session) {
  await env.DB.prepare(
    'UPDATE session SET answered = ?, run_streak = ?, running_score = ? WHERE id = ?',
  )
    .bind(JSON.stringify(session.answered), session.runStreak, session.runningScore, session.id)
    .run();
}

export async function deleteSession(env, id) {
  await env.DB.prepare('DELETE FROM session WHERE id = ?').bind(id).run();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM session WHERE expires_at < ?').bind(nowSec()).run();
  }
}

/**
 * Reject non-POST verbs with JSON instead of falling through to the SPA's
 * 404.html, which previously answered `GET /api/session/start` with an HTML
 * page and a 404 status.
 */
export function methodNotAllowed(allow = 'POST') {
  return json({ error: 'method_not_allowed' }, 405, { Allow: allow });
}
