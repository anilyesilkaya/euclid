// End-to-end tests for the Connector tool's connection points: shown on hover,
// snapped to while dragging, stored on the connector, and honored by routing.
//
// Usage:
//   npm run build && node tools/test-connector.mjs [--shots <dir>]
import {
  start, run, test, evaluate, waitFor, click, clickAt, press, toClient, hover, drag,
  savedDoc, exportedSvg, nodesOfType, ok, eq, near,
} from './e2e.mjs';

await start();

// --- Helpers ---

// Draw a shape with a real tool drag between two canvas points.
async function drawShape(tool, x1, y1, x2, y2) {
  await click(`[data-tool="${tool}"]`);
  await drag(await toClient(x1, y1), await toClient(x2, y2));
}

// Two rects: A at (100,100)–(300,250), B at (500,350)–(700,500).
async function twoRects() {
  await drawShape('rect', 100, 100, 300, 250);
  await drawShape('rect', 500, 350, 700, 500);
  await click('[data-tool="connector"]');
}

// Connection-point hints currently shown, in canvas units.
const hints = () => evaluate(`
  return [...document.querySelectorAll('#chrome-ports .port-hint')].map((c) => ({
    x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), active: c.classList.contains('active'),
  }));`);

async function hoverCanvas(x, y) { await hover(await toClient(x, y)); }

// Draw a connector between two canvas points and return its saved node.
async function connect(from, to) {
  await drag(await toClient(...from), await toClient(...to));
  const cs = nodesOfType(await savedDoc(), 'connector');
  eq(cs.length, 1, 'connector count');
  return cs[0];
}

// Rendered endpoints of a connector (first and last point), in canvas units.
const renderedEnds = (id) => evaluate(`
  const el = document.querySelector('#doc-layer [data-id="${id}"]');
  if (el.tagName === 'line') {
    return { a: { x: +el.getAttribute('x1'), y: +el.getAttribute('y1') },
             b: { x: +el.getAttribute('x2'), y: +el.getAttribute('y2') }, tag: 'line' };
  }
  const pts = el.getAttribute('points').trim().split(/\\s+/).map((p) => p.split(',').map(Number));
  return { a: { x: pts[0][0], y: pts[0][1] }, b: { x: pts.at(-1)[0], y: pts.at(-1)[1] },
           second: { x: pts[1][0], y: pts[1][1] }, tag: el.tagName };`);

const connectors = async () => nodesOfType(await savedDoc(), 'connector');

// Rendered points of a connector, in canvas units.
const renderedPoints = (id) => evaluate(`
  const el = document.querySelector('#doc-layer [data-id="${id}"]');
  return el.getAttribute('points').trim().split(/\\s+/).map((p) => p.split(',').map(Number)).map(([x, y]) => ({ x, y }));`);

// Every leg horizontal or vertical, and no leg passing through any of `boxes`
// ({x1,y1,x2,y2} in canvas units).
function assertElbow(pts, msg, boxes = []) {
  ok(pts.length >= 3, `${msg}: has a bend (${pts.length} points)`);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    ok(Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01, `${msg}: leg ${i} is axis-aligned`);
    for (const b of boxes) {
      const through = Math.max(p.x, q.x) > b.x1 + 0.01 && Math.min(p.x, q.x) < b.x2 - 0.01 &&
                      Math.max(p.y, q.y) > b.y1 + 0.01 && Math.min(p.y, q.y) < b.y2 - 0.01;
      ok(!through, `${msg}: leg ${i} (${p.x},${p.y})→(${q.x},${q.y}) stays out of the shape`);
    }
  }
}
const previewShown = () => evaluate('return !!document.querySelector(".connector-preview");');

// Move the mouse (no button held) through canvas points, as a user would.
async function moveThrough(...pts) {
  for (const [x, y] of pts) await hover(await toClient(x, y));
}

function nearPt(p, x, y, msg, tol = 0.6) { near(p.x, x, `${msg} x`, tol); near(p.y, y, `${msg} y`, tol); }

// --- Tests ---

test('Hovering a rect with the Connector tool shows its 12 connection points', async () => {
  await twoRects();
  await hoverCanvas(200, 175);
  const h = await hints();
  eq(h.length, 12, 'connection points on rect A');
  for (const [x, y] of [[150, 100], [200, 100], [250, 100], [300, 175], [200, 250], [100, 137.5]]) {
    ok(h.some((p) => Math.abs(p.x - x) < 0.6 && Math.abs(p.y - y) < 0.6), `point at (${x}, ${y})`);
  }
  eq(h.filter((p) => p.active).length, 0, 'none highlighted in the middle of the shape');

  await hoverCanvas(400, 300);  // empty canvas, far from both
  eq((await hints()).length, 0, 'hidden away from shapes');
});

test('Points also show just outside a shape, and hide when switching tools', async () => {
  await twoRects();
  await hoverCanvas(310, 175);  // 10 units right of A
  eq((await hints()).length, 12, 'shown near the shape');
  await click('[data-tool="select"]');
  eq((await hints()).length, 0, 'hidden after switching to Select');
});

test('The connection point under the pointer is highlighted', async () => {
  await twoRects();
  await hoverCanvas(303, 176);
  const active = (await hints()).filter((p) => p.active);
  eq(active.length, 1, 'one highlighted point');
  nearPt(active[0], 300, 175, 'highlighted point');
});

test('Dragging between connection points snaps both ends and stores the ports', async () => {
  await twoRects();
  // Start near A's right-middle point; release just outside B's left-middle point.
  const c = await connect([302, 176], [494, 427]);
  eq(c.from.ref != null && c.to.ref != null, true, 'both ends attached');
  eq(JSON.stringify(c.from.port), JSON.stringify({ x: 1, y: 0.5 }), 'from port');
  eq(JSON.stringify(c.to.port), JSON.stringify({ x: 0, y: 0.5 }), 'to port');
  const ends = await renderedEnds(c.id);
  nearPt(ends.a, 300, 175, 'rendered start');
  nearPt(ends.b, 500, 425, 'rendered end');
});

test('During the drag, the target shape shows its points with the snap target highlighted', async () => {
  await twoRects();
  let during = null;
  await drag(await toClient(302, 176), await toClient(598, 347), 0, 8, async () => { during = await hints(); });
  eq(during.length, 12, 'target points shown mid-drag');
  const active = during.filter((p) => p.active);
  eq(active.length, 1, 'one snap target');
  nearPt(active[0], 600, 350, 'snap target is B top-middle');
  eq((await hints()).length, 0, 'cleared on release');
});

test('Releasing inside a shape away from its points attaches floating, as before', async () => {
  await twoRects();
  const c = await connect([302, 176], [580, 410]);
  ok(c.to.ref != null, 'attached to B');
  eq(c.to.port, undefined, 'no fixed port');
});

test('Releasing on empty canvas leaves a free end', async () => {
  await twoRects();
  const c = await connect([302, 176], [420, 600]);
  eq(c.to.ref, undefined, 'not attached');
  near(c.to.x, 420, 'free x', 1); near(c.to.y, 600, 'free y', 1);
});

test('A port-attached end follows its shape when the shape moves', async () => {
  await twoRects();
  const c = await connect([302, 176], [494, 427]);
  await click('[data-tool="select"]');
  await drag(await toClient(600, 425), await toClient(700, 475));  // move B by (+100, +50)
  const ends = await renderedEnds(c.id);
  nearPt(ends.b, 600, 475, 'end moved with B’s left-middle point', 1);
  nearPt(ends.a, 300, 175, 'start unchanged');
});

test('Ellipse connection points lie on the curve', async () => {
  await drawShape('ellipse', 500, 300, 700, 400);
  await click('[data-tool="connector"]');
  await hoverCanvas(600, 350);
  const h = await hints();
  eq(h.length, 8, 'connection points on the ellipse');
  for (const p of h) {
    const v = ((p.x - 600) / 100) ** 2 + ((p.y - 350) / 50) ** 2;
    near(v, 1, `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) on the ellipse`, 0.02);
  }
});

test('Elbow routing leaves from the stored connection point', async () => {
  await twoRects();
  // A bottom-middle → B left-middle.
  const c = await connect([201, 252], [494, 427]);
  eq(JSON.stringify(c.from.port), JSON.stringify({ x: 0.5, y: 1 }), 'from port');
  const ends = await renderedEnds(c.id);
  eq(ends.tag, 'polyline', 'drawn as an elbow');
  nearPt(ends.a, 200, 250, 'starts at A bottom-middle');
  near(ends.second.x, 200, 'first leg leaves downward (same x)');
  ok(ends.second.y > 250, 'first leg goes down');
  nearPt(ends.b, 500, 425, 'ends at B left-middle');
});

test('Exported SVG draws the connector between the connection points', async () => {
  await twoRects();
  await connect([302, 176], [494, 427]);
  const svg = await exportedSvg();
  ok(/<polyline points="300,175 [^"]* 500,425"/.test(svg), 'exported elbow runs between the points');
});

test('Click a source point, move, click a target point: creates the connection', async () => {
  await twoRects();
  await clickAt(await toClient(302, 176));  // click A's right-middle point
  ok(await previewShown(), 'preview line stays after the first click');
  eq((await connectors()).length, 0, 'nothing created yet');

  await moveThrough([350, 250], [450, 380], [495, 426]);
  const h = await hints();
  eq(h.length, 12, 'target points shown while moving');
  const active = h.filter((p) => p.active);
  eq(active.length, 1, 'snap target highlighted');
  nearPt(active[0], 500, 425, 'snap target is B left-middle');
  const preview = await evaluate(`
    return document.querySelector('.connector-preview').getAttribute('points').trim().split(/\\s+/)
      .map((p) => p.split(',').map(Number)).map(([x, y]) => ({ x, y }));`);
  nearPt(preview[0], 300, 175, 'preview starts at the source point');
  nearPt(preview.at(-1), 500, 425, 'preview snaps to the target point');
  assertElbow(preview, 'preview');

  await clickAt(await toClient(495, 426));  // click B's left-middle point
  const cs = await connectors();
  eq(cs.length, 1, 'connector created');
  eq(JSON.stringify(cs[0].from.port), JSON.stringify({ x: 1, y: 0.5 }), 'from port');
  eq(JSON.stringify(cs[0].to.port), JSON.stringify({ x: 0, y: 0.5 }), 'to port');
  ok(!(await previewShown()), 'preview removed');
  const ends = await renderedEnds(cs[0].id);
  nearPt(ends.a, 300, 175, 'rendered start'); nearPt(ends.b, 500, 425, 'rendered end');
});

test('Click-click onto a shape body away from its points attaches floating', async () => {
  await twoRects();
  await clickAt(await toClient(302, 176));
  await moveThrough([450, 380], [580, 410]);
  await clickAt(await toClient(580, 410));
  const cs = await connectors();
  eq(cs.length, 1, 'connector created');
  ok(cs[0].to.ref != null && cs[0].to.port === undefined, 'floating attachment to B');
});

test('Click-click: a second click on empty canvas cancels', async () => {
  await twoRects();
  await clickAt(await toClient(302, 176));
  await moveThrough([420, 600]);
  await clickAt(await toClient(420, 600));
  eq((await connectors()).length, 0, 'no connector');
  ok(!(await previewShown()), 'preview removed');
  eq((await hints()).length, 0, 'no stale points');
  // The tool is ready for a fresh connector afterwards.
  await drag(await toClient(302, 176), await toClient(494, 427));
  eq((await connectors()).length, 1, 'a new drag still connects');
});

test('Click-click: Escape cancels an armed connector', async () => {
  await twoRects();
  await clickAt(await toClient(302, 176));
  await moveThrough([450, 380]);
  await evaluate('document.activeElement?.blur();');
  await press('Escape');
  ok(!(await previewShown()), 'preview removed');
  await clickAt(await toClient(495, 426));
  eq((await connectors()).length, 0, 'clicking the target afterwards creates nothing');
});

test('A plain click on empty canvas with the Connector tool does nothing', async () => {
  await twoRects();
  await clickAt(await toClient(420, 600));
  ok(!(await previewShown()), 'not armed');
  await clickAt(await toClient(495, 426));
  eq((await connectors()).length, 0, 'no connector');
});

// Computed cursor and hit element at a canvas point, as the browser resolves them.
const cursorAt = (x, y) => evaluate(`
  const svg = document.getElementById('canvas');
  const q = new DOMPoint(${x}, ${y}).matrixTransform(svg.getScreenCTM());
  const el = document.elementFromPoint(q.x, q.y);
  return { cursor: getComputedStyle(el).cursor, handle: !!el.closest('[data-role="resize"], [data-role="rotate"]') };`);

test('On a selected shape, connection points show a hand cursor, not the resize cursor', async () => {
  await twoRects();  // B (just drawn) is selected, so its resize handles are showing
  ok(await evaluate('return !!document.querySelector(\'[data-role="resize"][data-handle="e"]\')'), 'B has resize handles');
  await hoverCanvas(700, 425);  // B's right-middle point, right on the "e" resize handle
  let c = await cursorAt(700, 425);
  eq(c.handle, false, 'the resize handle does not take the pointer');
  eq(c.cursor, 'pointer', 'hand cursor on the connection point');

  await hoverCanvas(600, 425);  // middle of B, away from its points
  c = await cursorAt(600, 425);
  eq(c.cursor, 'crosshair', 'crosshair elsewhere');

  await click('[data-tool="select"]');
  c = await cursorAt(700, 425);
  eq(c.handle, true, 'handles work again with the Select tool');
});

test('Dragging from a point on a selected shape connects instead of resizing it', async () => {
  await twoRects();
  const before = nodesOfType(await savedDoc(), 'rect').find((r) => r.attrs.x === 500).attrs;
  const c = await connect([700, 425], [302, 176]);  // B right-middle → A right-middle
  eq(JSON.stringify(c.from.port), JSON.stringify({ x: 1, y: 0.5 }), 'from port');
  eq(JSON.stringify(c.to.port), JSON.stringify({ x: 1, y: 0.5 }), 'to port');
  const after = nodesOfType(await savedDoc(), 'rect').find((r) => r.attrs.x === 500).attrs;
  eq(after.width, before.width, 'B width unchanged');
  eq(after.height, before.height, 'B height unchanged');
});

test('New connectors are elbows by default', async () => {
  await twoRects();
  const c = await connect([302, 176], [494, 427]);  // A right-middle → B left-middle
  eq(c.route, 'orthogonal', 'stored route');
  const pts = await renderedPoints(c.id);
  assertElbow(pts, 'route', [{ x1: 100, y1: 100, x2: 300, y2: 250 }, { x1: 500, y1: 350, x2: 700, y2: 500 }]);
  nearPt(pts[0], 300, 175, 'start'); nearPt(pts.at(-1), 500, 425, 'end');
  ok(pts[1].x > 300 && Math.abs(pts[1].y - 175) < 0.01, 'leaves A to the right');
  ok(pts.at(-2).x < 500 && Math.abs(pts.at(-2).y - 425) < 0.01, 'enters B from the left');
});

test('Same-side points route around the shapes instead of through them', async () => {
  // The reported case: two stacked shapes, left-middle point to left-middle point.
  await drawShape('rect', 100, 100, 300, 250);
  await drawShape('rect', 180, 350, 420, 500);
  await click('[data-tool="connector"]');
  const c = await connect([98, 176], [178, 426]);
  eq(JSON.stringify([c.from.port, c.to.port]), JSON.stringify([{ x: 0, y: 0.5 }, { x: 0, y: 0.5 }]), 'both left-middle');
  const pts = await renderedPoints(c.id);
  assertElbow(pts, 'route', [{ x1: 100, y1: 100, x2: 300, y2: 250 }, { x1: 180, y1: 350, x2: 420, y2: 500 }]);
  ok(pts[1].x < 100, 'leaves the top shape to the left');
  ok(pts.at(-2).x < 180, 'enters the bottom shape from the left');
});

test('Bottom point to a shape below routes as an elbow, not a diagonal', async () => {
  await drawShape('rect', 100, 100, 300, 250);
  await drawShape('rect', 260, 350, 500, 500);
  await click('[data-tool="connector"]');
  const c = await connect([201, 252], [380, 420]);  // A bottom-middle → floating on B
  const pts = await renderedPoints(c.id);
  assertElbow(pts, 'route', [{ x1: 100, y1: 100, x2: 300, y2: 250 }, { x1: 260, y1: 350, x2: 500, y2: 500 }]);
  nearPt(pts[0], 200, 250, 'leaves from A bottom-middle');
  ok(Math.abs(pts[1].x - 200) < 0.01 && pts[1].y > 250, 'first leg goes down');
});

test('Routing → Straight turns an elbow back into a straight line', async () => {
  await twoRects();
  const c = await connect([302, 176], [494, 427]);
  await evaluate(`
    const s = document.getElementById('p-connector-route');
    s.value = 'straight'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await waitFor(`document.querySelector('#doc-layer [data-id="${c.id}"]').tagName === 'line'`, 'straight route');
  const ends = await renderedEnds(c.id);
  nearPt(ends.a, 300, 175, 'start'); nearPt(ends.b, 500, 425, 'end');
});

await run();
