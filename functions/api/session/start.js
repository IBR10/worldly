import { createQuiz, ALL_MODES, seededRng, dateSeed } from '../../../js/quiz.js';
import countries from '../../../data/countries.json';
import usStates from '../../../data/us_states.json';
import mxStates from '../../../data/mexico_states.json';
import caStates from '../../../data/canada_provinces.json';
import historicFlags from '../../../data/historic_flags.json';
import similarFlags from '../../../data/similar_flags.json';
import religions from '../../../data/religions.json';

const DATA = { countries, usStates, mxStates, caStates, historicFlags, similarFlags, religions };

const RATE_LIMIT_WINDOW_SECONDS = 600;
const RATE_LIMIT_MAX = 20;
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
  const mode = body?.mode;
  if (mode !== 'challenge' && mode !== 'daily') return json({ error: 'invalid_mode' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const rlKey = `ratelimit:${ip}:${bucket}`;
  const countStr = await env.SESSIONS_KV.get(rlKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return json({ error: 'rate_limited' }, 429);
  await env.SESSIONS_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });

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
  const stored = {
    mode,
    date,
    questions: full.map((q) => ({ id: q.id, answer: q.answer, funFact: q.funFact, history: q.history, symbolImg: q.symbolImg, learnMore: q.learnMore })),
    answered: {},
    runStreak: 0,
    runningScore: 0,
  };
  await env.SESSIONS_KV.put(`session:${sessionId}`, JSON.stringify(stored), { expirationTtl: SESSION_TTL_SECONDS });

  const safeQuestions = full.map((q) => ({
    id: q.id, category: q.category, region: q.region, prompt: q.prompt,
    choices: q.choices, flagIso: q.flagIso, flagImg: q.flagImg,
  }));
  return json({ sessionId, questions: safeQuestions });
}
