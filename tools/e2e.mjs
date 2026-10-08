// Shared harness for the end-to-end tests (tools/test-*.mjs): serves the app
// from the repo root, drives it in headless Chromium over CDP (see cdp.mjs),
// and provides page helpers, assertions, and a tiny test runner.
//
// Call `await start()` once before using any helper.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

export { sleep };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

export function listen(handler) {
  return new Promise((res) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => res({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// Installed before the app loads on every navigation: capture downloads
// (Save / Export SVG) and clipboard writes (Copy) instead of letting them leave
// the page.
const INIT = `
  window.__downloads = [];
  window.__clipboard = [];
  const __blobs = new Map();
  const __create = URL.createObjectURL;
  URL.createObjectURL = function (b) { const u = __create.call(URL, b); __blobs.set(u, b); return u; };
  const __click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && __blobs.has(this.href)) {
      window.__downloads.push({ name: this.download, blob: __blobs.get(this.href) });
      return;
    }
    return __click.call(this);
  };
  if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { window.__clipboard.push(t); };
`;

let cdp, closeBrowser, app;
export const dialogs = [];
const pageErrors = [];

export async function start() {
  app = await listen(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });

  ({ cdp, close: closeBrowser } = await launch({ width: 1400, height: 900 }));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  cdp.on('Page.javascriptDialogOpening', (p) => {
    dialogs.push(p.message);
    cdp.send('Page.handleJavaScriptDialog', { accept: true });
  });
  cdp.on('Runtime.exceptionThrown', (p) =>
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  return cdp;
}

// --- Page helpers ---

// userGesture lets a scripted click open a file chooser, like a real click.
export async function evaluate(expr, { userGesture = false } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture,
  });
  if (r.exceptionDetails) {
    throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

export async function waitFor(expr, what, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await evaluate(`return (${expr});`);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function freshPage() {
  await evaluate('try { localStorage.clear(); } catch {}');
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: app.origin + '/' });
  await loaded;
  await waitFor('document.querySelector("#image-btn")', 'app to mount');
  dialogs.length = 0;
  pageErrors.length = 0;
}

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  a: { code: 'KeyA', windowsVirtualKeyCode: 65 },
  g: { code: 'KeyG', windowsVirtualKeyCode: 71 },
};
export const MOD = { ctrl: 2, shift: 8 };

export async function press(key, modifiers = 0) {
  const k = KEYS[key];
  const text = modifiers ? undefined : k.text;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, ...k, text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k, text: undefined });
}

// Type text into the focused element, as an IME commit.
export async function insertText(text) {
  await cdp.send('Input.insertText', { text });
}

export async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click();`, { userGesture: true });
}

export async function center(selector) {
  return evaluate(`
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
}

// Canvas (viewBox) point -> client pixels.
export async function toClient(x, y) {
  return evaluate(`
    const svg = document.getElementById('canvas');
    const p = new DOMPoint(${x}, ${y}).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };`);
}

const mouse = (type, p, modifiers, extra = {}) => cdp.send('Input.dispatchMouseEvent',
  { type, x: p.x, y: p.y, modifiers, button: 'left', ...extra });

// Hover the mouse at a client point (no buttons held).
export async function hover(p) {
  await mouse('mouseMoved', p, 0, { button: 'none' });
  await sleep(20);
}

// Single left click at a client point.
export async function clickAt(p) {
  await mouse('mouseMoved', p, 0, { button: 'none' });
  await mouse('mousePressed', p, 0, { buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', p, 0, { buttons: 0, clickCount: 1 });
  await sleep(30);
}

// Real mouse drag (CDP mouse events become pointer events in the page).
// `beforeRelease` runs with the button still held at `to`.
export async function drag(from, to, modifiers = 0, steps = 8, beforeRelease = null) {
  await mouse('mouseMoved', from, modifiers, { button: 'none' });
  await mouse('mousePressed', from, modifiers, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, modifiers, { buttons: 1 });
  }
  if (beforeRelease) await beforeRelease();
  await mouse('mouseReleased', to, modifiers, { buttons: 0, clickCount: 1 });
  await sleep(50);
}

// A drag delta in canvas units -> client pixels, applied to a client point.
export async function offset(from, dx, dy) {
  const a = await toClient(0, 0), b = await toClient(dx, dy);
  return { x: from.x + (b.x - a.x), y: from.y + (b.y - a.y) };
}

// Pick a file through a real button that opens a file chooser, which CDP
// intercepts and fills.
export async function chooseFile(buttonSelector, path) {
  const chooser = cdp.once('Page.fileChooserOpened');
  await click(buttonSelector);
  const { backendNodeId } = await Promise.race([chooser,
    sleep(4000).then(() => { throw new Fail(`no file chooser opened from ${buttonSelector}`); })]);
  await cdp.send('DOM.setFileInputFiles', { files: [path], backendNodeId });
}

// Native drag-and-drop of files from the OS onto a client point.
export async function dropFiles(paths, at) {
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  }
  await sleep(50);
}

// Text of the most recent captured download with this file name.
export async function lastDownload(name) {
  return evaluate(`
    const d = window.__downloads.filter((d) => d.name === ${JSON.stringify(name)}).pop();
    return d ? await d.blob.text() : null;`);
}

// The document model, read through the real Save button.
export async function savedDoc() {
  await click('#save-btn');
  return JSON.parse(await lastDownload('drawing.euclid.json'));
}

export async function exportedSvg() {
  await click('#download-btn');
  return lastDownload('canvas.svg');
}

// All nodes of `type` in a saved document.
export function nodesOfType(doc, type) {
  const out = [];
  const walk = (n) => { if (n.type === type) out.push(n); (n.children || []).forEach(walk); };
  walk(doc.doc);
  return out;
}

// --- Assertions ---

export class Fail extends Error {}
export function ok(cond, msg) { if (!cond) throw new Fail(msg); }
export function eq(a, b, msg) { if (a !== b) throw new Fail(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
export function near(a, b, msg, tol = 0.5) { if (!(Math.abs(a - b) <= tol)) throw new Fail(`${msg}: expected ≈${b}, got ${a}`); }

// --- Runner ---

const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

// Run every registered test on a fresh page; `cleanup` runs after the browser
// closes. --shots <dir> writes a screenshot after each test for visual review.
export async function run(cleanup = () => {}) {
  const shotsIdx = process.argv.indexOf('--shots');
  const shotsDir = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  let failed = 0;
  try {
    for (const [i, t] of tests.entries()) {
      await freshPage();
      try {
        await t.fn();
        if (pageErrors.length) throw new Fail('page error: ' + pageErrors[0]);
        console.log(`  ✓ ${t.name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${t.name}\n      ${err instanceof Fail ? err.message : err.stack}`);
      }
      if (shotsDir) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(shotsDir, `${String(i + 1).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
      }
    }
  } finally {
    closeBrowser();
    app.srv.close();
    await cleanup();
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
