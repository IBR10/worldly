# Security policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/IBR10/worldly/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required.

## Scope

Worldly is a static site with no accounts and no personal data. Progress lives
in the visitor's own browser (`localStorage`) and is never transmitted, except
for two opt-in-by-play cases:

- **Challenge/Daily leaderboard** — a display name and a server-graded score.
- **XP leaderboard** — a display name, an XP total, and an opaque player id
  generated on the device. Self-reported and not verifiable; see
  `functions/api/xp.js`.

Things worth reporting:

- Anything that lets one player alter another player's leaderboard entry.
- Anything that gets script to run in another visitor's browser.
- Anything that reveals a Challenge/Daily answer before it has been submitted.
- Anything that bypasses the per-IP rate limits on `/api/*`.

Known and accepted:

- **XP totals are self-reported.** There is no account system to grade
  Practice/Custom Study/Review against, so the XP leaderboard is rate-limited
  rather than tamper-proof. This is documented in the UI. The Challenge and
  Daily boards *are* server-graded.
- **Display names are not moderated.** They are escaped on render, so this is a
  content concern rather than an injection one.

## Data contributions

`data/*.json` is community-correctable, and its contents are rendered into the
page. Text is escaped (`esc()`), and link targets are restricted to `http(s)`
by `safeUrl()` in `js/main.js` — `javascript:` URLs are not blocked by the CSP
on navigation, so that check is the control. Please keep new link fields going
through it.
