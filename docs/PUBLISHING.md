# Publishing Mirrory

This guide covers deploying the server to Railway and submitting the extension to the Chrome Web Store.

---

## 1. Deploy the Server to Railway

### Prerequisites

- A [Railway](https://railway.app) account
- The [Railway CLI](https://docs.railway.app/develop/cli) installed (`npm i -g @railway/cli`)

### Steps

```bash
# 1. Login
railway login

# 2. Create a new project from the server directory
cd server
railway init          # name it "mirrory-server"

# 3. Deploy
railway up

# 4. Expose a public URL
railway domain        # e.g. mirrory-server.up.railway.app
```

### Update the extension

Open `extension/content.js` and update line 2:

```js
const SERVER_URL = 'wss://YOUR-APP.up.railway.app';
```

Replace `YOUR-APP` with the domain Railway assigned.

### Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the HTTP/WS server listens on (Railway sets this automatically) |

---

## 2. Package the Extension

```bash
# From the repo root — zip the extension/ folder
cd extension
zip -r ../mirrory-extension.zip . --exclude "*.DS_Store"
```

On Windows (PowerShell):

```powershell
Compress-Archive -Path extension\* -DestinationPath mirrory-extension.zip
```

---

## 3. Chrome Web Store Submission

### Prerequisites

- A [Chrome Web Store Developer account](https://chrome.google.com/webstore/devconsole) ($5 one-time fee)

### Step-by-step

1. **Go to** [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)

2. **Click** "New item" → upload `mirrory-extension.zip`

3. **Fill in the store listing:**
   - **Name:** Mirrory
   - **Short description (≤132 chars):** Share your browsing in real-time. Generate a link — your guest sees your scroll, navigation and cursor live.
   - **Detailed description:** *(copy from README.md)*
   - **Category:** Productivity
   - **Language:** English

4. **Upload screenshots** (required — 1280×800 or 640×400 px):
   - Screenshot 1: Popup in host mode showing the share link
   - Screenshot 2: Guest browser showing the `👁 WATCHING` badge and cursor dot
   - Promotional image (optional, 440×280 px)

5. **Privacy tab:**
   - Single purpose: "Real-time browsing session sharing"
   - Justify each permission:
     - `activeTab` — read current tab URL to build share link
     - `tabs` — detect navigation changes to relay to guests
     - `storage` — persist session ID across popup open/close
     - `scripting` — inject content script on demand after navigation
     - `<all_urls>` — content script must run on any page the host visits

6. **Payments:** Free, no in-app purchases

7. **Submit for review** — Google typically reviews in 1–3 business days

---

## 4. Post-publish checklist

- [ ] Update `SERVER_URL` in `content.js` to production Railway URL before packaging
- [ ] Test on Chrome stable (not just Canary/Dev)
- [ ] Test with a guest on a different machine and screen size
- [ ] Verify session TTL — open a session and wait 2+ hours, confirm it ends
- [ ] Add the Chrome Web Store badge URL to README.md
- [ ] Tag the release in git: `git tag v1.0.0 && git push --tags`

---

## 5. Updates

To publish an update:

1. Bump `version` in `extension/manifest.json` (e.g. `1.0.1`)
2. Re-zip and re-upload in the Developer Dashboard
3. Click **Submit for review**

Railway server updates deploy automatically on `git push` if you connected the GitHub repo in the Railway dashboard.
