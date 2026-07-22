import { test, expect } from '@playwright/test';
import {
  findDuplicateAttributes,
  findInlineHandlers,
  installHtmlCapture,
  headingProbe,
  headingProblem,
} from './helpers/html-audit.js';

// Structural audit of every screen. These assertions exist because the defects
// they cover are invisible to ESLint (all markup lives in JS template literals)
// and invisible to the DOM (the parser silently drops duplicate attributes).

/** Open a screen from the home tabs and return the raw HTML rendered for it. */
async function gotoScreen(page, tab, cardName) {
  await page.goto('/');
  await page.waitForSelector('.card');
  if (tab) await page.getByRole('tab', { name: tab }).click();
  if (cardName) {
    await page.getByRole('button', { name: cardName }).click();
    await page.waitForTimeout(400);
  }
}

const SCREENS = [
  { label: 'home', tab: null, card: null },
  { label: 'flag key', tab: /Explore/, card: /Flag Key/ },
  { label: 'phrases', tab: /Explore/, card: /🗣️\s*Phrases/ },
  { label: 'music', tab: /Explore/, card: /🎵\s*Music/ },
  { label: 'crises', tab: /Explore/, card: /Crises & Events/ },
  { label: 'statistics', tab: /Explore/, card: /Statistics/ },
  { label: 'achievements', tab: /Explore/, card: /🏆\s*Achievements/ },
  { label: 'profile', tab: /Explore/, card: /🧭\s*Profile/ },
  { label: 'about', tab: /Explore/, card: /ℹ️\s*About/ },
  { label: 'custom study', tab: /Explore/, card: /Custom Study/ },
];

test.describe('rendered markup is structurally sound', () => {
  for (const { label, tab, card } of SCREENS) {
    test(`${label}: no duplicate attributes, no inline handlers`, async ({ page }) => {
      await page.addInitScript(installHtmlCapture());
      await gotoScreen(page, tab, card);

      const rendered = await page.evaluate(() => window.__rawHtml || []);
      expect(rendered.length).toBeGreaterThan(0);

      const dupes = rendered.flatMap((html) => findDuplicateAttributes(html));
      expect(dupes, `duplicate attributes on ${label}: ${JSON.stringify(dupes)}`).toEqual([]);

      // Under this app's CSP (script-src 'self', no unsafe-inline) an inline
      // handler never executes -- it is dead code that reads like working
      // error handling.
      const handlers = rendered.flatMap((html) => findInlineHandlers(html));
      expect(handlers, `inline handlers on ${label}: ${JSON.stringify(handlers)}`).toEqual([]);
    });
  }

  for (const { label, tab, card } of SCREENS) {
    test(`${label}: heading structure`, async ({ page }) => {
      await gotoScreen(page, tab, card);
      const headings = await page.evaluate(headingProbe);
      expect(headingProblem(headings), `${label} headings: ${JSON.stringify(headings)}`).toBeNull();
    });
  }
});

test('quiz screen has a heading', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Mixed Quiz/ }).click();
  await page.waitForSelector('.choice');

  const headings = await page.evaluate(headingProbe);
  expect(headingProblem(headings), `quiz headings: ${JSON.stringify(headings)}`).toBeNull();
});

test('quiz feedback keeps heading order', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Mixed Quiz/ }).click();
  await page.waitForSelector('.choice');
  await page.locator('.choice').first().click();
  await page.waitForSelector('#nextBtn');

  const headings = await page.evaluate(headingProbe);
  expect(headingProblem(headings), `feedback headings: ${JSON.stringify(headings)}`).toBeNull();
});
