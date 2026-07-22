import { json, readJson, withinRateLimit, sanitizeName, methodNotAllowed } from './_shared.js';

const MAX_XP = 100_000_000; // generous ceiling, just to reject garbage/overflow submissions

/**
 * Self-reported lifetime XP sync.
 *
 * Unlike the Challenge/Daily leaderboard, Practice/Custom Study/Review XP never
 * touches the server (there is no account system to grade it against), so this
 * total cannot be verified -- a player could submit any number. It is rate
 * limited per IP to keep spam cheap to ignore.
 *
 * Rows are keyed on a per-player id generated on the device, not the display
 * name. Keying on the name meant every player who never opened Profile shared
 * the default 'Explorer' row, so the leaderboard's top entry was a merge of an
 * unbounded number of anonymous players -- the feature was meaningless before
 * anyone thought to attack it. XP still only moves upward for a given player so
 * a stale device re-syncing cannot erase progress, but that no longer pins a
 * *name* permanently, because names are now just a mutable label.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed();

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const xp = Math.round(Number(body.xp));
  if (!Number.isFinite(xp) || xp < 0 || xp > MAX_XP) return json({ error: 'invalid_xp' }, 400);

  const playerId = String(body.playerId ?? '').trim();
  // UUIDs only: keeps the key space opaque and stops a client claiming a
  // guessable identity such as "1" or another player's name.
  if (!/^[0-9a-f-]{36}$/i.test(playerId)) return json({ error: 'invalid_player' }, 400);

  const name = sanitizeName(body.name);

  if (!(await withinRateLimit(env, 'xp', request))) return json({ error: 'rate_limited' }, 429);

  await env.DB.prepare(`
    INSERT INTO xp_leaderboard (player_id, name, xp, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(player_id) DO UPDATE SET
      name = excluded.name,
      xp = MAX(xp_leaderboard.xp, excluded.xp),
      updated_at = CASE WHEN excluded.xp > xp_leaderboard.xp THEN excluded.updated_at ELSE xp_leaderboard.updated_at END
  `).bind(playerId, name, xp).run();

  return json({ ok: true });
}
