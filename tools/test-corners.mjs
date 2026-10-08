// End-to-end tests for the Direct Selection live-corner widgets: shown inside
// the corners of a rect or pen path, dragged to round every corner.
//
// Usage:
//   npm run build && node tools/test-corners.mjs [--shots <dir>]
import {
  start, run, test, evaluate, click, clickAt, press, toClient, drag, offset, savedDoc,
  exportedSvg, nodesOfType, MOD, ok, eq, near,
} from './e2e.mjs';

await start();

// --- Helpers ---

async function drawRect(x1, y1, x2, y2) {
  await click('[data-tool="rect"]');
  await drag(await toClient(x1, y1), await toClient(x2, y2));
}

// Corner widgets currently shown, in canvas units (via their screen position,
// so a rotated shape's widgets are reported where they actually are).
const widgets = () => evaluate(`
  const svg = document.getElementById('canvas');
  const inv = svg.getScreenCTM().inverse();
  return [...document.querySelectorAll('[data-role="corner-radius"]')].map((w) => {
    const r = w.getBoundingClientRect();
    const p = new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(inv);
    return { index: +w.getAttribute('data-index'), x: p.x, y: p.y };
  });`);

const widgetClient = (index) => evaluate(`
  const r = document.querySelector('[data-role="corner-radius"][data-index="${index}"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);

// Drag corner widget `index` by (dx, dy) canvas units.
async function dragWidget(index, dx, dy) {
  const from = await widgetClient(index);
  await drag(from, await offset(from, dx, dy));
}

const onlyRect = async () => {
  const rs = nodesOfType(await savedDoc(), 'rect');
  eq(rs.length, 1, 'rect count');
  return rs[0];
};

// --- Tests ---

test('Direct Selection shows a widget inside each corner of a rect', async () => {
  await drawRect(200, 150, 600, 450);
  eq((await widgets()).length, 0, 'none under the Select tool');
  await click('[data-tool="directselect"]');
  const w = await widgets();
  eq(w.length, 4, 'four widgets');
  for (const [x, y] of [[200, 150], [600, 150], [600, 450], [200, 450]]) {
    const c = w.find((p) => Math.abs(p.x - x) < 25 && Math.abs(p.y - y) < 25);
    ok(c, `widget near corner (${x}, ${y})`);
    ok(Math.abs(c.x - x) > 5 && Math.abs(c.y - y) > 5, `widget sits inside corner (${x}, ${y}), clear of the anchor`);
  }
});

test('Dragging a widget inward rounds every corner, and the rect stays a rect', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  await dragWidget(0, 40, 40);  // top-left widget, diagonally inward
  const r = await onlyRect();
  ok(r.attrs.rx > 35 && r.attrs.rx < 60, `rx grew: ${r.attrs.rx}`);
  eq(r.attrs.ry, r.attrs.rx, 'ry matches rx');
  eq(r.anchors, undefined, 'not converted to a path');
  // Widgets follow the radius: each sits at the fillet's inner corner.
  const w = await widgets();
  const tl = w.find((p) => p.index === 0);
  near(tl.x, 200 + r.attrs.rx, 'top-left widget x', 1); near(tl.y, 150 + r.attrs.rx, 'top-left widget y', 1);
  const br = w.find((p) => p.index === 2);
  near(br.x, 600 - r.attrs.rx, 'bottom-right widget x', 1); near(br.y, 450 - r.attrs.rx, 'bottom-right widget y', 1);
  eq(await evaluate('return document.getElementById("p-rect-radius-num").value;'), String(Math.round(r.attrs.rx)), 'panel shows the radius');
  ok(/<rect [^>]*rx="\d/.test(await exportedSvg()), 'exported with rx');
});

test('Grabbing a widget does not jump the radius', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  await dragWidget(1, -30, 30);  // top-right widget inward → some radius
  const r1 = (await onlyRect()).attrs.rx;
  await dragWidget(1, -10, 10);  // grab again, move a little further
  const r2 = (await onlyRect()).attrs.rx;
  near(r2 - r1, 10, 'radius grows only by the extra drag', 1.5);
});

test('Dragging back out to the corner makes it sharp again', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  await dragWidget(0, 50, 50);
  ok((await onlyRect()).attrs.rx > 0, 'rounded first');
  await dragWidget(0, -120, -120);  // well past the corner
  const r = await onlyRect();
  eq(r.attrs.rx, undefined, 'rx removed');
  eq(r.attrs.ry, undefined, 'ry removed');
});

test('The radius stops at half the shorter side', async () => {
  await drawRect(200, 150, 600, 350);  // 400 × 200
  await click('[data-tool="directselect"]');
  await dragWidget(3, 300, -300);  // bottom-left widget far inward
  eq((await onlyRect()).attrs.rx, 100, 'clamped to a pill');
});

test('One drag is one undo step', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  await dragWidget(0, 40, 40);
  ok((await onlyRect()).attrs.rx > 0, 'rounded');
  await evaluate('document.activeElement?.blur();');
  await press('z', MOD.ctrl);
  const r = await onlyRect();
  ok(!r.attrs.rx, `undo restores the sharp rect (rx ${r.attrs.rx})`);
  eq(r.attrs.width, 400, 'and keeps the rect itself');
});

test('A rotated rect’s widgets follow its rotation', async () => {
  await drawRect(300, 200, 600, 400);
  await evaluate(`
    const i = document.getElementById('p-rotation');
    i.value = '30'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));`);
  await click('[data-tool="directselect"]');
  const w = await widgets();
  eq(w.length, 4, 'four widgets');
  // Widget 0 sits on the rotated top-left corner's bisector, inside the shape.
  const corner = await evaluate(`
    const el = document.querySelector('#doc-layer rect');
    const m = document.getElementById('canvas').getScreenCTM().inverse().multiply(el.getScreenCTM());
    const p = new DOMPoint(300, 200).matrixTransform(m); return { x: p.x, y: p.y };`);
  const w0 = w.find((p) => p.index === 0);
  const ang = Math.atan2(w0.y - corner.y, w0.x - corner.x) * 180 / Math.PI;
  near(ang, 45 + 30, 'widget direction from the corner follows the 30° rotation', 2);
  await dragWidget(0, 25 * Math.cos((75 * Math.PI) / 180) * Math.SQRT2, 25 * Math.sin((75 * Math.PI) / 180) * Math.SQRT2);
  const r = await onlyRect();
  ok(r.attrs.rx > 15, `rotated rect rounded: ${r.attrs.rx}`);
});

test('A closed pen path gets widgets on its sharp corners and rounds them', async () => {
  await click('[data-tool="pen"]');
  for (const [x, y] of [[300, 450], [500, 150], [700, 450], [300, 450]]) await clickAt(await toClient(x, y));
  await click('[data-tool="directselect"]');
  const paths = nodesOfType(await savedDoc(), 'path');
  eq(paths.length, 1, 'triangle drawn');
  ok(paths[0].closed, 'closed');
  // Select it with Direct Selection by clicking its outline (it has no fill).
  await clickAt(await toClient(500, 450));
  const w = await widgets();
  eq(w.length, 3, 'one widget per corner');
  const top = w.find((p) => Math.abs(p.x - 500) < 1);
  ok(top && top.y > 150, 'top widget sits below the apex');
  await dragWidget(top.index, 0, 30);
  const path = nodesOfType(await savedDoc(), 'path')[0];
  ok(path.cornerRadius > 5, `cornerRadius set: ${path.cornerRadius}`);
  ok(/ Q /.test(await evaluate(`return document.querySelector('#doc-layer [data-id="${path.id}"]').getAttribute('d');`)), 'path drawn with fillets');
});

test('Ellipses and small rects get no corner widgets', async () => {
  await click('[data-tool="ellipse"]');
  await drag(await toClient(200, 150), await toClient(500, 400));
  await click('[data-tool="directselect"]');
  eq((await widgets()).length, 0, 'none on an ellipse');
  await drawRect(600, 500, 625, 520);  // too small for widgets to fit
  await click('[data-tool="directselect"]');
  eq((await widgets()).length, 0, 'none on a tiny rect');
});

const readout = () => evaluate(`
  const el = document.querySelector('.drag-readout');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { text: el.textContent, x: r.x, y: r.y };`);

test('Dragging a widget shows the live radius next to the pointer', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  const from = await widgetClient(0);
  const to = await offset(from, 40, 40);
  let during = null, rxDuring = null;
  await drag(from, to, 0, 8, async () => {
    during = await readout();
    rxDuring = await evaluate('return document.querySelector("#doc-layer rect").getAttribute("rx");');
  });
  ok(during, 'readout shown while dragging');
  eq(during.text, `Radius: ${Math.round(Number(rxDuring) * 10) / 10}`, 'readout matches the live radius');
  ok(Math.abs(during.x - (to.x + 16)) < 2 && Math.abs(during.y - (to.y + 16)) < 2, 'readout sits by the pointer');
  eq(await readout(), null, 'readout hidden after release');
});

test('Grabbing a widget shows the current radius before moving', async () => {
  await drawRect(200, 150, 600, 450);
  await click('[data-tool="directselect"]');
  await dragWidget(0, 30, 30);
  const rx = (await onlyRect()).attrs.rx;
  let onGrab = null;
  const w = await widgetClient(0);
  await drag(w, w, 0, 1, async () => { onGrab = await readout(); });
  eq(onGrab && onGrab.text, `Radius: ${Math.round(rx * 10) / 10}`, 'current radius on grab');
  eq((await onlyRect()).attrs.rx, rx, 'a click leaves the radius alone');
  eq(await readout(), null, 'hidden after release');
});

test('Rotating still shows the angle readout', async () => {
  await drawRect(200, 150, 600, 450);
  const h = await evaluate(`
    const r = document.querySelector('[data-role="rotate"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  let during = null;
  await drag(h, await offset(h, 150, 150), 0, 8, async () => { during = await readout(); });
  ok(during && /^\d+(\.\d)?°$/.test(during.text), `angle readout: ${during && during.text}`);
  eq(await readout(), null, 'hidden after release');
});

await run();
