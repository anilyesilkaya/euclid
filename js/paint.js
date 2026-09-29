// Paint-server model: gradients as fill/stroke.
//
// Design (mirrors the pen-path "derive, don't store" precedent in paths.js):
// each node carries its own gradient paint inline —
//
//   node.gradients = {
//     fill?:   GradientDef,
//     stroke?: GradientDef,
//   }
//   GradientDef = { type: "linear", angle: <deg>, stops: [{ offset, color, opacity? }] }
//
// The <linearGradient> element and its `url(#id)` reference are *synthesized* at
// render/export from a deterministic id derived from the node id — never stored
// on node.attrs. Because the id is a pure function of node.id, duplicate/paste
// (which re-IDs nodes via deepReId) and copy/paste "just work": the def travels
// inline with the node, so there is no shared document-level registry to keep in
// sync, no id collisions, and no dangling references.
//
// Coordinate model: objectBoundingBox units (transform-agnostic — the gradient
// tracks the shape under translate/rotate/resize for free) with a horizontal
// base axis (x1=0 → x2=1) rotated about the box center via gradientTransform.
// So `angle` is a plain degrees value: 0 = left→right, 90 = top→bottom.

const SVG_NS = "http://www.w3.org/2000/svg";

// The two paint slots a gradient can occupy.
export const PAINT_SLOTS = ["fill", "stroke"];

// --- Model access -----------------------------------------------------------

export function getGradient(node, slot) {
  const g = node && node.gradients && node.gradients[slot];
  return isValidGradient(g) ? g : null;
}

export function hasGradient(node, slot) {
  return getGradient(node, slot) !== null;
}

// A gradient needs a known type and at least two stops to render meaningfully.
export function isValidGradient(g) {
  return !!g && g.type === "linear" && Array.isArray(g.stops) && g.stops.length >= 2;
}

// Deterministic, DOM-safe id for a node's paint slot. node ids are like
// "n_ab12cd34" (alnum + underscore), so the result is a valid SVG id.
export function gradientId(nodeId, slot) {
  return `eg-${nodeId}-${slot}`;
}

// The attribute value to paint with, or null if this slot isn't a gradient.
export function paintRef(node, slot) {
  return hasGradient(node, slot) ? `url(#${gradientId(node.id, slot)})` : null;
}

// A sensible default linear gradient seeded from an existing solid color, used
// when the UI first switches a slot from solid → linear.
export function defaultLinearGradient(fromColor = "#4c9aff") {
  const c = normalizeHex(fromColor) || "#4c9aff";
  return {
    type: "linear",
    angle: 90,
    stops: [
      { offset: 0, color: c, opacity: 1 },
      { offset: 1, color: "#ffffff", opacity: 1 },
    ],
  };
}

// Normalize a gradient for safe rendering: clamp/sort stops, coerce numbers.
// Returns a fresh object; never mutates the input.
export function normalizeGradient(g) {
  if (!isValidGradient(g)) return null;
  const stops = g.stops
    .map((s) => ({
      offset: clamp01(num(s.offset, 0)),
      color: normalizeHex(s.color) || "#000000",
      opacity: clamp01(num(s.opacity, 1)),
    }))
    .sort((a, b) => a.offset - b.offset);
  return { type: "linear", angle: num(g.angle, 0), stops };
}

// --- Render (DOM) -----------------------------------------------------------

// Build a <linearGradient> DOM element for the live canvas.
export function linearGradientElement(def, id) {
  const g = normalizeGradient(def);
  if (!g) return null;
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", id);
  // objectBoundingBox (the default) + a horizontal axis rotated about center.
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "1");
  grad.setAttribute("y2", "0");
  if (g.angle) grad.setAttribute("gradientTransform", `rotate(${round(g.angle)} 0.5 0.5)`);
  for (const s of g.stops) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", round(s.offset));
    stop.setAttribute("stop-color", s.color);
    if (s.opacity !== 1) stop.setAttribute("stop-opacity", round(s.opacity));
    grad.appendChild(stop);
  }
  return grad;
}

// --- Export (markup) --------------------------------------------------------

// Serialize a <linearGradient> to indented SVG lines.
export function linearGradientMarkup(def, id, pad, indentUnit) {
  const g = normalizeGradient(def);
  if (!g) return [];
  const attrs = [`id="${id}"`, `x1="0"`, `y1="0"`, `x2="1"`, `y2="0"`];
  if (g.angle) attrs.push(`gradientTransform="rotate(${round(g.angle)} 0.5 0.5)"`);
  const out = [`${pad}<linearGradient ${attrs.join(" ")}>`];
  for (const s of g.stops) {
    const sa = [`offset="${round(s.offset)}"`, `stop-color="${s.color}"`];
    if (s.opacity !== 1) sa.push(`stop-opacity="${round(s.opacity)}"`);
    out.push(`${pad}${indentUnit}<stop ${sa.join(" ")}/>`);
  }
  out.push(`${pad}</linearGradient>`);
  return out;
}

// --- Collection -------------------------------------------------------------

// Deep-walk the tree and collect every referenced gradient as {id, slot, def}.
// Used by render (inject <defs>) and export (emit <defs>).
export function collectGradients(root) {
  const out = [];
  (function rec(node) {
    if (!node || typeof node !== "object") return;
    for (const slot of PAINT_SLOTS) {
      const def = getGradient(node, slot);
      if (def) out.push({ id: gradientId(node.id, slot), slot, def });
    }
    if (Array.isArray(node.children)) for (const c of node.children) rec(c);
  })(root);
  return out;
}

// --- helpers ----------------------------------------------------------------

function num(v, d) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function round(n) {
  if (typeof n !== "number") return n;
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1000) / 1000;
}
// Accept #rgb / #rrggbb (case-insensitive); expand shorthand to 6 digits.
function normalizeHex(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  }
  return null;
}
