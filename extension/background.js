'use strict';

/**
 * Mirrory – Background Service Worker (Manifest V3)
 */

const SESSION_ID_BYTES = 4;

// ─── Badge ────────────────────────────────────────────────────────────────────

function setBadge(tabId, state) {
  const configs = {
    live:  { text: 'LIVE', color: '#6C47FF' },
    watch: { text: 'VIEW', color: '#FF4747' },
    off:   { text: '',     color: '#888888' },
  };
  const cfg = configs[state] || configs.off;
  chrome.action.setBadgeText({ text: cfg.text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: cfg.color, tabId });
}

// ─── Session ID ───────────────────────────────────────────────────────────────

function generateSessionId() {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function saveSession(info) {
  await chrome.storage.session.set({ mirrorySession: info });
}
async function clearSession() {
  await chrome.storage.session.remove('mirrorySession');
}
async function getSession() {
  const r = await chrome.storage.session.get('mirrorySession');
  return r.mirrorySession || null;
}

// ─── Content script bridge ────────────────────────────────────────────────────

async function sendToContent(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (err) { console.warn(`[Mirrory bg] tab ${tabId}:`, err.message); return null; }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      // ── Popup: create host session ──
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

      // ── Popup: kill / leave session ──
      case 'popup_kill_session': {
        const session = await getSession();
        if (session) {
          await sendToContent(session.tabId, { type: 'mirrory_kill' });
          setBadge(session.tabId, 'off');
          await clearSession();
          await chrome.storage.session.remove(['mirroryGuestCount', 'mirroryPeers', 'mirrorySettings']);
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Popup: get status ──
      case 'popup_get_status': {
        const session = await getSession();
        sendResponse({ session });
        break;
      }

      // ── Content: host started ──
      case 'mirrory_host_started': {
        const tabId = sender.tab?.id;
        if (tabId) setBadge(tabId, 'live');
        break;
      }

      // ── Content: guest started ──
      case 'mirrory_guest_started': {
        const tabId = sender.tab?.id;
        if (!tabId) break;
        setBadge(tabId, 'watch');
        const existing = await getSession();
        if (!existing || existing.role !== 'host') {
          await saveSession({ role: 'guest', sessionId: msg.sessionId, tabId });
        }
        break;
      }

      // ── Content: session ended / teardown ──
      case 'mirrory_session_ended':
      case 'mirrory_teardown_complete': {
        const tabId = sender.tab?.id;
        if (tabId) setBadge(tabId, 'off');
        await clearSession();
        await chrome.storage.session.remove(['mirroryGuestCount', 'mirroryPeers', 'mirrorySettings']);
        break;
      }

      // ── Content: guest count update ──
      case 'mirrory_guest_count': {
        await chrome.storage.session.set({ mirroryGuestCount: msg.count ?? 0 });
        break;
      }

      // ── Content: peer list update ──
      case 'mirrory_peer_list': {
        await chrome.storage.session.set({ mirroryPeers: msg.peers });
        // Forward to popup if open
        chrome.runtime.sendMessage({ type: 'mirrory_peer_list', peers: msg.peers }).catch(() => {});
        break;
      }

      // ── Content: settings update ──
      case 'mirrory_settings_update': {
        await chrome.storage.session.set({ mirrorySettings: {
          cursorsVisible:   msg.cursorsVisible,
          guestsCanControl: msg.guestsCanControl,
        }});
        break;
      }

      // ── Popup → content: update identity ──
      case 'mirrory_update_identity': {
        const session = await getSession();
        if (session) await sendToContent(session.tabId, msg);
        break;
      }

      // ── Popup → content: kick peer ──
      case 'mirrory_kick_peer': {
        const session = await getSession();
        if (session) await sendToContent(session.tabId, msg);
        break;
      }

      // ── Popup → content: host settings ──
      case 'mirrory_host_settings': {
        const session = await getSession();
        if (session) await sendToContent(session.tabId, msg);
        break;
      }

      // ── Popup → content: per-peer settings ──
      case 'mirrory_peer_settings': {
        const session = await getSession();
        if (session) await sendToContent(session.tabId, msg);
        break;
      }
    }
  })();

  return true;
});

// ─── Tab navigation tracking (host) ──────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const session = await getSession();
  if (!session || session.role !== 'host' || session.tabId !== tabId) return;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://')) return;
  await sendToContent(tabId, { type: 'mirrory_start_host', sessionId: session.sessionId });
});
