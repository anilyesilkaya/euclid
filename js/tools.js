// Tool state machine: select, rect, circle, ellipse, line, polyline.
// All pointer/keyboard input on the canvas funnels through here.

import {
  getDoc, getSelection, setSelection, toggleSelection, clearSelection,
  mutate, newId, emptyTransform, findNode, findPath, topAncestor,
} from "./state.js";
import * as history from "./history.js";
import { toCanvasPoint, getTransientLayer, getDocLayer, elementBBoxInCanvas, localToCanvasMatrix } from "./render.js";
import * as guides from "./guides.js";
import * as grid from "./grid.js";

const CANVAS_BBOX = { x: 0, y: 0, width: 1000, height: 700 };
const SNAP_THRESHOLD = 6; // canvas units — feels right at default zoom

const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_STYLE = {
  fill: "#88ccee",
  stroke: "#222222",
  "stroke-width": 2,
  opacity: 1,
};
const LINE_STYLE = {
  fill: "none",
  stroke: "#222222",
  "stroke-width": 2,
  opacity: 1,
};
const TEXT_DEFAULTS = {
  "font-family": "sans-serif",
  "font-size": 20,
  fill: "#000000",
};

let currentTool = "select";
let canvasSvg;
let polylineInProgress = null;  // { id, points, previewLineId } while drawing

// Gesture state
let gesture = null;

export function mount(svg) {
  canvasSvg = svg;

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("dblclick", onDoubleClick);
  svg.addEventListener("contextmenu", onContextMenu);
}

export function setTool(name) {
  if (currentTool === name) return;
  cancelPolyline();
  currentTool = name;
  canvasSvg.classList.toggle("draw-mode", name !== "select");
  document.dispatchEvent(new CustomEvent("tool-changed", { detail: name }));
}
export function getTool() { return currentTool; }

// --- Pointer handlers ---

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = toCanvasPoint(e);
  const target = e.target;

  // Chrome-layer roles override everything else.
  const role = target.getAttribute && target.getAttribute("data-role");
  if (role === "resize") return startResize(e, target, p);
  if (role === "rotate") return startRotate(e, target, p);

  if (currentTool === "select") return handleSelectDown(e, p, target);

  // Draw tools
  if (currentTool === "polyline") return handlePolylineDown(e, p);
  if (currentTool === "text") return handleTextDown(e, p);
  return startDraw(e, p);
}

function onPointerMove(e) {
  const p = toCanvasPoint(e);

  if (polylineInProgress) {
    updatePolylinePreview(p);
  }

  if (!gesture) return;
  const dx = p.x - gesture.origin.x;
  const dy = p.y - gesture.origin.y;
  gesture.last = p;
  gesture.moved = gesture.moved || Math.hypot(dx, dy) > 1.5;

  if (gesture.type === "draw") {
    updateDraw(p, e);
  } else if (gesture.type === "move") {
    updateMove(dx, dy, e);
  } else if (gesture.type === "resize") {
    updateResize(p, e);
  } else if (gesture.type === "rotate") {
    updateRotate(p, e);
  } else if (gesture.type === "marquee") {
    updateMarquee(p);
  }
}

function onPointerUp(e) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;

  if (g.type === "draw") {
    finishDraw(g);
  } else if (g.type === "marquee") {
    finishMarquee(g, e.shiftKey);
  } else if (g.type === "move" || g.type === "resize" || g.type === "rotate") {
    if (g.moved) history.commit(g.type);
    else history.abort();
  }

  clearTransient();
}

function onContextMenu(e) {
  e.preventDefault();
  // Only meaningful with the select tool active.
  if (currentTool !== "select") { closeContextMenu(); return; }
  const hit = hitTest(e.target);
  if (!hit) { closeContextMenu(); return; }
  const id = pickSelectionId(hit.id);
  if (!getSelection().has(id)) setSelection([id]);
  openContextMenu(e.clientX, e.clientY, id);
}

function onDoubleClick(e) {
  if (polylineInProgress) {
    commitPolyline();
    return;
  }
  if (currentTool !== "select") return;
  const hit = hitTest(e.target);
  if (!hit) return;
  const node = findNode(getDoc(), hit.id);
  if (!node) return;
  // Text node? Edit its content.
  if (node.type === "text") {
    openTextEditor(node);
    return;
  }
  // Shape (rect/circle/ellipse/line/polyline) — Illustrator-style: type a label centered inside.
  if (node.type !== "group") {
    setSelection([node.id]);
    openLabelEditor(node);
    return;
  }
  // Group hit — descend one level per double-click.
  const path = findPath(getDoc(), hit.id);
  if (!path) return;
  const sel = getSelection();
  const target = sel.has(path[0]?.id) && path.length > 1 ? path[1].id : path[0].id;
  setSelection([target]);
}

// --- Select tool ---

function handleSelectDown(e, p, target) {
  const hit = hitTest(target);
  if (!hit) {
    // Empty canvas: start marquee (unless shift, then keep selection and marquee-add).
    if (!e.shiftKey) clearSelection();
    startMarquee(p);
    return;
  }
  const id = pickSelectionId(hit.id);
  const sel = getSelection();
  if (e.shiftKey) {
    toggleSelection(id);
  } else if (!sel.has(id)) {
    setSelection([id]);
  }
  // Begin move gesture on the current selection (which now includes id).
  startMove(p);
}

function pickSelectionId(leafId) {
  // Click on a shape inside a group selects the OUTERMOST group (top-level child of root).
  const top = topAncestor(getDoc(), leafId);
  return top ? top.id : leafId;
}

function hitTest(target) {
  // Walk up from target until we find a data-id inside #doc-layer.
  const docLayer = getDocLayer();
  let el = target;
  while (el && el !== docLayer && el !== canvasSvg) {
    if (el.getAttribute && el.hasAttribute("data-id") && docLayer.contains(el)) {
      return { id: el.getAttribute("data-id"), el };
    }
    el = el.parentNode;
  }
  return null;
}

// --- Move gesture ---

function startMove(p) {
  const sel = [...getSelection()];
  if (sel.length === 0) return;
  history.beginTransaction();

  // Reduce the selection to the top-ancestor set — that's what actually gets moved.
  const doc = getDoc();
  const movingTopIds = new Set();
  for (const id of sel) {
    const top = topAncestor(doc, id);
    if (top) movingTopIds.add(top.id);
  }

  // Snapshot original transforms and per-node canvas bboxes for the moving set.
  const orig = new Map();
  const movingBBoxes = [];
  for (const id of movingTopIds) {
    const node = findNode(doc, id);
    if (!node) continue;
    orig.set(id, { tx: node.transform?.tx || 0, ty: node.transform?.ty || 0 });
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
    const b = el && elementBBoxInCanvas(el);
    if (b) movingBBoxes.push({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
  }
  // Union bbox of the moving set — the frame we align to stationary edges/centers.
  const movingUnion = unionOfBBoxes(movingBBoxes);

  // Snapshot stationary top-level bboxes (every top-level child not in the moving set).
  const stationaryBBoxes = [];
  for (const child of doc.children) {
    if (movingTopIds.has(child.id)) continue;
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(child.id)}"]`);
    const b = el && elementBBoxInCanvas(el);
    if (b) stationaryBBoxes.push({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
  }

  gesture = {
    type: "move", origin: p, last: p, moved: false,
    ids: [...movingTopIds], orig,
    movingUnion, stationaryBBoxes,
  };
}

function updateMove(dx, dy, e) {
  const { ids, orig, movingUnion, stationaryBBoxes } = gesture;

  // Hold Alt (or Option) to bypass snapping while still showing raw drag.
  let snapDx = 0, snapDy = 0;
  if (movingUnion && !e?.altKey) {
    const proposed = {
      x: movingUnion.x + dx, y: movingUnion.y + dy,
      width: movingUnion.width, height: movingUnion.height,
    };
    // Smart object-alignment guides take precedence per axis.
    const snap = guides.computeSnap({
      movingBBox: proposed,
      stationaryBBoxes,
      canvasBBox: CANVAS_BBOX,
      threshold: SNAP_THRESHOLD,
    });
    snapDx = snap.dx;
    snapDy = snap.dy;
    guides.drawGuides(snap.guides);
    // Grid snap fills in any axis a guide didn't already grab.
    if (grid.isSnap()) {
      const g = grid.snapDelta(proposed);
      if (snapDx === 0) snapDx = g.dx;
      if (snapDy === 0) snapDy = g.dy;
    }
  } else {
    guides.clearGuides();
  }

  const finalDx = dx + snapDx;
  const finalDy = dy + snapDy;
  mutate((root) => {
    for (const id of ids) {
      const node = findNode(root, id);
      if (!node) continue;
      if (!node.transform) node.transform = emptyTransform();
      const o = orig.get(id);
      node.transform.tx = o.tx + finalDx;
      node.transform.ty = o.ty + finalDy;
    }
  });
}

function unionOfBBoxes(bboxes) {
  if (!bboxes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// --- Marquee ---

function startMarquee(p) {
  gesture = { type: "marquee", origin: p, last: p, moved: false };
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "marquee");
  rect.setAttribute("x", p.x);
  rect.setAttribute("y", p.y);
  rect.setAttribute("width", 0);
  rect.setAttribute("height", 0);
  gesture.el = rect;
  getTransientLayer().appendChild(rect);
}

function updateMarquee(p) {
  const { origin, el } = gesture;
  const x = Math.min(origin.x, p.x);
  const y = Math.min(origin.y, p.y);
  const w = Math.abs(p.x - origin.x);
  const h = Math.abs(p.y - origin.y);
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("width", w);
  el.setAttribute("height", h);
}

function finishMarquee(g, additive) {
  if (!g.moved) return;
  const x1 = Math.min(g.origin.x, g.last.x);
  const y1 = Math.min(g.origin.y, g.last.y);
  const x2 = Math.max(g.origin.x, g.last.x);
  const y2 = Math.max(g.origin.y, g.last.y);

  const doc = getDoc();
  const hits = [];
  const docLayer = getDocLayer();
  for (const child of doc.children) {
    // Test against each TOP-LEVEL node's bounding box in canvas space.
    const el = docLayer.querySelector(`[data-id="${cssEscape(child.id)}"]`);
    if (!el) continue;
    const bbox = elementBBoxInCanvas(el);
    if (!bbox) continue;
    if (bbox.x1 >= x1 && bbox.y1 >= y1 && bbox.x2 <= x2 && bbox.y2 <= y2) {
      hits.push(child.id);
    }
  }
  if (additive) {
    const merged = new Set([...getSelection(), ...hits]);
    setSelection([...merged]);
  } else {
    setSelection(hits);
  }
}

// --- Draw (bbox-drag primitives) ---

function startDraw(e, p) {
  if (grid.isSnap() && !e.altKey) p = grid.snapPoint(p.x, p.y);
  const id = newId();
  const node = seedNodeFor(currentTool, id, p);
  if (!node) return;
  history.beginTransaction();
  mutate((root) => { root.children.push(node); });
  gesture = { type: "draw", origin: p, last: p, moved: false, id, tool: currentTool };
}

function seedNodeFor(tool, id, p) {
  const base = { id, type: tool, transform: emptyTransform() };
  const style = tool === "line" ? { ...LINE_STYLE } : { ...DEFAULT_STYLE };
  if (tool === "rect") {
    return { ...base, attrs: { x: p.x, y: p.y, width: 0, height: 0, rx: 0, ry: 0, ...style } };
  }
  if (tool === "circle") {
    return { ...base, attrs: { cx: p.x, cy: p.y, r: 0, ...style } };
  }
  if (tool === "ellipse") {
    return { ...base, attrs: { cx: p.x, cy: p.y, rx: 0, ry: 0, ...style } };
  }
  if (tool === "line") {
    return { ...base, attrs: { x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...style } };
  }
  return null;
}

function updateDraw(p, e) {
  const { origin, id, tool } = gesture;
  // Snap the live corner to the grid (origin was snapped at startDraw), so the
  // shape's size lands on grid multiples. Alt bypasses. Shift-constraint below
  // still applies on top of the snapped delta.
  if (grid.isSnap() && !e.altKey) p = grid.snapPoint(p.x, p.y);
  let dx = p.x - origin.x;
  let dy = p.y - origin.y;
  if (e.shiftKey && (tool === "rect" || tool === "ellipse" || tool === "circle")) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    if (tool === "rect") {
      n.attrs.x = Math.min(origin.x, origin.x + dx);
      n.attrs.y = Math.min(origin.y, origin.y + dy);
      n.attrs.width = Math.abs(dx);
      n.attrs.height = Math.abs(dy);
    } else if (tool === "ellipse") {
      n.attrs.cx = origin.x + dx / 2;
      n.attrs.cy = origin.y + dy / 2;
      n.attrs.rx = Math.abs(dx) / 2;
      n.attrs.ry = Math.abs(dy) / 2;
    } else if (tool === "circle") {
      n.attrs.cx = origin.x + dx / 2;
      n.attrs.cy = origin.y + dy / 2;
      n.attrs.r = Math.min(Math.abs(dx), Math.abs(dy)) / 2;
    } else if (tool === "line") {
      let ex = p.x, ey = p.y;
      if (e.shiftKey) {
        const ang = Math.atan2(p.y - origin.y, p.x - origin.x);
        const step = Math.PI / 4; // 45°
        const snapped = Math.round(ang / step) * step;
        const dist = Math.hypot(p.x - origin.x, p.y - origin.y);
        ex = origin.x + Math.cos(snapped) * dist;
        ey = origin.y + Math.sin(snapped) * dist;
      }
      n.attrs.x2 = ex;
      n.attrs.y2 = ey;
    }
  });
}

function finishDraw(g) {
  const { id, tool } = g;
  // Discard zero-size shapes.
  const doc = getDoc();
  const node = findNode(doc, id);
  if (!node) { history.abort(); return; }
  const empty = isEmptyShape(node, tool);
  if (empty) {
    mutate((root) => {
      const idx = root.children.findIndex(c => c.id === id);
      if (idx >= 0) root.children.splice(idx, 1);
    });
    history.abort();
    return;
  }
  history.commit("draw " + tool);
  setSelection([id]);
}

function isEmptyShape(node, tool) {
  if (tool === "rect") return !(node.attrs.width > 0 && node.attrs.height > 0);
  if (tool === "ellipse") return !(node.attrs.rx > 0 && node.attrs.ry > 0);
  if (tool === "circle") return !(node.attrs.r > 0);
  if (tool === "line") return node.attrs.x1 === node.attrs.x2 && node.attrs.y1 === node.attrs.y2;
  if (tool === "polyline") return !node.attrs.points || node.attrs.points.length < 2;
  return false;
}

// --- Polyline (click-based) ---

function handlePolylineDown(e, p) {
  if (!polylineInProgress) {
    const id = newId();
    history.beginTransaction();
    const node = {
      id, type: "polyline", transform: emptyTransform(),
      attrs: { points: [[p.x, p.y]], fill: "none", stroke: "#222222", "stroke-width": 2, opacity: 1 },
    };
    mutate((root) => { root.children.push(node); });
    polylineInProgress = { id };
    ensurePolylinePreview();
  } else {
    mutate((root) => {
      const n = findNode(root, polylineInProgress.id);
      if (n) n.attrs.points.push([p.x, p.y]);
    });
  }
}

function ensurePolylinePreview() {
  if (!polylineInProgress) return;
  if (polylineInProgress.previewEl) return;
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "rubber");
  polylineInProgress.previewEl = line;
  getTransientLayer().appendChild(line);
}

function updatePolylinePreview(p) {
  if (!polylineInProgress) return;
  const node = findNode(getDoc(), polylineInProgress.id);
  if (!node || !node.attrs.points.length) return;
  const last = node.attrs.points[node.attrs.points.length - 1];
  const line = polylineInProgress.previewEl;
  if (!line) return;
  line.setAttribute("x1", last[0]);
  line.setAttribute("y1", last[1]);
  line.setAttribute("x2", p.x);
  line.setAttribute("y2", p.y);
}

function commitPolyline() {
  if (!polylineInProgress) return;
  const id = polylineInProgress.id;
  const node = findNode(getDoc(), id);
  polylineInProgress = null;
  clearTransient();
  if (!node || !node.attrs.points || node.attrs.points.length < 2) {
    // Drop it.
    mutate((root) => {
      const idx = root.children.findIndex(c => c.id === id);
      if (idx >= 0) root.children.splice(idx, 1);
    });
    history.abort();
    return;
  }
  history.commit("draw polyline");
  setSelection([id]);
}

export function cancelPolyline() {
  if (!polylineInProgress) return;
  const id = polylineInProgress.id;
  const node = findNode(getDoc(), id);
  polylineInProgress = null;
  clearTransient();
  if (node && node.attrs.points && node.attrs.points.length >= 2) {
    history.commit("draw polyline");
    setSelection([id]);
  } else {
    mutate((root) => {
      const idx = root.children.findIndex(c => c.id === id);
      if (idx >= 0) root.children.splice(idx, 1);
    });
    history.abort();
  }
}

// --- Resize handle gesture ---

function startResize(e, handleEl, p) {
  const dir = handleEl.getAttribute("data-handle");
  const id = handleEl.getAttribute("data-id");
  const node = findNode(getDoc(), id);
  if (!node) return;
  history.beginTransaction();
  gesture = {
    type: "resize",
    origin: p,
    last: p,
    moved: false,
    id,
    dir,
    orig: cloneShape(node),
    // We resize in the shape's local coordinate space (pre-transform).
    // For rotated shapes, we need to convert screen deltas back into local via inverse of the transform.
    // For v1 simplicity, resize uses canvas-space deltas and treats them as local deltas;
    // this is correct for un-rotated shapes and acceptable for slightly-rotated ones.
  };
}

function cloneShape(node) {
  return {
    attrs: { ...node.attrs, points: node.attrs.points ? node.attrs.points.map(p => [...p]) : undefined },
    transform: { ...node.transform },
  };
}

function updateResize(p, _e) {
  const { id, dir, origin, orig } = gesture;
  // Snap the dragged handle to the grid so the resized edge lands on a grid line.
  // Alt bypasses (matches move/draw).
  if (grid.isSnap() && !_e?.altKey) p = grid.snapPoint(p.x, p.y);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    resizeNode(n, orig, dir, dx, dy);
  });
}

function resizeNode(n, orig, dir, dx, dy) {
  const west = dir.includes("w");
  const east = dir.includes("e");
  const north = dir.includes("n");
  const south = dir.includes("s");
  const applyBox = (x, y, w, h) => {
    let nx = x, ny = y, nw = w, nh = h;
    if (west) { nx = x + dx; nw = w - dx; }
    if (east) { nw = w + dx; }
    if (north) { ny = y + dy; nh = h - dy; }
    if (south) { nh = h + dy; }
    if (nw < 0) { nx += nw; nw = -nw; }
    if (nh < 0) { ny += nh; nh = -nh; }
    return { x: nx, y: ny, w: nw, h: nh };
  };
  if (n.type === "rect") {
    const r = applyBox(orig.attrs.x, orig.attrs.y, orig.attrs.width, orig.attrs.height);
    n.attrs.x = r.x; n.attrs.y = r.y; n.attrs.width = r.w; n.attrs.height = r.h;
  } else if (n.type === "ellipse") {
    const bx = orig.attrs.cx - orig.attrs.rx;
    const by = orig.attrs.cy - orig.attrs.ry;
    const bw = orig.attrs.rx * 2;
    const bh = orig.attrs.ry * 2;
    const r = applyBox(bx, by, bw, bh);
    n.attrs.cx = r.x + r.w / 2;
    n.attrs.cy = r.y + r.h / 2;
    n.attrs.rx = r.w / 2;
    n.attrs.ry = r.h / 2;
  } else if (n.type === "circle") {
    const bx = orig.attrs.cx - orig.attrs.r;
    const by = orig.attrs.cy - orig.attrs.r;
    const bw = orig.attrs.r * 2;
    const bh = orig.attrs.r * 2;
    const r = applyBox(bx, by, bw, bh);
    const side = Math.min(r.w, r.h);
    n.attrs.cx = r.x + r.w / 2;
    n.attrs.cy = r.y + r.h / 2;
    n.attrs.r = side / 2;
  } else if (n.type === "line") {
    // Treat handles like arbitrary corners of the bbox — move whichever endpoint sits on that side.
    const bx = Math.min(orig.attrs.x1, orig.attrs.x2);
    const by = Math.min(orig.attrs.y1, orig.attrs.y2);
    const bw = Math.abs(orig.attrs.x2 - orig.attrs.x1);
    const bh = Math.abs(orig.attrs.y2 - orig.attrs.y1);
    const r = applyBox(bx, by, bw, bh);
    const sx = bw ? (orig.attrs.x1 - bx) / bw : 0;
    const sy = bh ? (orig.attrs.y1 - by) / bh : 0;
    const ex = bw ? (orig.attrs.x2 - bx) / bw : 0;
    const ey = bh ? (orig.attrs.y2 - by) / bh : 0;
    n.attrs.x1 = r.x + sx * r.w;
    n.attrs.y1 = r.y + sy * r.h;
    n.attrs.x2 = r.x + ex * r.w;
    n.attrs.y2 = r.y + ey * r.h;
  } else if (n.type === "polyline" || n.type === "group") {
    // Scale points/children by ratio. For groups we do not descend; instead we scale via transform.
    const pts = orig.attrs.points;
    if (!pts) return; // group resize deferred to v2
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const bw = maxX - minX, bh = maxY - minY;
    const r = applyBox(minX, minY, bw, bh);
    const sx = bw ? r.w / bw : 1;
    const sy = bh ? r.h / bh : 1;
    n.attrs.points = pts.map(([x, y]) => [r.x + (x - minX) * sx, r.y + (y - minY) * sy]);
  }
}

// --- Rotate handle gesture ---

function startRotate(e, handleEl, p) {
  const id = handleEl.getAttribute("data-id");
  const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
  const node = findNode(getDoc(), id);
  if (!el || !node) return;
  const b = el.getBBox();
  const localCx = b.x + b.width / 2;
  const localCy = b.y + b.height / 2;
  // Convert local center to canvas space (so we can measure angle in canvas coords).
  const centerCanvas = localToCanvasPoint(el, localCx, localCy);
  history.beginTransaction();
  gesture = {
    type: "rotate",
    origin: p,
    last: p,
    moved: false,
    id,
    center: centerCanvas,
    localCx, localCy,
    startAngle: Math.atan2(p.y - centerCanvas.y, p.x - centerCanvas.x),
    originalRot: node.transform?.rot || 0,
  };
}

function updateRotate(p, e) {
  const { id, center, startAngle, originalRot, localCx, localCy } = gesture;
  let ang = Math.atan2(p.y - center.y, p.x - center.x);
  let delta = (ang - startAngle) * 180 / Math.PI;
  if (e.shiftKey) delta = Math.round(delta / 90) * 90;
  const newRot = originalRot + delta;
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    if (!n.transform) n.transform = emptyTransform();
    n.transform.rot = newRot;
    n.transform.cx = localCx;
    n.transform.cy = localCy;
  });
}

function localToCanvasPoint(el, x, y) {
  const svg = canvasSvg;
  const pt = svg.createSVGPoint();
  pt.x = x; pt.y = y;
  // Local -> canvas viewBox user units. NOT getCTM() (that targets the rendered
  // viewport and bakes in the viewBox scale + letterbox offset). See localToCanvasMatrix.
  const M = localToCanvasMatrix(el);
  if (!M) return { x, y };
  const back = pt.matrixTransform(M);
  return { x: back.x, y: back.y };
}

// --- Helpers ---

function clearTransient() {
  const layer = getTransientLayer();
  while (layer.firstChild) layer.removeChild(layer.firstChild);
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

// --- Text tool ---

function handleTextDown(e, p) {
  const id = newId("t");
  history.beginTransaction();
  const node = {
    id, type: "text", transform: emptyTransform(),
    attrs: {
      x: p.x, y: p.y,
      "font-family": TEXT_DEFAULTS["font-family"],
      "font-size": TEXT_DEFAULTS["font-size"],
      fill: TEXT_DEFAULTS.fill,
    },
    text: "",
  };
  mutate((root) => { root.children.push(node); });
  history.commit("create text");
  setSelection([id]);
  openTextEditor(node);
}

let editorEl = null;
let editorTargetId = null;
let editorMode = null; // "text-node" | "label"

export function openTextEditor(node) {
  editorTargetId = node.id;
  editorMode = "text-node";
  showEditor(node.text || "", () => positionForTextNode(node));
}

export function openLabelEditor(node) {
  editorTargetId = node.id;
  editorMode = "label";
  showEditor(node.label || "", () => positionForLabel(node));
}

function showEditor(initial, positionFn) {
  // Detach any leftover editor DOM without touching editorTargetId/editorMode,
  // which the caller (openTextEditor / openLabelEditor) has just set.
  if (editorEl) {
    try { editorEl.remove(); } catch { /* already detached */ }
    editorEl = null;
  }
  const el = document.createElement("div");
  el.className = "text-edit-overlay";
  el.contentEditable = "true";
  el.textContent = initial;
  document.body.appendChild(el);
  editorEl = el;
  Object.assign(el.style, positionFn());

  el.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      commitTextEditor();
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      cancelTextEditor();
    }
  });

  // Defer focus + blur binding to next task so the pointer sequence that opened
  // the editor doesn't immediately steal focus and dismiss it.
  setTimeout(() => {
    if (!editorEl || editorEl !== el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.addEventListener("blur", () => commitTextEditor(), { once: true });
  }, 0);
}

function positionForTextNode(node) {
  const svg = canvasSvg;
  const pt = svg.createSVGPoint();
  pt.x = node.attrs.x; pt.y = node.attrs.y;
  const ctm = svg.getScreenCTM();
  const screen = pt.matrixTransform(ctm);
  const size = node.attrs["font-size"] || 20;
  const screenSize = size * ctm.a;
  return {
    left: `${screen.x}px`,
    top: `${screen.y - screenSize}px`,
    fontFamily: node.attrs["font-family"] || "sans-serif",
    fontSize: `${screenSize}px`,
    color: node.attrs.fill || "#000",
  };
}

function positionForLabel(node) {
  const svg = canvasSvg;
  const ctm = svg.getScreenCTM();
  const style = node.labelStyle || {};
  const size = style["font-size"] || 16;
  const screenSize = size * (ctm?.a || 1);
  const base = {
    fontFamily: style["font-family"] || "sans-serif",
    fontSize: `${screenSize}px`,
    color: style.fill || "#000",
    transform: "translate(-50%, -50%)",
    textAlign: "center",
  };
  // Prefer the rendered label's own screen rect when it exists — cheapest and pixel-accurate.
  const labelDom = getDocLayer().querySelector(`text[data-role="label"][data-owner="${cssEscape(node.id)}"]`);
  if (labelDom) {
    const r = labelDom.getBoundingClientRect();
    return { ...base, left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px` };
  }
  // No label yet — center the editor over the shape itself.
  const shapeDom = getDocLayer().querySelector(`[data-id="${cssEscape(node.id)}"]`);
  if (shapeDom) {
    const r = shapeDom.getBoundingClientRect();
    return { ...base, left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px` };
  }
  return { ...base, left: `50%`, top: `50%` };
}

function commitTextEditor() {
  if (!editorEl || !editorTargetId) return closeTextEditor();
  const value = editorEl.textContent;
  const id = editorTargetId;
  const mode = editorMode;
  closeTextEditor();
  if (mode === "text-node") {
    if (!value || !value.trim()) {
      // Empty text — remove the node.
      history.record(() => {
        mutate((root) => {
          const idx = root.children.findIndex(c => c.id === id);
          if (idx >= 0) root.children.splice(idx, 1);
        });
      });
      return;
    }
    history.record(() => {
      mutate((root) => {
        const n = findNode(root, id);
        if (n) n.text = value;
      });
    });
  } else if (mode === "label") {
    history.record(() => {
      mutate((root) => {
        const n = findNode(root, id);
        if (!n) return;
        if (value && value.trim()) n.label = value;
        else delete n.label;
      });
    });
  }
}

function cancelTextEditor() {
  const id = editorTargetId;
  const mode = editorMode;
  closeTextEditor();
  if (mode === "text-node") {
    // Cancel on a freshly-created empty text: drop the node.
    const node = findNode(getDoc(), id);
    if (node && !node.text) {
      history.record(() => {
        mutate((root) => {
          const idx = root.children.findIndex(c => c.id === id);
          if (idx >= 0) root.children.splice(idx, 1);
        });
      });
    }
  }
}

function closeTextEditor() {
  if (editorEl) {
    try { editorEl.remove(); } catch { /* already detached */ }
  }
  editorEl = null;
  editorTargetId = null;
  editorMode = null;
}

export function isTextEditing() { return editorEl !== null; }

// --- Context menu (right-click) ---

let ctxMenuEl = null;

export function openContextMenu(clientX, clientY, anchorId) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  const items = [
    { label: "Bring to Front", action: () => zOrder("front") },
    { label: "Bring Forward",  action: () => zOrder("forward") },
    { label: "Send Backward",  action: () => zOrder("backward") },
    { label: "Send to Back",   action: () => zOrder("back") },
  ];
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = it.label;
    btn.addEventListener("click", () => {
      closeContextMenu();
      it.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // Position — clamp to viewport so it doesn't spill off-screen.
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = menu.getBoundingClientRect();
  const left = Math.min(clientX, vw - r.width - 4);
  const top = Math.min(clientY, vh - r.height - 4);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  ctxMenuEl = menu;
  // Dismiss on any outside interaction.
  setTimeout(() => {
    window.addEventListener("pointerdown", onDismissContext, true);
    window.addEventListener("keydown", onDismissContextKey, true);
    window.addEventListener("blur", closeContextMenu, true);
  }, 0);
}

function onDismissContext(e) {
  if (ctxMenuEl && ctxMenuEl.contains(e.target)) return;
  closeContextMenu();
}
function onDismissContextKey(e) {
  if (e.key === "Escape") closeContextMenu();
}

function closeContextMenu() {
  if (!ctxMenuEl) return;
  try { ctxMenuEl.remove(); } catch { /* already gone */ }
  ctxMenuEl = null;
  window.removeEventListener("pointerdown", onDismissContext, true);
  window.removeEventListener("keydown", onDismissContextKey, true);
  window.removeEventListener("blur", closeContextMenu, true);
}

function zOrder(op) {
  const sel = [...getSelection()];
  if (sel.length === 0) return;
  const doc = getDoc();
  // Reorder is a root-level operation — collapse the selection to its top ancestors.
  const topIds = new Set();
  for (const id of sel) {
    const top = topAncestor(doc, id);
    if (top) topIds.add(top.id);
  }
  if (topIds.size === 0) return;
  history.record(() => {
    mutate((root) => {
      const kids = root.children;
      const moving = kids.filter(c => topIds.has(c.id));      // preserves current paint order
      if (moving.length === 0) return;
      const stationary = kids.filter(c => !topIds.has(c.id));
      if (op === "front") {
        root.children = [...stationary, ...moving];
      } else if (op === "back") {
        root.children = [...moving, ...stationary];
      } else if (op === "forward") {
        // Shift each moving item one slot toward the end, from top-down so we don't clobber.
        const arr = kids.slice();
        for (let i = arr.length - 1; i >= 0; i--) {
          if (!topIds.has(arr[i].id)) continue;
          const j = i + 1;
          if (j >= arr.length) continue;
          if (topIds.has(arr[j].id)) continue; // already adjacent — don't swap peers
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        root.children = arr;
      } else if (op === "backward") {
        const arr = kids.slice();
        for (let i = 0; i < arr.length; i++) {
          if (!topIds.has(arr[i].id)) continue;
          const j = i - 1;
          if (j < 0) continue;
          if (topIds.has(arr[j].id)) continue;
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        root.children = arr;
      }
    });
  });
}
