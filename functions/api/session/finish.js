import { json, readJson, readSession, deleteSession, sanitizeName, methodNotAllowed } from '../_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed();

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const { sessionId } = body;
  if (!sessionId) return json({ error: 'invalid_body' }, 400);

  const session = await readSession(env, sessionId);
  if (!session) return json({ error: 'session_not_found' }, 410);

  const allAnswered = session.questions.every((q) => session.answered[q.id]);
  if (!allAnswered) return json({ error: 'incomplete' }, 409);

  const name = sanitizeName(body.name);
  const date = session.date || new Date().toISOString().slice(0, 10);

  await env.DB.prepare('INSERT INTO leaderboard (name, mode, score, date) VALUES (?, ?, ?, ?)')
    .bind(name, session.mode, session.runningScore, date)
    .run();
  await deleteSession(env, sessionId);

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
