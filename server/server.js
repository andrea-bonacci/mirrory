'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

/**
 * @typedef {Object} Peer
 * @property {string} peerId
 * @property {string} name
 * @property {string} color
 * @property {'host'|'guest'} role
 * @property {WebSocket} ws
 * @property {boolean} cursorVisible    — per-peer override (host can mute)
 * @property {boolean} canControl       — per-peer override
 */

/**
 * @typedef {Object} Session
 * @property {WebSocket|null} hostWs
 * @property {Map<string, Peer>} peers
 * @property {boolean} cursorsVisible         — global: show all peer cursors
 * @property {boolean} showHostCursor         — global: host cursor visible to guests
 * @property {boolean} guestsCanControl       — global default for guest control
 * @property {number} createdAt
 * @property {NodeJS.Timeout} expireTimer
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.expireTimer);
  const msg = JSON.stringify({ type: 'session_ended', sessionId });
  for (const peer of session.peers.values()) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(msg);
      peer.ws.close();
    }
  }
  sessions.delete(sessionId);
  console.log(`[session] destroyed ${sessionId} (${sessions.size} active)`);
}

function createSession(sessionId) {
  const expireTimer = setTimeout(() => {
    console.log(`[session] TTL expired for ${sessionId}`);
    destroySession(sessionId);
  }, SESSION_TTL_MS);

  const session = {
    hostWs: null,
    peers: new Map(),
    cursorsVisible: true,
    showHostCursor: true,
    guestsCanControl: false,
    createdAt: Date.now(),
    expireTimer,
  };
  sessions.set(sessionId, session);
  console.log(`[session] created ${sessionId} (${sessions.size} active)`);
  return session;
}

/** Send to every peer except the sender. */
function broadcast(session, raw, exceptWs = null) {
  for (const peer of session.peers.values()) {
    if (peer.ws !== exceptWs && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(raw);
    }
  }
}

/** Send only to guests (all peers except host). */
function broadcastToGuests(session, raw) {
  for (const peer of session.peers.values()) {
    if (peer.role === 'guest' && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(raw);
    }
  }
}

/** Build the peer-list payload sent on join/leave. */
function peerListMsg(session) {
  const peers = [];
  for (const p of session.peers.values()) {
    peers.push({
      peerId: p.peerId, name: p.name, color: p.color, role: p.role,
      cursorVisible: p.cursorVisible, canControl: p.canControl,
    });
  }
  return JSON.stringify({ type: 'peer_list', peers });
}

/** Build settings payload for a single peer (sent to that peer on join/settings change). */
function peerSettingsMsg(session, peer) {
  return JSON.stringify({
    type: 'your_settings',
    // cursorsVisible = global setting (do I see other cursors?)
    cursorsVisible:   session.cursorsVisible,
    showHostCursor:   session.showHostCursor,
    // canControl is per-peer (individual grant/revoke regardless of global default)
    guestsCanControl: peer.canControl,
  });
}

function handleConnection(ws) {
  let sessionId = null;
  let peerId    = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); return; }

    switch (msg.type) {

      // ── Host creates session ──────────────────────────────────────────────
      case 'host_create': {
        sessionId = msg.sessionId || generateId();
        peerId    = msg.peerId    || generateId();
        const name  = String(msg.name  || 'Host').slice(0, 32);
        const color = String(msg.color || '#6C47FF').slice(0, 16);

        let session = sessions.get(sessionId);
        if (!session) session = createSession(sessionId);

        // Remove stale host peer if reconnecting
        for (const [id, p] of session.peers) {
          if (p.role === 'host') { session.peers.delete(id); break; }
        }
        if (session.hostWs && session.hostWs !== ws) session.hostWs.close();
        session.hostWs = ws;

        session.peers.set(peerId, { peerId, name, color, role: 'host', ws, cursorVisible: true, canControl: false });

        ws.send(JSON.stringify({
          type: 'session_created', sessionId, peerId,
          cursorsVisible:   session.cursorsVisible,
          showHostCursor:   session.showHostCursor,
          guestsCanControl: session.guestsCanControl,
        }));
        // Tell existing guests about the new peer list
        broadcast(session, peerListMsg(session), ws);
        console.log(`[host] ${name} (${peerId}) joined session ${sessionId}`);
        break;
      }

      // ── Guest joins ───────────────────────────────────────────────────────
      case 'guest_join': {
        sessionId = msg.sessionId;
        peerId    = msg.peerId || generateId();
        const name  = String(msg.name  || 'Guest').slice(0, 32);
        const color = String(msg.color || '#FF4747').slice(0, 16);

        const session = sessions.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          ws.close(); return;
        }

        // Max 5 guests per session
        const currentGuests = [...session.peers.values()].filter(p => p.role === 'guest').length;
        if (currentGuests >= 5) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session full' }));
          ws.close(); return;
        }

        // canControl inherits the global default so new guests match the room setting
        const newPeer = { peerId, name, color, role: 'guest', ws, cursorVisible: true, canControl: session.guestsCanControl, controlOverridden: false };
        session.peers.set(peerId, newPeer);

        ws.send(JSON.stringify({
          type: 'guest_joined', sessionId, peerId,
          cursorsVisible:   session.cursorsVisible,
          showHostCursor:   session.showHostCursor,
          guestsCanControl: session.guestsCanControl,
        }));

        // Send current peer list + this guest's effective settings
        ws.send(peerListMsg(session));
        ws.send(peerSettingsMsg(session, newPeer));

        // Notify everyone else about the updated peer list
        broadcast(session, peerListMsg(session), ws);

        // Legacy guest_count for background.js badge
        if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
          const guestCount = [...session.peers.values()].filter(p => p.role === 'guest').length;
          session.hostWs.send(JSON.stringify({ type: 'guest_count', count: guestCount }));
        }

        console.log(`[guest] ${name} (${peerId}) joined ${sessionId} (${session.peers.size} peers)`);
        break;
      }

      // ── Identity update (name / color change) ─────────────────────────────
      case 'peer_identity': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const peer = session.peers.get(peerId);
        if (!peer) break;
        if (msg.name)  peer.name  = String(msg.name).slice(0, 32);
        if (msg.color) peer.color = String(msg.color).slice(0, 16);
        broadcast(session, peerListMsg(session));
        break;
      }

      // ── Host → all guests: scroll / navigate ─────────────────────────────
      case 'scroll':
      case 'navigate': {
        if (!sessionId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const peer = session.peers.get(peerId);
        if (!peer || peer.role !== 'host') break;
        broadcastToGuests(session, data.toString());
        break;
      }

      // ── Cursor: any peer → all others (if cursorsVisible) ─────────────────
      case 'peer_cursor': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const peer = session.peers.get(peerId);
        if (!peer) break;
        // Per-peer cursorVisible is an individual override:
        //   false  → always hidden (muted by host), regardless of global
        //   true   → shown only if global cursorsVisible is also true
        // Exception: host cursor follows showHostCursor, not cursorsVisible
        if (peer.role === 'host') {
          if (!session.showHostCursor) break;
        } else {
          if (!peer.cursorVisible) break;           // muted individually
          if (!session.cursorsVisible) break;       // global guest cursors off
        }
        const out = JSON.stringify({ ...msg, peerId, name: peer.name, color: peer.color });
        broadcast(session, out, ws);
        break;
      }

      // ── Guest input (scroll/click relay from guest) ───────────────────────
      case 'guest_scroll':
      case 'guest_click':
      case 'guest_navigate': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const peer = session.peers.get(peerId);
        // Check per-peer canControl (not global — host may have granted individually)
        if (!peer || peer.role !== 'guest' || !peer.canControl) break;
        // Relay to host only — do NOT echo back to guests (avoids scroll loops)
        if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
          session.hostWs.send(JSON.stringify({ ...msg, peerId, name: peer.name }));
        }
        break;
      }

      // ── Host global settings ──────────────────────────────────────────────
      case 'host_settings': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const sender = session.peers.get(peerId);
        if (!sender || sender.role !== 'host') break;
        if (typeof msg.cursorsVisible   === 'boolean') session.cursorsVisible   = msg.cursorsVisible;
        if (typeof msg.showHostCursor   === 'boolean') session.showHostCursor   = msg.showHostCursor;
        if (typeof msg.guestsCanControl === 'boolean') session.guestsCanControl = msg.guestsCanControl;
        // Broadcast global settings to all peers; each guest also gets their personal effective settings
        const globalOut = JSON.stringify({
          type: 'settings_update',
          cursorsVisible:   session.cursorsVisible,
          showHostCursor:   session.showHostCursor,
          guestsCanControl: session.guestsCanControl,
        });
        broadcast(session, globalOut);
        // Push per-peer effective settings to each guest.
        // Guests without a manual override inherit the new global default.
        for (const p of session.peers.values()) {
          if (p.role !== 'guest') continue;
          if (!p.controlOverridden) p.canControl = session.guestsCanControl;
          if (p.ws.readyState === WebSocket.OPEN) p.ws.send(peerSettingsMsg(session, p));
        }
        // If showHostCursor just turned off, tell all guests to remove the host cursor
        if (msg.showHostCursor === false && session.hostWs) {
          const hostPeer = [...session.peers.values()].find(p => p.role === 'host');
          if (hostPeer) {
            broadcastToGuests(session, JSON.stringify({ type: 'remove_cursor', peerId: hostPeer.peerId }));
          }
        }
        // If cursorsVisible just turned off, tell all guests to remove all cursors
        if (msg.cursorsVisible === false) {
          broadcastToGuests(session, JSON.stringify({ type: 'remove_all_cursors' }));
        }
        break;
      }

      // ── Host per-peer settings ────────────────────────────────────────────
      case 'host_peer_settings': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const sender = session.peers.get(peerId);
        if (!sender || sender.role !== 'host') break;
        const target = session.peers.get(msg.targetPeerId);
        if (!target || target.role === 'host') break;
        if (typeof msg.cursorVisible === 'boolean') {
          target.cursorVisible = msg.cursorVisible;
          // If muted, tell all peers to remove that cursor immediately
          if (!msg.cursorVisible) {
            broadcast(session, JSON.stringify({ type: 'remove_cursor', peerId: msg.targetPeerId }));
          }
        }
        if (typeof msg.canControl === 'boolean') {
          target.canControl        = msg.canControl;
          target.controlOverridden = true;
        }
        // Notify target of their new effective settings
        if (target.ws.readyState === WebSocket.OPEN) target.ws.send(peerSettingsMsg(session, target));
        // Update host's peer list so UI reflects the change
        if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
          session.hostWs.send(peerListMsg(session));
        }
        break;
      }

      // ── Host kicks a peer ─────────────────────────────────────────────────
      case 'host_kick': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const sender = session.peers.get(peerId);
        if (!sender || sender.role !== 'host') break;
        const target = session.peers.get(msg.targetPeerId);
        if (!target || target.role === 'host') break;
        target.ws.send(JSON.stringify({ type: 'kicked' }));
        target.ws.close();
        session.peers.delete(msg.targetPeerId);
        broadcast(session, peerListMsg(session));
        const guestCount = [...session.peers.values()].filter(p => p.role === 'guest').length;
        if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
          session.hostWs.send(JSON.stringify({ type: 'guest_count', count: guestCount }));
        }
        console.log(`[host] kicked peer ${msg.targetPeerId} from ${sessionId}`);
        break;
      }

      // ── Host kills session ────────────────────────────────────────────────
      case 'host_kill': {
        if (!sessionId || !peerId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        const peer = session.peers.get(peerId);
        if (!peer || peer.role !== 'host') break;
        console.log(`[host] killed session ${sessionId}`);
        destroySession(sessionId);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    if (!sessionId || !peerId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    const peer = session.peers.get(peerId);
    if (!peer) return;

    if (peer.role === 'host') {
      session.hostWs = null;
      session.peers.delete(peerId);
      broadcastToGuests(session, JSON.stringify({ type: 'host_disconnected' }));
      console.log(`[host] disconnected from session ${sessionId}`);
    } else {
      session.peers.delete(peerId);
      broadcast(session, peerListMsg(session));
      const guestCount = [...session.peers.values()].filter(p => p.role === 'guest').length;
      if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
        session.hostWs.send(JSON.stringify({ type: 'guest_count', count: guestCount }));
      }
      console.log(`[guest] ${peer.name} left ${sessionId} (${session.peers.size} peers remaining)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] error on session ${sessionId}:`, err.message);
  });
}

wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log(`SameTab server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  for (const id of sessions.keys()) destroySession(id);
  server.close(() => process.exit(0));
});
