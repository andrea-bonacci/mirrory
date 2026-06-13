// ─── Configuration ───────────────────────────────────────────────────────────
const SERVER_URL = 'ws://localhost:3000';
const RECONNECT_MAX = 3;
const RECONNECT_DELAY_MS = 2000;
const SCROLL_THROTTLE_MS = 100;

// ─── Peer identity (persisted in localStorage) ───────────────────────────────
const PEER_COLORS = [
  '#6C47FF','#FF4747','#00C49A','#FF8C00','#0088FF',
  '#FF47C4','#47FFD0','#FFD700','#FF6B6B','#7CFC00',
];

function loadIdentity() {
  try {
    const raw = localStorage.getItem('mirrory_identity');
    if (raw) return JSON.parse(raw);
  } catch {}
  // Generate a fresh identity
  const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  const id = { name: 'User', color, peerId: _genId() };
  saveIdentity(id);
  return id;
}

function saveIdentity(id) {
  try { localStorage.setItem('mirrory_identity', JSON.stringify(id)); } catch {}
}

function _genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─── State ────────────────────────────────────────────────────────────────────
let ws            = null;
let role          = null;       // 'host' | 'guest' | null
let sessionId     = null;
let myPeerId      = null;
let identity      = null;       // { name, color, peerId }
let reconnectAttempts = 0;
let reconnectTimer    = null;
let isConnected       = false;

// Session settings (synced from server)
let cursorsVisible   = true;
let showHostCursor   = true;
let guestsCanControl = false;

// Peers currently in the session: Map<peerId, { peerId, name, color, role }>
const peers = new Map();

// ─── Identity overlay (top-right panel) ──────────────────────────────────────

let _identityPanel = null;

function injectIdentityOverlay() {
  if (document.getElementById('mirrory-identity-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'mirrory-identity-overlay';
  _applyFixed(overlay, {
    top: '12px', right: '12px',
    zIndex: '2147483647',
    fontFamily: 'system-ui,sans-serif',
    fontSize: '12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px',
    pointerEvents: 'none',
    userSelect: 'none',
  });

  // Badge
  const badge = document.createElement('div');
  badge.id = 'mirrory-badge';
  _applyFixed(badge, {
    padding: '4px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    color: '#fff',
    background: role === 'host' ? '#6C47FF' : '#FF4747',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    cursor: 'pointer',
    pointerEvents: 'auto',
  });
  badge.textContent = role === 'host' ? '● LIVE' : '👁 WATCHING';
  badge.title = 'Click to open settings';
  badge.addEventListener('click', toggleIdentityPanel);
  overlay.appendChild(badge);

  // Panel (hidden by default)
  _identityPanel = _buildIdentityPanel();
  overlay.appendChild(_identityPanel);

  document.documentElement.appendChild(overlay);
}

function _buildIdentityPanel() {
  const panel = document.createElement('div');
  panel.id = 'mirrory-panel';
  _applyFixed(panel, {
    background: 'rgba(20,20,30,0.96)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '12px',
    padding: '14px',
    minWidth: '220px',
    display: 'none',
    flexDirection: 'column',
    gap: '10px',
    pointerEvents: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    color: '#fff',
  });

  // ── Identity section ──────────────────────────────────────────────────────
  const section = _panelSection('Your identity');

  // Name input
  const nameRow = _row();
  const nameLabel = _label('Name');
  const nameInput = document.createElement('input');
  _applyFixed(nameInput, {
    flex: '1', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '6px', color: '#fff', padding: '4px 8px', fontSize: '12px', outline: 'none',
  });
  nameInput.value = identity?.name || 'User';
  nameInput.maxLength = 32;
  nameInput.addEventListener('input', () => {
    if (!identity) return;
    identity.name = nameInput.value || 'User';
    saveIdentity(identity);
    send({ type: 'peer_identity', name: identity.name, color: identity.color });
  });
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  section.appendChild(nameRow);

  // Color swatches
  const colorRow = _row();
  colorRow.style.flexWrap = 'wrap';
  colorRow.style.gap = '5px';
  PEER_COLORS.forEach(c => {
    const swatch = document.createElement('div');
    _applyFixed(swatch, {
      width: '18px', height: '18px', borderRadius: '50%',
      background: c, cursor: 'pointer',
      border: c === identity?.color ? '2px solid #fff' : '2px solid transparent',
      transition: 'border-color 0.15s',
    });
    swatch.title = c;
    swatch.addEventListener('click', () => {
      if (!identity) return;
      identity.color = c;
      saveIdentity(identity);
      send({ type: 'peer_identity', name: identity.name, color: identity.color });
      // Update swatch borders
      colorRow.querySelectorAll('div').forEach(s => {
        s.style.borderColor = s.title === c ? '#fff' : 'transparent';
      });
      updateMyCursorColor();
    });
    colorRow.appendChild(swatch);
  });
  section.appendChild(colorRow);
  panel.appendChild(section);

  // ── Host-only controls ─────────────────────────────────────────────────────
  if (role === 'host') {
    panel.appendChild(_buildHostControls());
  }

  return panel;
}

function _buildHostControls() {
  const section = _panelSection('Session controls');

  // Toggle: show host cursor (to guests)
  const hostCursorRow = _toggleRow('Show my cursor', showHostCursor, (val) => {
    showHostCursor = val;
    send({ type: 'host_settings', cursorsVisible, showHostCursor, guestsCanControl });
  });
  hostCursorRow.id = 'mirrory-toggle-host-cursor';
  section.appendChild(hostCursorRow);

  // Toggle: show all guest cursors
  const cursorRow = _toggleRow('Show all cursors', cursorsVisible, (val) => {
    cursorsVisible = val;
    send({ type: 'host_settings', cursorsVisible, showHostCursor, guestsCanControl });
    if (!val) removeAllPeerCursors();
  });
  cursorRow.id = 'mirrory-toggle-cursors';
  section.appendChild(cursorRow);

  // Toggle: guests can control (global default)
  const controlRow = _toggleRow('Guests can control', guestsCanControl, (val) => {
    guestsCanControl = val;
    send({ type: 'host_settings', cursorsVisible, showHostCursor, guestsCanControl });
  });
  controlRow.id = 'mirrory-toggle-control';
  section.appendChild(controlRow);

  // Participant list
  const listTitle = _label('Participants');
  listTitle.style.marginTop = '6px';
  section.appendChild(listTitle);

  const peerListEl = document.createElement('div');
  peerListEl.id = 'mirrory-peer-list';
  _applyFixed(peerListEl, { display: 'flex', flexDirection: 'column', gap: '4px' });
  section.appendChild(peerListEl);

  return section;
}

function _refreshHostPeerList() {
  const el = document.getElementById('mirrory-peer-list');
  if (!el) return;
  el.innerHTML = '';
  const guests = [...peers.values()].filter(p => p.peerId !== myPeerId);
  if (guests.length === 0) {
    const empty = document.createElement('span');
    empty.textContent = 'No guests yet';
    _applyFixed(empty, { color: 'rgba(255,255,255,0.4)', fontSize: '11px' });
    el.appendChild(empty);
    return;
  }
  for (const p of guests) {
    // Header row: dot + name + kick
    const headerRow = _row();
    const dot = document.createElement('span');
    _applyFixed(dot, { width: '8px', height: '8px', borderRadius: '50%', background: p.color, flexShrink: '0' });
    const name = document.createElement('span');
    name.textContent = p.name;
    _applyFixed(name, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' });
    const kickBtn = document.createElement('button');
    _applyFixed(kickBtn, {
      background: 'rgba(255,71,71,0.2)', border: '1px solid rgba(255,71,71,0.4)',
      color: '#ff4747', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer',
    });
    kickBtn.textContent = 'Kick';
    kickBtn.addEventListener('click', () => send({ type: 'host_kick', targetPeerId: p.peerId }));
    headerRow.appendChild(dot); headerRow.appendChild(name); headerRow.appendChild(kickBtn);

    // Per-peer toggle row
    const togglesRow = _row();
    _applyFixed(togglesRow, { paddingLeft: '16px', gap: '10px' });

    const cursorOn = p.cursorVisible !== false; // default true if not set
    const ctrlOn   = p.canControl   !== false;

    const cursorToggle = _miniToggle('Cursor', cursorOn, (val) => {
      send({ type: 'host_peer_settings', targetPeerId: p.peerId, cursorVisible: val });
      if (!val) removePeerCursor(p.peerId);
    });
    const ctrlToggle = _miniToggle('Control', ctrlOn, (val) => {
      send({ type: 'host_peer_settings', targetPeerId: p.peerId, canControl: val });
    });
    togglesRow.appendChild(cursorToggle);
    togglesRow.appendChild(ctrlToggle);

    const wrap = document.createElement('div');
    _applyFixed(wrap, { display: 'flex', flexDirection: 'column', gap: '3px',
      padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' });
    wrap.appendChild(headerRow);
    wrap.appendChild(togglesRow);
    el.appendChild(wrap);
  }
}

function _miniToggle(label, initial, onChange) {
  const wrap = _row();
  _applyFixed(wrap, { gap: '4px' });
  const lbl = document.createElement('span');
  lbl.textContent = label;
  _applyFixed(lbl, { fontSize: '10px', color: 'rgba(255,255,255,0.5)' });
  let on = initial;
  const tog = document.createElement('div');
  const knob = document.createElement('span');
  _applyFixed(knob, { position: 'absolute', top: '2px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 0.15s' });
  const updateTog = () => {
    _applyFixed(tog, { width: '26px', height: '16px', borderRadius: '8px', position: 'relative',
      background: on ? '#6C47FF' : 'rgba(255,255,255,0.15)', cursor: 'pointer', transition: 'background 0.15s', flexShrink: '0' });
    knob.style.left = on ? '12px' : '2px';
  };
  tog.appendChild(knob);
  updateTog();
  tog.addEventListener('click', () => { on = !on; updateTog(); onChange(on); });
  wrap.appendChild(lbl);
  wrap.appendChild(tog);
  return wrap;
}

function toggleIdentityPanel() {
  if (!_identityPanel) return;
  const open = _identityPanel.style.display !== 'none';
  _identityPanel.style.display = open ? 'none' : 'flex';
}

function removeIdentityOverlay() {
  document.getElementById('mirrory-identity-overlay')?.remove();
  _identityPanel = null;
}

// ─── Panel helpers ────────────────────────────────────────────────────────────

function _applyFixed(el, styles) {
  Object.assign(el.style, styles);
}

function _panelSection(title) {
  const s = document.createElement('div');
  _applyFixed(s, { display: 'flex', flexDirection: 'column', gap: '6px' });
  const t = document.createElement('div');
  t.textContent = title;
  _applyFixed(t, { fontSize: '10px', fontWeight: '600', letterSpacing: '0.06em',
    color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' });
  s.appendChild(t);
  return s;
}

function _row() {
  const r = document.createElement('div');
  _applyFixed(r, { display: 'flex', alignItems: 'center', gap: '8px' });
  return r;
}

function _label(text) {
  const l = document.createElement('span');
  l.textContent = text;
  _applyFixed(l, { color: 'rgba(255,255,255,0.7)', fontSize: '12px', whiteSpace: 'nowrap' });
  return l;
}

function _toggleRow(label, initial, onChange) {
  const row = _row();
  const lbl = _label(label);
  lbl.style.flex = '1';
  const tog = document.createElement('div');
  let on = initial;
  const update = () => {
    _applyFixed(tog, {
      width: '32px', height: '18px', borderRadius: '9px',
      background: on ? '#6C47FF' : 'rgba(255,255,255,0.15)',
      cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: '0',
    });
    tog.querySelector('span').style.left = on ? '16px' : '2px';
  };
  const knob = document.createElement('span');
  _applyFixed(knob, {
    position: 'absolute', top: '2px', width: '14px', height: '14px',
    borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
  });
  tog.appendChild(knob);
  update();
  tog.addEventListener('click', () => { on = !on; update(); onChange(on); });
  row.appendChild(lbl);
  row.appendChild(tog);
  return row;
}

// ─── Peer cursors ─────────────────────────────────────────────────────────────

// Map<peerId, { el: HTMLElement, target: {sel,ox,oy}|null, current: {x,y}|null, rafId: number|null }>
const peerCursorState = new Map();

function getOrCreatePeerCursor(peerId, name, color) {
  if (peerCursorState.has(peerId)) return peerCursorState.get(peerId);

  const el = document.createElement('div');
  el.id = `mirrory-cursor-${peerId}`;

  // Dot
  const dot = document.createElement('div');
  _applyFixed(dot, {
    width: '14px', height: '14px', borderRadius: '50%',
    background: color, border: '2px solid #fff',
    boxShadow: `0 0 6px ${color}99`,
  });

  // Name tag (hidden by default, shown on hover)
  const tag = document.createElement('div');
  tag.textContent = name;
  _applyFixed(tag, {
    position: 'absolute', left: '16px', top: '-2px',
    background: color, color: '#fff',
    padding: '2px 6px', borderRadius: '6px',
    fontSize: '11px', fontWeight: '600', whiteSpace: 'nowrap',
    opacity: '0', transition: 'opacity 0.15s', pointerEvents: 'none',
  });

  _applyFixed(el, {
    position: 'fixed', pointerEvents: 'auto',
    zIndex: '2147483646', transform: 'translate(-50%,-50%)',
    cursor: 'none',
  });
  el.appendChild(dot);
  el.appendChild(tag);
  el.addEventListener('mouseenter', () => { tag.style.opacity = '1'; });
  el.addEventListener('mouseleave', () => { tag.style.opacity = '0'; });
  document.documentElement.appendChild(el);

  const state = { el, dot, tag, target: null, current: null, rafId: null };
  peerCursorState.set(peerId, state);
  return state;
}

function updatePeerCursor(peerId, name, color, sel, ox, oy) {
  if (!cursorsVisible) return;
  const state = getOrCreatePeerCursor(peerId, name, color);
  state.tag.textContent = name;
  state.dot.style.background = color;
  state.dot.style.boxShadow = `0 0 6px ${color}99`;
  state.tag.style.background = color;
  state.target = { sel, ox, oy };
  if (!state.rafId) state.rafId = requestAnimationFrame(() => _animatePeerCursor(peerId));
}

function _animatePeerCursor(peerId) {
  const state = peerCursorState.get(peerId);
  if (!state) return;
  state.rafId = null;
  if (!state.target) return;

  const target = resolveElementPos(state.target.sel, state.target.ox, state.target.oy);
  if (!target) { state.rafId = requestAnimationFrame(() => _animatePeerCursor(peerId)); return; }

  if (!state.current) state.current = { ...target };
  state.current.x += 0.18 * (target.x - state.current.x);
  state.current.y += 0.18 * (target.y - state.current.y);

  state.el.style.left = `${state.current.x}px`;
  state.el.style.top  = `${state.current.y}px`;

  const dx = target.x - state.current.x;
  const dy = target.y - state.current.y;
  if (dx * dx + dy * dy > 0.25) {
    state.rafId = requestAnimationFrame(() => _animatePeerCursor(peerId));
  }
}

function removePeerCursor(peerId) {
  const state = peerCursorState.get(peerId);
  if (!state) return;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.el.remove();
  peerCursorState.delete(peerId);
}

function removeAllPeerCursors() {
  for (const peerId of peerCursorState.keys()) removePeerCursor(peerId);
}

function updateMyCursorColor() {
  const el = document.getElementById('mirrory-cursor-self');
  if (el && identity) el.style.background = identity.color;
}

// ─── My own cursor (host only, shown to self as indicator) ───────────────────
// Guests see their own cursor via the OS; host sees its own dot for reference.
// Actually we skip self-cursor — the OS cursor is enough. We only show remote peers.

// ─── Viewport scaling (guest only, zoom approach) ────────────────────────────

let hostVW = 0, hostVH = 0;
let _lbBarX = 0, _lbBarY = 0, _lbRectW = 0, _lbRectH = 0;
let _lbBarEls = [];

function _setImp(el, prop, val) { el.style.setProperty(prop, val, 'important'); }

function applyLetterbox(hvw, hvh) {
  if (!hvw || !hvh) return;
  hostVW = hvw; hostVH = hvh;
  const gw = window.innerWidth, gh = window.innerHeight;
  const zoom = Math.min(gw / hvw, gh / hvh);
  const rectW = hvw * zoom, rectH = hvh * zoom;
  const barX = Math.max(0, Math.round((gw - rectW) / 2));
  const barY = Math.max(0, Math.round((gh - rectH) / 2));
  _lbBarX = barX; _lbBarY = barY; _lbRectW = rectW; _lbRectH = rectH;

  const html = document.documentElement, body = document.body;
  _setImp(html, 'zoom',          zoom.toFixed(8));
  _setImp(html, 'width',         hvw + 'px');
  _setImp(html, 'min-width',     hvw + 'px');
  _setImp(html, 'max-width',     hvw + 'px');
  _setImp(html, 'margin-top',    barY + 'px');
  _setImp(html, 'margin-left',   barX + 'px');
  _setImp(html, 'margin-right',  '0px');
  _setImp(html, 'margin-bottom', '0px');
  _setImp(html, 'padding',       '0px');
  _setImp(html, 'box-sizing',    'border-box');
  _setImp(html, 'background',    '#000');
  _setImp(body, 'margin',        '0px');
  _setImp(body, 'padding',       '0px');
  _setImp(body, 'min-width',     hvw + 'px');
  _setImp(body, 'max-width',     hvw + 'px');

  if (_lbBarEls.length === 0) {
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.id = 'mirrory-bar-' + i;
      _setImp(el, 'position', 'fixed'); _setImp(el, 'background', '#000');
      _setImp(el, 'pointer-events', 'none'); _setImp(el, 'z-index', '2147483645');
      _setImp(el, 'margin', '0px'); _setImp(el, 'padding', '0px');
      document.documentElement.appendChild(el);
      _lbBarEls.push(el);
    }
  }
  _posBar(_lbBarEls[0], 0,            0,            gw, barY);
  _posBar(_lbBarEls[1], barY + rectH, 0,            gw, Math.max(0, gh - barY - rectH));
  _posBar(_lbBarEls[2], 0,            0,            barX, gh);
  _posBar(_lbBarEls[3], 0,            barX + rectW, Math.max(0, gw - barX - rectW), gh);
}

function _posBar(el, top, left, w, h) {
  _setImp(el, 'top', top + 'px'); _setImp(el, 'left', left + 'px');
  _setImp(el, 'width', Math.max(0, w) + 'px'); _setImp(el, 'height', Math.max(0, h) + 'px');
}

function removeLetterbox() {
  _lbBarEls.forEach(el => el.remove()); _lbBarEls = [];
  for (const p of ['zoom','width','min-width','max-width','margin-top','margin-left',
                    'margin-right','margin-bottom','padding','box-sizing','background'])
    document.documentElement.style.removeProperty(p);
  for (const p of ['margin','padding','min-width','max-width'])
    document.body.style.removeProperty(p);
  hostVW = 0; hostVH = 0; _lbBarX = 0; _lbBarY = 0; _lbRectW = 0; _lbRectH = 0;
}

function onGuestResize() {
  if (role === 'guest' && hostVW) applyLetterbox(hostVW, hostVH);
}

// ─── My cursor tracking (host → broadcasts, guest → broadcasts if allowed) ───

let cursorTarget  = null;
let cursorCurrent = null;
let cursorRafId   = null;
const CURSOR_ALPHA = 0.18;

function onCursorPacket(peerId, name, color, sel, ox, oy) {
  if (peerId === myPeerId) return; // ignore own echo
  updatePeerCursor(peerId, name, color, sel, ox, oy);
}

function resolveElementPos(sel, ox, oy) {
  if (!sel) return { x: ox * window.innerWidth, y: oy * window.innerHeight };
  try {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + ox * r.width, y: r.top + oy * r.height };
  } catch { return null; }
}

function stopCursorAnimation() {
  if (cursorRafId) { cancelAnimationFrame(cursorRafId); cursorRafId = null; }
  cursorTarget = null; cursorCurrent = null;
}

// ─── DOM path helper ──────────────────────────────────────────────────────────

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

// ─── Throttle ─────────────────────────────────────────────────────────────────

function throttle(fn, ms) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn.apply(this, args); }
  };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function runtimeSend(msg) {
  try { chrome.runtime.sendMessage(msg); } catch {}
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(SERVER_URL);

  ws.addEventListener('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);
    if (role === 'host') {
      send({ type: 'host_create', sessionId, peerId: myPeerId, name: identity.name, color: identity.color });
      sendViewport();
    } else if (role === 'guest') {
      send({ type: 'guest_join', sessionId, peerId: myPeerId, name: identity.name, color: identity.color });
      window.addEventListener('resize', onGuestResize, { passive: true });
    }
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => { isConnected = false; scheduleReconnect(); });
  ws.addEventListener('error', () => {});
}

function scheduleReconnect() {
  if (!role || reconnectAttempts >= RECONNECT_MAX) {
    if (reconnectAttempts >= RECONNECT_MAX) {
      console.warn('[Mirrory] Max reconnect attempts reached.');
      runtimeSend({ type: 'mirrory_disconnected', sessionId });
    }
    return;
  }
  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * reconnectAttempts;
  reconnectTimer = setTimeout(connect, delay);
}

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'session_created':
      cursorsVisible   = msg.cursorsVisible   ?? true;
      showHostCursor   = msg.showHostCursor   ?? true;
      guestsCanControl = msg.guestsCanControl ?? false;
      break;

    case 'guest_joined':
      cursorsVisible   = msg.cursorsVisible   ?? true;
      showHostCursor   = msg.showHostCursor   ?? true;
      guestsCanControl = msg.guestsCanControl ?? false;
      break;

    case 'your_settings':
      cursorsVisible   = msg.cursorsVisible   ?? cursorsVisible;
      showHostCursor   = msg.showHostCursor   ?? showHostCursor;
      guestsCanControl = msg.guestsCanControl ?? guestsCanControl;
      if (!cursorsVisible) removeAllPeerCursors();
      break;

    case 'peer_list':
      peers.clear();
      for (const p of msg.peers) peers.set(p.peerId, p);
      for (const pid of peerCursorState.keys()) {
        if (!peers.has(pid)) removePeerCursor(pid);
      }
      if (role === 'host') _refreshHostPeerList();
      runtimeSend({ type: 'mirrory_peer_list', peers: msg.peers });
      break;

    case 'guest_count':
      runtimeSend({ type: 'mirrory_guest_count', count: msg.count });
      break;

    case 'settings_update':
      cursorsVisible   = msg.cursorsVisible   ?? cursorsVisible;
      showHostCursor   = msg.showHostCursor   ?? showHostCursor;
      guestsCanControl = msg.guestsCanControl ?? guestsCanControl;
      if (!cursorsVisible) removeAllPeerCursors();
      _syncToggleUI();
      runtimeSend({ type: 'mirrory_settings_update', cursorsVisible, showHostCursor, guestsCanControl });
      break;

    case 'peer_cursor': {
      if (!cursorsVisible) break;
      // Check if this is the host's cursor and showHostCursor is off
      const senderPeer = peers.get(msg.peerId);
      if (senderPeer?.role === 'host' && !showHostCursor) break;
      onCursorPacket(msg.peerId, msg.name, msg.color, msg.sel, msg.ox, msg.oy);
      break;
    }

    case 'viewport':
      if (role === 'guest') applyLetterbox(msg.vw, msg.vh);
      break;

    case 'scroll':
      if (role === 'guest') applyScroll(msg.yPct);
      break;

    case 'navigate':
      if (role === 'guest') applyNavigate(msg.url);
      break;

    // Guest receives host's own cursor via peer_cursor (host sends it too)
    // Guest input relayed to host
    case 'guest_scroll':
      if (role === 'host') applyScroll(msg.yPct);
      break;

    case 'guest_click':
      if (role === 'host') applyGuestClick(msg.sel);
      break;

    case 'guest_navigate':
      if (role === 'host') applyNavigate(msg.url);
      break;

    case 'host_disconnected':
      runtimeSend({ type: 'mirrory_host_disconnected' });
      break;

    case 'session_ended':
      teardown();
      runtimeSend({ type: 'mirrory_session_ended' });
      break;

    case 'kicked':
      teardown();
      runtimeSend({ type: 'mirrory_session_ended' });
      break;

    case 'error':
      console.error('[Mirrory] Server error:', msg.message);
      if (msg.message === 'Session not found') {
        teardown();
        runtimeSend({ type: 'mirrory_session_ended' });
      }
      break;
  }
}

function _syncToggleUI() {
  const cursorRow  = document.getElementById('mirrory-toggle-cursors');
  const controlRow = document.getElementById('mirrory-toggle-control');
  // Simplest approach: rebuild host controls section if panel is open
  if (role === 'host' && _identityPanel) {
    const existing = _identityPanel.querySelector('#mirrory-toggle-cursors')?.parentElement;
    if (existing) {
      const fresh = _buildHostControls();
      existing.replaceWith(fresh);
    }
  }
}

// ─── Scroll sync ──────────────────────────────────────────────────────────────

let suppressScrollEvent = false;

function applyScroll(yPct) {
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

const sendGuestScroll = throttle(() => {
  if (!guestsCanControl) return;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  const yPct = maxScroll > 0 ? window.scrollY / maxScroll : 0;
  send({ type: 'guest_scroll', yPct });
}, SCROLL_THROTTLE_MS);

// ─── Navigation sync ──────────────────────────────────────────────────────────

function applyNavigate(url) {
  try {
    const dest = new URL(url);
    dest.searchParams.set('mirrory', sessionId);
    if (window.location.href !== dest.toString()) window.location.href = dest.toString();
  } catch {}
}

function applyGuestClick(sel) {
  if (!sel) return;
  try {
    const el = document.querySelector(sel);
    if (el) el.click();
  } catch {}
}

function onHostClick(e) {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  try {
    const dest = new URL(anchor.href, window.location.href);
    if (dest.origin === window.location.origin || dest.protocol === 'https:' || dest.protocol === 'http:') {
      dest.searchParams.delete('mirrory');
      send({ type: 'navigate', url: dest.toString() });
    }
  } catch {}
}

function onHostSubmit(e) {
  const form = e.target;
  if (!form || form.method?.toLowerCase() !== 'get') return;
  try {
    const dest = new URL(form.action || window.location.href, window.location.href);
    const data = new URLSearchParams(new FormData(form));
    data.forEach((v, k) => dest.searchParams.set(k, v));
    dest.searchParams.delete('mirrory');
    send({ type: 'navigate', url: dest.toString() });
  } catch {}
}

function onGuestClick(e) {
  if (!guestsCanControl) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === document.documentElement || target === document.body) return;
  const sel = domPath(target);
  send({ type: 'guest_click', sel });
}

function onGuestNavClick(e) {
  if (!guestsCanControl) return;
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;
  try {
    const dest = new URL(anchor.href, window.location.href);
    if (dest.protocol === 'https:' || dest.protocol === 'http:') {
      dest.searchParams.delete('mirrory');
      send({ type: 'guest_navigate', url: dest.toString() });
    }
  } catch {}
}

// ─── Cursor tracking ──────────────────────────────────────────────────────────

function sendViewport() {
  send({ type: 'viewport', vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight });
}
const sendViewportThrottled = throttle(sendViewport, 200);

function sendCursor(e) {
  const target = document.elementFromPoint(e.clientX, e.clientY);
  let sel = '', ox = 0.5, oy = 0.5;
  if (target && target !== document.documentElement && target !== document.body) {
    sel = domPath(target);
    const r = target.getBoundingClientRect();
    if (r.width > 0)  ox = (e.clientX - r.left) / r.width;
    if (r.height > 0) oy = (e.clientY - r.top)  / r.height;
  } else {
    ox = e.clientX / document.documentElement.clientWidth;
    oy = e.clientY / document.documentElement.clientHeight;
  }
  send({ type: 'peer_cursor', sel, ox, oy });
}

function sendGuestCursor(e) {
  if (!cursorsVisible) return;
  sendCursor(e);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function attachHostListeners() {
  window.addEventListener('scroll',    sendScroll,            { passive: true });
  window.addEventListener('mousemove', sendCursor,            { passive: true });
  window.addEventListener('resize',    sendViewportThrottled, { passive: true });
  document.addEventListener('click',   onHostClick,           { capture: true, passive: true });
  document.addEventListener('submit',  onHostSubmit,          { capture: true, passive: true });
}

function detachHostListeners() {
  window.removeEventListener('scroll',    sendScroll);
  window.removeEventListener('mousemove', sendCursor);
  window.removeEventListener('resize',    sendViewportThrottled);
  document.removeEventListener('click',   onHostClick,  { capture: true });
  document.removeEventListener('submit',  onHostSubmit, { capture: true });
}

function attachGuestListeners() {
  window.addEventListener('scroll',    sendGuestScroll,  { passive: true });
  window.addEventListener('mousemove', sendGuestCursor,  { passive: true });
  document.addEventListener('click',   onGuestNavClick,  { capture: true, passive: true });
  document.addEventListener('click',   onGuestClick,     { capture: true, passive: true });
}

function detachGuestListeners() {
  window.removeEventListener('scroll',    sendGuestScroll);
  window.removeEventListener('mousemove', sendGuestCursor);
  document.removeEventListener('click',   onGuestNavClick, { capture: true });
  document.removeEventListener('click',   onGuestClick,    { capture: true });
  window.removeEventListener('resize',    onGuestResize);
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

function startHost(sid) {
  identity  = loadIdentity();
  myPeerId  = identity.peerId;
  role      = 'host';
  sessionId = sid;
  injectIdentityOverlay();
  attachHostListeners();
  connect();
  runtimeSend({ type: 'mirrory_host_started', sessionId });
}

function startGuest(sid) {
  identity  = loadIdentity();
  myPeerId  = identity.peerId;
  role      = 'guest';
  sessionId = sid;
  injectIdentityOverlay();
  attachGuestListeners();
  connect();
  runtimeSend({ type: 'mirrory_guest_started', sessionId });
}

function teardown() {
  if (role === 'host') {
    send({ type: 'host_kill' });
    detachHostListeners();
  } else if (role === 'guest') {
    detachGuestListeners();
  }

  if (ws) { ws.close(); ws = null; }
  clearTimeout(reconnectTimer);

  role = null; sessionId = null; myPeerId = null;
  isConnected = false; reconnectAttempts = 0;
  peers.clear();

  removeAllPeerCursors();
  stopCursorAnimation();
  removeIdentityOverlay();
  removeLetterbox();

  runtimeSend({ type: 'mirrory_teardown_complete' });
}

// ─── Badge (legacy — replaced by identity overlay, kept for compat) ──────────
function removeBadge() { document.getElementById('mirrory-badge')?.remove(); }

// ─── Message bridge ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'mirrory_start_host':  startHost(msg.sessionId);  sendResponse({ ok: true }); break;
    case 'mirrory_start_guest': startGuest(msg.sessionId); sendResponse({ ok: true }); break;
    case 'mirrory_kill':        teardown();                 sendResponse({ ok: true }); break;
    case 'mirrory_status':      sendResponse({ role, sessionId, isConnected });         break;

    case 'mirrory_update_identity':
      if (identity) {
        if (msg.name)  identity.name  = msg.name;
        if (msg.color) identity.color = msg.color;
        saveIdentity(identity);
        send({ type: 'peer_identity', name: identity.name, color: identity.color });
      }
      sendResponse({ ok: true });
      break;

    case 'mirrory_kick_peer':
      if (role === 'host') send({ type: 'host_kick', targetPeerId: msg.targetPeerId });
      sendResponse({ ok: true });
      break;

    case 'mirrory_host_settings':
      if (role === 'host') {
        cursorsVisible   = msg.cursorsVisible   ?? cursorsVisible;
        showHostCursor   = msg.showHostCursor   ?? showHostCursor;
        guestsCanControl = msg.guestsCanControl ?? guestsCanControl;
        send({ type: 'host_settings', cursorsVisible, showHostCursor, guestsCanControl });
      }
      sendResponse({ ok: true });
      break;

    case 'mirrory_peer_settings':
      if (role === 'host') {
        send({ type: 'host_peer_settings', targetPeerId: msg.targetPeerId,
               cursorVisible: msg.cursorVisible, canControl: msg.canControl });
      }
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// ─── Auto-join from URL param ─────────────────────────────────────────────────

(function checkAutoJoin() {
  try {
    const sid = new URLSearchParams(window.location.search).get('mirrory');
    if (sid && !role) setTimeout(() => startGuest(sid), 300);
  } catch {}
})();
