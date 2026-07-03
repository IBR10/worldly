// analytics.js — Microsoft Clarity integration (privacy-conscious).
//
// Loads the Clarity tag asynchronously and exposes a tiny event API that
// no-ops when analytics is unavailable (ad-blocker, offline, Node tests).
// Only event NAMES and coarse mode labels are ever sent — never quiz answers,
// display names, or anything from the stored profile.

const CLARITY_ID = 'xgi3gfz0eh';

(function load() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    const w = window;
    w.clarity = w.clarity || function (...args) { (w.clarity.q = w.clarity.q || []).push(args); };
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.clarity.ms/tag/${CLARITY_ID}`;
    document.head.appendChild(s);
  } catch { /* analytics must never break the app */ }
})();

/** Fire a named custom event (snake_case). Safe no-op without Clarity. */
export function track(eventName) {
  try { window.clarity?.('event', eventName); } catch { /* ignore */ }
}

/** Attach a session tag (key/value) for filtering sessions in the dashboard. */
export function tag(key, value) {
  try { window.clarity?.('set', key, String(value)); } catch { /* ignore */ }
}
