// End-to-end tests for image import (js/image.js), driven through the real UI
// in headless Chromium over CDP (see cdp.mjs).
//
// Usage:
//   npm run build && node tools/test-image.mjs [--shots <dir>]
//
// Spins up two local HTTP servers on different origins — one serving the app,
// one serving fixture images with and without CORS headers — so the
// embed-vs-link fallback is exercised for real. --shots writes a screenshot
// after each test for visual review.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { launch, sleep } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS_DIR = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;

// --- Fixtures ---

// Solid-color RGB PNG, encoded by hand (zlib is all PNG needs).
function solidPng(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 160, 0];
const FIX = {
  cors: solidPng(400, 200, RED),
  nocors: solidPng(400, 200, BLUE),
  big: solidPng(2000, 1000, GREEN),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">' +
    '<rect width="120" height="80" fill="#ff00ff"/></svg>'),
};

// --- Servers ---

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function listen(handler) {
  return new Promise((res) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => res({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const app = await listen(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(ROOT, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});

// A different origin, so the app's fetch() is subject to CORS.
const assets = await listen((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/cors.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' }).end(FIX.cors);
  } else if (path === '/nocors.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(FIX.nocors);
  } else {
    res.writeHead(404).end();
  }
});

const tmp = await mkdtemp(join(tmpdir(), 'euclid-image-test-'));
const files = {
  big: join(tmp, 'big.png'),
  svg: join(tmp, 'badge.svg'),
  red: join(tmp, 'red.png'),
  text: join(tmp, 'notes.txt'),
};
await writeFile(files.big, FIX.big);
await writeFile(files.svg, FIX.svg);
await writeFile(files.red, FIX.cors);
await writeFile(files.text, 'not an image');
if (SHOTS_DIR) await mkdir(SHOTS_DIR, { recursive: true });

// --- Browser ---

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

const { cdp, close } = await launch({ width: 1400, height: 900 });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

const dialogs = [];
cdp.on('Page.javascriptDialogOpening', (p) => {
  dialogs.push(p.message);
  cdp.send('Page.handleJavaScriptDialog', { accept: true });
});
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));

// --- Page helpers ---

// userGesture lets a scripted click open a file chooser, like a real click.
async function evaluate(expr, { userGesture = false } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture,
  });
  if (r.exceptionDetails) {
    throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(expr, what, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await evaluate(`return (${expr});`);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function freshPage() {
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
  a: { code: 'KeyA', windowsVirtualKeyCode: 65 },
  g: { code: 'KeyG', windowsVirtualKeyCode: 71 },
};
const MOD = { ctrl: 2, shift: 8 };

async function press(key, modifiers = 0) {
  const k = KEYS[key];
  const text = modifiers ? undefined : k.text;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, ...k, text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, ...k, text: undefined });
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click();`, { userGesture: true });
}

async function center(selector) {
  return evaluate(`
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
}

// Canvas (viewBox) point -> client pixels.
async function toClient(x, y) {
  return evaluate(`
    const svg = document.getElementById('canvas');
    const p = new DOMPoint(${x}, ${y}).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };`);
}

// Real mouse drag (CDP mouse events become pointer events in the page).
async function drag(from, to, modifiers = 0, steps = 8) {
  const m = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent',
    { type, x: p.x, y: p.y, modifiers, button: 'left', ...extra });
  await m('mouseMoved', from, { button: 'none' });
  await m('mousePressed', from, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await m('mouseMoved', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, { buttons: 1 });
  }
  await m('mouseReleased', to, { buttons: 0, clickCount: 1 });
  await sleep(50);
}

// A drag delta in canvas units -> client pixels, applied to a client point.
async function offset(from, dx, dy) {
  const a = await toClient(0, 0), b = await toClient(dx, dy);
  return { x: from.x + (b.x - a.x), y: from.y + (b.y - a.y) };
}

async function typeUrl(url) {
  await evaluate('const i = document.getElementById("image-url"); i.focus(); i.select();');
  await cdp.send('Input.insertText', { text: url });
}

async function openModal() {
  await click('#image-btn');
  await waitFor('!document.getElementById("image-modal").hidden', 'image modal to open');
}

const modalOpen = () => evaluate('return !document.getElementById("image-modal").hidden;');
const previewMeta = () => evaluate('return document.getElementById("image-preview-meta").textContent;');
const errorText = () => evaluate('const e = document.getElementById("image-error"); return e.hidden ? "" : e.textContent;');

// Pick a file through the real Browse… / Open buttons: the click opens a file
// chooser, which CDP intercepts and fills.
async function chooseFile(buttonSelector, path) {
  const chooser = cdp.once('Page.fileChooserOpened');
  await click(buttonSelector);
  const { backendNodeId } = await Promise.race([chooser,
    sleep(4000).then(() => { throw new Fail(`no file chooser opened from ${buttonSelector}`); })]);
  await cdp.send('DOM.setFileInputFiles', { files: [path], backendNodeId });
}

// Native drag-and-drop of files from the OS onto a client point.
async function dropFiles(paths, at) {
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  }
  await sleep(50);
}

// Text of the most recent capture download with this file name.
async function lastDownload(name) {
  return evaluate(`
    const d = window.__downloads.filter((d) => d.name === ${JSON.stringify(name)}).pop();
    return d ? await d.blob.text() : null;`);
}

// The document model, read through the real Save button.
async function savedDoc() {
  await click('#save-btn');
  return JSON.parse(await lastDownload('drawing.euclid.json'));
}

async function exportedSvg() {
  await click('#download-btn');
  return lastDownload('canvas.svg');
}

function images(doc) {
  const out = [];
  const walk = (n) => { if (n.type === 'image') out.push(n); (n.children || []).forEach(walk); };
  walk(doc.doc);
  return out;
}

async function onlyImage() {
  const imgs = images(await savedDoc());
  eq(imgs.length, 1, 'image node count');
  return imgs[0];
}

// --- Assertions ---

class Fail extends Error {}
function ok(cond, msg) { if (!cond) throw new Fail(msg); }
function eq(a, b, msg) { if (a !== b) throw new Fail(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function near(a, b, msg, tol = 0.5) { if (!(Math.abs(a - b) <= tol)) throw new Fail(`${msg}: expected ≈${b}, got ${a}`); }

// --- Tests ---

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('URL with CORS is embedded as data: and centered on the canvas', async () => {
  await openModal();
  await typeUrl(`${assets.origin}/cors.png`);
  await press('Enter');  // first Enter loads the preview
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  const meta = await previewMeta();
  ok(meta.startsWith('400 × 200 px · embedded'), `preview meta: ${meta}`);
  await press('Enter');  // second Enter places it
  await waitFor('document.getElementById("image-modal").hidden', 'modal to close');

  const img = await onlyImage();
  ok(img.attrs.href.startsWith('data:image/png;base64,'), `href is a PNG data URL: ${img.attrs.href.slice(0, 40)}`);
  // 400×200 fits inside 60% of the visible canvas, so it's placed 1:1, centered
  // on the canvas middle (500, 350).
  eq(img.attrs.width, 400, 'width'); eq(img.attrs.height, 200, 'height');
  eq(img.attrs.x, 300, 'x'); eq(img.attrs.y, 250, 'y');
  ok((await exportedSvg()).includes(`href="${img.attrs.href}"`), 'exported SVG contains the data URL');
  ok(await evaluate('return !!document.querySelector("#canvas image")'), 'image rendered on canvas');
});

test('URL without CORS falls back to a linked href', async () => {
  const url = `${assets.origin}/nocors.png`;
  await openModal();
  await typeUrl(url);
  await click('#image-confirm');  // Place straight after typing loads + places in one click
  await waitFor('document.getElementById("image-modal").hidden', 'modal to close');
  const img = await onlyImage();
  eq(img.attrs.href, url, 'href links to the URL');
  ok((await exportedSvg()).includes(`href="${url}"`), 'exported SVG links to the URL');
});

test('URL without CORS shows the "server doesn\'t allow embedding" note', async () => {
  await openModal();
  await typeUrl(`${assets.origin}/nocors.png`);
  await press('Enter');
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  const meta = await previewMeta();
  ok(meta.includes("linked by URL (the server doesn't allow embedding)"), `preview meta: ${meta}`);
});

test('Unchecking "Embed" links even a CORS-enabled URL', async () => {
  const url = `${assets.origin}/cors.png`;
  await openModal();
  await evaluate('document.getElementById("image-embed").click();');
  await typeUrl(url);
  await press('Enter');
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  ok((await previewMeta()).endsWith('· linked by URL'), `preview meta: ${await previewMeta()}`);
  await click('#image-confirm');
  await waitFor('document.getElementById("image-modal").hidden', 'modal to close');
  eq((await onlyImage()).attrs.href, url, 'href links to the URL');
});

test('Bad URLs show an error and keep the dialog open', async () => {
  await openModal();
  await typeUrl(`${assets.origin}/missing.png`);
  await click('#image-confirm');
  await waitFor('!document.getElementById("image-error").hidden', 'error');
  eq(await errorText(), "Couldn't load an image from that URL.", 'error for 404');
  ok(await modalOpen(), 'dialog stays open');

  await typeUrl('javascript:alert(1)');
  await press('Enter');
  await waitFor('document.getElementById("image-error").textContent.includes("Unsupported")', 'scheme error');
  ok((await errorText()).startsWith('Unsupported URL scheme "javascript:"'), `error: ${await errorText()}`);

  await typeUrl('');
  await click('#image-confirm');
  eq(await errorText(), 'Enter an image URL or choose a file.', 'error for empty URL');
  eq(images(await savedDoc()).length, 0, 'nothing placed');
});

test('Browse… a large local PNG: previewed, embedded, scaled to fit 60% of the canvas', async () => {
  await openModal();
  await chooseFile('#image-browse', files.big);
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  const meta = await previewMeta();
  ok(/^2000 × 1000 px · embedded, \d+ (B|KB)$/.test(meta), `preview meta: ${meta}`);
  await click('#image-confirm');
  await waitFor('document.getElementById("image-modal").hidden', 'modal to close');

  const img = await onlyImage();
  ok(img.attrs.href.startsWith('data:image/png;base64,'), 'href is a PNG data URL');
  // Scaled to fit 60% of the visible canvas (the viewBox follows the window
  // aspect), keeping its 2:1 ratio, and centered.
  const vb = await evaluate('const b = document.getElementById("canvas").viewBox.baseVal; return { x: b.x, y: b.y, w: b.width, h: b.height };');
  const fit = Math.min(vb.w * 0.6 / 2000, vb.h * 0.6 / 1000);
  ok(fit < 1, 'image is larger than the canvas');
  near(img.attrs.width, 2000 * fit, 'width', 0.01); near(img.attrs.height, 1000 * fit, 'height', 0.01);
  near(img.attrs.x + img.attrs.width / 2, vb.x + vb.w / 2, 'centered x', 0.01);
  near(img.attrs.y + img.attrs.height / 2, vb.y + vb.h / 2, 'centered y', 0.01);
});

test('Browse… a local SVG: embedded at its intrinsic size', async () => {
  await openModal();
  await chooseFile('#image-browse', files.svg);
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  ok((await previewMeta()).startsWith('120 × 80 px · embedded'), `preview meta: ${await previewMeta()}`);
  await click('#image-confirm');
  await waitFor('document.getElementById("image-modal").hidden', 'modal to close');
  const img = await onlyImage();
  ok(img.attrs.href.startsWith('data:image/svg+xml;base64,'), `href: ${img.attrs.href.slice(0, 40)}`);
  eq(img.attrs.width, 120, 'width'); eq(img.attrs.height, 80, 'height');
});

test('Browse… a non-image file shows an error', async () => {
  await openModal();
  await chooseFile('#image-browse', files.text);
  await waitFor('!document.getElementById("image-error").hidden', 'error');
  eq(await errorText(), '"notes.txt" is not an image.', 'error');
});

test('Drop an image file onto the canvas places it', async () => {
  const before = await evaluate('return location.href;');
  await dropFiles([files.red], await toClient(500, 350));
  await waitFor('document.querySelector("#canvas image")', 'dropped image to render');
  const img = await onlyImage();
  ok(img.attrs.href.startsWith('data:image/png;base64,'), 'href is a PNG data URL');
  eq(img.attrs.width, 400, 'width');
  eq(await evaluate('return location.href;'), before, 'page did not navigate');
  eq(dialogs.length, 0, 'no alert');
});

test('Drop a non-image file onto the canvas: alert, nothing placed, no navigation', async () => {
  const before = await evaluate('return location.href;');
  await dropFiles([files.text], await toClient(500, 350));
  await sleep(200);
  eq(dialogs[0], 'Only image files can be placed.', 'alert message');
  eq(await evaluate('return location.href;'), before, 'page did not navigate');
  eq(images(await savedDoc()).length, 0, 'nothing placed');
});

test('Drop files into the open dialog: images are staged, non-images error', async () => {
  await openModal();
  const at = await center('#image-modal .modal-card');
  await dropFiles([files.text], at);
  await waitFor('!document.getElementById("image-error").hidden', 'error');
  eq(await errorText(), 'Only image files can be placed.', 'error');
  await dropFiles([files.svg], at);
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  ok((await previewMeta()).startsWith('120 × 80 px'), `preview meta: ${await previewMeta()}`);
  eq(await errorText(), '', 'error cleared');
});

// Place the 400×200 red PNG at (300,250) via the file picker; it ends up selected.
async function placeRed() {
  await openModal();
  await chooseFile('#image-browse', files.red);
  await waitFor('!document.getElementById("image-preview").hidden', 'preview');
  await click('#image-confirm');
  await waitFor('document.querySelector(\'[data-role="resize"][data-handle="se"]\')', 'resize handles');
  await evaluate('document.activeElement?.blur();');
}

test('Corner resize keeps the aspect ratio; Shift resizes freely', async () => {
  await placeRed();
  const se = '[data-role="resize"][data-handle="se"]';
  let from = await center(se);
  await drag(from, await offset(from, 100, 10));  // mostly horizontal drag
  let img = await onlyImage();
  ok(img.attrs.width > 450, `width grew: ${img.attrs.width}`);
  near(img.attrs.width / img.attrs.height, 2, 'aspect ratio kept', 0.01);
  near(img.attrs.x, 300, 'nw corner x anchored'); near(img.attrs.y, 250, 'nw corner y anchored');

  const w0 = img.attrs.width, h0 = img.attrs.height;
  from = await center(se);
  await drag(from, await offset(from, 60, 90), MOD.shift);
  img = await onlyImage();
  near(img.attrs.width, w0 + 60, 'free width', 1.5);
  near(img.attrs.height, h0 + 90, 'free height', 1.5);
  ok(Math.abs(img.attrs.width / img.attrs.height - 2) > 0.1, `aspect changed: ${img.attrs.width}×${img.attrs.height}`);
});

test('A grouped image scales with its group', async () => {
  await placeRed();
  // Draw a rect with the real Rectangle tool, above-left of the image.
  await click('[data-tool="rect"]');
  await drag(await toClient(100, 100), await toClient(200, 180));
  await click('[data-tool="select"]');
  await evaluate('document.activeElement?.blur();');
  await press('a', MOD.ctrl);
  await press('g', MOD.ctrl);
  let doc = await savedDoc();
  const group = doc.doc.children.find((c) => c.type === 'group');
  ok(group && group.children.length === 2, 'image + rect grouped');
  const rect0 = group.children.find((c) => c.type === 'rect').attrs;
  const img0 = group.children.find((c) => c.type === 'image').attrs;

  // Group bbox spans (100,100)–(700,450); drag its SE corner by (+300, +70).
  const se = await center(`[data-role="resize"][data-id="${group.id}"][data-handle="se"]`);
  await drag(se, await offset(se, 300, 70));

  doc = await savedDoc();
  const g = doc.doc.children.find((c) => c.id === group.id);
  const rect = g.children.find((c) => c.type === 'rect').attrs;
  const img = g.children.find((c) => c.type === 'image').attrs;
  const sx = rect.width / rect0.width, sy = rect.height / rect0.height;
  ok(sx > 1.3 && sy > 1.1, `group scaled: sx=${sx.toFixed(3)} sy=${sy.toFixed(3)}`);
  near(img.width / img0.width, sx, 'image x-scale matches rect', 0.01);
  near(img.height / img0.height, sy, 'image y-scale matches rect', 0.01);
  near(img.x - rect.x, (img0.x - rect0.x) * sx, 'image x offset scaled', 0.5);
  near(img.y - rect.y, (img0.y - rect0.y) * sy, 'image y offset scaled', 0.5);
  // The rendered element follows the model.
  const box = await evaluate('const b = document.querySelector("#canvas image").getBBox(); return { w: b.width, h: b.height };');
  near(box.w, img.width, 'rendered width'); near(box.h, img.height, 'rendered height');
});

test('Layers panel shows the image icon; source panel elides base64 but Copy/Export keep it', async () => {
  await placeRed();
  const img = await onlyImage();
  const hasIcon = await evaluate(`
    const row = document.querySelector('.layer-row[data-id="${img.id}"]');
    return !!row && !!row.querySelector('.layer-icon circle[r="1"]') && !!row.querySelector('.layer-icon path');`);
  ok(hasIcon, 'image layer row has the picture icon');

  await sleep(100);  // source panel refresh is debounced
  const source = await evaluate('return document.getElementById("source").textContent;');
  const m = source.match(/href="(data:image\/png;base64,)([^"]*)"/);
  ok(m, 'source panel shows the data URL head');
  eq(m[2].length, 65, 'kept 64 base64 chars + ellipsis');
  ok(m[2].endsWith('…'), 'ends with an ellipsis');
  ok(!source.includes(img.attrs.href), 'full data not in source panel');

  await click('#copy-btn');
  await waitFor('window.__clipboard.length', 'clipboard write');
  ok((await evaluate('return window.__clipboard.at(-1);')).includes(`href="${img.attrs.href}"`), 'Copy has full data');
  ok((await exportedSvg()).includes(`href="${img.attrs.href}"`), 'Export has full data');
});

test('Save → Open round-trips the image; exported SVG renders standalone', async () => {
  await placeRed();
  await click('#save-btn');
  const saved = await lastDownload('drawing.euclid.json');
  const orig = images(JSON.parse(saved))[0];
  const svgText = await exportedSvg();

  await freshPage();
  eq(images(await savedDoc()).length, 0, 'fresh page is empty');
  const docFile = join(tmp, 'drawing.euclid.json');
  await writeFile(docFile, saved);
  await chooseFile('#open-btn', docFile);
  await waitFor('document.querySelector("#canvas image")', 'opened image to render');
  const back = images(await savedDoc())[0];
  for (const k of ['href', 'x', 'y', 'width', 'height']) eq(back.attrs[k], orig.attrs[k], `round-tripped ${k}`);

  // An SVG loaded as an <img> can't fetch anything external, so a correct
  // pixel here proves the export is self-contained.
  const px = await evaluate(`
    const url = URL.createObjectURL(new Blob([${JSON.stringify(svgText)}], { type: 'image/svg+xml' }));
    const el = new Image();
    await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('svg failed to load')); el.src = url; });
    const c = document.createElement('canvas'); c.width = 1000; c.height = 700;
    const ctx = c.getContext('2d'); ctx.drawImage(el, 0, 0, 1000, 700);
    return { inside: [...ctx.getImageData(500, 350, 1, 1).data], outside: [...ctx.getImageData(50, 50, 1, 1).data] };`);
  eq(px.inside.join(), '255,0,0,255', 'image pixel in exported SVG');
  eq(px.outside[3], 0, 'transparent outside the image');
});

// --- Run ---

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
    if (SHOTS_DIR) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(SHOTS_DIR, `${String(i + 1).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
    }
  }
} finally {
  close();
  app.srv.close();
  assets.srv.close();
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
