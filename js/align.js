// Alignment + distribution operations.
// Nudges top-ancestor nodes via `transform.tx/ty` so it composes with existing
// rotations without baking coordinates. Single selection aligns to the canvas
// viewBox; multi-selection aligns to the union bbox of the selection.

import {
  getDoc, getSelection, mutate, findNode, findPath, emptyTransform,
} from "./state.js";
import { getDocLayer } from "./render.js";
import * as history from "./history.js";

const CANVAS = { x: 0, y: 0, width: 1000, height: 700 };

export function align(op) {
  const doc = getDoc();
  const canvasSvg = getDocLayer().ownerSVGElement;
  const topIds = topAncestorIds([...getSelection()], doc);
  if (topIds.length === 0) return;

  // Build a bbox descriptor for each top-selected node — in canvas (viewBox) coords.
  const items = [];
  for (const id of topIds) {
    const el = getDocLayer().querySelector(`[data-id="${cssEscape(id)}"]`);
    if (!el) continue;
    const bbox = elementBBoxInCanvas(el, canvasSvg);
    if (!bbox) continue;
    items.push({ id, bbox });
  }
  if (items.length === 0) return;

  const isDistribute = op === "dist-h" || op === "dist-v";
  if (isDistribute && items.length < 3) return;

  const ref = items.length === 1 ? CANVAS : unionBBox(items.map(i => i.bbox));

  // Compute per-item delta.
  const deltas = new Map(); // id -> {dx, dy}
  if (isDistribute) {
    computeDistributeDeltas(items, op, deltas);
  } else {
    for (const it of items) {
      const { dx, dy } = alignDelta(it.bbox, ref, op);
      deltas.set(it.id, { dx, dy });
    }
  }

  // Bail if every delta is effectively zero — nothing to record.
  let anyMove = false;
  for (const { dx, dy } of deltas.values()) {
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) { anyMove = true; break; }
  }
  if (!anyMove) return;

  history.record(() => {
    mutate((root) => {
      for (const [id, d] of deltas) {
        const n = findNode(root, id);
        if (!n) continue;
        if (!n.transform) n.transform = emptyTransform();
        n.transform.tx = (n.transform.tx || 0) + d.dx;
        n.transform.ty = (n.transform.ty || 0) + d.dy;
      }
    });
  });
}

function alignDelta(b, ref, op) {
  switch (op) {
    case "left":     return { dx: ref.x - b.x, dy: 0 };
    case "right":    return { dx: (ref.x + ref.width) - (b.x + b.width), dy: 0 };
    case "center-h": return { dx: (ref.x + ref.width / 2) - (b.x + b.width / 2), dy: 0 };
    case "top":      return { dx: 0, dy: ref.y - b.y };
    case "bottom":   return { dx: 0, dy: (ref.y + ref.height) - (b.y + b.height) };
    case "middle-v": return { dx: 0, dy: (ref.y + ref.height / 2) - (b.y + b.height / 2) };
  }
  return { dx: 0, dy: 0 };
}

// Distribute middle items so centers are equally spaced along the axis.
// Endpoints (min/max on the axis) stay put; interior items get repositioned.
function computeDistributeDeltas(items, op, deltas) {
  const axis = op === "dist-h" ? "x" : "y";
  const size = axis === "x" ? "width" : "height";
  // Sort by current center on the axis.
  const sorted = items
    .map(it => ({ ...it, center: it.bbox[axis] + it.bbox[size] / 2 }))
    .sort((a, b) => a.center - b.center);
  const first = sorted[0].center;
  const last = sorted[sorted.length - 1].center;
  const step = (last - first) / (sorted.length - 1);
  for (let i = 0; i < sorted.length; i++) {
    const target = first + step * i;
    const delta = target - sorted[i].center;
    deltas.set(sorted[i].id, axis === "x" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
  }
}

function unionBBox(bboxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Return the top-ancestor id for each selected id, deduplicated in doc order.
function topAncestorIds(ids, root) {
  const set = new Set();
  const order = [];
  for (const c of root.children) {
    for (const id of ids) {
      const path = findPath(root, id);
      if (!path || path.length === 0) continue;
      if (path[0].id === c.id && !set.has(c.id)) {
        set.add(c.id);
        order.push(c.id);
      }
    }
  }
  return order;
}

// AABB of an element's local getBBox() corners projected into the canvas viewBox.
// This transparently handles rotation via getCTM().
function elementBBoxInCanvas(el, canvasSvg) {
  try {
    const b = el.getBBox();
    // getCTM() maps local coords straight to the ancestor <svg>'s viewBox space.
    const ctmEl = el.getCTM();
    if (!ctmEl) return null;
    const corners = [
      [b.x, b.y], [b.x + b.width, b.y],
      [b.x, b.y + b.height], [b.x + b.width, b.y + b.height],
    ];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [lx, ly] of corners) {
      const pt = canvasSvg.createSVGPoint();
      pt.x = lx; pt.y = ly;
      const back = pt.matrixTransform(ctmEl);
      if (back.x < x1) x1 = back.x;
      if (back.y < y1) y1 = back.y;
      if (back.x > x2) x2 = back.x;
      if (back.y > y2) y2 = back.y;
    }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  } catch {
    return null;
  }
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
