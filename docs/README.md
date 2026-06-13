# Mirrory

> Share your browsing in real-time with anyone — no account needed.

Mirrory is a Chrome extension that lets you stream your scroll position, navigation, and cursor to a guest via a simple share link.

---

## Screenshots

| Host popup | Guest overlay |
|---|---|
| *(screenshot placeholder)* | *(screenshot placeholder)* |

---

## Features

- **One-click sharing** — generate a session link instantly from the popup
- **Real-time scroll sync** — percentage-based, cross-screen compatible
- **Navigation mirroring** — guest follows every URL change
- **Live cursor overlay** — guest sees the host's cursor as a coloured dot
- **Kill switch** — host can end the session at any time
- **Visual indicators** — `● LIVE` badge for host, `👁 WATCHING` for guest
- **Auto-reconnect** — up to 3 attempts with back-off
- **Session TTL** — sessions automatically expire after 2 hours

---

## Setup

### Extension (development)

```bash
# Clone the repo
git clone https://github.com/your-org/mirrory.git
cd mirrory

# No build step needed — vanilla JS, no bundler
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the Mirrory icon to your toolbar

### Server (local development)

```bash
cd server
npm install
npm run dev
```

Server starts on `http://localhost:3000`.

Update `SERVER_URL` at the top of `extension/content.js` to `ws://localhost:3000` for local testing.

### Server (Railway deploy)

See [PUBLISHING.md](./PUBLISHING.md) for full deploy instructions.

---

## Usage

### Host

1. Click the Mirrory icon in the toolbar
2. Click **Start sharing**
3. Copy the generated link and share it with your guest
4. Browse normally — your guest sees everything in real time
5. Click **End session** when done

### Guest

1. Receive the share link from the host
2. Open the link in Chrome with the Mirrory extension installed
3. The `👁 WATCHING` badge appears — you are now mirroring the host
4. Click the icon → **Leave session** to disconnect

---

## Configuration

| Constant | File | Default | Description |
|---|---|---|---|
| `SERVER_URL` | `extension/content.js:2` | Railway URL | WebSocket server endpoint |
| `RECONNECT_MAX` | `extension/content.js:3` | `3` | Max reconnect attempts |
| `SESSION_TTL_MS` | `server/server.js:7` | `7200000` (2 h) | Session expiry |

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed data-flow diagram.

---

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for Chrome Web Store submission steps.

---

## License

MIT
