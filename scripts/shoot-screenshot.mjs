// Regenerates assets/screenshot-home.png — the README hero and the og:image.
//
// Dev-only, like build-pokedex.mjs. Needs the site served locally and Playwright
// installed (both are already dev dependencies):
//
//   python3 scripts/spa-serve.py 8124 &
//   node scripts/shoot-screenshot.mjs
//
// The profile below is seeded rather than real so the shot is reproducible and
// shows the hero map doing its job: a believable mid-game player, with plenty of
// the world still grey.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const countries = JSON.parse(readFileSync('data/countries.json', 'utf8'));
const srs = {};
// A believable mid-game profile: a bit of everything, plenty still grey.
countries.filter((c) => ['Europe', 'South America', 'Asia'].includes(c.region))
  .slice(0, 58).forEach((c, i) => { srs[`capital:${c.name}`] = { box: (i % 5) + 1, correct: 3, wrong: 1, lastSeen: Date.now() }; });
countries.filter((c) => c.region === 'Africa').slice(0, 14)
  .forEach((c) => { srs[`flag:${c.name}`] = { box: 5, correct: 5, wrong: 0, lastSeen: Date.now() }; });

const profile = {
  version: 1, playerId: '11111111-1111-4111-8111-111111111111', name: 'Explorer',
  xp: 1840, bestStreak: 22, currentStreak: 6, totalAnswered: 312, totalCorrect: 249,
  studyTimeMs: 4_200_000, perfectQuizzes: 2, dailyCompleted: 6, lastDaily: null,
  perCategory: {}, perRegion: {}, srs, missed: {},
  achievements: { first_steps: '2026-01-02T10:00:00.000Z' }, leaderboard: [],
  theme: 'dark', onboarded: true,
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: 2 });
await ctx.addInitScript((p) => localStorage.setItem('worldly_profile_v1', JSON.stringify(p)), profile);
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8124/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: 'assets/screenshot-home.png' });
await browser.close();
console.log('assets/screenshot-home.png regenerated');
