import { sessionQuestionXp } from '../../../js/quiz.js';
import { json, readJson, readSession, updateSessionProgress, methodNotAllowed } from '../_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed();

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const { sessionId, questionId, value } = body;
  if (!sessionId || !questionId) return json({ error: 'invalid_body' }, 400);
  if (value != null && typeof value !== 'string') return json({ error: 'invalid_body' }, 400);

  const session = await readSession(env, sessionId);
  if (!session) return json({ error: 'session_not_found' }, 404);

  if (session.answered[questionId]) return json({ error: 'already_answered' }, 409);
  const q = session.questions.find((x) => x.id === questionId);
  if (!q) return json({ error: 'unknown_question' }, 409);

  const correct = value === q.answer;
  const xpGained = sessionQuestionXp(session.runStreak, correct);
  session.runStreak = correct ? session.runStreak + 1 : 0;
  session.runningScore += xpGained;
  session.answered[questionId] = true;

  // One UPDATE per answer. This used to be a KV put on the same key for the
  // whole run, which is capped at 1 write/second -- a player answering two
  // questions inside a second got a 429, and the client turned that into a
  // wrong answer plus a "Connection lost" toast.
  await updateSessionProgress(env, session);

  return json({
    correct,
    correctAnswer: q.answer,
    funFact: q.funFact,
    history: q.history,
    symbolImg: q.symbolImg,
    learnMore: q.learnMore,
    xpGained,
    runningScore: session.runningScore,
    runningStreak: session.runStreak,
  });
}
