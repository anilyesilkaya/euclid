// Minimal Chrome DevTools Protocol client over the headless Chromium that
// Playwright previously cached on disk (Playwright itself can't be installed
// here — the npm mirror 502s). Node 24 ships a global WebSocket, so no deps.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCALAPPDATA = process.env.LOCALAPPDATA || join(process.env.HOME || '', 'AppData/Local');
const CANDIDATES = [
  `${LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`,
  `${LOCALAPPDATA}/ms-playwright/chromium-1234/chrome-win64/chrome.exe`,
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
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
  off(method) { this.handlers.delete(method); }
  once(method) {
    return new Promise((resolve) => this.on(method, (params) => { this.off(method); resolve(params); }));
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

// Launch headless Chromium and attach to its first page.
// Returns { cdp, close }.
export async function launch({ width = 1280, height = 860 } = {}) {
  const chrome = CANDIDATES.find(existsSync);
  if (!chrome) throw new Error('no cached chromium found in ' + CANDIDATES.join(', '));
  const port = 9222 + Math.floor((Date.now() % 5000));
  const profile = mkdtempSync(join(tmpdir(), 'euclid-cdp-'));
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const getJSON = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await getJSON('/json/version'); up = true; } catch { await sleep(200); }
  }
  if (!up) { proc.kill(); throw new Error('devtools endpoint never came up'); }

  const targets = await getJSON('/json/list');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = await connect(page.webSocketDebuggerUrl);
  return { cdp: new CDP(ws), close: () => { ws.close(); proc.kill(); } };
}
