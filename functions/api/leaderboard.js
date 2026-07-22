import { json, methodNotAllowed } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  // HEAD is GET without a body; rejecting it would break proxies and uptime
  // checks. The runtime strips the body for us.
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'challenge' && mode !== 'daily' && mode !== 'xp') return json({ error: 'invalid_mode' }, 400);

  // 'xp' isn't a session mode — it's each player's self-reported lifetime XP
  // total (from the /api/xp sync, covering every quiz mode, not just
  // Challenge/Daily). Unlike the other two tabs this isn't server-graded, so
  // it's not tamper-proof, just rate-limited. `hidden` allows a moderated row
  // to be withheld without deleting it.
  const query = mode === 'xp'
    ? env.DB.prepare('SELECT name, xp as score FROM xp_leaderboard WHERE hidden = 0 ORDER BY xp DESC LIMIT 20')
    : mode === 'daily'
      ? env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? AND date = ? ORDER BY score DESC LIMIT 20')
          .bind('daily', new Date().toISOString().slice(0, 10))
      : env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? ORDER BY score DESC LIMIT 20')
          .bind('challenge');

  const { results } = await query.all();
  // Read-heavy and changes rarely; a short edge cache keeps repeat views off D1
  // and well inside the free tier's daily row-read budget.
  return json({ entries: results }, 200, { 'Cache-Control': 'public, max-age=60' });
}
