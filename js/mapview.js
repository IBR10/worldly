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
 * @returns {{ el: HTMLElement, reveal: (clickedId, targetId) => void }}
 */
export function createMapView({ svgText, onPick, highlightId = null, interactive = true }) {
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
  if (highlightId) {
    const hl = svg.querySelector(`#${CSS.escape(highlightId)}`);
    if (hl) hl.classList.add('region-highlight');
  }

  // --- pan / zoom state -------------------------------------------------------
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const clampScale = (s) => Math.min(8, Math.max(1, s));

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

  // --- drag-to-pan vs click ---------------------------------------------------
  // We only capture the pointer (and treat the gesture as a pan) once it moves
  // past a small threshold. That way a plain click is NEVER swallowed by a tiny
  // mouse twitch — the previous version set `moved` on any >3px jitter and then
  // dropped the click, which is why some regions felt unresponsive.
  const DRAG_THRESHOLD = 6; // px
  let pointerId = null, dragging = false, downX = 0, downY = 0, panOX = 0, panOY = 0;

  holder.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return; // primary button only
    pointerId = e.pointerId;
    dragging = false;
    downX = e.clientX; downY = e.clientY;
    panOX = e.clientX - tx; panOY = e.clientY - ty;
  });
  holder.addEventListener('pointermove', (e) => {
    if (pointerId == null) return;
    if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD) {
      dragging = true;
      try { holder.setPointerCapture(pointerId); } catch { /* ignore */ }
    }
    if (dragging) { tx = e.clientX - panOX; ty = e.clientY - panOY; apply(); }
  });
  holder.addEventListener('pointerup', (e) => {
    const wasDragging = dragging;
    if (pointerId != null) { try { holder.releasePointerCapture(pointerId); } catch { /* ignore */ } }
    pointerId = null; dragging = false;
    if (wasDragging || answered || !interactive) return;
    // A genuine click: hit-test the region under the pointer.
    const path = regionAt(e.clientX, e.clientY);
    if (!path) return;
    answered = true;
    onPick(path.id, path.getAttribute('aria-label') || path.id);
  });
  holder.addEventListener('pointercancel', () => { pointerId = null; dragging = false; });

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
    mkBtn('⟳', 'Reset view', () => { scale = 1; tx = 0; ty = 0; apply(); }),
  );

  wrap.append(holder, controls);

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
