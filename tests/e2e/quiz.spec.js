import { test, expect } from '@playwright/test';

// The quiz session is the most-used code path in the app and has no unit
// coverage -- main.js is untested in tests/*.test.mjs, which cover the pure
// engines only.

async function startMixedQuiz(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Mixed Quiz/ }).click();
  await page.waitForSelector('.choice');
}

const progressPct = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.progress > span');
    return el ? Math.round(parseFloat(el.style.width) || 0) : null;
  });

test('answering shows feedback with the correct answer and a way forward', async ({ page }) => {
  await startMixedQuiz(page);
  await expect(page.locator('.q-prompt')).toBeVisible();
  await expect(page.locator('.choice')).toHaveCount(4);

  await page.locator('.choice').first().click();

  await expect(page.locator('#feedback')).toBeVisible();
  await expect(page.locator('#nextBtn')).toBeVisible();
  // Exactly one option is marked correct, whatever the player picked.
  await expect(page.locator('.choice.correct')).toHaveCount(1);
  // Every choice is locked once answered.
  const enabled = await page.locator('.choice:not([disabled])').count();
  expect(enabled).toBe(0);
});

test('progress advances as questions are answered', async ({ page }) => {
  await startMixedQuiz(page);

  const total = Number((await page.locator('.pill').first().innerText()).split('/')[1]);
  expect(total).toBeGreaterThan(1);

  // Before answering anything, no progress has been made.
  expect(await progressPct(page)).toBe(0);

  await page.locator('.choice').first().click();
  await page.waitForSelector('#nextBtn');

  // Regression guard: the bar used to be computed only when a *question*
  // rendered, so it still read 0% on the feedback screen and could never
  // reach 100%.
  const afterFirst = await progressPct(page);
  expect(afterFirst, 'progress should reflect the answered question').toBeGreaterThan(0);
  expect(afterFirst).toBeCloseTo(Math.round((1 / total) * 100), 0);

  await page.locator('#nextBtn').click();
  await page.waitForSelector('.choice:not([disabled])');
  expect(await progressPct(page)).toBe(afterFirst);
});

test('a full run reaches the results screen', async ({ page }) => {
  await startMixedQuiz(page);
  const total = Number((await page.locator('.pill').first().innerText()).split('/')[1]);

  for (let i = 0; i < total; i++) {
    await page.locator('.choice').first().click();
    await page.waitForSelector('#nextBtn');
    await page.locator('#nextBtn').click();
    await page.waitForTimeout(120);
  }

  await expect(page.locator('.result-hero .score')).toBeVisible();
  await expect(page.locator('.result-hero .score')).toContainText(`/${total}`);
  await expect(page.getByRole('button', { name: /Play again/ })).toBeVisible();
});

test('keyboard shortcuts answer and advance', async ({ page }) => {
  await startMixedQuiz(page);
  await page.keyboard.press('1');
  await expect(page.locator('#feedback')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.choice:not([disabled])').first()).toBeVisible();
});

test('quitting mid-quiz returns home', async ({ page }) => {
  await startMixedQuiz(page);
  await page.locator('#quitBtn').click();
  await expect(page.locator('h1.screen-title')).toContainText('Explore the world');
});
