function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'challenge' && mode !== 'daily' && mode !== 'xp') return json({ error: 'invalid_mode' }, 400);

  // 'xp' isn't a session mode — it's each player's self-reported lifetime XP
  // total (from the /api/xp sync, covering every quiz mode, not just
  // Challenge/Daily). Unlike the other two tabs this isn't server-graded, so
  // it's not tamper-proof, just rate-limited.
  const query = mode === 'xp'
    ? env.DB.prepare('SELECT name, xp as score FROM xp_leaderboard ORDER BY xp DESC LIMIT 20')
    : mode === 'daily'
      ? env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? AND date = ? ORDER BY score DESC LIMIT 20')
          .bind('daily', new Date().toISOString().slice(0, 10))
      : env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? ORDER BY score DESC LIMIT 20')
          .bind('challenge');

  const { results } = await query.all();
  return json({ entries: results });
}
