# Profile name & leaderboard access from the header

## Problem

The player's display name (`profile.name`) and their local high-score
leaderboard (`profile.leaderboard`) both already exist in state and are
editable/viewable, but only by drilling into Explore → Profile. There's no
quick way to see "whose progress this is" at a glance, or to check the
leaderboard without navigating away from wherever you are.

## Design

### 1. Name chip in the header HUD

Add a chip to `renderHUD()` (`js/main.js`), rendered into the existing `#hud`
element alongside the Lvl/XP/streak/accuracy chips:

```
👤 <name>
```

- Placed first in the HUD row (leftmost — identity before stats).
- Clicking it calls `showProfile()`.
- Gets the same `hide-sm` treatment as the XP/accuracy chips so the header
  doesn't overflow on narrow viewports.
- Re-rendered whenever `renderHUD()` runs (already called after any profile
  mutation), so a rename is reflected immediately.

### 2. Leaderboard: header icon + dedicated screen

- Add a `🏆` `icon-btn` to the `<header class="topbar">` in `index.html`,
  next to the existing help (`❓`) and theme (`🌙/☀️`) buttons.
- Wire it in `boot()` to call a new `showLeaderboard()` function.
- `showLeaderboard()` follows the existing screen pattern (see
  `showAchievements()`): `topNav()`, a `screen-title`, the ranked list, a
  "← Back" button, `wireNav()`.
- The leaderboard list markup (`profile.leaderboard` mapped to `<li>`s) moves
  from `showProfile()` into `showLeaderboard()` — single source of truth, no
  duplication.
- `showProfile()` loses its "Local leaderboard" `form-block`; the Explore
  card description for `profile` changes from *"Name, leaderboard & reset."*
  to *"Name & reset."*

### Out of scope

- No new persisted state — `name` and `leaderboard` are already tracked in
  `js/state.js`.
- No Explore-tab card for the leaderboard (header icon only, per product
  decision) — it's one tap from anywhere via the header.
- No multi-profile/account switching — "whose account it is" is answered by
  displaying the single local profile's name, not by adding accounts.

## Testing

Manual verification in the browser (no engine logic changes, so no new
`node --test` cases): rename updates the header chip immediately; the trophy
button opens the leaderboard from the home screen and from mid-navigation;
Profile screen still renders correctly without the removed block.
