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

test.describe('country guides', () => {
  test('the index lists every country and filters without rebuilding', async ({ page }) => {
    await page.goto('/country');
    await page.waitForSelector('.card[data-slug]');
    const total = await page.locator('.card[data-slug]').count();
    expect(total).toBeGreaterThan(190);

    // Tag one card's DOM node. Filtering must toggle .hidden on the existing
    // cards; regenerating the markup would discard and recreate ~200 <img>
    // elements per keystroke, which is the regression the Flag Key screen
    // exists to document. Checking node identity tests that directly —
    // counting image requests does not, because lazy images legitimately load
    // as the grid reflows.
    await page.evaluate(() => {
      document.querySelector('.card[data-slug="japan"]').dataset.probe = 'kept';
    });

    const started = Date.now();
    await page.locator('#countrySearch').type('jap');
    await page.waitForTimeout(50);
    const elapsed = Date.now() - started;

    expect(elapsed, 'typing three characters').toBeLessThan(1200);
    await expect(page.locator('.card[data-slug="japan"][data-probe="kept"]')).toHaveCount(1);
    expect(await page.locator('.card[data-slug]').count(), 'cards are hidden, not removed').toBe(total);
    await expect(page.locator('.card[data-slug]:visible')).toHaveCount(1);
  });

  test('the region filter narrows the list', async ({ page }) => {
    await page.goto('/country');
    await page.waitForSelector('.card[data-slug]');
    await page.selectOption('#countryRegion', 'South America');
    await expect(page.locator('.card[data-slug]:visible')).toHaveCount(12);
  });

  test('the index sorts, and reorders the cards it already has', async ({ page }) => {
    // The file order is grouped by region and reads as random when you are
    // looking for one country, so the index opens A-Z and offers the rest.
    await page.goto('/country');
    await page.waitForSelector('.card[data-slug]');
    const firstThree = () => page.evaluate(() =>
      [...document.querySelectorAll('.card[data-slug]')].slice(0, 3).map((c) => c.dataset.slug));

    expect(await firstThree()).toEqual(['afghanistan', 'albania', 'algeria']);

    // Hold on to one card, so we can prove sorting MOVES nodes rather than
    // rebuilding them — a rebuild would discard and re-request 198 flag images
    // on every change of the dropdown.
    await page.evaluate(() => { window.__card = document.querySelector('.card[data-slug="japan"]'); });

    await page.selectOption('#countrySort', 'nameDesc');
    expect(await firstThree()).toEqual(['zimbabwe', 'zambia', 'yemen']);

    await page.selectOption('#countrySort', 'population');
    expect((await firstThree())[0]).toBe('india');

    expect(await page.evaluate(() => window.__card === document.querySelector('.card[data-slug="japan"]')))
      .toBe(true);

    // Sorting must not disturb the filter, which works on the same nodes.
    await page.fill('#countrySearch', 'japan');
    await expect(page.locator('.card[data-slug]:visible')).toHaveCount(1);
  });

  test('a country page renders every section', async ({ page }) => {
    await page.goto('/country/japan');
    await page.waitForSelector('.person');

    await expect(page.locator('h1.screen-title')).toHaveText('Japan');
    await expect(page.locator('.hello-word')).toContainText('こんにちは');
    await expect(page.locator('.person')).toHaveCount(5);
    expect(await page.locator('.event').count()).toBeGreaterThanOrEqual(3);
    expect(await page.locator('.culture-cell').count()).toBeGreaterThanOrEqual(4);
    await expect(page.locator('.talk-list li')).toHaveCount(3);
    await expect(page.locator('.callout-warn')).toBeVisible();
    await expect(page.locator('.stat')).toHaveCount(4);
  });

  test('the greeting is spoken from the country page too', async ({ page }) => {
    await page.goto('/country/france');
    await page.waitForSelector('.hello-word');
    await expect(page.locator('.hello-word [data-speak]')).toBeVisible();
  });

  test('the country name and flag are not repeated inside the greeting card', async ({ page }) => {
    await page.goto('/country/portugal');
    await page.waitForSelector('.hello-panel');
    await expect(page.locator('.hello-panel h2')).toHaveCount(0);
    await expect(page.locator('.hello-panel .hello-flag')).toHaveCount(0);
  });

  test('an unknown country slug redirects to the index', async ({ page }) => {
    await page.goto('/country/atlantis');
    await page.waitForSelector('.card[data-slug]');
    expect(new URL(page.url()).pathname).toBe('/country');
  });

  test('a country with an accented name is reachable by its slug', async ({ page }) => {
    // slugify() strips diacritics, so Côte d'Ivoire lives at /country/ivory-coast
    // and São Tomé at /country/sao-tome-and-principe.
    await page.goto('/country/sao-tome-and-principe');
    await page.waitForSelector('.person');
    await expect(page.locator('h1.screen-title')).toContainText('Tom');
  });
});
