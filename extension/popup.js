'use strict';

/**
 * Mirrory Popup Script
 *
 * Manages the three popup views:
 *  - idle  : no session active
 *  - host  : user is sharing their browsing
 *  - guest : user is watching a shared session
 */

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const viewIdle   = document.getElementById('view-idle');
const viewHost   = document.getElementById('view-host');
const viewGuest  = document.getElementById('view-guest');
const headerBadge = document.getElementById('header-badge');

const btnStart   = document.getElementById('btn-start');
const btnKill    = document.getElementById('btn-kill');
const btnLeave   = document.getElementById('btn-leave');
const btnCopy    = document.getElementById('btn-copy');

const shareLink  = document.getElementById('share-link');
const guestCount = document.getElementById('guest-count');
const guestInfo  = document.getElementById('guest-info');

// ─── View switcher ────────────────────────────────────────────────────────────

/**
 * Switch the visible popup view.
 * @param {'idle'|'host'|'guest'} view
 */
function showView(view) {
  viewIdle.style.display  = view === 'idle'  ? 'block' : 'none';
  viewHost.style.display  = view === 'host'  ? 'block' : 'none';
  viewGuest.style.display = view === 'guest' ? 'block' : 'none';

  headerBadge.textContent = '';
  headerBadge.className = 'header-badge';

  if (view === 'host') {
    headerBadge.textContent = '● LIVE';
    headerBadge.classList.add('live');
  } else if (view === 'guest') {
    headerBadge.textContent = '👁 WATCHING';
    headerBadge.classList.add('watch');
  }
}

// ─── Share link helpers ───────────────────────────────────────────────────────

/**
 * Build the shareable guest URL for the given session.
 * Opens the current tab URL with a `?mirrory=<sid>` param appended.
 * @param {string} sid
 * @param {string} tabUrl - The host's current tab URL
 * @returns {string}
 */
function buildShareLink(sid, tabUrl) {
  try {
    const u = new URL(tabUrl);
    u.searchParams.set('mirrory', sid);
    return u.toString();
  } catch {
    return `https://example.com/?mirrory=${sid}`;
  }
}

/**
 * Copy text to clipboard and briefly change the button label.
 * @param {string} text
 * @param {HTMLButtonElement} btn
 */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  } catch {
    // Fallback for older / restricted contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    ta.remove();
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}

// ─── Background messaging ─────────────────────────────────────────────────────

/**
 * Send a message to the background service worker.
 * @param {object} msg
 * @returns {Promise<any>}
 */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

// ─── Initialise popup ─────────────────────────────────────────────────────────

/** Current session data cached in popup scope */
let currentSession = null;
let currentTabUrl = '';

/**
 * Bootstrap the popup by querying the background for current session state.
 */
async function init() {
  // Hide all views while loading
  viewIdle.style.display = 'none';
  viewHost.style.display = 'none';
  viewGuest.style.display = 'none';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url || '';

  const { session } = await bg({ type: 'popup_get_status' });
  currentSession = session;

  if (!session) {
    showView('idle');
    return;
  }

  if (session.role === 'host') {
    const link = buildShareLink(session.sessionId, currentTabUrl);
    shareLink.textContent = link;
    shareLink.title = link;
    showView('host');
  } else if (session.role === 'guest') {
    guestInfo.textContent = `Watching session ${session.sessionId}`;
    showView('guest');
  } else {
    showView('idle');
  }
}

// ─── Button handlers ──────────────────────────────────────────────────────────

/**
 * Start a new host session.
 */
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting…';

  const resp = await bg({ type: 'popup_create_session' });

  if (!resp || !resp.ok) {
    btnStart.disabled = false;
    btnStart.textContent = 'Start sharing';
    return;
  }

  currentSession = { role: 'host', sessionId: resp.sessionId, tabId: resp.tabId };
  const link = buildShareLink(resp.sessionId, currentTabUrl);
  shareLink.textContent = link;
  shareLink.title = link;
  showView('host');
});

/**
 * Copy the share link to the clipboard.
 */
btnCopy.addEventListener('click', () => {
  copyToClipboard(shareLink.title || shareLink.textContent, btnCopy);
});

/**
 * End the host session (kill switch).
 */
btnKill.addEventListener('click', async () => {
  btnKill.disabled = true;
  btnKill.textContent = 'Ending…';
  await bg({ type: 'popup_kill_session' });
  currentSession = null;
  showView('idle');
  btnKill.disabled = false;
  btnKill.textContent = 'End session';
});

/**
 * Leave the guest session.
 */
btnLeave.addEventListener('click', async () => {
  btnLeave.disabled = true;
  await bg({ type: 'popup_kill_session' });
  currentSession = null;
  showView('idle');
  btnLeave.disabled = false;
});

// ─── Live guest count updates ─────────────────────────────────────────────────

/**
 * Listen for guest count updates pushed from the background/content scripts.
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'mirrory_guest_count') {
    const n = msg.count ?? 0;
    guestCount.textContent = `${n} guest${n !== 1 ? 's' : ''} connected`;
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
