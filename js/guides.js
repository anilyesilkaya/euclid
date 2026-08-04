// Smart alignment guides. During a move gesture we snap the moving bbox's edges and
// centers to the same lines on stationary objects (and the canvas viewBox), then draw
// dashed connectors on the transient chrome layer. Style mirrors PowerPoint / Figma.

import { getTransientLayer } from "./render.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const CLASS = "align-guide";
const TICK_CLASS = "align-tick";
const TICK_HALF = 4; // canvas units; small crosshair at each aligning center

// Index 1 is the center of a bbox; 0/2 are the edges.
const LINE_KIND = ["edge", "center", "edge"];

function xLines(b) { return [b.x, b.x + b.width / 2, b.x + b.width]; }
function yLines(b) { return [b.y, b.y + b.height / 2, b.y + b.height]; }

// movingBBox and each stationaryBBoxes / canvasBBox use {x, y, width, height} in canvas coords.
// Returns snap deltas plus the guide lines to draw at the snapped position.
export function computeSnap({ movingBBox, stationaryBBoxes, canvasBBox, threshold }) {
  if (!movingBBox) return { dx: 0, dy: 0, guides: [] };
  const candidates = stationaryBBoxes.map(b => ({ ...b, _isCanvas: false }));
  if (canvasBBox) candidates.push({ ...canvasBBox, _isCanvas: true });

  const movXs = xLines(movingBBox);
  const movYs = yLines(movingBBox);

  // Prefer center-to-center snaps over edge snaps at the same distance so
  // that when both are within threshold, the guide clearly reads as centered.
  let bestX = null;
  let bestY = null;
  const scoreX = (dist, kindPair) => dist - (kindPair === "center-center" ? 1e-6 : 0);
  for (const sb of candidates) {
    const sxs = xLines(sb);
    for (let mi = 0; mi < 3; mi++) {
      for (let si = 0; si < 3; si++) {
        const delta = sxs[si] - movXs[mi];
        const dist = Math.abs(delta);
        if (dist > threshold) continue;
        const kindPair = `${LINE_KIND[mi]}-${LINE_KIND[si]}`;
        const score = scoreX(dist, kindPair);
        if (bestX === null || score < bestX.score) {
          bestX = { delta, score };
        }
      }
    }
    const sys = yLines(sb);
    for (let mi = 0; mi < 3; mi++) {
      for (let si = 0; si < 3; si++) {
        const delta = sys[si] - movYs[mi];
        const dist = Math.abs(delta);
        if (dist > threshold) continue;
        const kindPair = `${LINE_KIND[mi]}-${LINE_KIND[si]}`;
        const score = scoreX(dist, kindPair);
        if (bestY === null || score < bestY.score) {
          bestY = { delta, score };
        }
      }
    }
  }

  const dx = bestX ? bestX.delta : 0;
  const dy = bestY ? bestY.delta : 0;

  const snapped = { x: movingBBox.x + dx, y: movingBBox.y + dy, width: movingBBox.width, height: movingBBox.height };
  const guides = [];
  const EPS = 0.5;

  const snapXs = xLines(snapped);
  const snapYs = yLines(snapped);

  for (const sb of candidates) {
    const sxs = xLines(sb);
    for (let mi = 0; mi < 3; mi++) {
      const mx = snapXs[mi];
      for (let si = 0; si < 3; si++) {
        const sx = sxs[si];
        if (Math.abs(mx - sx) >= EPS) continue;
        const kind = (LINE_KIND[mi] === "center" && LINE_KIND[si] === "center") ? "center" : "edge";
        const y1 = sb._isCanvas ? snapped.y : Math.min(snapped.y, sb.y);
        const y2 = sb._isCanvas
          ? snapped.y + snapped.height
          : Math.max(snapped.y + snapped.height, sb.y + sb.height);
        const g = { orient: "v", kind, x: sx, y1, y2 };
        if (kind === "center") {
          g.centers = [
            { x: sx, y: snapped.y + snapped.height / 2 },
            ...(sb._isCanvas ? [] : [{ x: sx, y: sb.y + sb.height / 2 }]),
          ];
        }
        guides.push(g);
      }
    }
    const sys = yLines(sb);
    for (let mi = 0; mi < 3; mi++) {
      const my = snapYs[mi];
      for (let si = 0; si < 3; si++) {
        const sy = sys[si];
        if (Math.abs(my - sy) >= EPS) continue;
        const kind = (LINE_KIND[mi] === "center" && LINE_KIND[si] === "center") ? "center" : "edge";
        const x1 = sb._isCanvas ? snapped.x : Math.min(snapped.x, sb.x);
        const x2 = sb._isCanvas
          ? snapped.x + snapped.width
          : Math.max(snapped.x + snapped.width, sb.x + sb.width);
        const g = { orient: "h", kind, y: sy, x1, x2 };
        if (kind === "center") {
          g.centers = [
            { x: snapped.x + snapped.width / 2, y: sy },
            ...(sb._isCanvas ? [] : [{ x: sb.x + sb.width / 2, y: sy }]),
          ];
        }
        guides.push(g);
      }
    }
  }

  return { dx, dy, guides: dedupGuides(guides) };
}

function dedupGuides(guides) {
  // Prefer center guides over edge guides at the same coordinate.
  const byKey = new Map();
  for (const g of guides) {
    const key = g.orient === "v"
      ? `v:${r(g.x)}:${r(g.y1)}:${r(g.y2)}`
      : `h:${r(g.y)}:${r(g.x1)}:${r(g.x2)}`;
    const prev = byKey.get(key);
    if (!prev || (g.kind === "center" && prev.kind !== "center")) {
      byKey.set(key, g);
    }
  }
  return [...byKey.values()];
}
function r(n) { return Math.round(n * 100) / 100; }

export function drawGuides(guides) {
  clearGuides();
  const layer = getTransientLayer();
  for (const g of guides) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", `${CLASS} ${g.kind === "center" ? "center" : "edge"}`);
    if (g.orient === "v") {
      line.setAttribute("x1", g.x);
      line.setAttribute("y1", g.y1);
      line.setAttribute("x2", g.x);
      line.setAttribute("y2", g.y2);
    } else {
      line.setAttribute("x1", g.x1);
      line.setAttribute("y1", g.y);
      line.setAttribute("x2", g.x2);
      line.setAttribute("y2", g.y);
    }
    layer.appendChild(line);

    if (g.kind === "center" && g.centers) {
      for (const c of g.centers) layer.appendChild(centerTick(c.x, c.y));
    }
  }
}

function centerTick(cx, cy) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", TICK_CLASS);
  const h = document.createElementNS(SVG_NS, "line");
  h.setAttribute("x1", cx - TICK_HALF); h.setAttribute("y1", cy);
  h.setAttribute("x2", cx + TICK_HALF); h.setAttribute("y2", cy);
  const v = document.createElementNS(SVG_NS, "line");
  v.setAttribute("x1", cx); v.setAttribute("y1", cy - TICK_HALF);
  v.setAttribute("x2", cx); v.setAttribute("y2", cy + TICK_HALF);
  g.appendChild(h); g.appendChild(v);
  return g;
}

export function clearGuides() {
  const layer = getTransientLayer();
  const olds = layer.querySelectorAll("." + CLASS + ", ." + TICK_CLASS);
  for (const el of olds) el.remove();
}
