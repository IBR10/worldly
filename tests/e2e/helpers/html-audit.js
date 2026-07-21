// Structural checks over the markup the app actually renders.
//
// Why raw strings and not the DOM: `outerHTML` is re-serialised from the parsed
// DOM, and the HTML parser silently drops a repeated attribute. By the time
// markup reaches the DOM, `<button class="btn" class="btn danger">` has already
// become `class="btn"` -- the defect is invisible. So we capture every string
// assigned to `innerHTML` *before* the parser sees it (see installHtmlCapture)
// and inspect that instead.

/**
 * Attribute names used by each tag in a raw HTML string, in source order.
 * Hand-scanned rather than regexed so quoted values containing `=`, `>` or
 * spaces cannot produce false positives.
 * @returns {Array<{ tag: string, attrs: string[] }>}
 */
export function scanTags(html) {
  const out = [];
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== '<') continue;
    const nameMatch = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i, i + 40));
    if (!nameMatch) continue;
    const tag = nameMatch[1];
    let j = i + nameMatch[0].length;
    const attrs = [];
    let quote = null;
    let current = '';
    let expectingValue = false;
    const flush = () => {
      const name = current.replace(/\/+$/, '');
      if (name) attrs.push(name.toLowerCase());
      current = '';
    };
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) { quote = null; expectingValue = false; }
        continue;
      }
      if (c === '>') break;
      if (c === '=') { flush(); expectingValue = true; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (/\s/.test(c)) { flush(); expectingValue = false; continue; }
      // Any other character is part of an attribute name, unless we are
      // skipping over an unquoted attribute value (e.g. `class=btn`).
      if (!expectingValue) current += c;
    }
    flush();
    out.push({ tag, attrs });
    i = j;
  }
  return out;
}

/** Tags that declare the same attribute more than once. */
export function findDuplicateAttributes(html) {
  const dupes = [];
  for (const { tag, attrs } of scanTags(html)) {
    const seen = new Set();
    for (const a of attrs) {
      if (seen.has(a)) dupes.push({ tag, attr: a });
      seen.add(a);
    }
  }
  return dupes;
}

/** Inline event-handler attributes. Under this app's CSP they never execute,
 *  so any occurrence is dead code masquerading as error handling. */
export function findInlineHandlers(html) {
  const found = [];
  for (const { tag, attrs } of scanTags(html)) {
    for (const a of attrs) if (/^on[a-z]+$/.test(a)) found.push({ tag, attr: a });
  }
  return found;
}

/**
 * Patch the innerHTML setter so every raw string the app renders is retained
 * for inspection. Must run before app code (page.addInitScript).
 */
export function installHtmlCapture() {
  return () => {
    window.__rawHtml = [];
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        try {
          window.__rawHtml.push(String(value));
        } catch {
          /* capture must never break rendering */
        }
        desc.set.call(this, value);
      },
    });
  };
}

/** Heading levels present on screen, for order/uniqueness assertions. */
export function headingProbe() {
  return [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent.trim().slice(0, 60),
  }));
}

/** Describe how a heading list violates WCAG 1.3.1 / 2.4.10, or null if fine. */
export function headingProblem(headings) {
  if (headings.length === 0) return 'screen has no headings at all';
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) return `expected exactly one h1, found ${h1s.length}`;
  if (headings[0].level !== 1) return `first heading is h${headings[0].level}, not h1`;
  for (let i = 1; i < headings.length; i++) {
    const jump = headings[i].level - headings[i - 1].level;
    if (jump > 1) return `heading level jumps h${headings[i - 1].level} -> h${headings[i].level} ("${headings[i].text}")`;
  }
  return null;
}
