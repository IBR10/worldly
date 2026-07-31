import { test, expect } from '@playwright/test';

// The all-time Level/XP tab is fed by /api/xp, which is a *self-reported* sync
// from the device (see functions/api/xp.js). Lifetime XP is earned in every
// mode — Practice, Custom Study, Review — but for a long time the sync only
// fired at the end of a quiz, so a player who had accumulated XP and then
// opened the leaderboard never appeared on it. The board read "No scores yet"
// to someone sitting on thousands of XP, which is what made the tab look
// broken.
//
// These run on the static harness (scripts/spa-serve.py), where /api/* does not
// exist, so both endpoints are stubbed with page.route().

/** Seed a profile with lifetime XP as if the player had been playing for weeks. */
async function seedProfile(page, { xp, name = 'Cartographer' }) {
  await page.addInitScript(
    ([xpValue, playerName]) => {
      localStorage.setItem(
        'worldly_profile_v1',
        JSON.stringify({
          name: playerName,
          playerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
          xp: xpValue,
          srs: {},
          onboarded: true,
        }),
      );
    },
    [xp, name],
  );
}

test('opening the leaderboard syncs lifetime XP without playing a quiz', async ({ page }) => {
  const syncs = [];
  await page.route('**/api/xp', async (route) => {
    syncs.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/leaderboard**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"entries":[]}' }),
  );

  await seedProfile(page, { xp: 4200 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.waitForSelector('.tab-panel.active');

  await expect.poll(() => syncs.length, { timeout: 10000 }).toBe(1);
  expect(syncs[0]).toMatchObject({ xp: 4200, name: 'Cartographer' });
  expect(syncs[0].playerId).toMatch(/^[0-9a-f-]{36}$/i);
});

test('a player with no XP is not synced', async ({ page }) => {
  // Nothing to report, and every skipped call is one fewer D1 write against
  // the free tier's budget.
  const syncs = [];
  await page.route('**/api/xp', async (route) => {
    syncs.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/leaderboard**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"entries":[]}' }),
  );

  await seedProfile(page, { xp: 0 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.waitForSelector('.tab-panel.active');
  await page.waitForTimeout(1500);

  expect(syncs).toEqual([]);
});

test('re-opening the leaderboard does not re-sync an unchanged total', async ({ page }) => {
  const syncs = [];
  await page.route('**/api/xp', async (route) => {
    syncs.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/leaderboard**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"entries":[]}' }),
  );

  await seedProfile(page, { xp: 4200 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.waitForSelector('.tab-panel.active');
  await expect.poll(() => syncs.length, { timeout: 10000 }).toBe(1);

  await page.locator('#backHome').click();
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.waitForSelector('.tab-panel.active');
  await page.waitForTimeout(1500);

  expect(syncs.length).toBe(1);
});

test('the player appears on the XP tab on the same visit as the sync', async ({ page }) => {
  // The board only gains the row once /api/xp has landed, so the first read can
  // legitimately come back empty; the tab must not be left showing "No scores
  // yet" to the player who just synced.
  let synced = false;
  await page.route('**/api/xp', async (route) => {
    synced = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/leaderboard**', (route) => {
    const mode = new URL(route.request().url()).searchParams.get('mode');
    const entries = mode === 'xp' && synced ? [{ name: 'Cartographer', score: 4200 }] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
  });

  await seedProfile(page, { xp: 4200 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.getByRole('tab', { name: /Level\/XP/ }).click();

  await expect(page.locator('#globalList-xp')).toContainText('Cartographer', { timeout: 10000 });
  await expect(page.locator('#globalList-xp')).toContainText('4200 XP');
});

test('the XP tab renders level and XP for each entry', async ({ page }) => {
  await page.route('**/api/xp', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/leaderboard**', (route) => {
    const mode = new URL(route.request().url()).searchParams.get('mode');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: mode === 'xp' ? [{ name: 'Ada', score: 900 }, { name: 'Grace', score: 500 }] : [],
      }),
    });
  });

  await seedProfile(page, { xp: 4200 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.getByRole('tab', { name: /Level\/XP/ }).click();

  const panel = page.locator('#globalList-xp');
  await expect(panel).toContainText('Ada');
  await expect(panel).toContainText('900 XP');
  await expect(panel).toContainText(/Lvl \d+/);
});
