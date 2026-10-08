// Tool state machine: select, rect, circle, ellipse, line, polyline, pen.
// All pointer/keyboard input on the canvas funnels through here.

import {
  getDoc, getSelection, setSelection, toggleSelection, clearSelection,
  mutate, newId, emptyTransform, findNode, findPath, topAncestor, walk,
} from "./state.js";
import * as history from "./history.js";
import { toCanvasPoint, toLocalPoint, getTransientLayer, getDocLayer, elementBBoxInCanvas, localToCanvasMatrix, setHoverOutline, clearHoverOutline, resolveConnector, connectorMidpoint, canvasPixelScale, setDirectSelectMode, portToCanvas, setPortHints, clearPortHints } from "./render.js";
import * as guides from "./guides.js";
import * as grid from "./grid.js";
import { routeOrthogonal, portsFor } from "./connectors.js";
import { anchorsToPath, shapeToAnchors, GEOMETRY_ATTRS } from "./paths.js";

const CANVAS_BBOX = { x: 0, y: 0, width: 1000, height: 700 };
const SNAP_THRESHOLD = 6; // canvas units — feels right at default zoom
const DRAG_THRESHOLD = 3; // screen px the pointer must travel before a move "takes"
const PORT_SNAP_PX = 12;  // a connector end snaps to a connection point within this many screen px
const PORT_REACH_PX = 24; // a shape shows its connection points once the pointer is this close
const ROUND_RECT_RADIUS = 16; // default corner radius for the rounded-rect tool

let hoveredId = null;     // top-level id currently under the pointer (select tool)

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
const CONNECTOR_STYLE = {
  fill: "none",
  stroke: "#222222",
  "stroke-width": 2,
};

let currentTool = "select";
let canvasSvg;
let polylineInProgress = null;  // { id, points, previewLineId } while drawing
let penInProgress = null;       // { id, previewEl, dragging } while drawing a pen path

// Gesture state
let gesture = null;
let downClient = null;    // {x,y} client coords at pointerdown — for the drag threshold

// "Transform Again" descriptor: the last committed move/rotate gesture, so Ctrl+D
// can replay it (Illustrator step-and-repeat). Shape:
//   { kind: "move",   dx, dy, duplicate }
//   { kind: "rotate", deg, duplicate }   // rotation is about each node's own center
// A plain duplicate (Ctrl+D with no prior transform) falls back to a fixed nudge.
let lastTransform = null;

export function mount(svg) {
  canvasSvg = svg;

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointerleave", () => { if (!gesture) { setHover(null); hideConnectHints(); } });
  svg.addEventListener("dblclick", onDoubleClick);
  svg.addEventListener("contextmenu", onContextMenu);
}

export function setTool(name) {
  if (currentTool === name) return;
  cancelPolyline();
  cancelPen();
  cancelConnector();
  currentTool = name;
  // Both selection tools (Select, Direct Selection) are pointer/arrow tools — the
  // crosshair "draw-mode" cursor is only for shape-creating tools.
  canvasSvg.classList.toggle("draw-mode", !isSelectTool(name));
  // The Connector tool works on shapes, not on the selection: its connection
  // points sit right on the resize handles, so the handles stand aside (CSS).
  canvasSvg.classList.toggle("connector-mode", name === "connector");
  // Direct Selection swaps a lone path's chrome to editable anchors/handles.
  setDirectSelectMode(name === "directselect");
  setHover(null); // hover highlight is a select-tool affordance
  document.dispatchEvent(new CustomEvent("tool-changed", { detail: name }));
}
export function getTool() { return currentTool; }

// The two arrow tools that select + move objects (vs. shape-creating tools).
// Direct Selection shares Select's click/marquee/move behavior; it only differs
// in the chrome it shows for a lone pen path (editable anchors) and that path
// anchors are draggable under it.
function isSelectTool(name) { return name === "select" || name === "directselect"; }

// --- Pointer handlers ---

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = toCanvasPoint(e);
  const target = e.target;

  // Second click of a click-click connector: this click picks the target.
  if (gesture && gesture.type === "connector" && gesture.armed) {
    const g = gesture;
    gesture = null;
    g.last = p;
    finishConnector(g, e);
    clearTransient();
    return;
  }

  // A gesture is starting: drop the hover highlight and remember the screen-space
  // origin so the move gesture can apply a zoom-independent drag threshold.
  setHover(null);
  downClient = { x: e.clientX, y: e.clientY };

  // Chrome-layer roles override everything else.
  const role = target.getAttribute && target.getAttribute("data-role");
  if (role === "resize") return startResize(e, target, p);
  if (role === "resize-multi") return startResizeMulti(e, target, p);
  if (role === "rotate") return startRotate(e, target, p);
  if (role === "waypoint" || role === "waypoint-add") return startWaypointDrag(e, target, p);
  if (role === "path-anchor" || role === "path-handle") return startPathPointDrag(e, target, p);

  if (isSelectTool(currentTool)) return handleSelectDown(e, p, target);

  // Draw tools
  if (currentTool === "polyline") return handlePolylineDown(e, p);
  if (currentTool === "pen") return handlePenDown(e, p);
  if (currentTool === "text") return handleTextDown(e, p);
  if (currentTool === "connector") return startConnector(e, p, target);
  return startDraw(e, p);
}

function onPointerMove(e) {
  const p = toCanvasPoint(e);

  if (polylineInProgress) {
    updatePolylinePreview(p);
  }
  if (penInProgress && !gesture) {
    updatePenPreview(p);
  }

  if (!gesture) {
    updateHover(e);
    if (currentTool === "connector") showConnectHints(connectEndAt(p, e.target, null));
    return;
  }

  const dx = p.x - gesture.origin.x;
  const dy = p.y - gesture.origin.y;
  gesture.last = p;

  // Drag threshold: measure in screen pixels so it feels the same at every zoom.
  // A move gesture doesn't "take" (and doesn't spawn a Ctrl-drag duplicate) until
  // the pointer clears the threshold — a click that jitters shouldn't nudge.
  if (!gesture.moved && downClient) {
    const sdx = e.clientX - downClient.x;
    const sdy = e.clientY - downClient.y;
    if (Math.hypot(sdx, sdy) <= DRAG_THRESHOLD) return;
    gesture.moved = true;
    if (gesture.type === "move") {
      canvasSvg.classList.add("dragging");
      canvasSvg.classList.toggle("will-duplicate", !!gesture.duplicate);
      beginMovePayload(e);
    } else if (gesture.type === "rotate") {
      beginRotatePayload();
    } else if (gesture.type === "path-point") {
      beginPathPointPayload();
    }
  }

  if (gesture.type === "draw") {
    updateDraw(p, e);
  } else if (gesture.type === "move") {
    updateMove(dx, dy, e);
  } else if (gesture.type === "resize") {
    updateResize(p, e);
  } else if (gesture.type === "rotate") {
    updateRotate(p, e);
  } else if (gesture.type === "waypoint") {
    updateWaypoint(p, e);
  } else if (gesture.type === "pen") {
    updatePenDrag(p, e);
  } else if (gesture.type === "path-point") {
    updatePathPoint(e);
  } else if (gesture.type === "marquee") {
    updateMarquee(p);
  } else if (gesture.type === "connector") {
    updateConnector(p, e);
  }
}

// Hover highlight + cursor feedback while idle with the select tool.
function updateHover(e) {
  if (!isSelectTool(currentTool)) { setHover(null); return; }
  const role = e.target.getAttribute && e.target.getAttribute("data-role");
  if (role === "resize" || role === "resize-multi" || role === "rotate" ||
      role === "waypoint" || role === "waypoint-add" ||
      role === "path-anchor" || role === "path-handle") { setHover(null); return; }
  const hit = hitTest(e.target);
  const id = hit ? pickSelectionId(hit.id) : null;
  setHover(id);
  const dup = (e.ctrlKey || e.metaKey) && id;
  canvasSvg.classList.toggle("will-duplicate", !!dup);
}

function setHover(id) {
  canvasSvg.classList.toggle("over-shape", !!id && isSelectTool(currentTool));
  if (!id) canvasSvg.classList.remove("will-duplicate");
  if (id === hoveredId) return;
  hoveredId = id;
  // Don't outline a shape that's already selected — its selection chrome covers it.
  if (id && !getSelection().has(id)) setHoverOutline(id);
  else clearHoverOutline();
}

function onPointerUp(e) {
  downClient = null;
  canvasSvg.classList.remove("dragging", "will-duplicate");
  if (!gesture) return;
  const g = gesture;
  gesture = null;

  if (g.type === "draw") {
    finishDraw(g);
  } else if (g.type === "marquee") {
    finishMarquee(g, e.shiftKey);
  } else if (g.type === "connector") {
    // A click (no drag) that started on a shape arms the connector: the preview
    // keeps following the pointer and the next click on the canvas picks the
    // target. An armed connector only completes on that click (see
    // onPointerDown), never on a stray pointerup elsewhere on the page.
    if (g.armed || (!g.moved && g.from.ref)) {
      g.armed = true;
      gesture = g;
      return;
    }
    finishConnector(g, e);
  } else if (g.type === "move") {
    // Commit only a real move that touched at least one movable node (a
    // connector-only selection has an empty moving set — nothing to record).
    if (g.moved && g.ids.length > 0) {
      history.commit(g.type);
      lastTransform = {
        kind: "move",
        dx: g.appliedDx || 0, dy: g.appliedDy || 0,
        duplicate: !!g.duplicate,
      };
    } else history.abort();
  } else if (g.type === "resize" || g.type === "rotate") {
    if (g.moved) {
      history.commit(g.type);
      if (g.type === "rotate") {
        lastTransform = {
          kind: "rotate", deg: g.appliedDeg || 0, duplicate: !!g.duplicate,
          pivot: { x: g.center.x, y: g.center.y }, // canvas-space center of rotation
        };
      }
    } else history.abort();
    if (g.type === "rotate") hideRotationReadout();
  } else if (g.type === "waypoint") {
    // A real drag committed a moved/inserted waypoint; a click that never
    // crossed the threshold inserted nothing, so drop the transaction.
    if (g.moved) history.commit("waypoint");
    else history.abort();
  } else if (g.type === "pen") {
    finishPenAnchor(g, e);
    return; // pen path stays in progress; don't clear its rubber-band preview
  } else if (g.type === "path-point") {
    if (g.moved) history.commit("edit path");
    else history.abort();
  }

  clearTransient();
}

function onContextMenu(e) {
  e.preventDefault();
  // Only meaningful with a selection (arrow) tool active.
  if (!isSelectTool(currentTool)) { closeContextMenu(); return; }
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
  if (penInProgress) {
    // The double-click's second press already appended a coincident anchor;
    // commitPen drops that trailing duplicate before finalizing.
    commitPen();
    return;
  }
  // Double-clicking a waypoint handle removes that waypoint. Checked before the
  // select-tool gate so it works whenever the handle is visible (a connector is
  // selected), matching waypoint-drag which is tool-independent.
  const role = e.target.getAttribute && e.target.getAttribute("data-role");
  if (role === "waypoint") {
    deleteWaypoint(e.target.getAttribute("data-id"), Number(e.target.getAttribute("data-index")));
    return;
  }
  // Double-click a path anchor to delete it; a control handle to retract it
  // (turning a smooth node into a corner). Both are tool-independent, matching
  // waypoint editing.
  if (role === "path-anchor") {
    deletePathAnchor(e.target.getAttribute("data-id"), Number(e.target.getAttribute("data-index")));
    return;
  }
  if (role === "path-handle") {
    retractPathHandle(e.target.getAttribute("data-id"), Number(e.target.getAttribute("data-index")), e.target.getAttribute("data-which"));
    return;
  }
  if (!isSelectTool(currentTool)) return;
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
  const dup = e.ctrlKey || e.metaKey;
  if (e.shiftKey) {
    toggleSelection(id);
  } else if (dup) {
    // Ctrl/Cmd-drag duplicates. If the clicked shape isn't in the selection,
    // duplicate just it; otherwise duplicate the whole current selection.
    if (!sel.has(id)) setSelection([id]);
  } else if (!sel.has(id)) {
    setSelection([id]);
  }
  // Begin move gesture on the current selection (which now includes id).
  startMove(p, e);
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

function startMove(p, e) {
  const sel = [...getSelection()];
  if (sel.length === 0) return;
  history.beginTransaction();
  // Payload (snapshots, bboxes) is deferred to beginMovePayload() once the drag
  // threshold is crossed — so a Ctrl-drag only duplicates on an actual drag, and
  // a jittery click never nudges. duplicate = Ctrl/Cmd held at pointerdown.
  gesture = {
    type: "move", origin: p, last: p, moved: false,
    duplicate: !!(e && (e.ctrlKey || e.metaKey)),
    initialSel: sel,
    ids: [], orig: new Map(), movingUnion: null, stationaryBBoxes: [],
  };
}

// Called from onPointerMove when the drag threshold is first crossed.
function beginMovePayload(e) {
  const g = gesture;
  // Ctrl/Cmd-drag: clone the selection in place and drag the copies instead.
  if (g.duplicate) {
    const newIds = [];
    mutate((root) => {
      const topIds = new Set();
      for (const id of g.initialSel) {
        const path = findPath(root, id);
        if (path && path.length) topIds.add(path[0].id);
      }
      // Preserve paint order so stacking of the copies matches the originals.
      for (const child of root.children) {
        if (!topIds.has(child.id)) continue;
        const copy = deepReId(child);         // sits exactly atop the original
        root.children.push(copy);
        newIds.push(copy.id);
      }
    });
    if (newIds.length) setSelection(newIds);
  }
  computeMovePayload(g);
}

// Snapshot original transforms + canvas bboxes for the current selection (the
// moving set) and the stationary top-level nodes we align against.
function computeMovePayload(g) {
  const doc = getDoc();
  const movingTopIds = new Set();
  for (const id of getSelection()) {
    const top = topAncestor(doc, id);
    // Connectors have derived geometry (no transform) — they can't be dragged;
    // they follow whatever shapes they attach to. Skip them from the moving set.
    if (top && top.type !== "connector") movingTopIds.add(top.id);
  }

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
  const movingUnion = unionOfBBoxes(movingBBoxes);

  const stationaryBBoxes = [];
  for (const child of doc.children) {
    if (movingTopIds.has(child.id)) continue;
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(child.id)}"]`);
    const b = el && elementBBoxInCanvas(el);
    if (b) stationaryBBoxes.push({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
  }

  g.ids = [...movingTopIds];
  g.orig = orig;
  g.movingUnion = movingUnion;
  g.stationaryBBoxes = stationaryBBoxes;
}

// Deep-clone a node subtree with fresh ids. Local twin of ui.js's helper so the
// move gesture doesn't depend on the UI module.
function deepReId(node) {
  const copy = structuredClone(node);
  walk(copy, (n) => { n.id = newId(n.type === "group" ? "g" : "n"); });
  return copy;
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
  // Remember the net delta so "Transform Again" (Ctrl+D) can replay this move.
  gesture.appliedDx = finalDx;
  gesture.appliedDy = finalDy;
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
  // A rounded rect is a plain `rect` node carrying rx/ry — no distinct node type,
  // so render / export / resize handle it with zero extra plumbing.
  const type = tool === "roundrect" ? "rect" : tool;
  const base = { id, type, transform: emptyTransform() };
  const style = tool === "line" ? { ...LINE_STYLE } : { ...DEFAULT_STYLE };
  if (tool === "roundrect") {
    return { ...base, attrs: { x: p.x, y: p.y, width: 0, height: 0, rx: ROUND_RECT_RADIUS, ry: ROUND_RECT_RADIUS, ...style } };
  }
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
  if (e.shiftKey && (tool === "rect" || tool === "roundrect" || tool === "ellipse" || tool === "circle")) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    if (tool === "rect" || tool === "roundrect") {
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
  if (tool === "rect" || tool === "roundrect") return !(node.attrs.width > 0 && node.attrs.height > 0);
  if (tool === "ellipse") return !(node.attrs.rx > 0 && node.attrs.ry > 0);
  if (tool === "circle") return !(node.attrs.r > 0);
  if (tool === "line") return node.attrs.x1 === node.attrs.x2 && node.attrs.y1 === node.attrs.y2;
  if (tool === "polyline") return !node.attrs.points || node.attrs.points.length < 2;
  return false;
}

// --- Connector (drag between shapes) ---
//
// Drag from a shape to another, or click a shape, move, and click the target.
// Endpoints attach to the top-level shape under (or near) the pointer: snapped to
// one of its connection points when the pointer is close to one (draw.io "fixed"
// ends), else floating on its border; over empty canvas they pin a free point.
// While the tool is active, the nearby shape's connection points are shown and
// the snap target is highlighted. Geometry is never stored — the connector node
// holds only endpoint refs (+ port) or free points, and render/export re-route it
// from the live shapes, so it follows them on move/resize/rotate.

function startConnector(e, p, target) {
  const at = connectEndAt(p, target, null);
  gesture = {
    type: "connector",
    origin: p, last: p, moved: false,
    from: at.end || { x: p.x, y: p.y },
    to: null,
  };
  showConnectHints(at);
  // Preview of the elbow route on the transient layer.
  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("class", "connector-preview");
  gesture.previewEl = line;
  getTransientLayer().appendChild(line);
  updateConnectorPreview(p);
}

function updateConnector(p, e) {
  // Excluding the start shape rules out a self-loop we can't route.
  const at = connectEndAt(p, e.target, gesture.from.ref ?? null);
  gesture.to = at.end;
  highlightConnectTarget(at.end ? at.end.ref : null);
  showConnectHints(at);
  updateConnectorPreview(p);
}

function updateConnectorPreview(p) {
  const a = endGeometry(gesture.from);
  const b = gesture.to ? endGeometry(gesture.to) : { box: null, pt: p, port: null };
  const g = routeOrthogonal(a.box, b.box, a.pt, b.pt, null, a.port, b.port);
  if (!g.valid) return;
  gesture.previewEl.setAttribute("points", g.points.map((pt) => pt.join(",")).join(" "));
}

function finishConnector(g, e) {
  clearConnectTargetHighlight();
  hideConnectHints();
  const toEnd = connectEndAt(g.last, e.target, g.from.ref ?? null).end;
  // The second click of a click-click connector must land on a target; a
  // click on empty canvas cancels rather than leaving a dangling edge.
  if (g.armed && !toEnd) return;

  // A connector needs at least one attached endpoint AND a non-trivial length —
  // otherwise a stray click on empty canvas would create a zero-length edge.
  const dist = Math.hypot(g.last.x - g.origin.x, g.last.y - g.origin.y);
  const hasAttachment = !!g.from.ref || !!toEnd;
  if (!hasAttachment || (dist < 4 && !toEnd)) return;

  const to = toEnd || { x: round2(g.last.x), y: round2(g.last.y) };
  const from = g.from.ref ? g.from : { x: round2(g.from.x), y: round2(g.from.y) };

  const id = newId("c");
  const node = {
    id, type: "connector",
    from, to,
    // New connectors bend at right angles; Routing → Straight in the panel undoes it.
    route: "orthogonal",
    arrowEnd: true,
    attrs: { ...CONNECTOR_STYLE },
  };
  history.record(() => {
    mutate((root) => { root.children.push(node); });
  });
  setSelection([id]);
}

// Drop an in-progress connector (an armed click-click one, or a drag).
function cancelConnector() {
  hideConnectHints();
  if (!gesture || gesture.type !== "connector") return;
  gesture = null;
  clearConnectTargetHighlight();
  clearTransient();
}

// What a connector end at canvas point `p` would attach to. Returns
// { end, points, active }: `end` is { ref, port? } or null (a free point);
// `points` are the candidate shape's connection points in canvas space, and
// `active` indexes the one snapped to (-1 if none).
function connectEndAt(p, target, excludeId) {
  const scale = canvasPixelScale();
  const hit = hitTest(target);
  let overId = hit ? pickSelectionId(hit.id) : null;
  if (overId && (overId === excludeId || !isConnectable(overId))) overId = null;
  const shapeId = overId || nearestConnectable(p, PORT_REACH_PX * scale, excludeId);
  if (!shapeId) return { end: null, points: [], active: -1 };

  const el = getDocLayer().querySelector(`[data-id="${cssEscape(shapeId)}"]`);
  const ports = el ? portsFor(findNode(getDoc(), shapeId).type) : [];
  const points = ports.map((port) => portToCanvas(el, port));
  let active = -1, bestD = PORT_SNAP_PX * scale;
  points.forEach((q, i) => {
    if (!q) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) { bestD = d; active = i; }
  });
  if (active >= 0) return { end: { ref: shapeId, port: { ...ports[active] } }, points: points.filter(Boolean), active };
  return { end: overId ? { ref: shapeId } : null, points: points.filter(Boolean), active };
}

function isConnectable(id) {
  const n = findNode(getDoc(), id);
  return !!n && n.type !== "connector";
}

// Nearest top-level shape whose canvas box lies within `reach` of `p`.
function nearestConnectable(p, reach, excludeId) {
  let best = null, bestD = reach;
  for (const n of getDoc().children) {
    if (n.type === "connector" || n.id === excludeId) continue;
    const b = shapeBox(n.id);
    if (!b) continue;
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
    const d = Math.hypot(dx, dy);
    if (d <= bestD) { bestD = d; best = n.id; }
  }
  return best;
}

// Show a candidate shape's connection points; the pointer becomes a hand
// while it's on one (the click would snap there).
function showConnectHints(at) {
  if (!at.points.length) { hideConnectHints(); return; }
  setPortHints(at.points, at.active);
  canvasSvg.classList.toggle("over-port", at.active >= 0);
}

function hideConnectHints() {
  clearPortHints();
  canvasSvg.classList.remove("over-port");
}

// Canvas geometry of a connector end, in the form the router takes.
function endGeometry(end) {
  if (end.ref == null) return { box: null, pt: { x: end.x, y: end.y }, port: null };
  const el = getDocLayer().querySelector(`[data-id="${cssEscape(end.ref)}"]`);
  return {
    box: shapeBox(end.ref),
    pt: null,
    port: el && end.port ? portToCanvas(el, end.port) : null,
  };
}

// Canvas-space AABB of a top-level shape by id (null if unmeasurable).
function shapeBox(id) {
  const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
  if (!el) return null;
  const b = elementBBoxInCanvas(el);
  return b ? { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 } : null;
}

// Outline the shape the "to" end would attach to, as drag feedback.
function highlightConnectTarget(id) {
  clearConnectTargetHighlight();
  if (id) setHoverOutline(id);
}
function clearConnectTargetHighlight() {
  clearHoverOutline();
}

// --- Connector waypoints (orthogonal routes) ---
//
// Two handle kinds sit on a selected orthogonal connector: a `waypoint` handle
// over each stored waypoint (drag to move) and a `waypoint-add` handle at each
// segment midpoint (drag to bend — inserts a new waypoint at that leg's ordered
// position). Both share one gesture; an "add" defers the actual insert until the
// drag threshold is crossed so a stray click doesn't litter waypoints.
function startWaypointDrag(e, handleEl, p) {
  const id = handleEl.getAttribute("data-id");
  const node = findNode(getDoc(), id);
  if (!node || node.type !== "connector") return;
  const isAdd = handleEl.getAttribute("data-role") === "waypoint-add";
  history.beginTransaction();
  gesture = {
    type: "waypoint",
    origin: p, last: p, moved: false,
    connectorId: id,
    index: isAdd ? Number(handleEl.getAttribute("data-insert")) : Number(handleEl.getAttribute("data-index")),
    pendingInsert: isAdd, // true until the first move materializes the waypoint
  };
}

function updateWaypoint(p, e) {
  // Snap to grid unless Alt bypasses it (same convention as move/resize).
  let pt = p;
  if (grid.isSnap() && !e?.altKey) pt = grid.snapPoint(p.x, p.y);
  const { connectorId, index } = gesture;
  mutate((root) => {
    const n = findNode(root, connectorId);
    if (!n) return;
    if (!Array.isArray(n.waypoints)) n.waypoints = [];
    if (gesture.pendingInsert) {
      n.waypoints.splice(index, 0, { x: round2(pt.x), y: round2(pt.y) });
      gesture.pendingInsert = false;
    } else {
      if (!n.waypoints[index]) n.waypoints[index] = { x: 0, y: 0 };
      n.waypoints[index].x = round2(pt.x);
      n.waypoints[index].y = round2(pt.y);
    }
  });
}

// Double-click a waypoint handle to remove that waypoint.
function deleteWaypoint(id, index) {
  const node = findNode(getDoc(), id);
  if (!node || !Array.isArray(node.waypoints)) return;
  if (index < 0 || index >= node.waypoints.length) return;
  history.record(() => {
    mutate((root) => {
      const n = findNode(root, id);
      if (!n || !Array.isArray(n.waypoints)) return;
      n.waypoints.splice(index, 1);
      if (n.waypoints.length === 0) delete n.waypoints;
    });
  });
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

// --- Pen / bézier path (click for corners, click-drag for smooth curves) ---
//
// Mirrors the polyline click-flow but builds the structured anchor model from
// paths.js (node.anchors + node.closed) rather than a flat point list. Each
// pointerdown adds an anchor; dragging before release pulls out a symmetric
// bézier handle (a smooth point). Clicking the first anchor closes the path;
// double-click / Enter / tool-switch finalizes; Escape also finalizes a valid
// path (matching the polyline tool). The whole session is one history entry.
const PEN_CLOSE_PX = 10; // screen px: click within this of the first anchor closes

function handlePenDown(e, p) {
  const snapped = (grid.isSnap() && !e.altKey) ? grid.snapPoint(p.x, p.y) : p;

  if (!penInProgress) {
    const id = newId("p");
    history.beginTransaction();
    const node = {
      id, type: "path", transform: emptyTransform(),
      anchors: [{ x: round2(snapped.x), y: round2(snapped.y) }],
      closed: false,
      attrs: { fill: "none", stroke: "#222222", "stroke-width": 2, opacity: 1 },
    };
    mutate((root) => { root.children.push(node); });
    penInProgress = { id };
    ensurePenPreview();
    // Start a pen gesture so an immediate drag pulls a handle off this anchor.
    gesture = { type: "pen", origin: p, last: p, moved: false, penId: id, index: 0 };
    return;
  }

  // Click near the first anchor closes the path (needs at least a triangle).
  if (penCloseAnchor(p)) {
    mutate((root) => {
      const n = findNode(root, penInProgress.id);
      if (n) n.closed = true;
    });
    commitPen();
    return;
  }

  // Otherwise append a new anchor and arm a gesture for a drag-to-curve.
  let index = 0;
  mutate((root) => {
    const n = findNode(root, penInProgress.id);
    if (!n) return;
    if (!Array.isArray(n.anchors)) n.anchors = [];
    n.anchors.push({ x: round2(snapped.x), y: round2(snapped.y) });
    index = n.anchors.length - 1;
  });
  gesture = { type: "pen", origin: p, last: p, moved: false, penId: penInProgress.id, index };
}

// Drag after placing an anchor pulls a symmetric bézier handle (smooth point).
// The general move-threshold gate in onPointerMove only calls this once the drag
// clears DRAG_THRESHOLD, so a plain click stays a corner.
function updatePenDrag(p, e) {
  const { penId, index } = gesture;
  mutate((root) => {
    const n = findNode(root, penId);
    if (!n || !Array.isArray(n.anchors) || !n.anchors[index]) return;
    const a = n.anchors[index];
    // Outgoing handle follows the pointer; incoming handle mirrors it.
    a.cout = { x: round2(p.x), y: round2(p.y) };
    a.cin = { x: round2(2 * a.x - p.x), y: round2(2 * a.y - p.y) };
  });
}

// pointerup on a pen anchor: it's already in the in-progress path, so the session
// simply continues. The rubber-band preview resumes on the next pointermove.
function finishPenAnchor(g, e) { /* nothing to commit per-anchor */ }

// Would a click at canvas point `p` close the in-progress path? Returns the first
// anchor when yes (within PEN_CLOSE_PX and the path has ≥2 anchors), else null.
// Shared by the click handler and the hover cue so they agree exactly.
function penCloseAnchor(p) {
  if (!penInProgress) return null;
  const node = findNode(getDoc(), penInProgress.id);
  if (!node || !Array.isArray(node.anchors) || node.anchors.length < 2) return null;
  const first = node.anchors[0];
  if (Math.hypot(p.x - first.x, p.y - first.y) <= PEN_CLOSE_PX * canvasPixelScale()) return first;
  return null;
}

function ensurePenPreview() {
  if (!penInProgress || penInProgress.previewEl) return;
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "rubber");
  penInProgress.previewEl = line;
  getTransientLayer().appendChild(line);
}

// A ring drawn over the first anchor while the pointer is close enough to close
// the path — the Illustrator "○" pen-close cue. Created lazily; hidden otherwise.
function ensurePenCloseHint() {
  if (!penInProgress) return null;
  if (penInProgress.closeHintEl) return penInProgress.closeHintEl;
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("class", "pen-close-hint");
  penInProgress.closeHintEl = c;
  getTransientLayer().appendChild(c);
  return c;
}

function updatePenPreview(p) {
  if (!penInProgress) return;
  const node = findNode(getDoc(), penInProgress.id);
  if (!node || !Array.isArray(node.anchors) || !node.anchors.length) return;
  const last = node.anchors[node.anchors.length - 1];
  const line = penInProgress.previewEl;
  if (!line) return;

  // If hovering within the close threshold, snap the rubber-band to the first
  // anchor and show the close ring over it; otherwise track the pointer.
  const closeTo = penCloseAnchor(p);
  const end = closeTo || p;
  line.setAttribute("x1", last.x);
  line.setAttribute("y1", last.y);
  line.setAttribute("x2", end.x);
  line.setAttribute("y2", end.y);

  const hint = ensurePenCloseHint();
  if (hint) {
    if (closeTo) {
      const r = PEN_CLOSE_PX * canvasPixelScale();
      hint.setAttribute("cx", closeTo.x);
      hint.setAttribute("cy", closeTo.y);
      hint.setAttribute("r", r);
      hint.removeAttribute("hidden");
    } else {
      hint.setAttribute("hidden", "");
    }
  }
}

// Finalize the in-progress pen path: drop a trailing anchor coincident with its
// predecessor (a double-click to finish lands two clicks on one point), then
// commit as one history entry — or drop the node entirely if it has < 2 anchors.
function commitPen() {
  if (!penInProgress) return;
  const id = penInProgress.id;
  penInProgress = null;
  gesture = null;
  clearTransient();
  mutate((root) => {
    const n = findNode(root, id);
    if (!n || !Array.isArray(n.anchors)) return;
    const a = n.anchors;
    while (a.length >= 2) {
      const p1 = a[a.length - 1], p2 = a[a.length - 2];
      if (!p1.cin && !p1.cout && Math.abs(p1.x - p2.x) < 0.5 && Math.abs(p1.y - p2.y) < 0.5) a.pop();
      else break;
    }
  });
  const node = findNode(getDoc(), id);
  if (!node || !Array.isArray(node.anchors) || node.anchors.length < 2) {
    mutate((root) => {
      const idx = root.children.findIndex(c => c.id === id);
      if (idx >= 0) root.children.splice(idx, 1);
    });
    history.abort();
    return;
  }
  history.commit("draw path");
  setSelection([id]);
}

// Enter finalizes an in-progress pen path (keeps it selected). Returns whether it
// did anything, so the keyboard handler can swallow the key only when relevant.
export function finishPen() {
  if (!penInProgress) return false;
  commitPen();
  return true;
}

// Tool-switch / Escape finalizes any valid in-progress path (commitPen drops an
// under-2-anchor stub), mirroring cancelPolyline.
export function cancelPen() {
  if (!penInProgress) return;
  commitPen();
}

// --- Path node editing (anchors + bézier handles on a selected pen path) ---
//
// The chrome lives in the path's LOCAL space (its group mirrors the node
// transform), and node.anchors are in that same space — so pointer positions are
// converted via the path element's matrix (toLocalPoint), not toCanvasPoint.
//   • Dragging an anchor moves its point AND both control handles by the same
//     delta, so the local curve shape rides along.
//   • Dragging a control handle moves that handle; by default the opposite handle
//     mirrors it (keeps the anchor smooth). Alt breaks the pair (corner with two
//     independent handles) — matching Illustrator's Alt-drag-handle.
function startPathPointDrag(e, handleEl, p) {
  const id = handleEl.getAttribute("data-id");
  const node = findNode(getDoc(), id);
  if (!node) return;
  // Pen paths edit their stored anchors directly; a primitive shape (rect /
  // ellipse / line / polyline) is converted to an editable path on the first real
  // drag (Illustrator-style), deferred to beginPathPointPayload so a stray click
  // never rewrites the node.
  const isPath = node.type === "path" && Array.isArray(node.anchors);
  const needsConvert = !isPath && !!shapeToAnchors(node);
  if (!isPath && !needsConvert) return;
  const index = Number(handleEl.getAttribute("data-index"));
  const kind = handleEl.getAttribute("data-role"); // "path-anchor" | "path-handle"
  const which = handleEl.getAttribute("data-which"); // "in" | "out" (handles only)
  history.beginTransaction();
  gesture = {
    type: "path-point",
    origin: p, last: p, moved: false,
    pathId: id, index, kind, which, needsConvert,
    // No element ref is cached: every mutate() rebuilds #doc-layer, so the path
    // element is re-queried fresh each frame (a stale ref gave the wrong matrix
    // and made the dragged anchor jitter / track at the zoom factor).
  };
}

// First real drag on a primitive shape's joint: bake it into an editable path so
// subsequent frames mutate node.anchors like any pen path.
function beginPathPointPayload() {
  if (!gesture.needsConvert) return;
  convertShapeToPath(gesture.pathId);
  gesture.needsConvert = false;
}

// Replace a primitive shape node with an equivalent structured path in place
// (same id / transform / styling), dropping its geometry attrs. The derived
// anchors come from the same shapeToAnchors used to draw the joints, so the
// gesture's anchor index still points at the handle the user grabbed.
function convertShapeToPath(id) {
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    const derived = shapeToAnchors(n);
    if (!derived) return;
    n.type = "path";
    n.anchors = derived.anchors;
    n.closed = derived.closed;
    if (derived.cornerRadius) n.cornerRadius = derived.cornerRadius;
    for (const k of GEOMETRY_ATTRS) delete n.attrs[k];
  });
}

function updatePathPoint(e) {
  const { pathId, index, kind, which } = gesture;
  // Re-query the live path element each frame — mutate() rebuilt it last frame, so
  // a cached ref would be detached and yield a stale matrix (the jitter bug).
  const el = getDocLayer().querySelector(`[data-id="${cssEscape(pathId)}"]`);
  // Pointer → path-local coords (chrome mirrors the node transform).
  let loc = el ? toLocalPoint(e, el) : toCanvasPoint(e);
  // Snap anchors to the grid unless Alt bypasses; control handles stay free.
  if (kind === "path-anchor" && grid.isSnap() && !e.altKey) {
    const s = grid.snapPoint(loc.x, loc.y);
    loc = s;
  }
  const lx = round2(loc.x), ly = round2(loc.y);
  mutate((root) => {
    const n = findNode(root, pathId);
    if (!n || !Array.isArray(n.anchors) || !n.anchors[index]) return;
    const a = n.anchors[index];
    if (kind === "path-anchor") {
      const dx = lx - a.x, dy = ly - a.y;
      a.x = lx; a.y = ly;
      if (a.cin) { a.cin.x = round2(a.cin.x + dx); a.cin.y = round2(a.cin.y + dy); }
      if (a.cout) { a.cout.x = round2(a.cout.x + dx); a.cout.y = round2(a.cout.y + dy); }
    } else {
      const near = which === "in" ? "cin" : "cout";
      const far = which === "in" ? "cout" : "cin";
      a[near] = { x: lx, y: ly };
      // Mirror the opposite handle about the anchor for a smooth node, unless Alt
      // breaks the pair (independent handles → a corner with curved sides).
      if (!e.altKey && a[far]) {
        a[far] = { x: round2(2 * a.x - lx), y: round2(2 * a.y - ly) };
      }
    }
  });
}

// Double-click an anchor to delete it. A path needs ≥2 anchors to exist; removing
// below that deletes the whole node. A closed path that drops to 2 anchors reopens
// (a 2-point closed path is degenerate). One history entry.
function deletePathAnchor(id, index) {
  const node = findNode(getDoc(), id);
  if (!node || node.type !== "path" || !Array.isArray(node.anchors)) return;
  if (index < 0 || index >= node.anchors.length) return;
  history.record(() => {
    if (node.anchors.length <= 2) {
      mutate((root) => {
        const idx = root.children.findIndex(c => c.id === id);
        if (idx >= 0) root.children.splice(idx, 1);
      });
      clearSelection();
      return;
    }
    mutate((root) => {
      const n = findNode(root, id);
      if (!n || !Array.isArray(n.anchors)) return;
      n.anchors.splice(index, 1);
      if (n.closed && n.anchors.length < 3) n.closed = false;
    });
  });
}

// Double-click a control handle to retract it (smooth node → corner on that side).
function retractPathHandle(id, index, which) {
  const node = findNode(getDoc(), id);
  if (!node || node.type !== "path" || !Array.isArray(node.anchors)) return;
  const key = which === "in" ? "cin" : "cout";
  if (!node.anchors[index] || !node.anchors[index][key]) return;
  history.record(() => {
    mutate((root) => {
      const n = findNode(root, id);
      if (n && n.anchors[index]) delete n.anchors[index][key];
    });
  });
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
  // Groups scale their whole subtree, so snapshot it and measure the group's
  // LOCAL (pre-transform) bbox — the space the scale anchor lives in.
  if (node.type === "group") {
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
    gesture.origSubtree = structuredClone(node);
    gesture.localBBox = el ? safeGetBBox(el) : null;
  }
}

function safeGetBBox(el) {
  try { return el.getBBox(); } catch { return null; }
}

// Multi-selection resize: scale every selected top-level node about the union
// bounding box's fixed anchor, in canvas space. Snapshots each node's subtree so
// the scale is re-derived from the pristine state each frame (scaling is destructive).
function startResizeMulti(e, handleEl, p) {
  const dir = handleEl.getAttribute("data-handle");
  const doc = getDoc();
  const topIds = new Set();
  for (const id of getSelection()) {
    const top = topAncestor(doc, id);
    // Connectors have derived geometry — they follow their endpoints, can't be scaled.
    if (top && top.type !== "connector") topIds.add(top.id);
  }
  if (topIds.size === 0) return;

  // Union bbox in canvas (viewBox) coords from each node's projected element bbox.
  const snapshots = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of topIds) {
    const node = findNode(doc, id);
    if (!node) continue;
    snapshots.set(id, structuredClone(node));
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
    const b = el && elementBBoxInCanvas(el);
    if (!b) continue;
    if (b.x1 < minX) minX = b.x1;
    if (b.y1 < minY) minY = b.y1;
    if (b.x2 > maxX) maxX = b.x2;
    if (b.y2 > maxY) maxY = b.y2;
  }
  if (!isFinite(minX)) return;

  history.beginTransaction();
  gesture = {
    type: "resize",
    origin: p, last: p, moved: false,
    dir,
    multi: {
      ids: [...topIds],
      snapshots,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    },
  };
}

function cloneShape(node) {
  return {
    attrs: { ...node.attrs, points: node.attrs.points ? node.attrs.points.map(p => [...p]) : undefined },
    transform: { ...node.transform },
    // Pen paths resize by scaling their structured anchors — snapshot them too.
    anchors: Array.isArray(node.anchors) ? node.anchors.map(cloneAnchor) : undefined,
  };
}

function cloneAnchor(a) {
  const c = { x: a.x, y: a.y };
  if (a.cin) c.cin = { x: a.cin.x, y: a.cin.y };
  if (a.cout) c.cout = { x: a.cout.x, y: a.cout.y };
  return c;
}

function updateResize(p, _e) {
  const { id, dir, origin, orig } = gesture;
  // Snap the dragged handle to the grid so the resized edge lands on a grid line.
  // Alt bypasses (matches move/draw).
  if (grid.isSnap() && !_e?.altKey) p = grid.snapPoint(p.x, p.y);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;

  // Multi-selection: scale every selected top node about the union anchor (canvas space).
  if (gesture.multi) {
    const { ids, snapshots, bbox } = gesture.multi;
    const { sx, sy, ax, ay } = computeScale(bbox, dir, dx, dy, _e?.shiftKey);
    mutate((root) => {
      for (const nid of ids) {
        const n = findNode(root, nid);
        const snap = snapshots.get(nid);
        if (!n || !snap) continue;
        // Restore pristine geometry, then scale this node about the canvas anchor.
        n.attrs = structuredClone(snap.attrs);
        n.transform = structuredClone(snap.transform);
        if (snap.children) n.children = structuredClone(snap.children);
        scaleSubtree(n, ax, ay, sx, sy);
      }
    });
    return;
  }

  // Group: scale the subtree geometry about the fixed anchor (see scaleSubtree).
  if (gesture.origSubtree && gesture.localBBox) {
    const { sx, sy, ax, ay } = computeScale(gesture.localBBox, dir, dx, dy, _e?.shiftKey);
    mutate((root) => {
      const n = findNode(root, id);
      if (!n || !n.children) return;
      // Rebuild children from the pristine snapshot each frame — scaling is destructive.
      n.children = structuredClone(gesture.origSubtree.children);
      for (const c of n.children) scaleSubtree(c, ax, ay, sx, sy);
    });
    return;
  }

  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    // Placed images keep their aspect ratio on corner drags by default; Shift
    // frees it (the inverse of shapes, matching Illustrator's placed images).
    if (n.type === "image") {
      const a = orig.attrs;
      const box = { x: a.x, y: a.y, width: a.width, height: a.height };
      const { sx, sy, ax, ay } = computeScale(box, dir, dx, dy, !_e?.shiftKey);
      n.attrs.x = ax + (a.x - ax) * sx;
      n.attrs.y = ay + (a.y - ay) * sy;
      n.attrs.width = a.width * sx;
      n.attrs.height = a.height * sy;
      return;
    }
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
  if (n.type === "rect" || n.type === "image") {
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
  } else if (n.type === "polyline") {
    // Scale points by ratio within the bbox.
    const pts = orig.attrs.points;
    if (!pts) return;
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
  } else if (n.type === "path" && Array.isArray(orig.anchors)) {
    // Pen path in shape mode: scale every anchor AND its bézier handles by the
    // box ratio, positioned within the anchors' local bbox (control points
    // included so the box matches the selection outline).
    const A = orig.anchors;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
    for (const a of A) { acc(a.x, a.y); if (a.cin) acc(a.cin.x, a.cin.y); if (a.cout) acc(a.cout.x, a.cout.y); }
    if (!isFinite(minX)) return;
    const bw = maxX - minX, bh = maxY - minY;
    const r = applyBox(minX, minY, bw, bh);
    const sx = bw ? r.w / bw : 1;
    const sy = bh ? r.h / bh : 1;
    const mapPt = (x, y) => ({ x: r.x + (x - minX) * sx, y: r.y + (y - minY) * sy });
    n.anchors = A.map((a) => {
      const na = mapPt(a.x, a.y);
      const out = { x: round2(na.x), y: round2(na.y) };
      if (a.cin) { const c = mapPt(a.cin.x, a.cin.y); out.cin = { x: round2(c.x), y: round2(c.y) }; }
      if (a.cout) { const c = mapPt(a.cout.x, a.cout.y); out.cout = { x: round2(c.x), y: round2(c.y) }; }
      return out;
    });
  }
  // Groups don't resize here — updateResize scales their subtree geometry directly
  // (see scaleSubtree) so the model stays translate+rotate only (no scale transform).
}

// --- Scale-by-baking (group & multi-selection resize) ---
//
// The transform model is deliberately rigid (translate + rotate only — import/export
// reject scale/shear). So resizing a container scales its CONTENTS by baking the factor
// into leaf geometry and child translates rather than adding a scale() transform.
//
// Scaling every point p about anchor A by S=diag(sx,sy) is the affine map
// p ↦ S·(p−A)+A. For a node that decomposes into: reposition its translate via the same
// formula, scale its own geometry about the local origin, and recurse into children about
// the local origin (0,0) — because a child's coords already live post-translate. This is
// exact for un-rotated subtrees (the common case) and for uniform scale under any rotation;
// non-uniform scale of a rotated subtree is approximated (geometry scales, angle is kept).
function scaleSubtree(node, ax, ay, sx, sy) {
  if (!node.transform) node.transform = emptyTransform();
  const t = node.transform;
  t.tx = ax + ((t.tx || 0) - ax) * sx;
  t.ty = ay + ((t.ty || 0) - ay) * sy;
  // Rotation pivot lives in this node's local space, which we scale about its origin.
  if (t.rot) { t.cx = (t.cx || 0) * sx; t.cy = (t.cy || 0) * sy; }
  scaleGeom(node, sx, sy);
  if (node.children) for (const c of node.children) scaleSubtree(c, 0, 0, sx, sy);
}

// Scale a single node's own geometry about its local origin (0,0). Radii/font that
// can't be non-uniform (circle r, text font-size) use the average factor.
function scaleGeom(node, sx, sy) {
  const a = node.attrs;
  const avg = (Math.abs(sx) + Math.abs(sy)) / 2;
  if (node.type === "rect" || node.type === "image") {
    a.x *= sx; a.y *= sy; a.width *= sx; a.height *= sy;
  } else if (node.type === "ellipse") {
    a.cx *= sx; a.cy *= sy; a.rx *= sx; a.ry *= sy;
  } else if (node.type === "circle") {
    a.cx *= sx; a.cy *= sy; a.r *= avg;
  } else if (node.type === "line") {
    a.x1 *= sx; a.y1 *= sy; a.x2 *= sx; a.y2 *= sy;
  } else if (node.type === "polyline" && Array.isArray(a.points)) {
    a.points = a.points.map(([x, y]) => [x * sx, y * sy]);
  } else if (node.type === "path" && Array.isArray(node.anchors)) {
    // Scale a pen path's structured anchors (+ handles) about the local origin.
    node.anchors = node.anchors.map((an) => {
      const out = { x: an.x * sx, y: an.y * sy };
      if (an.cin) out.cin = { x: an.cin.x * sx, y: an.cin.y * sy };
      if (an.cout) out.cout = { x: an.cout.x * sx, y: an.cout.y * sy };
      return out;
    });
  } else if (node.type === "text") {
    a.x *= sx; a.y *= sy;
    if (a["font-size"]) a["font-size"] *= avg;
  }
  // group: no own geometry — children are scaled by the scaleSubtree recursion.
}

// Derive (sx, sy) and the fixed anchor for a resize drag. bbox is the pre-drag box in
// the space the scale is applied in; dir is the handle ("nw".."se"); dx/dy the drag delta;
// shift locks aspect ratio on corner handles. Scale is clamped positive (no flip in v1).
function computeScale(bbox, dir, dx, dy, shift) {
  const west = dir.includes("w"), east = dir.includes("e");
  const north = dir.includes("n"), south = dir.includes("s");
  const { x, y, width: w, height: h } = bbox;
  // Anchor is the edge/corner OPPOSITE the one being dragged — it stays put.
  const ax = west ? x + w : east ? x : x + w / 2;
  const ay = north ? y + h : south ? y : y + h / 2;
  let nw = w, nh = h;
  if (east) nw = w + dx; else if (west) nw = w - dx;
  if (south) nh = h + dy; else if (north) nh = h - dy;
  let sx = (east || west) && w ? nw / w : 1;
  let sy = (north || south) && h ? nh / h : 1;
  // Corner + Shift: lock aspect ratio to the larger factor (Illustrator-style).
  if (shift && (east || west) && (north || south)) {
    const s = Math.max(Math.abs(sx), Math.abs(sy));
    sx = s; sy = s;
  }
  const MIN = 0.02;
  sx = Math.max(sx, MIN);
  sy = Math.max(sy, MIN);
  return { sx, sy, ax, ay };
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
    // Alt/Option held at pointerdown → rotate a duplicate, leaving the original
    // in place (Illustrator rotate-and-copy). Deferred to the drag threshold so a
    // click never spawns a copy — see beginRotatePayload().
    duplicate: !!(e && e.altKey),
    center: centerCanvas,
    localCx, localCy,
    startAngle: Math.atan2(p.y - centerCanvas.y, p.x - centerCanvas.x),
    originalRot: node.transform?.rot || 0,
  };
}

// Called from onPointerMove when a rotate drag first crosses the threshold. If
// Alt was held, clone the node in place and rotate the copy instead. The copy
// shares the original's geometry + transform, so the pivot (center / localCx /
// localCy / originalRot) captured in startRotate is still correct.
function beginRotatePayload() {
  const g = gesture;
  if (!g.duplicate) return;
  const doc = getDoc();
  const path = findPath(doc, g.id);
  if (!path || !path.length) return;
  const topId = path[0].id;
  let newTopId = null;
  mutate((root) => {
    const top = findNode(root, topId);
    if (!top) return;
    const copy = deepReId(top);
    root.children.push(copy);   // sits exactly atop the original
    newTopId = copy.id;
  });
  if (!newTopId) return;
  // The rotate handle targets the top-level node directly (single selection), so
  // retarget the gesture at the fresh copy.
  g.id = newTopId;
  setSelection([newTopId]);
}

function updateRotate(p, e) {
  const { id, center, startAngle, originalRot, localCx, localCy } = gesture;
  const ang = Math.atan2(p.y - center.y, p.x - center.x);
  const delta = (ang - startAngle) * 180 / Math.PI;
  let newRot = originalRot + delta;
  // Constrained rotation: Shift snaps the absolute angle to 22.5° increments;
  // add Ctrl/Cmd for 1° fine increments. Snapping the absolute (not the delta)
  // yields clean angles like 22.5°/45°/90° regardless of the starting rotation.
  if (e.shiftKey) {
    const step = (e.ctrlKey || e.metaKey) ? 1 : 22.5;
    newRot = Math.round(newRot / step) * step;
  }
  // Net angular change from the gesture start — replayed by "Transform Again".
  gesture.appliedDeg = newRot - originalRot;
  mutate((root) => {
    const n = findNode(root, id);
    if (!n) return;
    if (!n.transform) n.transform = emptyTransform();
    n.transform.rot = newRot;
    n.transform.cx = localCx;
    n.transform.cy = localCy;
  });
  showRotationReadout(newRot, p);
}

// --- "Transform Again" (Ctrl+D) — Illustrator step-and-repeat ---

// Replay the last committed move/rotate on the current selection, re-duplicating
// first when the recorded transform was itself a duplicate-drag (Ctrl-drag move
// or Alt-drag rotate). This turns Ctrl+D into a step-and-repeat: rotate-copy a
// spoke 15°, then Ctrl+D eleven more times for a radial burst. Returns false when
// no transform has been recorded yet, so the caller can fall back to a plain
// duplicate.
export function transformAgain() {
  const lt = lastTransform;
  if (!lt) return false;
  const sel = [...getSelection()];
  if (sel.length === 0) return true; // a transform exists, but nothing to act on

  const newIds = [];
  history.record(() => {
    mutate((root) => {
      // Unique top-level ancestors of the selection, kept in paint order.
      const topIds = new Set();
      for (const id of sel) {
        const path = findPath(root, id);
        if (path && path.length) topIds.add(path[0].id);
      }
      const targets = root.children.filter((c) => topIds.has(c.id));
      for (const src of targets) {
        let node = src;
        if (lt.duplicate) {
          node = deepReId(src);   // copy sits exactly atop its source
          root.children.push(node);
          newIds.push(node.id);
        }
        applyRecordedTransform(node, lt);
      }
    });
  });
  if (lt.duplicate && newIds.length) setSelection(newIds);
  return true;
}

// Re-apply a recorded transform to one node's transform in place. Move is a plain
// translate; rotate composes a rotation about the fixed canvas pivot P onto the
// node's existing translate+rotate (exact transform algebra, so the node both
// spins and orbits P correctly regardless of its current transform).
function applyRecordedTransform(node, lt) {
  if (!node.transform) node.transform = emptyTransform();
  const tr = node.transform;
  if (lt.kind === "move") {
    tr.tx = (tr.tx || 0) + lt.dx;
    tr.ty = (tr.ty || 0) + lt.dy;
    return;
  }
  if (lt.kind === "rotate") {
    const P = lt.pivot;
    const cx = tr.cx || 0, cy = tr.cy || 0;
    const tx = tr.tx || 0, ty = tr.ty || 0;
    const th = (lt.deg * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    // t' = Rot(deg)(c + t - P) + P - c   (see derivation: left-multiply the
    // existing translate+rotate by a rotation about P, keeping rotate-center c).
    const vx = cx + tx - P.x, vy = cy + ty - P.y;
    tr.tx = (cos * vx - sin * vy) + P.x - cx;
    tr.ty = (sin * vx + cos * vy) + P.y - cy;
    tr.rot = (tr.rot || 0) + lt.deg;
  }
}

// --- Rotation readout box (a tooltip that follows the handle during rotate) ---

let rotationReadoutEl = null;

function showRotationReadout(deg, p) {
  if (!rotationReadoutEl) {
    rotationReadoutEl = document.createElement("div");
    rotationReadoutEl.className = "rotation-readout";
    document.body.appendChild(rotationReadoutEl);
  }
  rotationReadoutEl.textContent = formatAngle(deg);
  const s = canvasToScreen(p);
  rotationReadoutEl.style.left = `${s.x + 16}px`;
  rotationReadoutEl.style.top = `${s.y + 16}px`;
}

function hideRotationReadout() {
  if (rotationReadoutEl) {
    try { rotationReadoutEl.remove(); } catch { /* already detached */ }
    rotationReadoutEl = null;
  }
}

// Normalize to [0, 360) and show at most one decimal (so 22.5° reads cleanly).
function formatAngle(deg) {
  let a = ((deg % 360) + 360) % 360;
  a = Math.round(a * 10) / 10;
  if (a === 360) a = 0;
  return `${a}°`;
}

function canvasToScreen(pt) {
  const ctm = canvasSvg.getScreenCTM();
  if (!ctm) return { x: pt.x, y: pt.y };
  const sp = canvasSvg.createSVGPoint();
  sp.x = pt.x; sp.y = pt.y;
  const r = sp.matrixTransform(ctm);
  return { x: r.x, y: r.y };
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

function round2(n) { return Math.round(n * 100) / 100; }

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
let editorHiddenEl = null; // rendered <text> hidden while its inline editor is open

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

  // Hide the rendered glyphs underneath so the live edit isn't drawn over the
  // stale rendered text (otherwise the two overlap until the next re-render).
  hideEditorTarget();

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
  // No label yet. A connector has no meaningful bbox center (its box spans the
  // gap between shapes), so center on the path midpoint in canvas → screen coords.
  if (node.type === "connector") {
    const geom = resolveConnector(node);
    const mid = connectorMidpoint(geom);
    const ctmS = svg.getScreenCTM();
    if (mid && ctmS) {
      const pt = svg.createSVGPoint(); pt.x = mid.x; pt.y = mid.y;
      const s = pt.matrixTransform(ctmS);
      return { ...base, left: `${s.x}px`, top: `${s.y}px` };
    }
  }
  // Otherwise center the editor over the shape itself.
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

// Hide the rendered element the editor is standing in for, so the overlay isn't
// drawn on top of stale glyphs. For a text node that's its own <text>; for a
// label it's the owned label <text> (a shape's own geometry stays visible).
function hideEditorTarget() {
  restoreEditorTarget();
  if (!editorTargetId) return;
  const layer = getDocLayer();
  if (!layer) return;
  let el = null;
  if (editorMode === "text-node") {
    el = layer.querySelector(`text[data-id="${cssEscape(editorTargetId)}"]`);
  } else if (editorMode === "label") {
    el = layer.querySelector(`text[data-role="label"][data-owner="${cssEscape(editorTargetId)}"]`);
  }
  if (el) {
    el.style.visibility = "hidden";
    editorHiddenEl = el;
  }
}

function restoreEditorTarget() {
  if (editorHiddenEl) {
    try { editorHiddenEl.style.visibility = ""; } catch { /* detached by a re-render */ }
    editorHiddenEl = null;
  }
}

function closeTextEditor() {
  if (editorEl) {
    try { editorEl.remove(); } catch { /* already detached */ }
  }
  restoreEditorTarget();
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
