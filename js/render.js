// Renders the doc tree into #doc-layer and selection chrome into #chrome-selection.
// Wipe-and-rebuild strategy: cheap at 100-500 nodes, avoids a whole class of diff bugs.
// Event listeners are delegated on #canvas, so losing per-element refs is fine.

import { getDoc, getSelection } from "./state.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 8;      // px in screen space (via non-scaling stroke + fixed size)
const ROT_STEM_LEN = 24;    // px in screen space

let docLayer, chromeHover, chromeSelection, chromeTransient, canvasSvg;

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
  chrome.appendChild(chromeHover);
  chrome.appendChild(chromeSelection);
  chrome.appendChild(chromeTransient);
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
  for (const child of doc.children) {
    docLayer.appendChild(nodeToElement(child));
  }
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
  t.setAttribute("pointer-events", "none");
  t.textContent = ownerNode.label;
  return t;
}

// Local bbox of a shape node computed from its own attrs (no DOM).
function localBBoxOfShapeNode(node) {
  const a = node.attrs;
  if (node.type === "rect") return { x: a.x, y: a.y, width: a.width, height: a.height };
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
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === undefined || v === null || v === "") continue;
    el.setAttribute(k, formatAttr(k, v));
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

  // For a single selection: render tight rotated outline + 8 resize handles + rotate handle.
  // For multi-selection: render union AABB (in canvas space) + 8 resize handles, no rotate.
  if (boxes.length === 1) {
    drawSingleSelectionChrome(boxes[0]);
  } else {
    drawMultiSelectionChrome(boxes);
  }
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

  const outline = document.createElementNS(SVG_NS, "rect");
  outline.setAttribute("class", "selection-outline");
  outline.setAttribute("x", minX);
  outline.setAttribute("y", minY);
  outline.setAttribute("width", maxX - minX);
  outline.setAttribute("height", maxY - minY);
  wrap.appendChild(outline);

  // Handles in canvas space; multi-selection resize is deferred to a group-move-only interaction in v1.
  // We still show corner handles for future use, but tools only wire the move gesture on the outline itself.
  chromeSelection.appendChild(wrap);
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
