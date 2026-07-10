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
    history: q.history,
    learnMore: q.learnMore,
    xpGained,
    runningScore: session.runningScore,
    runningStreak: session.runStreak,
  });
}
