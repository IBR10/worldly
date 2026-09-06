import { test, expect } from '@playwright/test';

// The Language Map, the Say Hello map and the country guides. These three share
// the 1.2 MB world SVG and the greetings dataset, so several assertions here are
// about NOT refetching or NOT rebuilding — the failure modes are performance
// ones that look fine in a screenshot.

/** Count requests for the world SVG, so a repaint that remounts it is caught. */
async function countSvgRequests(page) {
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/assets/maps/world.svg')) seen.push(r.url()); });
  return seen;
}

test.describe('language map', () => {
  test('paints every region and the key matches the paint', async ({ page }) => {
    await page.goto('/languages');
    await page.waitForSelector('.map-svg path.lf-romance');

    const painted = await page.locator('.map-svg path[class*="lf-"]').count();
    expect(painted, 'regions given a family colour').toBeGreaterThan(200);

    // Nothing may be left unpainted: an unstyled region reads as a rendering bug.
    const unpainted = await page.evaluate(() =>
      [...document.querySelectorAll('.map-svg path[id]')].filter((p) => ![...p.classList].some((c) => c.startsWith('lf-'))).map((p) => p.id));
    expect(unpainted, `regions with no colour: ${unpainted.join(' ')}`).toEqual([]);

    // Every key entry's swatch class is one the map actually used.
    const legendClasses = await page.evaluate(() =>
      [...document.querySelectorAll('.legend-swatch')].map((s) => [...s.classList].find((c) => c.startsWith('lf-') || c.startsWith('lg-'))));
    expect(legendClasses.length).toBeGreaterThan(5);
    for (const cls of legendClasses) {
      expect(await page.locator(`.map-svg path.${cls}`).count(), `${cls} is in the key but on no region`).toBeGreaterThan(0);
    }
  });

  test('switching to the language view repaints without refetching the SVG', async ({ page }) => {
    const svgRequests = await countSvgRequests(page);
    await page.goto('/languages');
    await page.waitForSelector('.map-svg path.lf-romance');
    expect(svgRequests.length).toBe(1);

    await page.locator('#langmode-language').click();
    await page.waitForSelector('.map-svg path.lg-1');

    // The 1.2 MB SVG must be reused, not re-injected.
    expect(svgRequests.length, 'world.svg fetched again on repaint').toBe(1);
    // And the previous mode's classes must be gone, or colours would stack.
    expect(await page.locator('.map-svg path[class*="lf-romance"]').count()).toBe(0);
  });

  test('a key entry isolates its group, and clicking again clears it', async ({ page }) => {
    await page.goto('/languages');
    await page.waitForSelector('.map-svg path.lf-romance');
    expect(await page.locator('.map-svg path.region-dim').count()).toBe(0);

    const romance = await page.locator('.map-svg path.lf-romance').count();
    await page.locator('.legend-item[data-bucket="romance"]').click();

    const dimmed = await page.locator('.map-svg path.region-dim').count();
    const total = await page.locator('.map-svg path[id]').count();
    expect(dimmed).toBe(total - romance);
    await expect(page.locator('.legend-item[data-bucket="romance"]')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('.legend-item[data-bucket="romance"]').click();
    expect(await page.locator('.map-svg path.region-dim').count()).toBe(0);
  });

  test('a painted country still gets hover feedback', async ({ page }) => {
    await page.goto('/languages');
    await page.waitForSelector('.map-svg path.lf-romance');
    // The fill comes from the paint class; hover must add relief without
    // overriding it, or every painted country would lose its affordance.
    const relief = await page.evaluate(() => {
      const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
      const hover = rules.find((r) => r.selectorText === '.map-svg.map-choropleth path:hover');
      return hover && hover.style.filter;
    });
    expect(relief, 'choropleth hover relief').toBeTruthy();
  });
});

test.describe('say hello map', () => {
  test('picking two countries in a row updates the panel each time', async ({ page }) => {
    const svgRequests = await countSvgRequests(page);
    await page.goto('/hello');
    await page.waitForSelector('#helloPanel');
    await expect(page.locator('.hello-empty')).toBeVisible();

    await page.selectOption('#helloPick', 'fr');
    await expect(page.locator('.hello-panel h2')).toHaveText('France');
    await expect(page.locator('.hello-word')).toContainText('Bonjour');
    await expect(page.locator('#helloPanel [data-speak]').first()).toBeVisible();

    // repeat:true — a browsing map must not latch after the first pick.
    await page.selectOption('#helloPick', 'jp');
    await expect(page.locator('.hello-panel h2')).toHaveText('Japan');
    await expect(page.locator('.hello-word')).toContainText('こんにちは');

    expect(svgRequests.length, 'the map must not remount between picks').toBe(1);
  });

  test('clicking a country on the map shows its greeting', async ({ page }) => {
    await page.goto('/hello');
    await page.waitForSelector('.map-svg path#fr');
    await page.locator('.map-svg path#fr').click({ force: true });
    await expect(page.locator('.hello-panel h2')).toHaveText('France');
  });

  test('the greeting is announced, not only shown', async ({ page }) => {
    await page.goto('/hello');
    await page.waitForSelector('#helloPanel');
    await expect(page.locator('#helloPanel')).toHaveAttribute('aria-live', 'polite');
  });

  test('a territory shows its greeting and offers no country page', async ({ page }) => {
    await page.goto('/hello');
    await page.waitForSelector('#helloPanel');
    await page.selectOption('#helloPick', 'pr');
    await expect(page.locator('.hello-panel h2')).toHaveText('Puerto Rico');
    await expect(page.locator('.hello-panel .screen-sub')).toContainText('part of the United States');
    await expect(page.locator('[data-country-page]')).toHaveCount(0);
  });
});
