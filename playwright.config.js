import { defineConfig, devices } from '@playwright/test';

// Smoke coverage for the ~70% of the app that has no unit tests: main.js owns
// routing, every screen and the quiz session, and none of it is exercised by
// tests/*.test.mjs (those cover the pure engines only).
//
// Served by scripts/spa-serve.py, which mirrors Cloudflare Pages: real files are
// served directly and any other path falls back to index.html (200) so the
// History-API router can handle deep links and reloads. /api/* still 404s here
// (those are Pages Functions in production), so the leaderboard spec asserts the
// error path; the success path is verified against the real deployment.

const PORT = 8123;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: `python3 scripts/spa-serve.py ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
