import { test, expect } from '@playwright/test';

// The Pokédex is a sandbox bolted onto a learning app, and the defects worth
// guarding are the ones that would either break the app it lives in or quietly
// corrupt the player's real progress:
//
//  - the nine generation buttons must not be .tab, or wireTabs() claims them and
//    the Dex/Practice/Progress group breaks;
//  - the grid must page, because loading="lazy" defers nothing at sprite density
//    (measured: a full generation issued all 151 image requests on open);
//  - Pokémon progress must never touch worldly_profile_v1. That is the whole
//    premise of the feature being separate.

const DEX_KEY = 'worldly_pokedex_v1';
const PROFILE_KEY = 'worldly_profile_v1';

/** Open the Pokédex the way a player would: Explore tab → the card. */
async function openPokedex(page) {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('tab', { name: /Explore/ }).click();
  await page.getByRole('button', { name: /⚡\s*Pokédex/ }).click();
  await page.waitForSelector('.dex-card');
}

test('is reachable from the Explore tab and lists the full dex', async ({ page }) => {
  await openPokedex(page);
  await expect(page.locator('h1.screen-title')).toContainText('Pokédex');
  await expect(page.locator('.screen-sub').first()).toContainText('1025');
  expect(page.url()).toContain('/pokedex');
});

test('the grid pages instead of requesting every sprite at once', async ({ page }) => {
  let images = 0;
  page.on('request', (r) => { if (r.resourceType() === 'image') images++; });
  await openPokedex(page);
  await page.waitForTimeout(600);

  // The Flag Key screen is held to the same kind of budget for the same reason.
  expect(images, `${images} image requests on open`).toBeLessThan(110);
  await expect(page.locator('.dex-card')).toHaveCount(60);
  await expect(page.locator('#dexMore')).toBeVisible();

  await page.locator('#dexMore').click();
  await expect(page.locator('.dex-card')).toHaveCount(120);
});

test('generation buttons switch the grid without breaking the main tabs', async ({ page }) => {
  await openPokedex(page);
  await page.getByRole('tab', { name: /Gen 2/ }).click();
  await page.waitForTimeout(300);

  // If the gen buttons carried .tab, wireTabs() would drive them from a missing
  // data-tab and hide the panel they live in.
  await expect(page.locator('.tab-panel[data-panel="dex"]')).toBeVisible();
  await expect(page.locator('.dex-card').first()).toBeVisible();
});

test('search spans every generation, not just the open one', async ({ page }) => {
  await openPokedex(page);
  await page.locator('#dexReveal').check();
  await page.locator('#dexSearch').fill('char');
  await page.waitForTimeout(300);

  const names = await page.locator('.dex-card .dex-name').allInnerTexts();
  expect(names).toContain('Charizard');   // gen 1
  expect(names).toContain('Charcadet');   // gen 9
  await expect(page.locator('#genTabs')).toBeHidden();
});

test('unregistered species stay hidden until the reveal toggle', async ({ page }) => {
  await openPokedex(page);
  await expect(page.locator('.dex-card.unseen').first()).toBeVisible();
  await expect(page.locator('.dex-card .dex-name').first()).toHaveText('???');

  await page.locator('#dexReveal').check();
  await page.waitForTimeout(300);
  await expect(page.locator('.dex-card .dex-name').first()).not.toHaveText('???');
});

test('a species page deep-links and shows its stats and evolution', async ({ page }) => {
  await page.goto('/pokedex/pikachu');
  await page.waitForSelector('.dex-detail');

  await expect(page.locator('h1.screen-title')).toContainText('Pikachu');
  await expect(page).toHaveTitle(/Pikachu/);
  await expect(page.locator('.bar-row')).toHaveCount(6);
  await expect(page.locator('.dex-detail')).toBeVisible();
  await expect(page.locator('body')).toContainText('Raichu');

  // Widths come from data-w via CSSOM; an inline style= would be dead under CSP.
  const width = await page.locator('.bar-track > span').first().evaluate((el) => el.style.width);
  expect(width).toMatch(/^\d+%$/);
});

test('an unknown species falls through to the 404 screen', async ({ page }) => {
  await page.goto('/pokedex/not-a-pokemon');
  await page.waitForTimeout(600);
  await expect(page.locator('body')).not.toContainText('Base stats');
});

test('practice registers a species and leaves the Worldly profile alone', async ({ page }) => {
  await page.goto('/pokedex/quiz/poke_who');
  await page.waitForSelector('.choice');

  await expect(page.locator('.dex-quiz-sprite.silhouette')).toBeVisible();
  await expect(page.locator('.choice')).toHaveCount(4);

  await page.locator('.choice').first().click();
  await page.waitForSelector('#pokeNext');
  await expect(page.locator('.choice.correct')).toHaveCount(1);

  const dex = await page.evaluate((k) => localStorage.getItem(k), DEX_KEY);
  expect(dex).toBeTruthy();
  expect(JSON.parse(dex).answered).toBe(1);

  // The sandbox guarantee: nothing here may create or touch the real profile.
  const profile = await page.evaluate((k) => localStorage.getItem(k), PROFILE_KEY);
  expect(profile).toBeNull();
});

test('registration earned in practice shows up in the dex and progress tabs', async ({ page }) => {
  // Seed a profile that has already registered Bulbasaur three times over, so
  // the assertion does not depend on answering a random question correctly.
  await page.addInitScript(([key, value]) => {
    localStorage.setItem(key, value);
  }, [DEX_KEY, JSON.stringify({
    v: 1, e: { 1: { c: 3, w: 0, s: 3 } }, answered: 3, correct: 3, streak: 3, bestStreak: 3,
  })]);

  await openPokedex(page);
  await expect(page.locator('.screen-sub').first()).toContainText('1 of 1025');
  await expect(page.locator('.dex-card.mastered')).toHaveCount(1);
  await expect(page.locator('.dex-card').first()).not.toHaveClass(/unseen/);

  await page.getByRole('tab', { name: /Progress/ }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.stat').first()).toContainText('1');
  await expect(page.locator('.bar-row')).toHaveCount(9);   // one per generation
});

test('resetting the Pokédex does not touch Worldly progress', async ({ page }) => {
  await page.addInitScript(([dexKey, dexVal, profKey, profVal]) => {
    localStorage.setItem(dexKey, dexVal);
    localStorage.setItem(profKey, profVal);
  }, [
    DEX_KEY, JSON.stringify({ v: 1, e: { 1: { c: 3, w: 0, s: 3 } }, answered: 3, correct: 3 }),
    PROFILE_KEY, JSON.stringify({ version: 1, xp: 4200, srs: {}, achievements: {}, missed: {} }),
  ]);

  await openPokedex(page);
  await page.getByRole('tab', { name: /Progress/ }).click();
  page.on('dialog', (d) => d.accept());
  await page.locator('#dexReset').click();
  await page.waitForTimeout(400);

  const dex = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), DEX_KEY));
  expect(dex.answered).toBe(0);

  const profile = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), PROFILE_KEY));
  expect(profile.xp).toBe(4200);
});
