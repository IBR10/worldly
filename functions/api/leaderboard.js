function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'challenge' && mode !== 'daily' && mode !== 'xp') return json({ error: 'invalid_mode' }, 400);

  // 'xp' isn't a session mode — it's every player's Challenge + Daily scores
  // (both server-graded, so this stays as tamper-resistant as the other two
  // tabs) summed into one running total, ranking accumulated play rather than
  // a single best run.
  const query = mode === 'xp'
    ? env.DB.prepare('SELECT name, SUM(score) as score FROM leaderboard GROUP BY name ORDER BY score DESC LIMIT 20')
    : mode === 'daily'
      ? env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? AND date = ? ORDER BY score DESC LIMIT 20')
          .bind('daily', new Date().toISOString().slice(0, 10))
      : env.DB.prepare('SELECT name, score, date FROM leaderboard WHERE mode = ? ORDER BY score DESC LIMIT 20')
          .bind('challenge');

  const { results } = await query.all();
  return json({ entries: results });
}
