// Zero-dependency headless-Chromium screenshot driver over the Chrome DevTools
// Protocol. Playwright can't be installed here (npm mirror 502s), but the
// browsers Playwright previously downloaded are cached on disk and Node 24 ships
// a global WebSocket, so we can drive Chromium directly.
//
// Usage:
//   node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [evalFile]
//
// If evalFile is given, its contents are evaluated in the page (via
// Runtime.evaluate, awaiting a returned promise) after load and before the
// screenshot — used to script interactions (click a tool, draw a shape, etc.).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, out, w = '1280', h = '860', waitMs = '600', evalFile] = process.argv;
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [w] [h] [waitMs] [evalFile]');
  process.exit(2);
}

const CANDIDATES = [
  `${process.env.LOCALAPPDATA || join(process.env.HOME || '', 'AppData/Local')}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`,
  `${process.env.LOCALAPPDATA || join(process.env.HOME || '', 'AppData/Local')}/ms-playwright/chromium-1234/chrome-win64/chrome.exe`,
];
const chrome = CANDIDATES.find(existsSync);
if (!chrome) { console.error('no cached chromium found in', CANDIDATES); process.exit(3); }

const port = 9222 + Math.floor((Date.now() % 5000));
const profile = mkdtempSync(join(tmpdir(), 'euclid-cdp-'));
const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  `--window-size=${w},${h}`,
  'about:blank',
];
const proc = spawn(chrome, args, { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}
async function waitForDevtools(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { return await getJSON('/json/version'); } catch { await sleep(200); }
  }
  throw new Error('devtools endpoint never came up');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        this.handlers.get(msg.method)(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

try {
  await waitForDevtools();
  const targets = await getJSON('/json/list');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = await connect(page.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(Number(waitMs));
  if (evalFile && existsSync(evalFile)) {
    const expr = readFileSync(evalFile, 'utf8');
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    if (r.result && r.result.value !== undefined) console.log('eval result:', JSON.stringify(r.result.value));
    await sleep(Number(waitMs));
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('wrote', out);
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  proc.kill();
}
