import { test, expect } from '@playwright/test';

// Performance budget for the worst measured interaction in the app.
// Baseline before remediation (production, desktop):
//   251 image requests on open, longest task 1,009 ms, 1,610 ms to type
//   three characters into the "live" search.

async function openFlagKey(page) {
  await page.goto('/');
  await page.waitForSelector('.card');
  await page.getByRole('tab', { name: /Explore/ }).click();
  await page.getByRole('button', { name: /Flag Key/ }).click();
  await page.waitForSelector('.flagkey-card');
}

test('opening Flag Key does not request every flag at once', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.card');

  let imageRequests = 0;
  page.on('request', (r) => {
    if (r.resourceType() === 'image') imageRequests++;
  });

  await page.getByRole('tab', { name: /Explore/ }).click();
  await page.getByRole('button', { name: /Flag Key/ }).click();
  await page.waitForSelector('.flagkey-card');
  await page.waitForTimeout(1500);

  // Baseline was 251 (all four tabs built, nothing lazy). Now only the active
  // tab is built and its images are lazy, so the count is whatever Chromium
  // decides is near the viewport -- measured 40-76 depending on timing. The
  // budget guards the regression, not an exact number.
  expect(imageRequests, 'flag images requested on open').toBeLessThan(110);
});

test('only the active tab panel is rendered', async ({ page }) => {
  await openFlagKey(page);
  // Building all four panels and hiding three with display:none still
  // downloads their images.
  const panels = await page.locator('.tab-panel').count();
  const gridsWithCards = await page.evaluate(
    () => [...document.querySelectorAll('.flagkey-grid')].filter((g) => g.children.length > 0).length,
  );
  expect(panels).toBeGreaterThan(0);
  expect(gridsWithCards, 'only one populated grid should exist').toBe(1);
});

test('grid images are lazy and occupy a reserved box', async ({ page }) => {
  await openFlagKey(page);

  const bad = await page.evaluate(
    () => [...document.querySelectorAll('.flagkey-card img')].filter((i) => i.loading !== 'lazy' || i.decoding !== 'async').length,
  );
  expect(bad, 'grid images missing loading="lazy" / decoding="async"').toBe(0);

  // Space is reserved via a fixed CSS box rather than width/height attributes,
  // because flags range from 1:1 to 28:11 and a single ratio would distort some.
  const box = await page.evaluate(() => {
    const i = document.querySelector('.flagkey-card img');
    const cs = getComputedStyle(i);
    return { h: cs.height, fit: cs.objectFit };
  });
  expect(box.h).not.toBe('auto');
  expect(box.fit).toBe('contain');
});

test('search filters quickly and correctly', async ({ page }) => {
  await openFlagKey(page);
  const box = page.locator('.tab-panel.active .flagkey-search');

  const started = Date.now();
  await box.pressSequentially('uni', { delay: 60 });
  await page.waitForTimeout(250);
  const elapsed = Date.now() - started;

  await expect(box).toHaveValue('uni');

  const visible = await page.evaluate(
    () => [...document.querySelectorAll('.flagkey-card')].filter((c) => c.offsetParent !== null).length,
  );
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(20);

  // 3 keystrokes at 60ms = 180ms of typing; the rest is the app's own work.
  expect(elapsed, 'typing three characters into the live search').toBeLessThan(1200);
});

test('clearing the search restores the full list', async ({ page }) => {
  await openFlagKey(page);
  const box = page.locator('.tab-panel.active .flagkey-search');
  const before = await page.locator('.tab-panel.active .flagkey-card').count();

  await box.pressSequentially('uni', { delay: 40 });
  await page.waitForTimeout(250);
  await box.fill('');
  await page.waitForTimeout(250);

  const visible = await page.evaluate(
    () => [...document.querySelectorAll('.tab-panel.active .flagkey-card')].filter((c) => c.offsetParent !== null).length,
  );
  expect(visible).toBe(before);
});
