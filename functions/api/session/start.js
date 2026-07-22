import { createQuiz, ALL_MODES, seededRng, dateSeed } from '../../../js/quiz.js';
import countries from '../../../data/countries.json';
import usStates from '../../../data/us_states.json';
import mxStates from '../../../data/mexico_states.json';
import caStates from '../../../data/canada_provinces.json';
import historicFlags from '../../../data/historic_flags.json';
import similarFlags from '../../../data/similar_flags.json';
import religions from '../../../data/religions.json';
import { json, readJson, withinRateLimit, createSession, methodNotAllowed } from '../_shared.js';

const DATA = { countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions };

// Single catch-all handler: Pages treats an exported `onRequest` as covering
// every method, so method dispatch happens here rather than by also exporting
// onRequestPost (which `onRequest` would shadow).
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed();

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const mode = body.mode;
  if (mode !== 'challenge' && mode !== 'daily') return json({ error: 'invalid_mode' }, 400);

  if (!(await withinRateLimit(env, 'session', request))) return json({ error: 'rate_limited' }, 429);

  const total = mode === 'daily' ? 10 : 15;
  let date = null;
  let rng;
  if (mode === 'daily') {
    date = new Date().toISOString().slice(0, 10);
    rng = seededRng(dateSeed(date));
  } else {
    rng = seededRng(crypto.getRandomValues(new Uint32Array(1))[0]);
  }

  const config = { modes: ALL_MODES, continents: 'all', difficulty: 'medium', choices: 4, rng };
  const engine = createQuiz({ data: DATA, config, rng });
  if (engine.size === 0) return json({ error: 'empty_pool' }, 500);

  const full = [];
  for (let i = 0; i < total && full.length < engine.size; i++) {
    const q = engine.next();
    if (!q) break;
    full.push(q);
  }

  const sessionId = crypto.randomUUID();
  await createSession(env, {
    id: sessionId,
    mode,
    date,
    // Answers and reveal copy stay server-side until the client has answered.
    questions: full.map((q) => ({
      id: q.id, answer: q.answer, funFact: q.funFact, history: q.history,
      symbolImg: q.symbolImg, learnMore: q.learnMore,
    })),
    answered: {},
    runStreak: 0,
    runningScore: 0,
  });

  const safeQuestions = full.map((q) => ({
    id: q.id, category: q.category, region: q.region, prompt: q.prompt,
    choices: q.choices, flagIso: q.flagIso, flagImg: q.flagImg,
  }));
  return json({ sessionId, questions: safeQuestions });
}
