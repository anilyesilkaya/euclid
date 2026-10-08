// Renders the doc tree into #doc-layer and selection chrome into #chrome-selection.
// Wipe-and-rebuild strategy: cheap at 100-500 nodes, avoids a whole class of diff bugs.
// Event listeners are delegated on #canvas, so losing per-element refs is fine.

import { getDoc, getSelection, findNode } from "./state.js";
import { routeStraight, routeOrthogonal, portNormal, dirOf } from "./connectors.js";
import { anchorsToPath, anchorsBBox, shapeToAnchors } from "./paths.js";
import { collectGradients, linearGradientElement, paintRef, PAINT_SLOTS } from "./paint.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 8;      // px in screen space (via non-scaling stroke + fixed size)
const ROT_STEM_LEN = 24;    // px in screen space

let docLayer, chromeHover, chromeSelection, chromeTransient, chromePorts, canvasSvg;

// Whether the Direct Selection tool (Illustrator's white arrow) is active. Gates
// the path-anchor chrome: a lone pen path shows editable anchors/handles only
// under Direct Selection, and the normal move/resize bbox under the plain
// Selection tool (black arrow). tools.js flips this on every tool change.
let directSelectMode = false;

// Set by tools.js when the active tool changes. Re-decides selection chrome for
// the current selection so switching Select ⇄ Direct Selection swaps a lone
// path between bbox handles and anchor/handle joints without a state mutation.
export function setDirectSelectMode(on) {
  const next = !!on;
  if (next === directSelectMode) return;
  directSelectMode = next;
  if (chromeSelection) renderSelection();
}

export function mount(svg) {
  canvasSvg = svg;
  docLayer = svg.querySelector("#doc-layer");
  const chrome = svg.querySelector("#chrome-layer");
  // Hover sits below selection so a selected shape's handles always draw on top.
  chromeHover = document.createElementNS(SVG_NS, "g");
  chromeHover.setAttribute("id", "chrome-hover");
  chromeSelection = document.createElementNS(SVG_NS, "g");
  chromeSelection.setAttribute("id", "chrome-selection");
  chromeTransient = document.createElementNS(SVG_NS, "g");
  chromeTransient.setAttribute("id", "chrome-transient");
  // Connector-tool connection points sit on top of everything.
  chromePorts = document.createElementNS(SVG_NS, "g");
  chromePorts.setAttribute("id", "chrome-ports");
  chrome.appendChild(chromeHover);
  chrome.appendChild(chromeSelection);
  chrome.appendChild(chromeTransient);
  chrome.appendChild(chromePorts);
}

export function getTransientLayer() { return chromeTransient; }
export function getDocLayer() { return docLayer; }

// --- Hover highlight (managed by tools.js on pointer move) ---
// Independent of the selection re-render so it never fights renderAll(). Mirrors
// the hovered element's transform and draws a thin outline around its local bbox.
export function setHoverOutline(id) {
  clearHoverOutline();
  if (!id) return;
  const el = docLayer.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (!el) return;
  const box = safeBBox(el);
  if (!(box.width > 0 || box.height > 0)) return;
  const wrap = document.createElementNS(SVG_NS, "g");
  const t = el.getAttribute("transform");
  if (t) wrap.setAttribute("transform", t);
  const outline = document.createElementNS(SVG_NS, "rect");
  outline.setAttribute("class", "hover-outline");
  outline.setAttribute("x", box.x);
  outline.setAttribute("y", box.y);
  outline.setAttribute("width", box.width);
  outline.setAttribute("height", box.height);
  wrap.appendChild(outline);
  chromeHover.appendChild(wrap);
}

export function clearHoverOutline() {
  if (!chromeHover) return;
  while (chromeHover.firstChild) chromeHover.removeChild(chromeHover.firstChild);
}

export function renderAll() {
  renderDoc();
  renderSelection();
}

function renderDoc() {
  while (docLayer.firstChild) docLayer.removeChild(docLayer.firstChild);
  const doc = getDoc();
  // Pass 0: gradient paint servers. Injected as a <defs> at the top of #doc-layer
  // so `fill="url(#eg-…)"` references (set by applyCommon) resolve on the live
  // canvas — render.js otherwise relies only on the static <defs> in index.html.
  renderGradientDefs(doc);
  // Pass 1: shapes/groups/text. Connectors are routed from their neighbours' live
  // canvas boxes, so they can only be measured once the shapes are in the DOM.
  const connectorNodes = [];
  for (const child of doc.children) {
    if (child.type === "connector") { connectorNodes.push(child); continue; }
    docLayer.appendChild(nodeToElement(child));
  }
  // Pass 2: connectors, now that every shape has a measurable box. A connector
  // with a label draws the edge plus a mid-edge <text> (a sibling, so it isn't
  // clipped by the thin line and stays hit-testable to the connector's id).
  for (const node of connectorNodes) {
    const geom = resolveConnector(node);
    if (!geom || !geom.valid) continue;
    docLayer.appendChild(connectorElement(node, geom));
    if (node.label) {
      const mid = connectorMidpoint(geom);
      if (mid) docLayer.appendChild(connectorLabelElement(node, mid));
    }
  }
}

// Inject a <defs> holding every gradient the document references. Rebuilt each
// render (cheap; ids are deterministic per node+slot) and prepended to #doc-layer.
function renderGradientDefs(doc) {
  const grads = collectGradients(doc);
  if (!grads.length) return;
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const g of grads) {
    const el = linearGradientElement(g.def, g.id);
    if (el) defs.appendChild(el);
  }
  docLayer.appendChild(defs);
}

// Build a connector element from already-resolved geometry. Orthogonal routes
// render as a <polyline> (multi-segment); straight routes as a <line>.
function connectorElement(node, geom) {
  const el = geom.points
    ? polylineConnector(geom.points)
    : lineConnector(geom);
  el.setAttribute("data-id", node.id);
  el.setAttribute("data-connector", "1");
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (v === undefined || v === null || v === "") continue;
    el.setAttribute(k, formatAttr(k, v));
  }
  if (node.arrowEnd) el.setAttribute("marker-end", "url(#arrow-end)");
  if (node.arrowStart) el.setAttribute("marker-start", "url(#arrow-start)");
  return el;
}

// Mid-edge label for a connector: a <text> centered on the path midpoint with a
// white halo (paint-order stroke) so it stays readable where it crosses the line.
// Carries the connector's id so clicking the label selects the connector.
function connectorLabelElement(node, mid) {
  const style = node.labelStyle || {};
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("data-id", node.id);
  t.setAttribute("data-role", "label");
  t.setAttribute("data-owner", node.id);
  t.setAttribute("x", round(mid.x));
  t.setAttribute("y", round(mid.y));
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "middle");
  t.setAttribute("font-family", style["font-family"] || "sans-serif");
  t.setAttribute("font-size", style["font-size"] || 16);
  t.setAttribute("fill", style.fill || "#000000");
  if (style["font-weight"]) t.setAttribute("font-weight", style["font-weight"]);
  if (style["font-style"]) t.setAttribute("font-style", style["font-style"]);
  t.setAttribute("stroke", "#ffffff");
  t.setAttribute("stroke-width", 3);
  t.setAttribute("stroke-linejoin", "round");
  t.setAttribute("paint-order", "stroke");
  t.textContent = node.label;
  return t;
}

// Point at half the path length of a resolved connector geometry — where the
// mid-edge label sits. Handles both straight ({x1,y1,x2,y2}) and orthogonal
// ({points}) routes. Exported so export.js positions labels identically.
export function connectorMidpoint(geom) {
  if (!geom) return null;
  if (geom.points) {
    const pts = geom.points;
    if (pts.length < 2) return null;
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
    let half = total / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      if (segLen >= half) {
        const f = segLen === 0 ? 0 : half / segLen;
        return { x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f };
      }
      half -= segLen;
    }
    const last = pts[pts.length - 1];
    return { x: last[0], y: last[1] };
  }
  if (typeof geom.x1 === "number") {
    return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
  }
  return null;
}

function lineConnector(geom) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", round(geom.x1));
  line.setAttribute("y1", round(geom.y1));
  line.setAttribute("x2", round(geom.x2));
  line.setAttribute("y2", round(geom.y2));
  return line;
}

function polylineConnector(points) {
  const pl = document.createElementNS(SVG_NS, "polyline");
  pl.setAttribute("points", points.map(([x, y]) => `${round(x)},${round(y)}`).join(" "));
  pl.setAttribute("fill", "none");
  return pl;
}

// Endpoint box lookup: an attached endpoint ({ref}) resolves to that shape's
// current canvas-space AABB; a free endpoint ({x,y}) resolves to a point.
// Routing mode is chosen by node.route ("orthogonal" → elbow, else straight).
export function resolveConnector(node) {
  const end = (e) => {
    if (e && e.ref != null) {
      const el = docLayer.querySelector(`[data-id="${cssEscape(e.ref)}"]`);
      if (!el) return { box: null, pt: null, missing: true };
      const bb = elementBBoxInCanvas(el);
      if (!bb) return { box: null, pt: null, missing: true };
      return { box: bb, pt: null, port: e.port ? portToCanvas(el, e.port) : null };
    }
    return { box: null, pt: e ? { x: e.x, y: e.y } : null };
  };
  const a = end(node.from);
  const b = end(node.to);
  if (a.missing || b.missing) return { valid: false };
  if (node.route === "orthogonal") {
    return routeOrthogonal(a.box, b.box, a.pt, b.pt, node.waypoints, a.port, b.port);
  }
  return routeStraight(a.box, b.box, a.pt, b.pt, a.port, b.port);
}

// The element whose geometry defines a shape's connection points: the shape
// itself, not a label wrapper (whose bbox would include the label text).
function portElement(el) {
  return el.getAttribute("data-wrapper") === "label" && el.firstElementChild ? el.firstElementChild : el;
}

// Canvas-space {x, y, dir} of a port ({x, y} fractions of the shape's local
// bbox). dir is the canvas compass direction the port faces, so it follows rotation.
export function portToCanvas(el, port) {
  const shape = portElement(el);
  const b = safeBBox(shape);
  const M = localToCanvasMatrix(shape);
  if (!M) return null;
  const pt = canvasSvg.createSVGPoint();
  pt.x = b.x + port.x * b.width;
  pt.y = b.y + port.y * b.height;
  const q = pt.matrixTransform(M);
  const n = portNormal(port);
  const dir = dirOf({ x: M.a * n.x + M.c * n.y, y: M.b * n.x + M.d * n.y });
  return { x: q.x, y: q.y, dir };
}

// --- Connection-point hints (managed by tools.js while the Connector tool is active) ---
// `points` are canvas-space {x, y}; `active` is the index of the snapped point, or -1.
export function setPortHints(points, active = -1) {
  clearPortHints();
  const r = 4 * canvasPixelScale();
  points.forEach((p, i) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", i === active ? "port-hint active" : "port-hint");
    c.setAttribute("cx", p.x);
    c.setAttribute("cy", p.y);
    c.setAttribute("r", i === active ? r * 1.5 : r);
    chromePorts.appendChild(c);
  });
}

export function clearPortHints() {
  if (!chromePorts) return;
  while (chromePorts.firstChild) chromePorts.removeChild(chromePorts.firstChild);
}

function nodeToElement(node) {
  if (node.type === "group") {
    const g = document.createElementNS(SVG_NS, "g");
    applyCommon(g, node);
    for (const child of node.children) g.appendChild(nodeToElement(child));
    if (node.label) g.appendChild(labelElement(node, bboxOfGroupChildren(node)));
    return g;
  }
  if (node.type === "text") {
    const el = document.createElementNS(SVG_NS, "text");
    applyCommon(el, node);
    el.textContent = node.text ?? "";
    return el;
  }
  const el = document.createElementNS(SVG_NS, node.type);
  applyCommon(el, node);
  // Shape with a label: wrap into an implicit <g> so both stay clickable as a unit.
  if (node.label) {
    const wrap = document.createElementNS(SVG_NS, "g");
    wrap.setAttribute("data-id", node.id);
    wrap.setAttribute("data-wrapper", "label");
    // Move the node's transform onto the wrapper so the shape AND its label
    // translate/rotate together. The label is positioned in the shape's *local*
    // (pre-transform) coords, so the transform has to live on their common parent
    // — and must NOT also stay on the inner shape, or it'd be applied twice.
    const tstr = transformToString(node.transform);
    if (tstr) {
      wrap.setAttribute("transform", tstr);
      el.removeAttribute("transform");
    }
    // The shape carries its own data-id; that's fine — hit-test walks up until it finds one.
    wrap.appendChild(el);
    wrap.appendChild(labelElement(node, localBBoxOfShapeNode(node)));
    return wrap;
  }
  return el;
}

function labelElement(ownerNode, bbox) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("data-role", "label");
  t.setAttribute("data-owner", ownerNode.id);
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  t.setAttribute("x", round(cx));
  t.setAttribute("y", round(cy));
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "middle");
  t.setAttribute("font-family", ownerNode.labelStyle?.["font-family"] || "sans-serif");
  t.setAttribute("font-size", ownerNode.labelStyle?.["font-size"] || 16);
  t.setAttribute("fill", ownerNode.labelStyle?.fill || "#000000");
  if (ownerNode.labelStyle?.["font-weight"]) t.setAttribute("font-weight", ownerNode.labelStyle["font-weight"]);
  if (ownerNode.labelStyle?.["font-style"]) t.setAttribute("font-style", ownerNode.labelStyle["font-style"]);
  t.setAttribute("pointer-events", "none");
  t.textContent = ownerNode.label;
  return t;
}

// Local bbox of a shape node computed from its own attrs (no DOM).
function localBBoxOfShapeNode(node) {
  const a = node.attrs;
  if (node.type === "rect" || node.type === "image") return { x: a.x, y: a.y, width: a.width, height: a.height };
  if (node.type === "circle") return { x: a.cx - a.r, y: a.cy - a.r, width: a.r * 2, height: a.r * 2 };
  if (node.type === "ellipse") return { x: a.cx - a.rx, y: a.cy - a.ry, width: a.rx * 2, height: a.ry * 2 };
  if (node.type === "line") {
    const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
    return { x, y, width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1) };
  }
  if (node.type === "polyline" && Array.isArray(a.points) && a.points.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of a.points) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (node.type === "path" && Array.isArray(node.anchors) && node.anchors.length) {
    return anchorsBBox(node.anchors);
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

function bboxOfGroupChildren(group) {
  // Union of child local bboxes; child transforms are applied to their local coords via translate only for centering.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function rec(node) {
    const tx = node.transform?.tx || 0;
    const ty = node.transform?.ty || 0;
    if (node.type === "group") {
      if (!node.children) return;
      for (const c of node.children) rec(c);
      return;
    }
    let b;
    if (node.type === "text") {
      // No reliable pre-render bbox for text; approximate width from string length * font-size * 0.6.
      const size = node.attrs["font-size"] || 16;
      const w = String(node.text || "").length * size * 0.6;
      b = { x: node.attrs.x, y: node.attrs.y - size, width: w, height: size * 1.2 };
    } else {
      b = localBBoxOfShapeNode(node);
    }
    const x1 = b.x + tx, y1 = b.y + ty, x2 = x1 + b.width, y2 = y1 + b.height;
    if (x1 < minX) minX = x1; if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2; if (y2 > maxY) maxY = y2;
  }
  if (group.children) for (const c of group.children) rec(c);
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function applyCommon(el, node) {
  el.setAttribute("data-id", node.id);
  // Pen-drawn paths derive their `d` from the structured anchor model; any stored
  // attrs.d is stale, so skip it and emit the freshly computed geometry instead.
  const derivedD = node.type === "path" && Array.isArray(node.anchors)
    ? anchorsToPath(node.anchors, node.closed, node.cornerRadius || 0)
    : null;
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "d" && derivedD !== null) continue;
    // A gradient in this paint slot overrides the stored solid color.
    if ((k === "fill" || k === "stroke") && paintRef(node, k)) continue;
    el.setAttribute(k, formatAttr(k, v));
  }
  if (derivedD !== null) el.setAttribute("d", derivedD);
  // Apply gradient paint refs (fill/stroke) synthesized from node.gradients.
  for (const slot of PAINT_SLOTS) {
    const ref = paintRef(node, slot);
    if (ref) el.setAttribute(slot, ref);
  }
  const t = transformToString(node.transform);
  if (t) el.setAttribute("transform", t);
}

function formatAttr(k, v) {
  if (k === "points" && Array.isArray(v)) {
    return v.map(p => `${round(p[0])},${round(p[1])}`).join(" ");
  }
  if (typeof v === "number") return round(v);
  return String(v);
}

export function transformToString(t) {
  if (!t) return "";
  const parts = [];
  if (t.tx || t.ty) parts.push(`translate(${round(t.tx)},${round(t.ty)})`);
  if (t.rot) parts.push(`rotate(${round(t.rot)},${round(t.cx)},${round(t.cy)})`);
  return parts.join(" ");
}

function round(n) {
  if (typeof n !== "number") return n;
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1000) / 1000;
}

// --- Selection chrome ---

function renderSelection() {
  while (chromeSelection.firstChild) chromeSelection.removeChild(chromeSelection.firstChild);
  const sel = getSelection();
  if (sel.size === 0) return;

  const boxes = [];
  for (const id of sel) {
    const el = docLayer.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (!el) continue;
    // Compute local (unrotated) bbox and the transform we should mirror onto the chrome.
    boxes.push({ id, el, box: safeBBox(el) });
  }
  if (boxes.length === 0) return;

  // A lone selected connector gets a highlight overlay, not box/handles — its
  // geometry is derived, so resize/rotate/move handles would be meaningless.
  if (boxes.length === 1 && boxes[0].el.hasAttribute("data-connector")) {
    drawConnectorSelection(boxes[0].id, boxes[0].el);
    return;
  }

  // Under the Direct Selection tool (the white arrow), a lone selected object
  // shows direct node-editing chrome — a draggable joint at every anchor, plus
  // bézier-handle points on smooth anchors — instead of the move/resize bbox.
  // Pen paths use their stored anchors; primitive shapes (rect / ellipse / circle
  // / line / polyline) derive anchors on the fly (shapeToAnchors) so they get
  // joints too — Illustrator converts the primitive to a real path only once you
  // actually drag a joint (handled in tools.js). "Shape mode" paths (Convert to
  // shape) opt out and keep the bbox chrome so they resize/rotate like a rect.
  if (boxes.length === 1 && directSelectMode) {
    const node = findNode(getDoc(), boxes[0].id);
    const editable = anchorsForEditing(node);
    if (editable) {
      drawPathSelection(boxes[0], editable);
      return;
    }
  }

  // For a single selection: render tight rotated outline + 8 resize handles + rotate handle.
  // For multi-selection: render union AABB (in canvas space) + 8 resize handles, no rotate.
  if (boxes.length === 1) {
    drawSingleSelectionChrome(boxes[0]);
  } else {
    drawMultiSelectionChrome(boxes);
  }
}

const WAYPOINT_MIN_SEG = 12; // canvas units — don't offer an add-handle on a tiny leg

function drawConnectorSelection(id, el) {
  // Mirror the connector's own element type so the highlight traces every leg
  // of an orthogonal route, not just its endpoints.
  const isPolyline = el.tagName.toLowerCase() === "polyline";
  const overlay = document.createElementNS(SVG_NS, isPolyline ? "polyline" : "line");
  overlay.setAttribute("class", "connector-selected");
  if (isPolyline) {
    overlay.setAttribute("points", el.getAttribute("points"));
    overlay.setAttribute("fill", "none");
  } else {
    overlay.setAttribute("x1", el.getAttribute("x1"));
    overlay.setAttribute("y1", el.getAttribute("y1"));
    overlay.setAttribute("x2", el.getAttribute("x2"));
    overlay.setAttribute("y2", el.getAttribute("y2"));
  }
  chromeSelection.appendChild(overlay);

  // Orthogonal connectors get editable waypoint handles: a solid square at each
  // stored waypoint (drag to move, double-click to delete) and a hollow circle
  // at each segment midpoint (drag to bend — inserts a new waypoint).
  const node = findNode(getDoc(), id);
  if (!node || node.route !== "orthogonal") return;
  const geom = resolveConnector(node);
  if (!geom || !geom.valid || !geom.points) return;
  const scale = canvasPixelScale();
  const hs = HANDLE_SIZE * scale;

  // Stored-waypoint move handles.
  const wps = Array.isArray(node.waypoints) ? node.waypoints : [];
  wps.forEach((w, i) => {
    if (!w || !isFinite(w.x) || !isFinite(w.y)) return;
    const h = document.createElementNS(SVG_NS, "rect");
    h.setAttribute("class", "waypoint-handle");
    h.setAttribute("data-role", "waypoint");
    h.setAttribute("data-id", id);
    h.setAttribute("data-index", i);
    h.setAttribute("x", w.x - hs / 2);
    h.setAttribute("y", w.y - hs / 2);
    h.setAttribute("width", hs);
    h.setAttribute("height", hs);
    chromeSelection.appendChild(h);
  });

  // Segment-midpoint add handles.
  const pts = geom.points;
  const segInsert = geom.segInsert || [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (Math.hypot(x2 - x1, y2 - y1) < WAYPOINT_MIN_SEG) continue;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", "waypoint-add-handle");
    c.setAttribute("data-role", "waypoint-add");
    c.setAttribute("data-id", id);
    c.setAttribute("data-insert", segInsert[i] ?? wps.length);
    c.setAttribute("cx", mx);
    c.setAttribute("cy", my);
    c.setAttribute("r", hs / 2);
    chromeSelection.appendChild(c);
  }
}

// What to show joints for under Direct Selection, or null if the node isn't
// anchor-editable. Returns { anchors, closed, cornerRadius } so the chrome can
// trace the outline from anchors (a primitive's element has no `d` to borrow).
// Pen paths (not in shape mode) expose their stored anchors; primitive shapes
// derive a transient anchor list so they get joints too.
function anchorsForEditing(node) {
  if (!node) return null;
  if (node.type === "path" && Array.isArray(node.anchors) && node.anchors.length && !node.shapeMode) {
    return { anchors: node.anchors, closed: !!node.closed, cornerRadius: node.cornerRadius || 0 };
  }
  return shapeToAnchors(node);
}

// Direct node-editing chrome for a path/shape: control lines + round bézier-handle
// points for smooth anchors, and a square handle at every anchor. All live in the
// node's LOCAL space (same space as the anchors), so the chrome group mirrors the
// element's transform — dragging then converts pointer→local via that matrix.
function drawPathSelection({ id, el }, editable) {
  const { anchors, closed, cornerRadius } = editable;
  const wrap = document.createElementNS(SVG_NS, "g");
  wrap.setAttribute("data-role", "path-edit");
  wrap.setAttribute("data-id", id);
  const t = el.getAttribute("transform");
  if (t) wrap.setAttribute("transform", t);
  chromeSelection.appendChild(wrap);

  // Trace the outline as a highlight, in local space. Derived from the anchors
  // (not the element's `d`) so a primitive shape — whose <rect>/<ellipse>/<line>
  // element has no `d` — still gets a traced outline.
  const outline = document.createElementNS(SVG_NS, "path");
  outline.setAttribute("class", "connector-selected");
  outline.setAttribute("d", anchorsToPath(anchors, closed, cornerRadius));
  outline.setAttribute("fill", "none");
  wrap.appendChild(outline);

  const scale = pixelScaleOf(el);
  const hs = HANDLE_SIZE * scale;

  // Bézier control handles first (so anchor squares paint on top).
  anchors.forEach((a, i) => {
    if (!a) return;
    for (const which of ["cin", "cout"]) {
      const c = a[which];
      if (!c || !isFinite(c.x) || !isFinite(c.y)) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "path-ctrl-line");
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", c.x); line.setAttribute("y2", c.y);
      wrap.appendChild(line);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "path-ctrl-handle");
      dot.setAttribute("data-role", "path-handle");
      dot.setAttribute("data-id", id);
      dot.setAttribute("data-index", i);
      dot.setAttribute("data-which", which === "cin" ? "in" : "out");
      dot.setAttribute("cx", c.x);
      dot.setAttribute("cy", c.y);
      dot.setAttribute("r", hs / 2);
      wrap.appendChild(dot);
    }
  });

  // Anchor squares.
  anchors.forEach((a, i) => {
    if (!a || !isFinite(a.x) || !isFinite(a.y)) return;
    const h = document.createElementNS(SVG_NS, "rect");
    h.setAttribute("class", "path-anchor-handle");
    h.setAttribute("data-role", "path-anchor");
    h.setAttribute("data-id", id);
    h.setAttribute("data-index", i);
    h.setAttribute("x", a.x - hs / 2);
    h.setAttribute("y", a.y - hs / 2);
    h.setAttribute("width", hs);
    h.setAttribute("height", hs);
    wrap.appendChild(h);
  });
}

function drawSingleSelectionChrome({ id, el, box }) {
  const wrap = document.createElementNS(SVG_NS, "g");
  wrap.setAttribute("data-role", "selection");
  wrap.setAttribute("data-id", id);
  // Mirror the element's own transform on the chrome, so handles rotate with the shape.
  const t = el.getAttribute("transform");
  if (t) wrap.setAttribute("transform", t);

  const outline = document.createElementNS(SVG_NS, "rect");
  outline.setAttribute("class", "selection-outline");
  outline.setAttribute("x", box.x);
  outline.setAttribute("y", box.y);
  outline.setAttribute("width", box.width);
  outline.setAttribute("height", box.height);
  wrap.appendChild(outline);

  // Screen-space size for handles: scale from screen to local units at this CTM.
  const scale = pixelScaleOf(el);
  const hs = HANDLE_SIZE * scale;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const positions = [
    ["nw", box.x, box.y],
    ["n",  cx,    box.y],
    ["ne", box.x + box.width, box.y],
    ["e",  box.x + box.width, cy],
    ["se", box.x + box.width, box.y + box.height],
    ["s",  cx,    box.y + box.height],
    ["sw", box.x, box.y + box.height],
    ["w",  box.x, cy],
  ];
  for (const [dir, px, py] of positions) {
    const h = document.createElementNS(SVG_NS, "rect");
    h.setAttribute("class", `handle ${dir}`);
    h.setAttribute("data-role", "resize");
    h.setAttribute("data-handle", dir);
    h.setAttribute("data-id", id);
    h.setAttribute("x", px - hs / 2);
    h.setAttribute("y", py - hs / 2);
    h.setAttribute("width", hs);
    h.setAttribute("height", hs);
    wrap.appendChild(h);
  }

  // Rotation stem + handle above top-center.
  const rotY = box.y - ROT_STEM_LEN * scale;
  const stem = document.createElementNS(SVG_NS, "line");
  stem.setAttribute("class", "rot-stem");
  stem.setAttribute("x1", cx);
  stem.setAttribute("y1", box.y);
  stem.setAttribute("x2", cx);
  stem.setAttribute("y2", rotY);
  wrap.appendChild(stem);

  const rot = document.createElementNS(SVG_NS, "circle");
  rot.setAttribute("class", "rot-handle");
  rot.setAttribute("data-role", "rotate");
  rot.setAttribute("data-id", id);
  rot.setAttribute("cx", cx);
  rot.setAttribute("cy", rotY);
  rot.setAttribute("r", hs / 2);
  wrap.appendChild(rot);

  chromeSelection.appendChild(wrap);
}

function drawMultiSelectionChrome(boxes) {
  // Union AABB in canvas (viewBox) coordinates from each element's local bbox corners.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { el, box } of boxes) {
    const corners = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ];
    for (const [lx, ly] of corners) {
      // Transform local -> canvas viewBox user units (see localToCanvasMatrix).
      const p = localToCanvas(el, lx, ly);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return;

  const wrap = document.createElementNS(SVG_NS, "g");
  wrap.setAttribute("data-role", "selection-multi");

  const w = maxX - minX;
  const h = maxY - minY;
  const outline = document.createElementNS(SVG_NS, "rect");
  outline.setAttribute("class", "selection-outline");
  outline.setAttribute("x", minX);
  outline.setAttribute("y", minY);
  outline.setAttribute("width", w);
  outline.setAttribute("height", h);
  wrap.appendChild(outline);

  // 8 functional resize handles, in canvas (viewBox) space. The multi chrome carries
  // no transform, so handles are sized in canvas units scaled to a fixed screen pixel size.
  const hs = HANDLE_SIZE * canvasPixelScale();
  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const positions = [
    ["nw", minX, minY], ["n", cx, minY], ["ne", maxX, minY],
    ["e", maxX, cy], ["se", maxX, maxY], ["s", cx, maxY],
    ["sw", minX, maxY], ["w", minX, cy],
  ];
  for (const [dir, px, py] of positions) {
    const hnd = document.createElementNS(SVG_NS, "rect");
    hnd.setAttribute("class", `handle ${dir}`);
    hnd.setAttribute("data-role", "resize-multi");
    hnd.setAttribute("data-handle", dir);
    hnd.setAttribute("x", px - hs / 2);
    hnd.setAttribute("y", py - hs / 2);
    hnd.setAttribute("width", hs);
    hnd.setAttribute("height", hs);
    wrap.appendChild(hnd);
  }
  chromeSelection.appendChild(wrap);
}

// Canvas (viewBox) units per screen pixel at the root — for sizing chrome that
// lives directly in canvas space (no element transform to mirror).
export function canvasPixelScale() {
  const ctm = canvasSvg.getScreenCTM();
  if (!ctm) return 1;
  const sx = Math.hypot(ctm.a, ctm.b);
  return sx > 0 ? 1 / sx : 1;
}

function safeBBox(el) {
  try {
    return el.getBBox();
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

// Matrix mapping `el`'s local coords → canvas viewBox *user units*.
// NOTE: deliberately NOT el.getCTM(). getCTM() targets the SVG *viewport*
// (rendered pixels), so it folds in the viewBox→viewport scale and the
// preserveAspectRatio letterbox offset. Feeding that output back into the
// chrome/doc layers (which live in user-unit space) double-applies the viewBox
// transform — guides, marquee AABBs, etc. then render scaled + offset. Composing
// the relative screen CTMs cancels the shared viewport transform exactly.
export function localToCanvasMatrix(el) {
  const svgScreen = canvasSvg.getScreenCTM();
  const elScreen = el.getScreenCTM();
  if (!svgScreen || !elScreen) return null;
  return svgScreen.inverse().multiply(elScreen);
}

// AABB of el's local getBBox() projected into canvas viewBox coords. Honors any
// translate/rotate on the element. Returns both {x1,y1,x2,y2} and
// {x,y,width,height} so every caller's preferred shape works. Null if unmeasurable.
export function elementBBoxInCanvas(el) {
  let b;
  try { b = el.getBBox(); } catch { return null; }
  const M = localToCanvasMatrix(el);
  if (!M) return null;
  const corners = [
    [b.x, b.y], [b.x + b.width, b.y],
    [b.x, b.y + b.height], [b.x + b.width, b.y + b.height],
  ];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [lx, ly] of corners) {
    const pt = canvasSvg.createSVGPoint();
    pt.x = lx; pt.y = ly;
    const q = pt.matrixTransform(M);
    if (q.x < x1) x1 = q.x;
    if (q.y < y1) y1 = q.y;
    if (q.x > x2) x2 = q.x;
    if (q.y > y2) y2 = q.y;
  }
  return { x1, y1, x2, y2, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// Convert a local point on `el` to canvas (viewBox) coords.
function localToCanvas(el, x, y) {
  const pt = canvasSvg.createSVGPoint();
  pt.x = x; pt.y = y;
  const M = localToCanvasMatrix(el);
  if (!M) return { x, y };
  const back = pt.matrixTransform(M);
  return { x: back.x, y: back.y };
}

// Approx local-units per screen-pixel at `el` — used to keep handles visually screen-sized.
function pixelScaleOf(el) {
  const ctm = el.getScreenCTM();
  if (!ctm) return 1;
  // 1 px in screen X ≈ 1 / a local units per screen px (assuming no shear).
  const sx = Math.hypot(ctm.a, ctm.b);
  return sx > 0 ? 1 / sx : 1;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

// Canvas coord conversion helper — one place, used by tools.js too.
export function toCanvasPoint(evt) {
  const pt = canvasSvg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = canvasSvg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

// Same, but converted to a target element's local coordinate system.
export function toLocalPoint(evt, el) {
  const pt = canvasSvg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = el.getScreenCTM();
  if (!ctm) return toCanvasPoint(evt);
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}
