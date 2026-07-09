function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function sanitizeName(raw) {
  const cleaned = String(raw ?? '').replace(/[ -]/g, '').trim().slice(0, 20);
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
