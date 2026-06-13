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
 * @typedef {Object} Session
 * @property {WebSocket|null} host - Host WebSocket connection
 * @property {Set<WebSocket>} guests - Connected guest sockets
 * @property {number} createdAt - Unix timestamp ms when session was created
 * @property {NodeJS.Timeout} expireTimer - Timer handle for TTL cleanup
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * Generate a cryptographically random session ID (8 hex chars).
 * @returns {string}
 */
function generateSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Remove a session and close all connected sockets with a 'session_ended' message.
 * @param {string} sessionId
 */
function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearTimeout(session.expireTimer);

  const msg = JSON.stringify({ type: 'session_ended', sessionId });

  if (session.host && session.host.readyState === WebSocket.OPEN) {
    session.host.send(msg);
    session.host.close();
  }

  for (const guest of session.guests) {
    if (guest.readyState === WebSocket.OPEN) {
      guest.send(msg);
      guest.close();
    }
  }

  sessions.delete(sessionId);
  console.log(`[session] destroyed ${sessionId} (${sessions.size} active)`);
}

/**
 * Create a new session with TTL.
 * @param {string} sessionId
 * @returns {Session}
 */
function createSession(sessionId) {
  const expireTimer = setTimeout(() => {
    console.log(`[session] TTL expired for ${sessionId}`);
    destroySession(sessionId);
  }, SESSION_TTL_MS);

  const session = {
    host: null,
    guests: new Set(),
    createdAt: Date.now(),
    expireTimer,
  };

  sessions.set(sessionId, session);
  console.log(`[session] created ${sessionId} (${sessions.size} active)`);
  return session;
}

/**
 * Broadcast a message from the host to all guests in a session.
 * @param {Session} session
 * @param {string} raw - Serialized JSON string
 */
function broadcastToGuests(session, raw) {
  for (const guest of session.guests) {
    if (guest.readyState === WebSocket.OPEN) {
      guest.send(raw);
    }
  }
}

/**
 * Handle an incoming WebSocket connection.
 * @param {WebSocket} ws
 * @param {http.IncomingMessage} req
 */
function handleConnection(ws, req) {
  /** @type {string|null} */
  let sessionId = null;
  /** @type {'host'|'guest'|null} */
  let role = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'host_create': {
        // Host creates or reclaims a session
        sessionId = msg.sessionId || generateSessionId();
        role = 'host';

        let session = sessions.get(sessionId);
        if (!session) {
          session = createSession(sessionId);
        }

        // Replace existing host if reconnecting
        if (session.host && session.host !== ws) {
          session.host.close();
        }
        session.host = ws;

        ws.send(JSON.stringify({ type: 'session_created', sessionId }));
        console.log(`[host] joined session ${sessionId}`);
        break;
      }

      case 'guest_join': {
        // Guest joins an existing session
        sessionId = msg.sessionId;
        role = 'guest';

        const session = sessions.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          ws.close();
          return;
        }

        session.guests.add(ws);
        ws.send(JSON.stringify({ type: 'guest_joined', sessionId }));

        // Notify host that a guest connected
        if (session.host && session.host.readyState === WebSocket.OPEN) {
          session.host.send(JSON.stringify({
            type: 'guest_count',
            count: session.guests.size,
          }));
        }

        console.log(`[guest] joined session ${sessionId} (${session.guests.size} guests)`);
        break;
      }

      // Host → guests relay messages (scroll, navigate, cursor)
      case 'scroll':
      case 'navigate':
      case 'cursor': {
        if (role !== 'host' || !sessionId) break;
        const session = sessions.get(sessionId);
        if (!session) break;
        broadcastToGuests(session, data.toString());
        break;
      }

      case 'host_kill': {
        // Host explicitly ends the session
        if (role !== 'host' || !sessionId) break;
        console.log(`[host] killed session ${sessionId}`);
        destroySession(sessionId);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    if (role === 'host') {
      // Host disconnected — notify guests but keep session alive for reconnect
      session.host = null;
      broadcastToGuests(session, JSON.stringify({ type: 'host_disconnected' }));
      console.log(`[host] disconnected from session ${sessionId}`);
    } else if (role === 'guest') {
      session.guests.delete(ws);
      if (session.host && session.host.readyState === WebSocket.OPEN) {
        session.host.send(JSON.stringify({
          type: 'guest_count',
          count: session.guests.size,
        }));
      }
      console.log(`[guest] left session ${sessionId} (${session.guests.size} remaining)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] error on session ${sessionId}:`, err.message);
  });
}

wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log(`Mirrory server listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  for (const id of sessions.keys()) destroySession(id);
  server.close(() => process.exit(0));
});
