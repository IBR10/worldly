// analytics.js — Microsoft Clarity integration (privacy-conscious).
//
// Exposes a tiny event API that no-ops when analytics is unavailable
// (ad-blocker, offline, opted out, Node tests). Only event NAMES and coarse
// mode labels are ever sent — never quiz answers, display names, or anything
// from the stored profile.
//
// Loading is gated. Clarity does session replay, not just event counting, so
// it does not load when the visitor has signalled they do not want tracking
// (Global Privacy Control or Do Not Track) or has opted out in Profile. The
// tag is never fetched in those cases — this is a real gate, not a flag passed
// to a script that has already loaded.

const CLARITY_ID = 'xgi3gfz0eh';
const OPT_OUT_KEY = 'worldly_analytics_optout';

/** True when the visitor has asked, by any available signal, not to be tracked. */
export function analyticsOptedOut() {
  if (typeof window === 'undefined') return true;
  try {
    if (window.localStorage?.getItem(OPT_OUT_KEY) === '1') return true;
    if (navigator.globalPrivacyControl === true) return true;
    const dnt = navigator.doNotTrack ?? window.doNotTrack;
    if (dnt === '1' || dnt === 'yes') return true;
  } catch {
    // A browser that denies storage access is not a reason to start tracking.
    return true;
  }
  return false;
}

export function setAnalyticsOptOut(optOut) {
  try {
    if (optOut) window.localStorage.setItem(OPT_OUT_KEY, '1');
    else window.localStorage.removeItem(OPT_OUT_KEY);
  } catch { /* nothing else to do */ }
}

let loaded = false;

export function loadAnalytics() {
  if (loaded) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (analyticsOptedOut()) return;
  loaded = true;
  try {
    const w = window;
    w.clarity = w.clarity || function (...args) { (w.clarity.q = w.clarity.q || []).push(args); };
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.clarity.ms/tag/${CLARITY_ID}`;
    document.head.appendChild(s);
  } catch { /* analytics must never break the app */ }
}

/** Fire a named custom event (snake_case). Safe no-op without Clarity. */
export function track(eventName) {
  if (analyticsOptedOut()) return;
  try { window.clarity?.('event', eventName); } catch { /* ignore */ }
}

/** Attach a session tag (key/value) for filtering sessions in the dashboard. */
export function tag(key, value) {
  if (analyticsOptedOut()) return;
  try { window.clarity?.('set', key, String(value)); } catch { /* ignore */ }
}
