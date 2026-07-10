const RATE_LIMIT_WINDOW_SECONDS = 600;
const RATE_LIMIT_MAX = 20;
const MAX_XP = 100_000_000; // generous ceiling, just to reject garbage/overflow submissions

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function sanitizeName(raw) {
  const cleaned = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 20);
  return cleaned || 'Explorer';
}

/**
 * Self-reported lifetime XP sync. Unlike the Challenge/Daily leaderboard,
 * Practice/Custom Study/Review XP never touches the server (there's no
 * account system to grade it against), so this total can't be verified —
 * a player could submit any number. Rate-limited per IP to keep spam cheap
 * to ignore; ON CONFLICT keeps the higher of the stored and submitted value
 * so an older/stale device re-syncing can't accidentally erase progress.
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const xp = Math.round(Number(body?.xp));
  if (!Number.isFinite(xp) || xp < 0 || xp > MAX_XP) return json({ error: 'invalid_xp' }, 400);
  const name = sanitizeName(body?.name);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const rlKey = `ratelimit:xp:${ip}:${bucket}`;
  const countStr = await env.SESSIONS_KV.get(rlKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return json({ error: 'rate_limited' }, 429);
  await env.SESSIONS_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });

  await env.DB.prepare(`
    INSERT INTO xp_leaderboard (name, xp, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      xp = MAX(xp_leaderboard.xp, excluded.xp),
      updated_at = CASE WHEN excluded.xp > xp_leaderboard.xp THEN excluded.updated_at ELSE xp_leaderboard.updated_at END
  `).bind(name, xp).run();

  return json({ ok: true });
}
