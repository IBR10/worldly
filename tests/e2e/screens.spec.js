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
    // Wait for the destination's own heading rather than a fixed 400ms. Screens
    // that fetch a dataset on open (the Pokédex pulls a 457 KB dex, the culture
    // screens a 1.2 MB map) can miss a fixed deadline on a busy machine, and the
    // failure then reads as "screen has no headings at all" — which is a lie
    // about the markup, not a finding about it. The h1 belongs to the new
    // screen: main.js replaces the whole #app subtree per route.
    await page.waitForSelector('#app h1', { timeout: 15000 });
    await page.waitForTimeout(150);
  }
}

const SCREENS = [
  { label: 'home', tab: null, card: null },
  { label: 'flag key', tab: /Explore/, card: /Flag Key/ },
  { label: 'phrases', tab: /Explore/, card: /Phrases/ },
  { label: 'language map', tab: /Explore/, card: /Language Map/ },
  { label: 'say hello', tab: /Explore/, card: /Say Hello/ },
  { label: 'country guides', tab: /Explore/, card: /Country Guides/ },
  { label: 'music', tab: /Explore/, card: /Music/ },
  { label: 'crises', tab: /Explore/, card: /Crises & Events/ },
  { label: 'statistics', tab: /Explore/, card: /Statistics/ },
  { label: 'achievements', tab: /Explore/, card: /Achievements/ },
  { label: 'profile', tab: /Explore/, card: /Profile/ },
  { label: 'about', tab: /Explore/, card: /About Credits/ },
  { label: 'custom study', tab: /Explore/, card: /Custom Study/ },
  { label: 'pokédex', tab: /Explore/, card: /Pokédex/ },
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
