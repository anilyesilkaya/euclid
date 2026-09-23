// Hand-written SVG serializer. Walks the model — never a DOM clone.
// Same output powers the live source panel, Copy, and Download.

import { getDoc } from "./state.js";
import { elementBBoxInCanvas, resolveConnector } from "./render.js";

const DEFAULT_VIEWBOX = { x: 0, y: 0, width: 1000, height: 700 };
const TIGHT_PADDING = 8;
const INDENT = "  ";

let tightMode = false;

const GEOMETRY_ATTRS = [
  "x", "y", "width", "height", "rx", "ry",
  "cx", "cy", "r",
  "x1", "y1", "x2", "y2",
  "points",
  "d",
];
const TEXT_ATTRS = [
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline",
];
const PRESENTATION_ATTRS = [
  "fill", "fill-opacity",
  "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "opacity",
];
const DEFAULTS = {
  opacity: 1,
  "fill-opacity": 1,
  "stroke-opacity": 1,
  rx: 0,
  ry: 0,
};

export function serialize() {
  const doc = getDoc();
  const vb = tightMode ? computeTightViewBox() : DEFAULT_VIEWBOX;
  const vbStr = `${round(vb.x)} ${round(vb.y)} ${round(vb.width)} ${round(vb.height)}`;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbStr}">`,
  ];
  // Emit arrowhead marker defs only when some connector uses them.
  lines.push(...arrowDefs(doc));
  for (const child of doc.children) {
    lines.push(...emitNode(child, 1));
  }
  lines.push(`</svg>`);
  return lines.join("\n") + "\n";
}

function arrowDefs(doc) {
  const needsEnd = doc.children.some(c => c.type === "connector" && c.arrowEnd);
  const needsStart = doc.children.some(c => c.type === "connector" && c.arrowStart);
  if (!needsEnd && !needsStart) return [];
  const out = [`${INDENT}<defs>`];
  const marker = (id) => [
    `${INDENT}${INDENT}<marker id="${id}" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">`,
    `${INDENT}${INDENT}${INDENT}<path d="M0 0L10 5L0 10z" fill="context-stroke"/>`,
    `${INDENT}${INDENT}</marker>`,
  ];
  if (needsEnd) out.push(...marker("arrow-end"));
  if (needsStart) out.push(...marker("arrow-start"));
  out.push(`${INDENT}</defs>`);
  return out;
}

export function setTightMode(on) {
  tightMode = !!on;
  refreshSourcePanel();
}
export function isTightMode() { return tightMode; }

// Union AABB of every top-level shape in canvas (viewBox) coords, computed
// from the live DOM so rotations are honored. Falls back to the default
// viewBox when the document is empty.
function computeTightViewBox() {
  const docLayer = document.getElementById("doc-layer");
  const canvasSvg = docLayer?.ownerSVGElement;
  if (!docLayer || !canvasSvg) return DEFAULT_VIEWBOX;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of docLayer.children) {
    // elementBBoxInCanvas returns AABB corners in canvas viewBox user units,
    // honoring translate/rotate (see localToCanvasMatrix in render.js).
    const bb = elementBBoxInCanvas(el);
    if (!bb) continue;
    if (bb.width === 0 && bb.height === 0) continue;
    if (bb.x1 < minX) minX = bb.x1;
    if (bb.y1 < minY) minY = bb.y1;
    if (bb.x2 > maxX) maxX = bb.x2;
    if (bb.y2 > maxY) maxY = bb.y2;
  }
  if (!isFinite(minX)) return DEFAULT_VIEWBOX;
  return {
    x: minX - TIGHT_PADDING,
    y: minY - TIGHT_PADDING,
    width: (maxX - minX) + TIGHT_PADDING * 2,
    height: (maxY - minY) + TIGHT_PADDING * 2,
  };
}

function emitNode(node, depth) {
  const pad = INDENT.repeat(depth);

  // Connectors carry no stored geometry — resolve to a concrete <line> at export
  // time from the live shape boxes, so exported SVG is self-contained.
  if (node.type === "connector") {
    const g = resolveConnector(node);
    if (!g || !g.valid) return []; // dangling connector: emit nothing
    const parts = [
      `x1="${round(g.x1)}"`, `y1="${round(g.y1)}"`,
      `x2="${round(g.x2)}"`, `y2="${round(g.y2)}"`,
    ];
    for (const k of PRESENTATION_ATTRS) {
      if (!(k in (node.attrs || {}))) continue;
      const v = node.attrs[k];
      if (isDefault(k, v)) continue;
      parts.push(`${k}="${formatValue(k, v)}"`);
    }
    if (node.arrowEnd) parts.push(`marker-end="url(#arrow-end)"`);
    if (node.arrowStart) parts.push(`marker-start="url(#arrow-start)"`);
    return [`${pad}<line ${parts.join(" ")}/>`];
  }

  const attrs = buildAttrs(node);
  const attrStr = attrs.length ? " " + attrs.join(" ") : "";

  if (node.type === "group") {
    const children = node.children || [];
    const labelChild = node.label ? labelChildFor(node) : null;
    if (children.length === 0 && !labelChild) {
      return [`${pad}<g${attrStr}/>`];
    }
    const out = [`${pad}<g${attrStr}>`];
    for (const child of children) out.push(...emitNode(child, depth + 1));
    if (labelChild) out.push(...emitNode(labelChild, depth + 1));
    out.push(`${pad}</g>`);
    return out;
  }

  if (node.type === "text") {
    const inner = escapeXmlText(String(node.text ?? ""));
    return [`${pad}<text${attrStr}>${inner}</text>`];
  }

  // Shape with label — wrap in <g> so both travel together.
  if (node.label) {
    const wrapper = {
      type: "group",
      attrs: {},
      transform: null,
      children: [ { ...node, label: undefined } ],
      label: undefined,
    };
    const label = labelChildFor(node);
    const out = [`${pad}<g>`];
    out.push(...emitNode(wrapper.children[0], depth + 1));
    out.push(...emitNode(label, depth + 1));
    out.push(`${pad}</g>`);
    return out;
  }

  return [`${pad}<${node.type}${attrStr}/>`];
}

function labelChildFor(ownerNode) {
  const bbox = localBBoxOfNode(ownerNode);
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const style = ownerNode.labelStyle || {};
  return {
    type: "text",
    attrs: {
      x: cx,
      y: cy,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-family": style["font-family"] || "sans-serif",
      "font-size": style["font-size"] || 16,
      fill: style.fill || "#000000",
    },
    transform: null,
    text: ownerNode.label,
  };
}

function localBBoxOfNode(node) {
  if (node.type === "group") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rec = (n) => {
      const tx = n.transform?.tx || 0;
      const ty = n.transform?.ty || 0;
      if (n.type === "group") { (n.children || []).forEach(rec); return; }
      const b = localBBoxOfNode(n);
      const x1 = b.x + tx, y1 = b.y + ty, x2 = x1 + b.width, y2 = y1 + b.height;
      if (x1 < minX) minX = x1; if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2; if (y2 > maxY) maxY = y2;
    };
    (node.children || []).forEach(rec);
    if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
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
  if (node.type === "text") {
    const size = a["font-size"] || 16;
    const w = String(node.text || "").length * size * 0.6;
    return { x: a.x, y: a.y - size, width: w, height: size * 1.2 };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

function escapeXmlText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildAttrs(node) {
  const attrs = [];
  const emit = (k, v) => attrs.push(`${k}="${formatValue(k, v)}"`);

  // 1) Geometry
  for (const k of GEOMETRY_ATTRS) {
    if (!(k in node.attrs)) continue;
    const v = node.attrs[k];
    if (isDefault(k, v)) continue;
    emit(k, v);
  }
  // 2) Text attrs
  for (const k of TEXT_ATTRS) {
    if (!(k in node.attrs)) continue;
    const v = node.attrs[k];
    if (isDefault(k, v)) continue;
    emit(k, v);
  }
  // 3) Presentation
  for (const k of PRESENTATION_ATTRS) {
    if (!(k in node.attrs)) continue;
    const v = node.attrs[k];
    if (isDefault(k, v)) continue;
    emit(k, v);
  }
  // 4) Any remaining custom attrs (preserve author-provided extras)
  for (const [k, v] of Object.entries(node.attrs)) {
    if (GEOMETRY_ATTRS.includes(k) || TEXT_ATTRS.includes(k) || PRESENTATION_ATTRS.includes(k)) continue;
    if (isDefault(k, v)) continue;
    emit(k, v);
  }
  // 5) Transform
  const tStr = transformString(node.transform);
  if (tStr) attrs.push(`transform="${tStr}"`);

  return attrs;
}

function isDefault(k, v) {
  if (v === undefined || v === null || v === "") return true;
  if (k in DEFAULTS && v === DEFAULTS[k]) return true;
  return false;
}

function formatValue(k, v) {
  if (k === "points" && Array.isArray(v)) {
    return v.map(p => `${round(p[0])},${round(p[1])}`).join(" ");
  }
  if (typeof v === "number") return String(round(v));
  return escapeXml(String(v));
}

function round(n) {
  if (typeof n !== "number") return n;
  if (Math.abs(n) < 1e-9) return 0;
  return Math.round(n * 1000) / 1000;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function transformString(t) {
  if (!t) return "";
  const parts = [];
  if (t.tx || t.ty) parts.push(`translate(${round(t.tx)},${round(t.ty)})`);
  if (t.rot) parts.push(`rotate(${round(t.rot)},${round(t.cx)},${round(t.cy)})`);
  return parts.join(" ");
}

// --- Panel + IO wiring ---

let sourcePanel;
let debounceTimer = null;

export function mountPanel(preEl, copyBtn, downloadBtn, tightToggle) {
  sourcePanel = preEl;
  if (tightToggle) {
    tightToggle.checked = tightMode;
    tightToggle.addEventListener("change", () => setTightMode(tightToggle.checked));
  }

  copyBtn.addEventListener("click", async () => {
    const text = serialize();
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fall through */ }
    if (!ok) ok = fallbackCopy(text);
    if (ok) flashButton(copyBtn);
  });

  downloadBtn.addEventListener("click", () => {
    const text = serialize();
    const blob = new Blob([text], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "canvas.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashButton(downloadBtn);
  });

  refreshSourcePanel();
}

export function refreshSourcePanel() {
  if (!sourcePanel) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    sourcePanel.textContent = serialize();
  }, 40);
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

function flashButton(btn) {
  btn.classList.add("flash");
  setTimeout(() => btn.classList.remove("flash"), 200);
}
