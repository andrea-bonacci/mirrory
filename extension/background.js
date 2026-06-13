'use strict';

/**
 * Mirrory – Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Generate unique session IDs
 *  - Persist session state in chrome.storage.session (cleared on browser restart)
 *  - Relay start/kill commands to the active tab's content script
 *  - Update the action badge (LIVE / WATCH / idle)
 *  - Forward navigation events to the content script when host changes tabs
 */

const SESSION_ID_BYTES = 4; // 8 hex chars

// ─── Badge helpers ────────────────────────────────────────────────────────────

/**
 * Set the browser action badge for the given tab.
 * @param {number} tabId
 * @param {'live'|'watch'|'off'} state
 */
function setBadge(tabId, state) {
  const configs = {
    live:  { text: 'LIVE',  color: '#6C47FF' },
    watch: { text: 'VIEW',  color: '#FF4747' },
    off:   { text: '',      color: '#888888' },
  };
  const cfg = configs[state] || configs.off;
  chrome.action.setBadgeText({ text: cfg.text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: cfg.color, tabId });
}

// ─── Session ID generation ────────────────────────────────────────────────────

/**
 * Generate a cryptographically random hex session ID.
 * @returns {string}
 */
function generateSessionId() {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Persist current session info.
 * @param {{ role: string, sessionId: string, tabId: number }} info
 */
async function saveSession(info) {
  await chrome.storage.session.set({ mirrorySession: info });
}

/**
 * Clear persisted session info.
 */
async function clearSession() {
  await chrome.storage.session.remove('mirrorySession');
}

/**
 * Retrieve persisted session info.
 * @returns {Promise<{role: string, sessionId: string, tabId: number}|null>}
 */
async function getSession() {
  const result = await chrome.storage.session.get('mirrorySession');
  return result.mirrorySession || null;
}

// ─── Content script bridge ────────────────────────────────────────────────────

/**
 * Send a message to the content script running in a specific tab.
 * @param {number} tabId
 * @param {object} msg
 * @returns {Promise<any>}
 */
async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    console.warn(`[Mirrory bg] Could not reach content script in tab ${tabId}:`, err.message);
    return null;
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

/**
 * Central message dispatcher — listens to messages from popup and content scripts.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      // ── Popup requests a new host session ──
      case 'popup_create_session': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { sendResponse({ ok: false, error: 'No active tab' }); return; }

        const sid = generateSessionId();
        await saveSession({ role: 'host', sessionId: sid, tabId: tab.id });
        setBadge(tab.id, 'live');

        await sendToContent(tab.id, { type: 'mirrory_start_host', sessionId: sid });
        sendResponse({ ok: true, sessionId: sid, tabId: tab.id });
        break;
      }

      // ── Popup requests session kill ──
      case 'popup_kill_session': {
        const session = await getSession();
        if (session) {
          await sendToContent(session.tabId, { type: 'mirrory_kill' });
          setBadge(session.tabId, 'off');
          await clearSession();
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Popup polls current status ──
      case 'popup_get_status': {
        const session = await getSession();
        sendResponse({ session });
        break;
      }

      // ── Content script reports host started ──
      case 'mirrory_host_started': {
        const tabId = sender.tab?.id;
        if (tabId) setBadge(tabId, 'live');
        break;
      }

      // ── Content script reports guest started ──
      case 'mirrory_guest_started': {
        const tabId = sender.tab?.id;
        if (tabId) {
          setBadge(tabId, 'watch');
          await saveSession({ role: 'guest', sessionId: msg.sessionId, tabId });
        }
        break;
      }

      // ── Session ended (from server) ──
      case 'mirrory_session_ended':
      case 'mirrory_teardown_complete': {
        const tabId = sender.tab?.id;
        if (tabId) setBadge(tabId, 'off');
        await clearSession();
        break;
      }

      // ── Guest count update (relay to popup if open) ──
      case 'mirrory_guest_count': {
        // Popup listens via its own onMessage; just pass it through
        break;
      }
    }
  })();

  return true; // keep message channel open for async
});

// ─── Tab navigation tracking (host only) ─────────────────────────────────────

/**
 * When the host navigates to a new URL, send it to the content script
 * so it can broadcast a `navigate` event to all guests.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const session = await getSession();
  if (!session || session.role !== 'host' || session.tabId !== tabId) return;

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://')) return;

  // Re-inject content script on navigation (SPA or hard nav)
  await sendToContent(tabId, { type: 'mirrory_start_host', sessionId: session.sessionId });
});
