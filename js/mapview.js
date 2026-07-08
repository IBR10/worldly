// mapview.js — the reusable interactive map widget shared by every click-the-map
// mode (world / US / Mexico). It injects a bundled inline SVG, adds pan + zoom,
// and lets the browser do hit-testing: each region is a <path> whose `id` is an
// ISO/postal code, so a click simply reports which region was hit. This is the
// "reusable MapMode component" from the roadmap. It is the only DOM-coupled part
// of the map feature — all scoring/question logic lives in the pure maps.js.

/**
 * Build an interactive map.
 * @param {object} opts
 *   svgText      the bundled inline SVG markup (regions are <path id="..">)
 *   onPick       (id, name) => void, fired once when the player clicks a region
 *   highlightId  optional region id to pre-highlight (used by reverse "name it" mode)
 *   interactive  when false, the map is display-only (no picking) — reverse mode
 *   focusIds     optional list of region ids to zoom the initial view to (e.g.
 *                every country in one continent) instead of showing the whole map
 * @returns {{ el: HTMLElement, reveal: (clickedId, targetId) => void }}
 */
export function createMapView({ svgText, onPick, highlightId = null, interactive = true, focusIds = null }) {
  const wrap = document.createElement('div');
  wrap.className = 'map-wrap';

  // --- inject the SVG ---------------------------------------------------------
  const holder = document.createElement('div');
  holder.className = 'map-holder';
  holder.innerHTML = svgText;
  const svg = holder.querySelector('svg');
  svg.classList.add('map-svg');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  if (!interactive) svg.classList.add('map-static');

  // Pre-highlight a region (reverse mode shows the region and asks its name).
  // The highlight itself is only a fill-color change, which is invisible to a
  // screen reader — add a visually-hidden text alternative so the highlighted
  // region's name is actually announced, not just shown.
  const srAnnounce = document.createElement('p');
  srAnnounce.className = 'sr-only';
  if (highlightId) {
    const hl = svg.querySelector(`#${CSS.escape(highlightId)}`);
    if (hl) {
      hl.classList.add('region-highlight');
      srAnnounce.textContent = `Highlighted on the map: ${hl.getAttribute('aria-label') || hl.id}`;
    }
  }

  // --- pan / zoom state -------------------------------------------------------
  let scale = 1, tx = 0, ty = 0;
  // "Home" view — plain scale=1/centered by default, but re-anchored to a
  // continent's bounding box by fitToIds() below. Reset view returns here.
  let homeScale = 1, homeTx = 0, homeTy = 0;
  const apply = () => { svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const clampScale = (s) => Math.min(8, Math.max(1, s));

  // Zoom the initial view to fit the union of the given region ids (e.g. every
  // country in one continent), so a region/continent mode opens already zoomed
  // in instead of showing the whole map. Runs once, on the next animation frame
  // so the SVG has been laid out (main.js always appends `.el` synchronously
  // right after createMapView() returns, well before the next frame).
  function fitToIds(ids) {
    const els = ids.map((id) => svg.querySelector(`#${CSS.escape(id)}`)).filter(Boolean);
    if (!els.length) return;
    const holderRect = holder.getBoundingClientRect();
    if (!holderRect.width || !holderRect.height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect(); // baseline screen rect (scale=1, tx=ty=0 still in effect)
      minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
    }
    const bboxW = maxX - minX, bboxH = maxY - minY;
    if (bboxW <= 0 || bboxH <= 0) return;
    const cx = minX + bboxW / 2 - holderRect.left, cy = minY + bboxH / 2 - holderRect.top;
    const FILL = 0.75; // the region fills ~75% of the viewport, leaving surrounding context
    const s = clampScale(Math.min((holderRect.width * FILL) / bboxW, (holderRect.height * FILL) / bboxH));
    homeScale = s;
    homeTx = holderRect.width / 2 - cx * s;
    homeTy = holderRect.height / 2 - cy * s;
    scale = homeScale; tx = homeTx; ty = homeTy;
    apply();
  }
  if (focusIds && focusIds.length) requestAnimationFrame(() => fitToIds(focusIds));

  function zoomAt(cx, cy, factor) {
    const rect = holder.getBoundingClientRect();
    const px = cx - rect.left, py = cy - rect.top;
    const next = clampScale(scale * factor);
    if (next === scale) return;
    // keep the point under the cursor stationary
    tx = px - (px - tx) * (next / scale);
    ty = py - (py - ty) * (next / scale);
    scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }

  holder.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  // --- drag-to-pan vs click vs pinch-zoom --------------------------------------
  // Single pointer: a pan only starts past a small threshold, so a plain click
  // is never swallowed by a tiny mouse twitch. Two pointers: pinch-zoom around
  // the gesture midpoint (reusing zoomAt's anchor math); a pinch always
  // suppresses the click on release.
  const DRAG_THRESHOLD = 6; // px
  const pointers = new Map(); // active pointerId -> { x, y }
  let dragging = false, pinched = false, pinchDist = null;
  let downX = 0, downY = 0, panOX = 0, panOY = 0;

  const pinchPair = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  };

  holder.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return; // primary button / touch only
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { holder.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointers.size === 2) {
      pinched = true; // this gesture is a zoom, never a click
      dragging = false;
      pinchDist = pinchPair().dist;
    } else if (pointers.size === 1) {
      dragging = false; pinched = false;
      downX = e.clientX; downY = e.clientY;
      panOX = e.clientX - tx; panOY = e.clientY - ty;
    }
  });
  holder.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const { dist, midX, midY } = pinchPair();
      if (pinchDist && dist > 0) zoomAt(midX, midY, dist / pinchDist);
      pinchDist = dist;
      return;
    }
    if (pinched) return; // fingers lifting after a pinch — don't start a pan
    if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD) dragging = true;
    if (dragging) { tx = e.clientX - panOX; ty = e.clientY - panOY; apply(); }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    try { holder.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointers.size < 2) pinchDist = null;
  };
  holder.addEventListener('pointerup', (e) => {
    const wasDragging = dragging, wasPinch = pinched;
    endPointer(e);
    if (pointers.size === 0) { dragging = false; pinched = false; }
    if (wasDragging || wasPinch || answered || !interactive || pointers.size > 0) return;
    // A genuine click: hit-test the region under the pointer.
    const path = regionAt(e.clientX, e.clientY);
    if (!path) return;
    answered = true;
    onPick(path.id, path.getAttribute('aria-label') || path.id);
  });
  holder.addEventListener('pointercancel', (e) => {
    endPointer(e);
    if (pointers.size === 0) { dragging = false; pinched = false; }
  });

  // Find the region under a screen point. Small regions are often drawn UNDER a
  // larger neighbour (e.g. DC under Maryland, Andorra under France, Guanajuato
  // under Jalisco), so `document.elementFromPoint` — which returns the topmost
  // painted path — would resolve to the wrong country/state. Instead we test the
  // click against every region's fill and keep the SMALLEST one that contains it,
  // so a nested/overlapped region is always selectable.
  function regionAt(clientX, clientY) {
    const paths = svg.querySelectorAll('path[id]');
    const ctm = svg.getScreenCTM();
    if (ctm && svg.createSVGPoint && paths[0] && paths[0].isPointInFill) {
      const sp = svg.createSVGPoint();
      sp.x = clientX; sp.y = clientY;
      const p = sp.matrixTransform(ctm.inverse()); // screen → SVG user space
      let best = null, bestArea = Infinity;
      for (const el of paths) {
        let inside = false;
        try { inside = el.isPointInFill(p); } catch { inside = false; }
        if (!inside) continue;
        const bb = el.getBBox();
        const area = bb.width * bb.height;
        if (area < bestArea) { bestArea = area; best = el; }
      }
      if (best) return best;
    }
    // Fallback for older engines: topmost painted path under the point.
    const el = document.elementFromPoint(clientX, clientY);
    return el && el.closest ? el.closest('path[id]') : null;
  }

  // --- state ------------------------------------------------------------------
  let answered = !interactive;

  // --- zoom controls ----------------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'map-controls';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'map-btn'; b.textContent = label; b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const zoomCenter = (factor) => {
    const r = holder.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };
  controls.append(
    mkBtn('＋', 'Zoom in', () => zoomCenter(1.3)),
    mkBtn('－', 'Zoom out', () => zoomCenter(1 / 1.3)),
    mkBtn('⟳', 'Reset view', () => { scale = homeScale; tx = homeTx; ty = homeTy; apply(); }),
  );

  // Interactive (forward) modes: make every region keyboard-operable — Tab to
  // a region, Enter/Space picks it, mirroring the click/hit-test behaviour.
  if (interactive) {
    svg.querySelectorAll('path[id]').forEach((p) => {
      p.setAttribute('tabindex', '0');
      p.setAttribute('role', 'button');
      if (!p.hasAttribute('aria-label')) p.setAttribute('aria-label', p.id);
    });
    holder.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const path = e.target.closest && e.target.closest('path[id]');
      if (!path || answered) return;
      e.preventDefault();
      // onPick() synchronously flips the quiz to its feedback phase. Without
      // stopping propagation, this SAME keydown event keeps bubbling to the
      // document-level handler, which would see the now-updated phase and
      // immediately auto-advance past the feedback screen on this one keypress.
      e.stopPropagation();
      answered = true;
      onPick(path.id, path.getAttribute('aria-label') || path.id);
    });
  }

  wrap.append(holder, controls, srAnnounce);

  /** Color the answered regions: target green, a wrong pick red; lock the map. */
  function reveal(clickedId, targetId) {
    answered = true;
    const target = svg.querySelector(`#${CSS.escape(targetId)}`);
    if (target) target.classList.add('region-correct');
    if (clickedId && clickedId !== targetId) {
      const picked = svg.querySelector(`#${CSS.escape(clickedId)}`);
      if (picked) picked.classList.add('region-wrong');
    }
    svg.classList.add('map-answered');
  }

  return { el: wrap, reveal };
}
