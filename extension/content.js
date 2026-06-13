// ─── Configuration ───────────────────────────────────────────────────────────
const SERVER_URL = 'wss://mirrory-server.up.railway.app';
const RECONNECT_MAX = 3;
const RECONNECT_DELAY_MS = 2000;
const CURSOR_THROTTLE_MS = 50;
const SCROLL_THROTTLE_MS = 100;

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
    transition: 'left 0.05s linear, top 0.05s linear',
  });
  document.body.appendChild(cursorEl);
  return cursorEl;
}

/**
 * Move the cursor to a viewport-relative position.
 * @param {number} xPct - Cursor X as fraction of viewport width (0–1)
 * @param {number} yPct - Cursor Y as fraction of viewport height (0–1)
 */
function moveCursor(xPct, yPct) {
  const el = getCursorEl();
  el.style.left = `${xPct * window.innerWidth}px`;
  el.style.top = `${yPct * window.innerHeight}px`;
}

/**
 * Remove the remote cursor element.
 */
function removeCursor() {
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
    } else if (role === 'guest') {
      send({ type: 'guest_join', sessionId });
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
      chrome.runtime.sendMessage({ type: 'mirrory_disconnected', sessionId });
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
      chrome.runtime.sendMessage({ type: 'mirrory_guest_count', count: msg.count });
      break;

    case 'scroll':
      if (role === 'guest') applyScroll(msg.yPct);
      break;

    case 'navigate':
      if (role === 'guest') applyNavigate(msg.url);
      break;

    case 'cursor':
      if (role === 'guest') moveCursor(msg.xPct, msg.yPct);
      break;

    case 'host_disconnected':
      chrome.runtime.sendMessage({ type: 'mirrory_host_disconnected' });
      break;

    case 'session_ended':
      teardown();
      chrome.runtime.sendMessage({ type: 'mirrory_session_ended' });
      break;

    case 'error':
      console.error('[Mirrory] Server error:', msg.message);
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
 * Navigate the guest tab to a new URL.
 * @param {string} url
 */
function applyNavigate(url) {
  if (window.location.href !== url) {
    window.location.href = url;
  }
}

// ─── Cursor tracking (host only) ─────────────────────────────────────────────

const sendCursor = throttle((e) => {
  const xPct = e.clientX / window.innerWidth;
  const yPct = e.clientY / window.innerHeight;
  send({ type: 'cursor', xPct, yPct });
}, CURSOR_THROTTLE_MS);

// ─── Event listeners ──────────────────────────────────────────────────────────

/**
 * Attach host-side event listeners for scroll and cursor.
 */
function attachHostListeners() {
  window.addEventListener('scroll', sendScroll, { passive: true });
  window.addEventListener('mousemove', sendCursor, { passive: true });
}

/**
 * Remove host-side event listeners.
 */
function detachHostListeners() {
  window.removeEventListener('scroll', sendScroll);
  window.removeEventListener('mousemove', sendCursor);
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
  // Notify background to update badge icon
  chrome.runtime.sendMessage({ type: 'mirrory_host_started', sessionId });
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
  chrome.runtime.sendMessage({ type: 'mirrory_guest_started', sessionId });
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

  removeBadge();
  removeCursor();

  chrome.runtime.sendMessage({ type: 'mirrory_teardown_complete' });
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
