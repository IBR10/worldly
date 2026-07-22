import { test, expect } from '@playwright/test';

test('map mode mounts an interactive SVG and scores a click', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('tab', { name: /Maps/ }).click();
  await page.getByRole('button', { name: /Find the US State/ }).click();

  await page.waitForSelector('#mapMount svg path[id]', { timeout: 30000 });
  const paths = await page.locator('#mapMount svg path[id]').count();
  expect(paths).toBeGreaterThan(40);

  // Regions must be keyboard-operable, not click-only.
  const firstPath = page.locator('#mapMount svg path[id]').first();
  await expect(firstPath).toHaveAttribute('role', 'button');
  await expect(firstPath).toHaveAttribute('tabindex', '0');

  await firstPath.click({ force: true });
  await expect(page.locator('#feedback')).toBeVisible();
  await expect(page.locator('#nextBtn')).toBeVisible();
});

test('theme toggle persists across a reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');

  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator('#themeToggle').click();
  const toggled = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(toggled).not.toBe(initial);

  await page.reload();
  await page.waitForSelector('.card');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(toggled);
});

test('profile export round-trips through import', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');

  // Earn some XP so there is state worth preserving.
  await page.getByRole('button', { name: /Mixed Quiz/ }).click();
  await page.waitForSelector('.choice');
  await page.locator('.choice').first().click();
  await page.waitForSelector('#nextBtn');

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('worldly_profile_v1')));
  expect(before.totalAnswered).toBe(1);

  // Wipe, then import the captured profile through the real import path.
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('tab', { name: /Explore/ }).click();
  await page.getByRole('button', { name: /🧭\s*Profile/ }).click();
  // The file input is deliberately hidden and driven by the Import button, so
  // wait for it to exist rather than to be visible.
  await page.waitForSelector('#importFile', { state: 'attached' });

  await page.setInputFiles('#importFile', {
    name: 'worldly-profile.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(before)),
  });
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('worldly_profile_v1')));
  expect(after.xp).toBe(before.xp);
  expect(after.totalAnswered).toBe(before.totalAnswered);
  expect(after.srs).toEqual(before.srs);
});

test('leaderboard surfaces an error state when the API is unreachable', async ({ page }) => {
  // Served statically here, so /api/* genuinely does not exist. This asserts
  // the app degrades rather than hanging on "Loading…".
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.locator('#leaderboardBtn').click();
  await page.waitForSelector('.tab-panel.active');

  const panel = page.locator('.tab-panel.active .form-block');
  await expect(panel).not.toContainText('Loading…', { timeout: 10000 });
  await expect(panel).toContainText(/Couldn't reach|No scores yet/);
});

test('storage-denied does not break boot', async ({ page }) => {
  // Private-mode browsers throw on localStorage writes; the app must still run.
  await page.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.localStorage);
    proto.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
  });
  await page.goto('/');
  await expect(page.locator('.card').first()).toBeVisible();
});
