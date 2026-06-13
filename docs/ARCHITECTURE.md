# Mirrory — Architecture

## Overview

Mirrory uses a **relay server** architecture. The server never processes page content — it only forwards binary-encoded JSON events from the host to all connected guests.

```
┌─────────────────────────┐         ┌──────────────────────┐        ┌─────────────────────────┐
│      HOST BROWSER       │         │   MIRRORY SERVER     │        │     GUEST BROWSER       │
│                         │         │   (Railway / Node)   │        │                         │
│  ┌───────────────────┐  │  ws://  │                      │  ws:// │  ┌───────────────────┐  │
│  │   content.js      │──┼─────────▶  WebSocket rooms     ├────────▶  │   content.js      │  │
│  │                   │  │         │                      │        │  │                   │  │
│  │  scroll events ───┼──┼─────────▶  broadcast to        │        │  │  applyScroll()    │  │
│  │  mousemove ───────┼──┼─────────▶  all guests          ├────────▶  │  moveCursor()     │  │
│  │  url change ──────┼──┼─────────▶                      │        │  │  applyNavigate()  │  │
│  └────────┬──────────┘  │         └──────────────────────┘        │  └───────────────────┘  │
│           │             │                                          │                         │
│  ┌────────▼──────────┐  │                                          │  ┌───────────────────┐  │
│  │   background.js   │  │                                          │  │   background.js   │  │
│  │                   │  │                                          │  │                   │  │
│  │  session state    │  │                                          │  │  badge: WATCHING  │  │
│  │  badge: LIVE      │  │                                          │  └───────────────────┘  │
│  └────────┬──────────┘  │                                          │                         │
│           │             │                                          │  ┌───────────────────┐  │
│  ┌────────▼──────────┐  │                                          │  │   popup.html/js   │  │
│  │   popup.html/js   │  │                                          │  │                   │  │
│  │                   │  │                                          │  │  "Leave session"  │  │
│  │  "Start sharing"  │  │                                          │  └───────────────────┘  │
│  │  "End session"    │  │                                          │                         │
│  └───────────────────┘  │                                          └─────────────────────────┘
└─────────────────────────┘
```

---

## Data Flow

### 1. Session Creation (Host)

```
Popup                  background.js              content.js             Server
  │                         │                         │                     │
  │  popup_create_session   │                         │                     │
  │────────────────────────▶│                         │                     │
  │                         │  mirrory_start_host     │                     │
  │                         │────────────────────────▶│                     │
  │                         │                         │  {type:host_create} │
  │                         │                         │────────────────────▶│
  │                         │                         │  {type:session_created, sessionId}
  │                         │                         │◀────────────────────│
  │  {ok:true, sessionId}   │                         │                     │
  │◀────────────────────────│                         │                     │
```

### 2. Guest Joins

```
URL opened → content.js auto-join (checkAutoJoin)
  │                                                    Server
  │  {type:guest_join, sessionId}                        │
  │─────────────────────────────────────────────────────▶│
  │  {type:guest_joined}                                  │
  │◀─────────────────────────────────────────────────────│
  │                              Host content.js          │
  │                  {type:guest_count, count:1}          │
  │◀─────────────────────────────────────────────────────│
```

### 3. Real-time Sync

```
Host browser              Server               Guest browser
     │                       │                       │
     │  {type:scroll,        │                       │
     │   yPct:0.35}          │                       │
     │──────────────────────▶│                       │
     │                       │  broadcast to guests  │
     │                       │──────────────────────▶│
     │                       │                       │  window.scrollTo(yPct * maxScroll)
     │                       │                       │
     │  {type:cursor,        │                       │
     │   xPct:0.5,yPct:0.6}  │                       │
     │──────────────────────▶│──────────────────────▶│  cursor dot moves
     │                       │                       │
     │  {type:navigate,      │                       │
     │   url:"https://..."}  │                       │
     │──────────────────────▶│──────────────────────▶│  window.location.href = url
```

### 4. Session Kill

```
Popup              background.js         content.js           Server
  │                     │                    │                    │
  │  popup_kill_session │                    │                    │
  │────────────────────▶│                    │                    │
  │                     │  mirrory_kill      │                    │
  │                     │───────────────────▶│                    │
  │                     │                    │  {type:host_kill}  │
  │                     │                    │───────────────────▶│
  │                     │                    │                    │ destroySession()
  │                     │                    │  {type:session_ended} (to all)
  │                     │                    │◀───────────────────│
  │                     │                    │  ws.close()        │
  │◀────────────────────│                    │                    │
  showView('idle')
```

---

## Message Types Reference

### Extension → Server

| Type | Sender | Payload | Description |
|------|--------|---------|-------------|
| `host_create` | Host | `{ sessionId? }` | Create or reclaim a session |
| `guest_join` | Guest | `{ sessionId }` | Join an existing session |
| `scroll` | Host | `{ yPct: number }` | Scroll position (0–1) |
| `navigate` | Host | `{ url: string }` | URL navigation |
| `cursor` | Host | `{ xPct, yPct }` | Mouse position (0–1 each) |
| `host_kill` | Host | — | Terminate session |

### Server → Extension

| Type | Recipient | Payload | Description |
|------|-----------|---------|-------------|
| `session_created` | Host | `{ sessionId }` | Session created/reclaimed |
| `guest_joined` | Guest | `{ sessionId }` | Joined successfully |
| `guest_count` | Host | `{ count }` | Number of connected guests |
| `scroll` | Guests | `{ yPct }` | Forwarded from host |
| `navigate` | Guests | `{ url }` | Forwarded from host |
| `cursor` | Guests | `{ xPct, yPct }` | Forwarded from host |
| `host_disconnected` | Guests | — | Host socket closed |
| `session_ended` | All | `{ sessionId }` | Session destroyed |
| `error` | Sender | `{ message }` | Protocol error |

---

## Security Notes

- Session IDs are 32-bit cryptographically random values (8 hex chars, ~4 billion combinations)
- The server validates that only the host sends relay events — guest messages other than `guest_join` are ignored
- Sessions expire server-side after 2 hours regardless of activity
- The extension only holds `activeTab`, `tabs`, `storage`, `scripting` permissions — no broad host access beyond what `content_scripts` already provides
