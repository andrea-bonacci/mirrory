// ─── Configuration ───────────────────────────────────────────────────────────
const SERVER_URL = 'ws://localhost:3000';
const RECONNECT_MAX = 3;
const RECONNECT_DELAY_MS = 2000;
const SCROLL_THROTTLE_MS = 100;
// Cursor packets are sent on every mousemove (no throttle).
// The guest interpolates between packets using rAF for smooth 60fps motion.

// ─── State ────────────────────────────────────────────────────────────────────
let ws = null;
let role = null;           // 'host' | 'guest' | null
let sessionId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isConnected = false;

// ─── Badge overlay ────────────────────────────────────────────────────────────

/**
 * Inject the LIVE / WATCHING badge into the page.
 * @param {'host'|'guest'} currentRole
 */
function injectBadge(currentRole) {
  if (document.getElementById('mirrory-badge')) return;

  const badge = document.createElement('div');
  badge.id = 'mirrory-badge';
  Object.assign(badge.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483647',
    padding: '4px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    fontFamily: 'system-ui, sans-serif',
    color: '#fff',
    background: currentRole === 'host' ? '#6C47FF' : '#FF4747',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    userSelect: 'none',
    pointerEvents: 'none',
  });
  badge.textContent = currentRole === 'host' ? '● LIVE' : '👁 WATCHING';
  document.body.appendChild(badge);
}

/**
 * Remove the badge from the page.
 */
function removeBadge() {
  document.getElementById('mirrory-badge')?.remove();
}

// ─── Viewport scaling — letterbox/pillarbox (guest only) ─────────────────────
//
//  Strategy: CSS `zoom` on <html> with !important.
//
//  `zoom` is the only property that scales EVERYTHING including position:fixed
//  elements (navbar, overlays, modals) because it affects the entire layout
//  viewport, not just a subtree.  transform:scale on a wrapper div leaves
//  position:fixed children anchored to the real viewport.
//
//  Math:
//    zoom  = min(guestW/hostW, guestH/hostH)
//    rectW = hostW * zoom,  rectH = hostH * zoom
//    barX  = (guestW - rectW) / 2   (horizontal centering margin)
//    barY  = (guestH - rectH) / 2   (vertical centering margin)
//
//  We set:
//    html { zoom: <scale>; width: hostW; margin: barY barX; overflow: hidden; }
//  and add 4 fixed black bar divs to cover the gutters.
//
//  Scroll sync still works because we scroll window.scrollY as a fraction of
//  scrollHeight (which is already in zoomed coordinates).

let hostVW = 0;
let hostVH = 0;
let _lbBarX  = 0;
let _lbBarY  = 0;
let _lbRectW = 0;
let _lbRectH = 0;
let _lbBarEls = [];
// saved original html/body inline styles so we can restore on teardown
let _lbHtmlStyle = '';
let _lbBodyStyle = '';

function _setImp(el, prop, val) {
  el.style.setProperty(prop, val, 'important');
}

function applyLetterbox(hvw, hvh) {
  if (!hvw || !hvh) return;
  hostVW = hvw;
  hostVH = hvh;

  const gw   = window.innerWidth;
  const gh   = window.innerHeight;
  const zoom = Math.min(gw / hvw, gh / hvh);
  const rectW = hvw * zoom;
  const rectH = hvh * zoom;
  const barX  = Math.max(0, Math.round((gw - rectW) / 2));
  const barY  = Math.max(0, Math.round((gh - rectH) / 2));

  _lbBarX = barX; _lbBarY = barY; _lbRectW = rectW; _lbRectH = rectH;

  const html = document.documentElement;
  const body = document.body;

  // ── Apply zoom to <html> ──────────────────────────────────────────────────
  // zoom scales everything: layout, text, fixed-position elements, scrollbars.
  // We must set width = hostW so the page renders at host resolution, then
  // the zoom shrinks the rendered box to fit the guest viewport.
  _setImp(html, 'zoom',             zoom.toFixed(8));
  _setImp(html, 'width',            hvw + 'px');
  _setImp(html, 'min-width',        hvw + 'px');
  _setImp(html, 'max-width',        hvw + 'px');
  _setImp(html, 'margin-top',       barY + 'px');
  _setImp(html, 'margin-left',      barX + 'px');
  _setImp(html, 'margin-right',     '0px');
  _setImp(html, 'margin-bottom',    '0px');
  _setImp(html, 'padding',          '0px');
  _setImp(html, 'box-sizing',       'border-box');
  _setImp(html, 'background',       '#000');  // outer gutters colour

  // body: don't restrict height — let the page scroll normally inside the zoom
  _setImp(body, 'margin',           '0px');
  _setImp(body, 'padding',          '0px');
  _setImp(body, 'min-width',        hvw + 'px');
  _setImp(body, 'max-width',        hvw + 'px');

  // ── Black bar divs (cover gutters above the zoomed html element) ──────────
  if (_lbBarEls.length === 0) {
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.id = 'mirrory-bar-' + i;
      // Use fixed positioning in UNZOOMED space.
      // Because zoom is on <html>, position:fixed children of <body> are inside
      // the zoomed frame.  We need bars outside the zoomed frame, so we append
      // them directly to documentElement (outside <body>) — fixed positioning
      // there is relative to the real (unzoomed) viewport.
      _setImp(el, 'position',       'fixed');
      _setImp(el, 'background',     '#000');
      _setImp(el, 'pointer-events', 'none');
      _setImp(el, 'z-index',        '2147483645');
      _setImp(el, 'margin',         '0px');
      _setImp(el, 'padding',        '0px');
      document.documentElement.appendChild(el);
      _lbBarEls.push(el);
    }
  }
  // top / bottom / left / right bars (in real viewport px, not zoomed px)
  _posBar(_lbBarEls[0], 0,            0,            gw,                barY);
  _posBar(_lbBarEls[1], barY + rectH, 0,            gw,                Math.max(0, gh - barY - rectH));
  _posBar(_lbBarEls[2], 0,            0,            barX,              gh);
  _posBar(_lbBarEls[3], 0,            barX + rectW, Math.max(0, gw - barX - rectW), gh);
}

function _posBar(el, top, left, w, h) {
  _setImp(el, 'top',    top    + 'px');
  _setImp(el, 'left',   left   + 'px');
  _setImp(el, 'width',  Math.max(0, w) + 'px');
  _setImp(el, 'height', Math.max(0, h) + 'px');
}

function removeLetterbox() {
  _lbBarEls.forEach(el => el.remove()); _lbBarEls = [];
  // Remove only the properties we set — don't nuke the whole style attribute
  const htmlProps = ['zoom','width','min-width','max-width',
                     'margin-top','margin-left','margin-right','margin-bottom',
                     'padding','box-sizing','background'];
  const bodyProps = ['margin','padding','min-width','max-width'];
  for (const p of htmlProps) document.documentElement.style.removeProperty(p);
  for (const p of bodyProps) document.body.style.removeProperty(p);
  hostVW = 0; hostVH = 0;
  _lbBarX = 0; _lbBarY = 0; _lbRectW = 0; _lbRectH = 0;
}

function onGuestResize() {
  if (role === 'guest' && hostVW) applyLetterbox(hostVW, hostVH);
}

// ─── Cursor overlay (guest only) ──────────────────────────────────────────────

let cursorEl = null;

/**
 * Create or reuse the remote cursor element shown to guests.
 * @returns {HTMLElement}
 */
function getCursorEl() {
  if (cursorEl) return cursorEl;

  cursorEl = document.createElement('div');
  cursorEl.id = 'mirrory-cursor';
  Object.assign(cursorEl.style, {
    // position:fixed — coordinates are in viewport space (0..innerWidth/Height).
    // This is the only reference frame that is truly identical on both sides:
    // the host sends clientX/innerWidth (fraction of its own viewport) and the
    // guest multiplies by its own innerWidth/Height — always correct regardless
    // of page width, zoom level, font size, or scrollWidth differences.
    position: 'fixed',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: 'rgba(108, 71, 255, 0.7)',
    border: '2px solid #fff',
    boxShadow: '0 0 6px rgba(108,71,255,0.6)',
    pointerEvents: 'none',
    zIndex: '2147483646',
    transform: 'translate(-50%, -50%)',
  });
  document.documentElement.appendChild(cursorEl);
  return cursorEl;
}

// ── Cursor interpolation state (guest side) ───────────────────────────────────
// We keep the last two received positions plus their timestamps and interpolate
// between them on every animation frame.  This gives smooth 60fps motion even
// when packets arrive every 30-50ms (dead-reckoning / linear prediction).
let cursorFrom  = null;   // { xPct, yPct, t }  — previous received position
let cursorTo    = null;   // { xPct, yPct, t }  — latest received position
let cursorRafId = null;   // requestAnimationFrame handle

/**
 * Receive a new cursor packet from the host.
 * Packet has { sel, ox, oy } where sel is a DOM path selector and
 * ox/oy are offsets within that element (0–1).
 */
function onCursorPacket(sel, ox, oy) {
  const pos = resolveElementPos(sel, ox, oy);
  if (!pos) return;
  cursorFrom = cursorTo ?? { ...pos, t: performance.now() };
  cursorTo   = { ...pos, t: performance.now() };
  if (!cursorRafId) cursorRafId = requestAnimationFrame(animateCursor);
}

/**
 * Resolve a DOM path + offset to {x, y} in viewport px on the guest side.
 * Returns null if the element is not found.
 * @param {string} sel
 * @param {number} ox  — offset within element width  (0–1)
 * @param {number} oy  — offset within element height (0–1)
 * @returns {{x:number, y:number}|null}
 */
function resolveElementPos(sel, ox, oy) {
  if (!sel) {
    // fallback: ox/oy are viewport fractions
    return { x: ox * window.innerWidth, y: oy * window.innerHeight };
  }
  try {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + ox * r.width,
      y: r.top  + oy * r.height,
    };
  } catch {
    return null;
  }
}

/**
 * rAF loop: interpolates the cursor dot between the last two positions.
 */
function animateCursor() {
  cursorRafId = null;
  if (!cursorFrom || !cursorTo) return;

  const now  = performance.now();
  const span = cursorTo.t - cursorFrom.t;
  const t    = span > 0 ? Math.min((now - cursorFrom.t) / span, 1.5) : 1;

  const x = cursorFrom.x + (cursorTo.x - cursorFrom.x) * t;
  const y = cursorFrom.y + (cursorTo.y - cursorFrom.y) * t;

  const el = getCursorEl();
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;

  if (t < 1) cursorRafId = requestAnimationFrame(animateCursor);
}

/**
 * Stop the cursor animation loop and reset state.
 */
function stopCursorAnimation() {
  if (cursorRafId) { cancelAnimationFrame(cursorRafId); cursorRafId = null; }
  cursorFrom = null;
  cursorTo   = null;
}

/**
 * Remove the remote cursor element and stop the animation loop.
 */
function removeCursor() {
  stopCursorAnimation();
  cursorEl?.remove();
  cursorEl = null;
}

// ─── Throttle helper ──────────────────────────────────────────────────────────

/**
 * Returns a throttled version of fn that fires at most once per `ms`.
 * @template {(...args: any[]) => void} T
 * @param {T} fn
 * @param {number} ms
 * @returns {T}
 */
function throttle(fn, ms) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn.apply(this, args);
    }
  };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

/**
 * Safely send a message to the background service worker.
 * Swallows "Extension context invalidated" errors that occur when the
 * extension is reloaded while the content script is still running.
 * @param {object} msg
 */
function runtimeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    // Extension was reloaded — this content script instance is orphaned.
    // Nothing we can do; the new instance will take over on next navigation.
  }
}

/**
 * Send a JSON message if the socket is open.
 * @param {object} msg
 */
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Open a WebSocket connection to the server and attach event handlers.
 */
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(SERVER_URL);

  ws.addEventListener('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);

    if (role === 'host') {
      send({ type: 'host_create', sessionId });
      sendViewport();
    } else if (role === 'guest') {
      send({ type: 'guest_join', sessionId });
      window.addEventListener('resize', onGuestResize, { passive: true });
    }
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    isConnected = false;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close event fires after error, reconnect handled there
  });
}

/**
 * Attempt to reconnect with exponential back-off, up to RECONNECT_MAX times.
 */
function scheduleReconnect() {
  if (!role || reconnectAttempts >= RECONNECT_MAX) {
    if (reconnectAttempts >= RECONNECT_MAX) {
      console.warn('[Mirrory] Max reconnect attempts reached. Giving up.');
      runtimeSend({ type: 'mirrory_disconnected', sessionId });
    }
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * reconnectAttempts;
  console.log(`[Mirrory] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${RECONNECT_MAX})`);
  reconnectTimer = setTimeout(connect, delay);
}

/**
 * Dispatch incoming server messages to the appropriate handler.
 * @param {object} msg
 */
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_created':
      // Confirmed by server — nothing extra needed
      break;

    case 'guest_joined':
      // Confirmed by server — nothing extra needed
      break;

    case 'guest_count':
      runtimeSend({ type: 'mirrory_guest_count', count: msg.count });
      break;

    case 'viewport':
      if (role === 'guest') applyLetterbox(msg.vw, msg.vh);
      break;

    case 'scroll':
      if (role === 'guest') applyScroll(msg.yPct);
      break;

    case 'navigate':
      if (role === 'guest') applyNavigate(msg.url);
      break;

    case 'cursor':
      if (role === 'guest') onCursorPacket(msg.sel, msg.ox, msg.oy);
      break;

    case 'host_disconnected':
      runtimeSend({ type: 'mirrory_host_disconnected' });
      break;

    case 'session_ended':
      teardown();
      runtimeSend({ type: 'mirrory_session_ended' });
      break;

    case 'error':
      console.error('[Mirrory] Server error:', msg.message);
      // "Session not found" means the server has no record of this session
      // (server restart, TTL expired). Tear down immediately instead of
      // retrying — reconnect attempts would keep failing forever.
      if (msg.message === 'Session not found') {
        teardown();
        runtimeSend({ type: 'mirrory_session_ended' });
      }
      break;
  }
}

// ─── Scroll sync ──────────────────────────────────────────────────────────────

/** Prevent scroll echo when host sets scroll position */
let suppressScrollEvent = false;

/**
 * Apply a scroll position received from the host.
 * @param {number} yPct - Scroll position as fraction of scrollable height (0–1)
 */
function applyScroll(yPct) {
  // When zoom is active, scrollHeight is in zoomed (layout) px.
  // innerHeight is in real viewport px, so we must divide by zoom to compare.
  const zoom = hostVW ? Math.min(window.innerWidth / hostVW, window.innerHeight / hostVH) : 1;
  const viewH = window.innerHeight / zoom;
  const maxScroll = document.documentElement.scrollHeight - viewH;
  if (maxScroll <= 0) return;
  suppressScrollEvent = true;
  window.scrollTo({ top: yPct * maxScroll, behavior: 'auto' });
  setTimeout(() => { suppressScrollEvent = false; }, 50);
}

const sendScroll = throttle(() => {
  if (suppressScrollEvent) return;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  const yPct = maxScroll > 0 ? window.scrollY / maxScroll : 0;
  send({ type: 'scroll', yPct });
}, SCROLL_THROTTLE_MS);

// ─── Navigation sync ──────────────────────────────────────────────────────────

/**
 * Navigate the guest tab to a new URL, preserving the ?mirrory= param so
 * the guest stays connected after the page load.
 * @param {string} url
 */
function applyNavigate(url) {
  try {
    const dest = new URL(url);
    dest.searchParams.set('mirrory', sessionId);
    if (window.location.href !== dest.toString()) {
      window.location.href = dest.toString();
    }
  } catch {
    // Malformed URL — ignore
  }
}

/**
 * Intercept link clicks and form submits on the host side and broadcast
 * the destination URL before the browser navigates away.
 * Uses capture phase so it fires before any page-level click handlers.
 * @param {MouseEvent} e
 */
function onHostClick(e) {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  try {
    const dest = new URL(anchor.href, window.location.href);
    // Only sync http/https navigations — skip mailto:, javascript:, #anchors
    if (dest.origin === window.location.origin || dest.protocol === 'https:' || dest.protocol === 'http:') {
      // Strip any existing mirrory param from the URL we broadcast so the
      // guest doesn't receive it doubled
      dest.searchParams.delete('mirrory');
      send({ type: 'navigate', url: dest.toString() });
    }
  } catch {
    // Relative or malformed href — the background's tabs.onUpdated will catch
    // the navigation after the fact
  }
}

/**
 * Intercept form submissions on the host side.
 * @param {SubmitEvent} e
 */
function onHostSubmit(e) {
  const form = e.target;
  if (!form || form.method?.toLowerCase() !== 'get') return;
  try {
    const dest = new URL(form.action || window.location.href, window.location.href);
    new FormData(form); // read fields
    // For GET forms, build the URL with query params
    const data = new URLSearchParams(new FormData(form));
    data.forEach((v, k) => dest.searchParams.set(k, v));
    dest.searchParams.delete('mirrory');
    send({ type: 'navigate', url: dest.toString() });
  } catch {
    // ignore
  }
}

// ─── Cursor tracking (host only) ─────────────────────────────────────────────

/**
 * Broadcast the host viewport size so guests can apply letterbox scaling.
 * Called once on connect and on window resize.
 */
function sendViewport() {
  send({
    type: 'viewport',
    vw: document.documentElement.clientWidth,
    vh: document.documentElement.clientHeight,
  });
}

const sendViewportThrottled = throttle(sendViewport, 200);

/**
 * Build a CSS selector path that uniquely identifies an element by its
 * position in the DOM tree (nth-child chain from <html>).
 * Works without id/class and survives different viewport sizes.
 * @param {Element} el
 * @returns {string}
 */
function domPath(el) {
  const parts = [];
  let node = el;
  while (node && node !== document.documentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.children, node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
    node = parent;
  }
  return parts.join(' > ');
}

function sendCursor(e) {
  const target = document.elementFromPoint(e.clientX, e.clientY);
  // Offset within the element as fraction of its size (0–1),
  // so the guest can reconstruct the exact sub-pixel position.
  let sel = '', ox = 0.5, oy = 0.5;
  if (target && target !== document.documentElement && target !== document.body) {
    sel = domPath(target);
    const r = target.getBoundingClientRect();
    if (r.width > 0)  ox = (e.clientX - r.left) / r.width;
    if (r.height > 0) oy = (e.clientY - r.top)  / r.height;
  } else {
    // Fallback: percentage of viewport (used when hovering html/body)
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    ox = e.clientX / vw;
    oy = e.clientY / vh;
  }
  send({ type: 'cursor', sel, ox, oy });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Attach host-side event listeners for scroll, cursor, and navigation.
 */
function attachHostListeners() {
  window.addEventListener('scroll',   sendScroll,            { passive: true });
  window.addEventListener('mousemove', sendCursor,           { passive: true });
  window.addEventListener('resize',   sendViewportThrottled, { passive: true });
  document.addEventListener('click',  onHostClick,           { capture: true, passive: true });
  document.addEventListener('submit', onHostSubmit,          { capture: true, passive: true });
}

/**
 * Remove host-side event listeners.
 */
function detachHostListeners() {
  window.removeEventListener('scroll',   sendScroll);
  window.removeEventListener('mousemove', sendCursor);
  window.removeEventListener('resize',   sendViewportThrottled);
  document.removeEventListener('click',  onHostClick,  { capture: true });
  document.removeEventListener('submit', onHostSubmit, { capture: true });
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Start the extension as host for the given session.
 * @param {string} sid
 */
function startHost(sid) {
  role = 'host';
  sessionId = sid;
  injectBadge('host');
  attachHostListeners();
  connect();
  runtimeSend({ type: 'mirrory_host_started', sessionId });
}

/**
 * Start the extension as guest for the given session.
 * @param {string} sid
 */
function startGuest(sid) {
  role = 'guest';
  sessionId = sid;
  injectBadge('guest');
  connect();
  runtimeSend({ type: 'mirrory_guest_started', sessionId });
}

/**
 * Terminate the session (called by host or on session_ended).
 */
function teardown() {
  if (role === 'host') {
    send({ type: 'host_kill' });
    detachHostListeners();
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  clearTimeout(reconnectTimer);
  role = null;
  sessionId = null;
  isConnected = false;
  reconnectAttempts = 0;

  window.removeEventListener('resize', onGuestResize);
  removeBadge();
  removeCursor();
  removeLetterbox();

  runtimeSend({ type: 'mirrory_teardown_complete' });
}

// ─── Message bridge (from background / popup) ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'mirrory_start_host':
      startHost(msg.sessionId);
      sendResponse({ ok: true });
      break;

    case 'mirrory_start_guest':
      startGuest(msg.sessionId);
      sendResponse({ ok: true });
      break;

    case 'mirrory_kill':
      teardown();
      sendResponse({ ok: true });
      break;

    case 'mirrory_status':
      sendResponse({ role, sessionId, isConnected });
      break;
  }
  return true; // keep channel open for async responses
});

// ─── Auto-join from URL param ─────────────────────────────────────────────────

/**
 * Check the current URL for a `mirrory` query param and auto-join as guest.
 */
(function checkAutoJoin() {
  try {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('mirrory');
    if (sid && !role) {
      // Small delay to ensure background script is ready
      setTimeout(() => startGuest(sid), 300);
    }
  } catch {
    // URL parse error — ignore
  }
})();
