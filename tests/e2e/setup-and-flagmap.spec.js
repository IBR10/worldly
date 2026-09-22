import { test, expect } from '@playwright/test';

// Two screens added together because they are the two answers to "I want to
// study a narrower slice of the world": the setup panel narrows what a session
// asks, and the Flag Map is the reference you look things up in.
//
// The defects worth guarding here are the ones that only show up in a browser:
//
//  - `[hidden]` on a flex container does nothing unless the stylesheet restates
//    it, so both the collapsed subregion groups and the hover card have been
//    caught rendering when they were supposed to be gone;
//  - a continent checkbox is a roll-up of its children, and `indeterminate` is
//    a DOM property with no HTML attribute, so only a real DOM can assert it;
//  - the setup has to survive a reload, which means the profile write actually
//    happened rather than just the in-memory object changing.

const PROFILE_KEY = 'worldly_profile_v1';

test('the mixed round can have question types switched off', async ({ page }) => {
  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');

  const before = await page.locator('#setupCount').textContent();
  await page.locator('#modeChecks input[value="population"]').uncheck();
  const after = await page.locator('#setupCount').textContent();
  expect(after, 'the live count reacts to the checklist').not.toBe(before);

  await page.locator('#startMixed').click();
  await page.waitForSelector('.choice');

  // Walk the whole round: not one question may be the type that was turned off.
  // The last question's Next button reads "See results" and is still #nextBtn,
  // so the loop ends on the results screen appearing, not on that button.
  for (let i = 0; i < 12; i++) {
    await expect(page.locator('#app h1').first()).not.toContainText('population');
    await page.locator('.choice').first().click();
    await page.locator('#nextBtn').waitFor({ timeout: 8000 });
    await page.locator('#nextBtn').click();
    await page.locator('.choice, #againBtn').first().waitFor({ timeout: 8000 });
    if (await page.locator('#againBtn').isVisible()) break;
  }
  await expect(page.locator('#againBtn')).toBeVisible();
});

test('subregion groups start collapsed and roll up into their continent', async ({ page }) => {
  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');

  // Collapsed by default: a checklist inside a checklist is only useful if the
  // outer one is still readable at a glance.
  expect(await page.locator('.tree-kids:not([hidden])').count()).toBe(0);

  await page.locator('.tree-group:has(input[data-region="Asia"]) .tree-toggle').click();
  await expect(page.locator('#tg-asia')).toBeVisible();

  // Unticking the continent unticks every subregion under it.
  await page.locator('input[data-region="Asia"]').uncheck();
  expect(await page.locator('#tg-asia input:checked').count()).toBe(0);

  // Ticking one back leaves the continent partially selected, not on or off.
  await page.locator('input[data-sub="Middle East"]').check();
  const asia = page.locator('input[data-region="Asia"]');
  expect(await asia.isChecked()).toBe(false);
  expect(await asia.evaluate((el) => el.indeterminate)).toBe(true);

  // And ticking the rest rolls it back up to fully checked.
  for (const sub of ['Caucasus', 'Central Asia', 'East Asia', 'South Asia', 'Southeast Asia']) {
    await page.locator(`input[data-sub="${sub}"]`).check();
  }
  expect(await asia.isChecked()).toBe(true);
  expect(await asia.evaluate((el) => el.indeterminate)).toBe(false);
});

test('a bare /quiz/mixed still plays immediately, using the saved setup', async ({ page }) => {
  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');
  await page.locator('#modeChecks input[value="population"]').uncheck();
  await page.locator('#startMixed').click();
  await page.waitForSelector('.choice');

  // The deep link means "play now" — the hero's quick button relies on it, and
  // it still has to honor what the setup screen saved.
  await page.goto('/quiz/mixed');
  await page.waitForSelector('.choice');
  expect(await page.locator('#regionTree').count()).toBe(0);
  await expect(page.locator('#app h1').first()).not.toContainText('population');
});

test('the setup is remembered across a reload and shared with Custom Study', async ({ page }) => {
  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');
  await page.locator('#modeChecks input[value="population"]').uncheck();
  await page.locator('input[data-region="Asia"]').uncheck();
  await page.locator('#startMixed').click();
  await page.waitForSelector('.choice');

  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).setup, PROFILE_KEY);
  expect(saved.modes).not.toContain('population');
  expect(saved.subregions).not.toContain('East Asia');

  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');
  await expect(page.locator('#modeChecks input[value="population"]')).not.toBeChecked();
  await expect(page.locator('input[data-sub="East Asia"]')).not.toBeChecked();
  // Asia is fully off, so its group stays collapsed — only a partial one opens.
  await expect(page.locator('#tg-asia')).toBeHidden();

  await page.goto('/custom');
  await page.waitForSelector('#regionTree');
  await expect(page.locator('#modeChecks input[value="population"]')).not.toBeChecked();
});

test('a selection with no questions in it is refused, not started', async ({ page }) => {
  await page.goto('/quiz/mixed/setup');
  await page.waitForSelector('#regionTree');
  await page.locator('[data-none="modeChecks"]').click();
  await expect(page.locator('#setupCount')).toContainText('at least one');

  await page.locator('#startMixed').click();
  await expect(page.locator('.toast')).toBeVisible();
  await expect(page.locator('.choice')).toHaveCount(0);
});

test('the flag map shows a flag for the country under the pointer', async ({ page }) => {
  await page.goto('/flagmap');
  await page.waitForSelector('.map-svg path[id]', { timeout: 20000 });
  await expect(page.locator('#flagPanel')).toContainText('Point at a country');

  const brazil = page.locator('.map-svg path#br');
  await brazil.hover({ force: true });
  await expect(page.locator('.flag-tip')).toBeVisible();
  await expect(page.locator('.flag-tip')).toContainText('Brazil');
  await expect(page.locator('.flag-tip-img')).toHaveAttribute('src', /flagcdn\.com\/w160\/br\.png/);

  // Leaving the map takes the card with it, rather than stranding it mid-screen.
  const box = await page.locator('.map-svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60, { steps: 10 });
  await expect(page.locator('.flag-tip')).toBeHidden();
});

test('the flag map works without a pointer at all', async ({ page }) => {
  await page.goto('/flagmap');
  await page.waitForSelector('.map-svg path[id]', { timeout: 20000 });

  // Keyboard focus fills the panel: hover is a mouse idea and cannot be the
  // only way in.
  await page.locator('.map-svg path#jp').focus();
  await expect(page.locator('#flagPanel')).toContainText('Japan');
  await expect(page.locator('#flagPanel')).toContainText('Tokyo');

  // A tap does the same, which is what a touch device gets.
  await page.locator('.map-svg path#br').click({ force: true });
  await expect(page.locator('#flagPanel')).toContainText('Brasília');

  const img = page.locator('.flag-card-img');
  await expect(img).toHaveAttribute('alt', 'Flag of Brazil');
  expect(await img.evaluate((el) => el.complete && el.naturalWidth > 0), 'the flag actually loaded').toBe(true);

  await page.locator('#flagPanel a').click();
  await expect(page).toHaveURL(/\/country\/brazil/);
});
