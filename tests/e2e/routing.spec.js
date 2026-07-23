import { test, expect } from '@playwright/test';

// The audit's headline UX defect: "Back button exits the site; nothing is
// shareable." These specs are the regression net for the fix — every one of
// them fails against the pre-routing build.
//
// The test server (scripts/spa-serve.py) mirrors Cloudflare Pages: deep links
// and reloads serve the app shell, so goto('/leaderboard') exercises the real
// server→router path, not just in-app navigation.

test('clicking a card changes the URL, and Back returns to Home', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('tab', { name: /Explore/ }).click();
  await page.getByRole('button', { name: /Flag Key/ }).click();
  await page.waitForSelector('.flagkey-card');
  await expect(page).toHaveURL(/\/flags$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/); // back at root
  await expect(page.locator('h1')).toContainText('Explore the world');
});

test('the header Leaderboard button routes, and Back does not leave the site', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('button', { name: 'Leaderboard' }).click();
  await expect(page).toHaveURL(/\/leaderboard$/);
  await expect(page.locator('.screen-title')).toContainText('Leaderboard');

  await page.goBack();
  await expect(page.locator('h1')).toContainText('Explore the world');
});

test('a deep link to /leaderboard renders that screen and sets the title', async ({ page }) => {
  await page.goto('/leaderboard');
  await expect(page.locator('.screen-title')).toContainText('Leaderboard');
  await expect(page).toHaveTitle(/Leaderboard/);
});

test('a deep link to /quiz/mixed starts a quiz', async ({ page }) => {
  await page.goto('/quiz/mixed');
  await expect(page.locator('.q-prompt')).toBeVisible();
  await expect(page).toHaveURL(/\/quiz\/mixed$/);
});

test('an unknown route renders the 404 screen and is tagged noindex', async ({ page }) => {
  await page.goto('/definitely-not-a-real-route');
  await expect(page.locator('.center-block')).toContainText('404');
  await expect(page.locator('meta[data-router-robots]')).toHaveAttribute('content', 'noindex');
  await expect(page).toHaveTitle(/Page not found/);
});

test('leaving the 404 clears the noindex tag', async ({ page }) => {
  await page.goto('/definitely-not-a-real-route');
  await expect(page.locator('meta[data-router-robots]')).toHaveCount(1);
  await page.getByRole('link', { name: /Back to Worldly/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('meta[data-router-robots]')).toHaveCount(0);
});

test('a content detail is deep-linkable and survives a reload', async ({ page }) => {
  await page.goto('/crises');
  await page.waitForSelector('[data-crisis]');
  await page.locator('[data-crisis]').first().click();
  await expect(page).toHaveURL(/\/crises\/.+/);
  const deepUrl = page.url();

  // Reload hits the server at the deep URL → shell → router → detail again.
  await page.reload();
  await expect(page).toHaveURL(deepUrl);
  await expect(page.locator('.crisis-body')).toBeVisible();

  // And Back from the detail returns to the list, not off-site.
  await page.goBack();
  await expect(page).toHaveURL(/\/crises$/);
  await expect(page.locator('[data-crisis]').first()).toBeVisible();
});

test('Forward re-enters a screen after Back', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('button', { name: 'About and help' }).click();
  await expect(page).toHaveURL(/\/about$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
});
