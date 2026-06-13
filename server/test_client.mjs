import { WebSocket } from 'ws';

const URL = 'ws://localhost:3000';
const log = (who, msg) => console.log(`[${new Date().toISOString().slice(11, 23)}] [${who.padEnd(5)}] ${msg}`);

function connect(label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => { log(label, 'connected'); resolve(ws); });
    ws.on('error', (e) => { log(label, `ERROR: ${e.message}`); });
  });
}

function waitMsg(ws, label) {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      const msg = JSON.parse(data);
      log(label, `<< ${JSON.stringify(msg)}`);
      resolve(msg);
    });
  });
}

function send(ws, label, msg) {
  log(label, `>> ${JSON.stringify(msg)}`);
  ws.send(JSON.stringify(msg));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Health check ──────────────────────────────────────────────────────────
console.log('\n── 1. Health check ─────────────────────────────────────────');
const res = await fetch('http://localhost:3000/health');
const health = await res.json();
log('http ', `GET /health → ${JSON.stringify(health)}`);

await sleep(150);

// ── 2. Host creates session ──────────────────────────────────────────────────
console.log('\n── 2. Host creates session ─────────────────────────────────');
const host = await connect('host');
send(host, 'host', { type: 'host_create' });
const created = await waitMsg(host, 'host');
const sessionId = created.sessionId;
log('test ', `session ID → ${sessionId}`);

await sleep(150);

// ── 3. Guest joins ───────────────────────────────────────────────────────────
console.log('\n── 3. Guest joins ──────────────────────────────────────────');
const guest = await connect('guest');
send(guest, 'guest', { type: 'guest_join', sessionId });
const [guestConf, guestCount] = await Promise.all([
  waitMsg(guest, 'guest'),
  waitMsg(host,  'host'),
]);

await sleep(150);

// ── 4. Scroll broadcast ──────────────────────────────────────────────────────
console.log('\n── 4. Scroll broadcast ─────────────────────────────────────');
send(host, 'host', { type: 'scroll', yPct: 0.42 });
await waitMsg(guest, 'guest');

await sleep(100);

// ── 5. Cursor broadcast ──────────────────────────────────────────────────────
console.log('\n── 5. Cursor broadcast ─────────────────────────────────────');
send(host, 'host', { type: 'cursor', xPct: 0.5, yPct: 0.3 });
await waitMsg(guest, 'guest');

await sleep(100);

// ── 6. Navigate broadcast ────────────────────────────────────────────────────
console.log('\n── 6. Navigate broadcast ───────────────────────────────────');
send(host, 'host', { type: 'navigate', url: 'https://example.com' });
await waitMsg(guest, 'guest');

await sleep(100);

// ── 7. Host kills session ────────────────────────────────────────────────────
console.log('\n── 7. Kill session ─────────────────────────────────────────');
send(host, 'host', { type: 'host_kill' });
await Promise.all([
  waitMsg(host,  'host'),
  waitMsg(guest, 'guest'),
]);

await sleep(150);

// ── 7b. Viewport broadcast ──────────────────────────────────────────────────
console.log('\n── 7b. Viewport broadcast ──────────────────────────────────');
// Need a fresh session since kill closed the previous one
const host2  = await connect('host2');
const guest2 = await connect('gust2');
send(host2, 'host2', { type: 'host_create' });
const created2 = await waitMsg(host2, 'host2');
send(guest2, 'gust2', { type: 'guest_join', sessionId: created2.sessionId });
await Promise.all([ waitMsg(guest2, 'gust2'), waitMsg(host2, 'host2') ]);
send(host2, 'host2', { type: 'viewport', vw: 1440, vh: 820 });
const vp = await waitMsg(guest2, 'gust2');
if (vp.type !== 'viewport' || vp.vw !== 1440 || vp.vh !== 820) {
  throw new Error('viewport relay failed: ' + JSON.stringify(vp));
}
send(host2, 'host2', { type: 'host_kill' });
await Promise.all([ waitMsg(host2, 'host2'), waitMsg(guest2, 'gust2') ]);
host2.close(); guest2.close();

await sleep(150);

// ── 8. Final health check (sessions = 0) ────────────────────────────────────
console.log('\n── 8. Final health check ───────────────────────────────────');
const res2 = await fetch('http://localhost:3000/health');
const health2 = await res2.json();
log('http ', `GET /health → ${JSON.stringify(health2)}`);

host.close();
guest.close();

console.log('\n✓  All tests passed\n');
