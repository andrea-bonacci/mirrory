'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const PEER_COLORS = [
  '#6C47FF','#FF4747','#00C49A','#FF8C00','#0088FF',
  '#FF47C4','#47FFD0','#FFD700','#FF6B6B','#7CFC00',
];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const viewIdle    = document.getElementById('view-idle');
const viewHost    = document.getElementById('view-host');
const viewGuest   = document.getElementById('view-guest');
const headerBadge = document.getElementById('header-badge');

const btnStart    = document.getElementById('btn-start');
const btnKill     = document.getElementById('btn-kill');
const btnLeave    = document.getElementById('btn-leave');
const btnCopy     = document.getElementById('btn-copy');

const shareLink   = document.getElementById('share-link');
const guestCount  = document.getElementById('guest-count');
const guestInfo   = document.getElementById('guest-info');
const peerListEl  = document.getElementById('peer-list');

const nameInput     = document.getElementById('name-input');
const colorPreview  = document.getElementById('color-preview');
const colorPicker   = document.getElementById('color-picker');

const toggleHostCursor = document.getElementById('toggle-host-cursor');
const toggleCursors    = document.getElementById('toggle-cursors');
const toggleControl    = document.getElementById('toggle-control');

// ─── Identity ─────────────────────────────────────────────────────────────────

function loadIdentity() {
  try {
    const raw = localStorage.getItem('mirrory_identity');
    if (raw) return JSON.parse(raw);
  } catch {}
  const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  return { name: 'User', color, peerId: Math.random().toString(36).slice(2, 10) };
}

function saveIdentity(id) {
  try { localStorage.setItem('mirrory_identity', JSON.stringify(id)); } catch {}
}

let identity = loadIdentity();

function initIdentityUI() {
  nameInput.value = identity.name;
  colorPreview.style.background = identity.color;

  // Build colour swatches
  colorPicker.innerHTML = '';
  PEER_COLORS.forEach(c => {
    const s = document.createElement('div');
    s.className = 'color-swatch' + (c === identity.color ? ' selected' : '');
    s.style.background = c;
    s.title = c;
    s.addEventListener('click', () => {
      identity.color = c;
      saveIdentity(identity);
      colorPreview.style.background = c;
      colorPicker.querySelectorAll('.color-swatch').forEach(sw =>
        sw.classList.toggle('selected', sw.title === c));
      notifyIdentityChange();
    });
    colorPicker.appendChild(s);
  });

  // Toggle colour picker
  colorPreview.addEventListener('click', () => {
    colorPicker.classList.toggle('open');
  });

  // Name change
  nameInput.addEventListener('input', () => {
    identity.name = nameInput.value.trim() || 'User';
    saveIdentity(identity);
    notifyIdentityChange();
  });
}

function notifyIdentityChange() {
  // Tell the content script so it can push peer_identity to the server
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, {
      type: 'mirrory_update_identity',
      name: identity.name,
      color: identity.color,
    }).catch(() => {});
  });
}

// ─── View switcher ────────────────────────────────────────────────────────────

function showView(view) {
  viewIdle.style.display  = view === 'idle'  ? 'block' : 'none';
  viewHost.style.display  = view === 'host'  ? 'block' : 'none';
  viewGuest.style.display = view === 'guest' ? 'block' : 'none';

  headerBadge.textContent = '';
  headerBadge.className = 'header-badge';
  if (view === 'host')  { headerBadge.textContent = '● LIVE';      headerBadge.classList.add('live');  }
  if (view === 'guest') { headerBadge.textContent = '👁 WATCHING'; headerBadge.classList.add('watch'); }
}

// ─── Share link ───────────────────────────────────────────────────────────────

function buildShareLink(sid, tabUrl) {
  try {
    const u = new URL(tabUrl);
    u.searchParams.set('mirrory', sid);
    return u.toString();
  } catch {
    return `https://example.com/?mirrory=${sid}`;
  }
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  btn.textContent = 'Copied!'; btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
}

// ─── Peer list (host view) ────────────────────────────────────────────────────

function renderPeerList(peerArray) {
  peerListEl.innerHTML = '';
  const guests = peerArray.filter(p => p.role === 'guest');
  if (guests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'peer-empty';
    empty.textContent = 'No guests yet';
    peerListEl.appendChild(empty);
    return;
  }
  for (const p of guests) {
    // Header row
    const row = document.createElement('div');
    row.className = 'peer-row';
    row.style.borderBottom = 'none';
    row.style.paddingBottom = '4px';

    const dot = document.createElement('div');
    dot.className = 'peer-dot';
    dot.style.background = p.color;

    const name = document.createElement('div');
    name.className = 'peer-name';
    name.textContent = p.name;

    const kickBtn = document.createElement('button');
    kickBtn.className = 'kick-btn';
    kickBtn.textContent = 'Kick';
    kickBtn.addEventListener('click', () => kickPeer(p.peerId));

    row.appendChild(dot); row.appendChild(name); row.appendChild(kickBtn);

    // Per-guest controls row
    const controls = document.createElement('div');
    controls.className = 'peer-controls';

    const cursorOn = p.cursorVisible !== false;
    const ctrlOn   = p.canControl   !== false;

    controls.appendChild(_miniToggleEl(`cursor-${p.peerId}`, 'Cursor', cursorOn, (val) => {
      sendPeerSettings(p.peerId, { cursorVisible: val });
    }));
    controls.appendChild(_miniToggleEl(`ctrl-${p.peerId}`, 'Control', ctrlOn, (val) => {
      sendPeerSettings(p.peerId, { canControl: val });
    }));

    const wrap = document.createElement('div');
    wrap.style.borderBottom = '1px solid var(--border)';
    wrap.style.paddingBottom = '4px';
    wrap.style.marginBottom = '4px';
    wrap.appendChild(row);
    wrap.appendChild(controls);
    peerListEl.appendChild(wrap);
  }
}

function _miniToggleEl(id, label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'peer-mini-toggle';
  wrap.htmlFor = id;
  wrap.textContent = label + ' ';

  const tog = document.createElement('label');
  tog.className = 'mini-toggle';
  const inp = document.createElement('input');
  inp.type = 'checkbox'; inp.id = id; inp.checked = checked;
  inp.addEventListener('change', () => onChange(inp.checked));
  const track = document.createElement('div');
  track.className = 'mini-toggle-track';
  tog.appendChild(inp); tog.appendChild(track);
  wrap.appendChild(tog);
  return wrap;
}

function kickPeer(targetPeerId) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'mirrory_kick_peer', targetPeerId }).catch(() => {});
  });
}

// ─── Background messaging ─────────────────────────────────────────────────────

function bg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// ─── Host settings ────────────────────────────────────────────────────────────

let currentSession = null;
let currentTabUrl  = '';

function sendSettings() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, {
      type: 'mirrory_host_settings',
      cursorsVisible:   toggleCursors.checked,
      showHostCursor:   toggleHostCursor.checked,
      guestsCanControl: toggleControl.checked,
    }).catch(() => {});
  });
}

function sendPeerSettings(targetPeerId, settings) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'mirrory_peer_settings', targetPeerId, ...settings }).catch(() => {});
  });
}

toggleHostCursor.addEventListener('change', sendSettings);
toggleCursors.addEventListener('change', sendSettings);
toggleControl.addEventListener('change', sendSettings);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  viewIdle.style.display = 'none';
  viewHost.style.display = 'none';
  viewGuest.style.display = 'none';

  initIdentityUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url || '';

  const { session } = await bg({ type: 'popup_get_status' });
  currentSession = session;

  if (!session) { showView('idle'); return; }

  if (session.role === 'host') {
    const link = buildShareLink(session.sessionId, currentTabUrl);
    shareLink.textContent = link;
    shareLink.title = link;

    const stored = await chrome.storage.session.get(['mirroryGuestCount', 'mirroryPeers', 'mirrorySettings']);
    const n = stored.mirroryGuestCount ?? 0;
    guestCount.textContent = `${n} guest${n !== 1 ? 's' : ''} connected`;
    if (stored.mirroryPeers) renderPeerList(stored.mirroryPeers);
    if (stored.mirrorySettings) {
      toggleHostCursor.checked = stored.mirrorySettings.showHostCursor   ?? true;
      toggleCursors.checked    = stored.mirrorySettings.cursorsVisible   ?? true;
      toggleControl.checked    = stored.mirrorySettings.guestsCanControl ?? false;
    }
    showView('host');
  } else if (session.role === 'guest') {
    guestInfo.textContent = `Watching session ${session.sessionId}`;
    showView('guest');
  } else {
    showView('idle');
  }
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting…';
  const resp = await bg({ type: 'popup_create_session' });
  if (!resp?.ok) { btnStart.disabled = false; btnStart.textContent = 'Start sharing'; return; }
  currentSession = { role: 'host', sessionId: resp.sessionId, tabId: resp.tabId };
  const link = buildShareLink(resp.sessionId, currentTabUrl);
  shareLink.textContent = link; shareLink.title = link;
  renderPeerList([]);
  showView('host');
});

btnCopy.addEventListener('click', () => copyToClipboard(shareLink.title || shareLink.textContent, btnCopy));

btnKill.addEventListener('click', async () => {
  btnKill.disabled = true; btnKill.textContent = 'Ending…';
  await bg({ type: 'popup_kill_session' });
  currentSession = null; showView('idle');
  btnKill.disabled = false; btnKill.textContent = 'End session';
});

btnLeave.addEventListener('click', async () => {
  btnLeave.disabled = true;
  await bg({ type: 'popup_kill_session' });
  currentSession = null; showView('idle');
  btnLeave.disabled = false;
});

// ─── Live updates from background ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'mirrory_guest_count') {
    const n = msg.count ?? 0;
    guestCount.textContent = `${n} guest${n !== 1 ? 's' : ''} connected`;
  }
  if (msg.type === 'mirrory_peer_list') {
    renderPeerList(msg.peers);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
