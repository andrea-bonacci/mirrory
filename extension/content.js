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
//  Works on any screen size combination.  Math:
//    scale = min(guestW/hostW, guestH/hostH)   — fit host rect in guest window
//    rectW = hostW * scale,  rectH = hostH * scale
//    barX  = (guestW - rectW) / 2              — centre horizontally
//    barY  = (guestH - rectH) / 2              — centre vertically
//
//  Implementation:
//  1. A <div id="mirrory-wrap"> wraps all body children.
//     Its inline style (JS .style.setProperty with 'important') cannot be
//     overridden by any site stylesheet.
//     Size: hostW × hostH.  Transform: translate(barX,barY) scale(scale).
//  2. A MutationObserver moves any new body children into the wrapper so
//     dynamically injected modals/widgets are also scaled.
//  3. Four fixed black divs cover the bars outside the rectangle.
//  4. <body>/<html> get inline !important overrides to remove their own
//     margins/padding that would otherwise shift the wrapper.

let hostVW = 0;
let hostVH = 0;
let _lbBarX  = 0;
let _lbBarY  = 0;
let _lbRectW = 0;
let _lbRectH = 0;
let _lbWrap     = null;
let _lbObserver = null;
let _lbBarEls   = [];

function _setImp(el, prop, val) {
  el.style.setProperty(prop, val, 'important');
}

function applyLetterbox(hvw, hvh) {
  if (!hvw || !hvh) return;
  hostVW = hvw;
  hostVH = hvh;

  const gw    = window.innerWidth;
  const gh    = window.innerHeight;
  const scale = Math.min(gw / hvw, gh / hvh);
  const rectW = hvw * scale;
  const rectH = hvh * scale;
  const barX  = Math.round((gw - rectW) / 2);
  const barY  = Math.round((gh - rectH) / 2);

  _lbBarX = barX; _lbBarY = barY; _lbRectW = rectW; _lbRectH = rectH;

  // ── 1. Wrapper ────────────────────────────────────────────────────────────
  if (!_lbWrap) {
    _lbWrap = document.createElement('div');
    _lbWrap.id = 'mirrory-wrap';
    // absorb all current body children
    while (document.body.firstChild) _lbWrap.appendChild(document.body.firstChild);
    document.body.appendChild(_lbWrap);

    // ── 2. MutationObserver — keep future children inside wrapper ──────────
    _lbObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node !== _lbWrap && !_lbBarEls.includes(node)) {
            _lbWrap.appendChild(node);
          }
        }
      }
    });
    _lbObserver.observe(document.body, { childList: true });
  }

  // wrapper: fixed size = host viewport, scaled + translated into position
  _setImp(_lbWrap, 'position',         'absolute');
  _setImp(_lbWrap, 'top',              '0px');
  _setImp(_lbWrap, 'left',             '0px');
  _setImp(_lbWrap, 'width',            hvw + 'px');
  _setImp(_lbWrap, 'height',           hvh + 'px');
  _setImp(_lbWrap, 'transform-origin', '0 0');
  _setImp(_lbWrap, 'transform',        `translate(${barX}px,${barY}px) scale(${scale.toFixed(8)})`);
  _setImp(_lbWrap, 'overflow',         'hidden');

  // ── 3. Neutralise body/html so they don't add extra space ─────────────────
  for (const prop of ['margin','padding','border','outline']) {
    _setImp(document.body,             prop, '0px');
    _setImp(document.documentElement,  prop, '0px');
  }
  _setImp(document.body,            'overflow',   'hidden');
  _setImp(document.body,            'background', '#000');
  _setImp(document.body,            'width',      gw + 'px');
  _setImp(document.body,            'height',     gh + 'px');
  _setImp(document.body,            'position',   'relative');  // wrapper absolute positioning needs this
  _setImp(document.documentElement, 'overflow',   'hidden');
  _setImp(document.documentElement, 'width',      gw + 'px');
  _setImp(document.documentElement, 'height',     gh + 'px');

  // ── 4. Black bars ─────────────────────────────────────────────────────────
  if (_lbBarEls.length === 0) {
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.id = 'mirrory-bar-' + i;
      _setImp(el, 'position',       'fixed');
      _setImp(el, 'background',     '#000');
      _setImp(el, 'pointer-events', 'none');
      _setImp(el, 'z-index',        '2147483645');
      _setImp(el, 'margin',         '0');
      _setImp(el, 'padding',        '0');
      document.documentElement.appendChild(el);
      _lbBarEls.push(el);
    }
  }
  _posBar(_lbBarEls[0], 0,            0,            gw,               barY);
  _posBar(_lbBarEls[1], barY + rectH, 0,            gw,               gh - barY - rectH);
  _posBar(_lbBarEls[2], 0,            0,            barX,             gh);
  _posBar(_lbBarEls[3], 0,            barX + rectW, gw - barX - rectW, gh);
}

function _posBar(el, top, left, w, h) {
  _setImp(el, 'top',    top    + 'px');
  _setImp(el, 'left',   left   + 'px');
  _setImp(el, 'width',  Math.max(0, w) + 'px');
  _setImp(el, 'height', Math.max(0, h) + 'px');
}

function removeLetterbox() {
  _lbObserver?.disconnect(); _lbObserver = null;
  if (_lbWrap) {
    while (_lbWrap.firstChild) document.body.insertBefore(_lbWrap.firstChild, _lbWrap);
    _lbWrap.remove(); _lbWrap = null;
  }
  _lbBarEls.forEach(el => el.remove()); _lbBarEls = [];
  document.body.style.cssText = '';
  document.documentElement.style.cssText = '';
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
 * Receive a new cursor position packet from the host and kick off rAF loop.
 * @param {number} xPct
 * @param {number} yPct
 */
function onCursorPacket(xPct, yPct) {
  cursorFrom = cursorTo ?? { xPct, yPct, t: performance.now() };
  cursorTo   = { xPct, yPct, t: performance.now() };
  if (!cursorRafId) cursorRafId = requestAnimationFrame(animateCursor);
}

/**
 * rAF loop: interpolates the cursor dot between the last two received positions.
 * Extrapolates briefly past cursorTo so motion looks continuous even when the
 * next packet is slightly late.
 */
function animateCursor() {
  cursorRafId = null;
  if (!cursorFrom || !cursorTo) return;

  const now      = performance.now();
  const span     = cursorTo.t - cursorFrom.t;
  // t=0 → cursorFrom, t=1 → cursorTo; allow slight overshoot (max 1.5)
  const t        = span > 0 ? Math.min((now - cursorFrom.t) / span, 1.5) : 1;

  const xPct = cursorFrom.xPct + (cursorTo.xPct - cursorFrom.xPct) * t;
  const yPct = cursorFrom.yPct + (cursorTo.yPct - cursorFrom.yPct) * t;

  const el = getCursorEl();
  // Map host fractions onto the content rectangle in guest px.
  // _lbBarX/Y = top-left corner of the rectangle, _lbRectW/H = its size.
  // Falls back to full window if viewport message not yet received.
  const left = _lbRectW
    ? _lbBarX + xPct * _lbRectW
    : xPct * window.innerWidth;
  const top = _lbRectH
    ? _lbBarY + yPct * _lbRectH
    : yPct * window.innerHeight;
  el.style.left = `${left}px`;
  el.style.top  = `${top}px`;

  // Keep animating until motion has settled (t reached 1)
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
      if (role === 'guest') onCursorPacket(msg.xPct, msg.yPct);
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
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  if (maxScroll <= 0) return;
  suppressScrollEvent = true;
  window.scrollTo({ top: yPct * maxScroll, behavior: 'auto' });
  // Reset flag after event loop tick
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

function sendCursor(e) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const xPct = e.clientX / vw;
  const yPct = e.clientY / vh;
  send({ type: 'cursor', xPct, yPct });
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
