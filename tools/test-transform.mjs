// End-to-end tests for the properties panel's X / Y / W / H fields and the
// proportions lock between W and H.
//
// Usage:
//   npm run build && node tools/test-transform.mjs [--shots <dir>]
import {
  start, run, test, evaluate, click, press, insertText, toClient, drag, offset, savedDoc,
  nodesOfType, MOD, ok, eq, near,
} from './e2e.mjs';

await start();

// --- Helpers ---

async function draw(tool, x1, y1, x2, y2) {
  await click(`[data-tool="${tool}"]`);
  await drag(await toClient(x1, y1), await toClient(x2, y2));
}

const fields = () => evaluate(`
  const v = (id) => document.getElementById(id).value;
  return { x: +v('p-x'), y: +v('p-y'), w: +v('p-w'), h: +v('p-h'),
           shown: !document.getElementById('transform-grid').hidden && !document.getElementById('props-form').hidden };`);

// Type into a field the way a user does: focus, select all, type, Enter.
async function typeField(id, text) {
  await evaluate(`const i = document.getElementById('${id}'); i.focus(); i.select();`);
  await insertText(text);
  await press('Enter');
  await evaluate(`document.getElementById('${id}').blur();`);
}

// Rendered canvas-space bbox of a node, from the drawing itself.
const renderedBox = (id) => evaluate(`
  const el = document.querySelector('#doc-layer [data-id="${id}"]');
  const b = el.getBBox();
  const m = document.getElementById('canvas').getScreenCTM().inverse().multiply(el.getScreenCTM());
  const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };`);

function nearBox(b, x, y, w, h, msg, tol = 0.6) {
  near(b.x, x, `${msg} x`, tol); near(b.y, y, `${msg} y`, tol);
  near(b.w, w, `${msg} w`, tol); near(b.h, h, `${msg} h`, tol);
}

const firstId = async (type) => nodesOfType(await savedDoc(), type)[0].id;
const lockOn = () => evaluate('return document.getElementById("p-lock").getAttribute("aria-pressed") === "true";');

// --- Tests ---

test('The fields show the selected shape’s X, Y, W and H', async () => {
  await draw('rect', 250, 150, 450, 250);
  const f = await fields();
  ok(f.shown, 'fields shown');
  nearBox(f, 250, 150, 200, 100, 'fields');
  await click('[data-tool="select"]');
  await clickEmpty();
  ok(!(await fields()).shown, 'hidden with nothing selected');
});

async function clickEmpty() {
  const p = await toClient(900, 650);
  await drag(p, p, 0, 1);
}

test('Typing X and Y moves the shape without resizing it', async () => {
  await draw('rect', 250, 150, 450, 250);
  await typeField('p-x', '100');
  await typeField('p-y', '60');
  const id = await firstId('rect');
  nearBox(await renderedBox(id), 100, 60, 200, 100, 'rendered');
  nearBox(await fields(), 100, 60, 200, 100, 'fields');
});

test('Typing W or H with the lock off changes only that side', async () => {
  await draw('rect', 250, 150, 450, 250);
  ok(!(await lockOn()), 'lock off by default');
  await typeField('p-w', '300');
  const id = await firstId('rect');
  nearBox(await renderedBox(id), 250, 150, 300, 100, 'after W');
  await typeField('p-h', '40');
  nearBox(await renderedBox(id), 250, 150, 300, 40, 'after H');
  const r = nodesOfType(await savedDoc(), 'rect')[0];
  near(r.attrs.width, 300, 'stored width'); near(r.attrs.height, 40, 'stored height');
});

test('With the lock on, W and H keep their proportions', async () => {
  await draw('rect', 250, 150, 450, 250);
  await click('#p-lock');
  ok(await lockOn(), 'lock on');
  await typeField('p-w', '400');
  const id = await firstId('rect');
  nearBox(await renderedBox(id), 250, 150, 400, 200, 'after W');
  await typeField('p-h', '50');
  nearBox(await renderedBox(id), 250, 150, 100, 50, 'after H');
  await click('#p-lock');
  ok(!(await lockOn()), 'lock toggles off');
});

test('The fields follow edits made on the canvas', async () => {
  await draw('rect', 250, 150, 450, 250);
  await click('[data-tool="select"]');
  const c = await toClient(350, 200);
  await drag(c, await offset(c, 50, 30));
  nearBox(await fields(), 300, 180, 200, 100, 'after a move');
});

test('Ellipses resize through their radii', async () => {
  await draw('ellipse', 200, 200, 400, 300);
  nearBox(await fields(), 200, 200, 200, 100, 'fields');
  await typeField('p-w', '100');
  const e = nodesOfType(await savedDoc(), 'ellipse')[0];
  near(e.attrs.rx, 50, 'rx'); near(e.attrs.ry, 50, 'ry unchanged');
  nearBox(await renderedBox(e.id), 200, 200, 100, 100, 'rendered');
});

test('A multi-selection moves and scales as one box', async () => {
  await draw('rect', 100, 100, 200, 200);
  await draw('rect', 300, 300, 400, 400);
  await click('[data-tool="select"]');
  await evaluate('document.activeElement?.blur();');
  await press('a', MOD.ctrl);
  nearBox(await fields(), 100, 100, 300, 300, 'union box');
  await typeField('p-w', '600');
  const [a, b] = nodesOfType(await savedDoc(), 'rect');
  nearBox(await renderedBox(a.id), 100, 100, 200, 100, 'first rect');
  nearBox(await renderedBox(b.id), 500, 300, 200, 100, 'second rect');
});

test('A rotated shape shows its rotated bounding box', async () => {
  await draw('rect', 300, 200, 500, 300);
  await evaluate(`
    const i = document.getElementById('p-rotation');
    i.value = '90'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));`);
  nearBox(await fields(), 350, 150, 100, 200, 'rotated 90°');
});

test('Invalid sizes are rejected and the field reverts', async () => {
  await draw('rect', 250, 150, 450, 250);
  for (const bad of ['0', '-20', '']) {
    await typeField('p-w', bad);
    near((await fields()).w, 200, `W after "${bad}"`);
  }
  near(nodesOfType(await savedDoc(), 'rect')[0].attrs.width, 200, 'shape unchanged');
});

test('Each field edit is one undo step', async () => {
  await draw('rect', 250, 150, 450, 250);
  await typeField('p-w', '300');
  await typeField('p-x', '50');
  await press('z', MOD.ctrl);
  const id = await firstId('rect');
  nearBox(await renderedBox(id), 250, 150, 300, 100, 'undo the move only');
  await press('z', MOD.ctrl);
  nearBox(await renderedBox(id), 250, 150, 200, 100, 'undo the resize');
});

test('A connector-only selection hides the fields', async () => {
  await draw('rect', 100, 100, 200, 200);
  await draw('rect', 400, 300, 500, 400);
  await click('[data-tool="connector"]');
  await drag(await toClient(202, 151), await toClient(398, 351));
  ok(nodesOfType(await savedDoc(), 'connector').length === 1, 'connector selected after drawing');
  ok(!(await fields()).shown, 'fields hidden');
});

test('Dragging a multi-selection corner still scales the whole selection', async () => {
  await draw('rect', 100, 100, 200, 200);
  await draw('rect', 300, 300, 400, 400);
  await click('[data-tool="select"]');
  await evaluate('document.activeElement?.blur();');
  await press('a', MOD.ctrl);
  const se = await evaluate(`
    const r = document.querySelector('[data-role="resize-multi"][data-handle="se"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await drag(se, await offset(se, 300, 0));  // union box 300 wide → 600 wide
  const [a, b] = nodesOfType(await savedDoc(), 'rect');
  nearBox(await renderedBox(a.id), 100, 100, 200, 100, 'first rect', 1);
  nearBox(await renderedBox(b.id), 500, 300, 200, 100, 'second rect', 1);
  nearBox(await fields(), 100, 100, 600, 300, 'fields follow', 1);
});

await run();
