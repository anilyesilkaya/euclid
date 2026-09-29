// SVG paste-import. Strict: rejects unsupported elements/transforms with a
// specific error so users know exactly what's blocking the import.

import { mutate, newId, emptyTransform } from "./state.js";
import * as history from "./history.js";

const SUPPORTED_SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "text", "path"]);
const SUPPORTED_CONTAINERS = new Set(["g"]);
// Metadata-only elements we can safely skip at parse time (they don't render).
// <style> and <defs> are handled by the preflight pass (class inlining, paint-server rejection).
const IGNORABLE = new Set(["title", "desc", "metadata", "style", "defs"]);
// Elements collected separately (not parsed as shapes) but still supported.
const COLLECTED_ELEMENTS = new Set(["linearGradient"]);
// Paint-server / filter / mask elements we still can't represent. Present anywhere
// → reject with a specific message rather than silently dropping them. Note
// linearGradient is deliberately absent: it's collected into the paint model.
const PAINT_SERVER_ELEMENTS = new Set([
  "radialGradient", "pattern",
  "filter", "clipPath", "mask",
  "symbol", "marker", "use", "image",
]);

const SHAPE_ATTRS = {
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  text: ["x", "y"],
  path: ["d"],
};
const PRESENTATION_ATTRS = [
  "fill", "fill-opacity",
  "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "opacity",
  "font-family", "font-size", "font-weight", "font-style",
  "text-anchor", "dominant-baseline",
];

export class ImportError extends Error {
  constructor(message) { super(message); this.name = "ImportError"; }
}

// Parse an SVG string into an array of doc-tree nodes. Throws ImportError on
// anything unsupported. Caller decides whether to append or replace.
export function parseSvgToNodes(source) {
  const trimmed = String(source ?? "").trim();
  if (!trimmed) throw new ImportError("Empty input");

  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, "image/svg+xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    throw new ImportError("XML parse error: " + (parseErr.textContent || "").trim().slice(0, 200));
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "svg") {
    throw new ImportError(`Root element must be <svg> (got <${root?.localName || "empty"}>)`);
  }

  // Collect <linearGradient> defs first so preflight can accept url(#…) paint
  // references that resolve to one, and so shapes can bind to the paint model.
  const gradients = collectLinearGradients(root);
  // Preflight: reject unsupported paint servers / references before doing any parsing.
  // Illustrator exports commonly include <defs> with only <style>, which is fine —
  // reject only when <defs> contains something we can't represent.
  preflightRejectPaintServers(root, gradients);
  // Inline class-based styles from any <style> blocks so downstream code sees plain attributes.
  inlineStyleClasses(root);

  const nodes = [];
  for (const child of Array.from(root.children)) {
    const parsed = parseElement(child);
    if (parsed) nodes.push(parsed);
  }
  if (nodes.length === 0) throw new ImportError("No supported elements found");
  // Resolve url(#…) fill/stroke references into the inline gradient paint model.
  for (const n of nodes) resolveGradientRefs(n, gradients);
  return nodes;
}

// Walk the entire tree once and throw if we encounter anything we can't render.
// url(#...) paint references are allowed only when they resolve to a collected
// <linearGradient>; anything else (radial, pattern, unknown id) still rejects.
function preflightRejectPaintServers(root, gradients) {
  const resolves = (v) => {
    const id = paintRefId(v);
    return id != null && gradients.has(id);
  };
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    for (const child of Array.from(el.children)) {
      const name = child.localName;
      // A <linearGradient> is collected into the paint model, not rejected. Its
      // own subtree (<stop>s) needn't be walked for paint refs.
      if (COLLECTED_ELEMENTS.has(name)) continue;
      if (PAINT_SERVER_ELEMENTS.has(name)) {
        throw new ImportError(
          `<${name}> is not supported — radial gradients, patterns, filters, clip paths, masks, ` +
          `<use>, and <image> can't be represented in this editor's model.`,
        );
      }
      // Check fill/stroke on this element for url(#...) references.
      for (const key of ["fill", "stroke"]) {
        const v = child.getAttribute(key);
        if (v && /url\s*\(/i.test(v) && !resolves(v)) {
          throw new ImportError(
            `${key}="${v}" references an unsupported paint server (only linear gradients are supported).`,
          );
        }
      }
      const style = child.getAttribute("style");
      if (style && /url\s*\(/i.test(style)) {
        // Allow only if every url(...) in the style resolves to a linear gradient.
        const refs = style.match(/url\s*\([^)]*\)/gi) || [];
        if (!refs.every(resolves)) {
          throw new ImportError(
            `style="${style.slice(0, 80)}..." references an unsupported paint server (only linear gradients are supported).`,
          );
        }
      }
      stack.push(child);
    }
  }
}

// Extract the id from a `url(#id)` paint reference (with or without quotes), or
// null if the value isn't a local url reference.
function paintRefId(v) {
  if (typeof v !== "string") return null;
  const m = /url\s*\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i.exec(v);
  return m ? m[1] : null;
}

// Collect every <linearGradient id="…"> in the tree into a Map(id → GradientDef)
// in our paint model. Resolves xlink:href / href stop inheritance one level and
// converts the gradient's coordinates + gradientTransform into a single angle.
function collectLinearGradients(root) {
  const byId = new Map();      // id → element
  const els = root.getElementsByTagName("linearGradient");
  for (const el of Array.from(els)) {
    const id = el.getAttribute("id");
    if (id) byId.set(id, el);
  }
  const out = new Map();       // id → GradientDef
  for (const [id, el] of byId) {
    const def = linearGradientToDef(el, byId);
    if (def) out.set(id, def);
  }
  return out;
}

// Convert a <linearGradient> element into { type:"linear", angle, stops }.
function linearGradientToDef(el, byId) {
  // Stops may be inherited via href from a referenced gradient.
  let stopHost = el;
  let stops = readStops(el);
  if (stops.length === 0) {
    const href = el.getAttribute("href") || el.getAttribute("xlink:href");
    const refId = href && href.startsWith("#") ? href.slice(1) : null;
    if (refId && byId.has(refId)) { stopHost = byId.get(refId); stops = readStops(stopHost); }
  }
  if (stops.length < 2) return null;
  return { type: "linear", angle: linearGradientAngle(el), stops };
}

function readStops(el) {
  const out = [];
  for (const s of Array.from(el.children)) {
    if (s.localName !== "stop") continue;
    let offset = parseFloat(s.getAttribute("offset"));
    if (!Number.isFinite(offset)) offset = 0;
    if (String(s.getAttribute("offset")).includes("%")) offset /= 100;
    if (offset > 1) offset /= 100; // tolerate "50" meaning 50%
    // stop-color / stop-opacity can be attribute or inline style.
    const style = parseInlineStyle(s.getAttribute("style"));
    const color = s.getAttribute("stop-color") || style["stop-color"] || "#000000";
    const opRaw = s.getAttribute("stop-opacity") || style["stop-opacity"];
    const opacity = opRaw != null && opRaw !== "" ? clamp01(parseFloat(opRaw)) : 1;
    out.push({ offset: clamp01(offset), color, opacity: Number.isFinite(opacity) ? opacity : 1 });
  }
  return out;
}

// Derive our single `angle` (degrees, 0 = →, 90 = ↓) from a gradient's x1/y1/x2/y2
// plus any rotate() in gradientTransform. Defaults to horizontal when unset.
function linearGradientAngle(el) {
  const num = (k, d) => {
    const raw = el.getAttribute(k);
    if (raw == null) return d;
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) return d;
    if (String(raw).includes("%")) n /= 100;
    return n;
  };
  const x1 = num("x1", 0), y1 = num("y1", 0), x2 = num("x2", 1), y2 = num("y2", 0);
  let base = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  // Fold a rotate(<deg> …) from gradientTransform into the axis angle.
  const gt = el.getAttribute("gradientTransform");
  if (gt) {
    const m = /rotate\s*\(\s*(-?[\d.]+)/.exec(gt);
    if (m) base += parseFloat(m[1]);
  }
  return ((Math.round(base) % 360) + 360) % 360;
}

// Rewrite a node's (and its subtree's) url(#…) fill/stroke into node.gradients.
function resolveGradientRefs(node, gradients) {
  if (!node || typeof node !== "object") return;
  if (node.attrs) {
    for (const slot of ["fill", "stroke"]) {
      const id = paintRefId(node.attrs[slot]);
      if (id != null && gradients.has(id)) {
        if (!node.gradients) node.gradients = {};
        // Clone so two shapes referencing the same def don't share one object.
        node.gradients[slot] = cloneGradient(gradients.get(id));
        // Drop the raw url(...) string; keep a solid fallback for round-safety.
        node.attrs[slot] = node.gradients[slot].stops[0]?.color || "#000000";
      }
    }
  }
  if (Array.isArray(node.children)) for (const c of node.children) resolveGradientRefs(c, gradients);
}

function cloneGradient(g) {
  return { type: g.type, angle: g.angle, stops: g.stops.map((s) => ({ ...s })) };
}

function parseInlineStyle(style) {
  const out = {};
  if (!style) return out;
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const k = decl.slice(0, idx).trim();
    const v = decl.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Collect every <style> block, parse simple ".cls { k: v; ... }" rules,
// and copy those declarations onto matching elements as inline style="" —
// but only for PRESENTATION_ATTRS we already understand. Attribute-form on
// the element wins on conflict; existing inline style wins over class style.
function inlineStyleClasses(root) {
  const styleEls = root.getElementsByTagName("style");
  if (styleEls.length === 0) return;
  const classMap = new Map(); // className -> { key: value, ... }
  for (const styleEl of Array.from(styleEls)) {
    const css = styleEl.textContent || "";
    parseCssRules(css, classMap);
  }
  if (classMap.size === 0) return;
  // Apply to every element that carries a class attribute matching one we saw.
  const all = root.getElementsByTagName("*");
  for (const el of Array.from(all)) {
    const cls = el.getAttribute("class");
    if (!cls) continue;
    const classes = cls.trim().split(/\s+/);
    // Merge decls from left-to-right so later classes override earlier ones,
    // then let the element's own attrs/style win over the merged result.
    const merged = {};
    for (const c of classes) {
      const decls = classMap.get(c);
      if (!decls) continue;
      Object.assign(merged, decls);
    }
    for (const [key, value] of Object.entries(merged)) {
      if (!PRESENTATION_ATTRS.includes(key)) continue;
      if (el.hasAttribute(key)) continue; // element attr wins
      // Inline style on the element wins too — check existing style="" for this key.
      const inline = el.getAttribute("style");
      if (inline && new RegExp(`(?:^|;)\\s*${escapeReForCss(key)}\\s*:`).test(inline)) continue;
      el.setAttribute(key, value);
    }
  }
}

// Minimal CSS rule parser — sufficient for Illustrator's flat ".stN { k: v; ... }" output.
// Skips at-rules, comments, and any selector we don't recognize as a bare class.
function parseCssRules(css, out) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(stripped)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    if (!selector || selector.startsWith("@")) continue;
    // Support one or more class selectors separated by commas, each ".name".
    const classNames = [];
    for (const sel of selector.split(",")) {
      const s = sel.trim();
      const cm = /^\.([A-Za-z_][\w-]*)$/.exec(s);
      if (cm) classNames.push(cm[1]);
    }
    if (classNames.length === 0) continue;
    const decls = {};
    for (const decl of body.split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      const key = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (!key || value === "") continue;
      decls[key] = value;
    }
    for (const name of classNames) {
      const prev = out.get(name);
      out.set(name, prev ? { ...prev, ...decls } : decls);
    }
  }
}

function escapeReForCss(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseElement(el) {
  const name = el.localName;
  if (IGNORABLE.has(name)) return null;
  if (SUPPORTED_CONTAINERS.has(name)) return parseGroup(el);
  if (SUPPORTED_SHAPES.has(name)) return parseShape(el);
  throw new ImportError(`Unsupported element <${name}> — this editor only handles rect, circle, ellipse, line, polyline, text, g.`);
}

function parseGroup(el) {
  const children = [];
  for (const c of Array.from(el.children)) {
    const parsed = parseElement(c);
    if (parsed) children.push(parsed);
  }
  return {
    id: newId("g"),
    type: "group",
    attrs: readPresentation(el),
    transform: parseTransform(el.getAttribute("transform")),
    children,
  };
}

function parseShape(el) {
  const type = el.localName;
  const attrs = {};

  // Geometry.
  for (const key of SHAPE_ATTRS[type]) {
    const raw = el.getAttribute(key);
    if (raw == null) continue;
    if (key === "points") {
      attrs.points = parsePoints(raw);
    } else if (key === "d") {
      attrs.d = String(raw).trim();
    } else {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) attrs[key] = n;
    }
  }
  // Presentation.
  Object.assign(attrs, readPresentation(el));

  const node = {
    id: newId(type === "text" ? "t" : "n"),
    type,
    attrs,
    transform: parseTransform(el.getAttribute("transform")),
  };
  if (type === "text") {
    node.text = (el.textContent || "").replace(/\s+/g, " ").trim();
  }
  return node;
}

function readPresentation(el) {
  const out = {};
  // 1) Element attributes (SVG presentation attributes).
  for (const key of PRESENTATION_ATTRS) {
    const raw = el.getAttribute(key);
    if (raw == null) continue;
    out[key] = coerceAttrValue(key, raw);
  }
  // 2) Inline style="" — attribute-form wins on collision (SVG precedence rule).
  const style = el.getAttribute("style");
  if (style) {
    for (const decl of style.split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      const key = decl.slice(0, idx).trim();
      const val = decl.slice(idx + 1).trim();
      if (!key || val === "") continue;
      if (!PRESENTATION_ATTRS.includes(key)) continue;
      if (out[key] !== undefined) continue;
      out[key] = coerceAttrValue(key, val);
    }
  }
  return out;
}

function coerceAttrValue(key, raw) {
  // Numeric-valued attrs.
  if (key === "font-size" || key === "stroke-width" || key === "opacity" ||
      key === "fill-opacity" || key === "stroke-opacity") {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function parsePoints(raw) {
  const tokens = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const pts = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) pts.push([tokens[i], tokens[i + 1]]);
  return pts;
}

// Parse an SVG transform attribute into our decomposed { tx, ty, rot, cx, cy } form.
// Compose all transform functions into a single 2×3 affine matrix, then decompose.
// Accepts anything that reduces to a rigid transform (translate + rotation).
// Rejects scale, skew, and non-uniform matrices with a specific message.
function parseTransform(raw) {
  const t = emptyTransform();
  if (!raw) return t;
  // Compose left-to-right (SVG semantics: each transform is a further mapping of local coords).
  let M = [1, 0, 0, 1, 0, 0]; // [a, b, c, d, e, f]
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const fn = m[1].toLowerCase();
    const args = m[2].trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (fn === "translate") {
      const tx = args[0] || 0;
      const ty = args.length > 1 ? args[1] : 0;
      M = mul(M, [1, 0, 0, 1, tx, ty]);
    } else if (fn === "rotate") {
      const deg = args[0] || 0;
      const cx = args[1] || 0;
      const cy = args[2] || 0;
      const rad = deg * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      // rotate around (cx,cy) = translate(cx,cy) · rotate · translate(-cx,-cy)
      let R = [1, 0, 0, 1, cx, cy];
      R = mul(R, [cos, sin, -sin, cos, 0, 0]);
      R = mul(R, [1, 0, 0, 1, -cx, -cy]);
      M = mul(M, R);
    } else if (fn === "matrix") {
      if (args.length !== 6) {
        throw new ImportError(`matrix() expects 6 numbers, got ${args.length}.`);
      }
      M = mul(M, args);
    } else if (fn === "scale" || fn === "skewx" || fn === "skewy") {
      throw new ImportError(
        `Transform '${fn}()' can't be represented — this editor only supports translation and rotation.`,
      );
    } else {
      throw new ImportError(`Unsupported transform '${fn}()'.`);
    }
  }
  return decomposeRigid(M);
}

// Multiply two 2×3 affine matrices A · B (both in [a,b,c,d,e,f] flat form).
function mul(A, B) {
  const [a1, b1, c1, d1, e1, f1] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a1 * a2 + c1 * b2,        b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,        b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,   b1 * e2 + d1 * f2 + f1,
  ];
}

// Decompose a 2×3 affine into { tx, ty, rot(°), cx: 0, cy: 0 } iff it is rigid
// (rotation + translation, no scale, no shear). Otherwise throw.
function decomposeRigid(M) {
  const [a, b, c, d, e, f] = M;
  const EPS = 1e-4;
  // Rigid ⇔ [[a,c],[b,d]] is a proper rotation: a=d, b=-c, and det=1.
  if (Math.abs(a - d) > EPS || Math.abs(b + c) > EPS) {
    throw new ImportError(
      "Transform contains scale or shear — only translation and rotation are supported.",
    );
  }
  const det = a * d - b * c;
  if (Math.abs(det - 1) > EPS) {
    const scale = Math.sqrt(Math.abs(det));
    throw new ImportError(
      `Transform includes scaling (factor ~${scale.toFixed(3)}) — only translation and rotation are supported.`,
    );
  }
  const t = emptyTransform();
  t.tx = e;
  t.ty = f;
  const rad = Math.atan2(b, a);
  t.rot = rad * 180 / Math.PI;
  // Rotation is expressed around the origin — cx/cy at 0 keeps our downstream code happy.
  t.cx = 0;
  t.cy = 0;
  // Clean up numerical fuzz so identity transforms serialize as identity.
  if (Math.abs(t.rot) < 1e-6) t.rot = 0;
  if (Math.abs(t.tx) < 1e-9) t.tx = 0;
  if (Math.abs(t.ty) < 1e-9) t.ty = 0;
  return t;
}

// --- Modal UI wiring ---

let modal, textarea, errorBox, confirmBtn, cancelBtn, openBtn;

export function mountImport(root) {
  modal = root.querySelector("#import-modal");
  textarea = root.querySelector("#import-text");
  errorBox = root.querySelector("#import-error");
  confirmBtn = root.querySelector("#import-confirm");
  cancelBtn = root.querySelector("#import-cancel");
  openBtn = root.querySelector("#import-btn");

  openBtn.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", runImport);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runImport(); }
  });
}

function openModal() {
  errorBox.hidden = true;
  errorBox.textContent = "";
  modal.hidden = false;
  setTimeout(() => textarea.focus(), 0);
}

function closeModal() {
  modal.hidden = true;
}

function runImport() {
  errorBox.hidden = true;
  errorBox.textContent = "";
  let nodes;
  try {
    nodes = parseSvgToNodes(textarea.value);
  } catch (err) {
    errorBox.textContent = err instanceof ImportError ? err.message : String(err);
    errorBox.hidden = false;
    return;
  }
  const mode = modal.querySelector('input[name="import-mode"]:checked').value;
  history.record(() => {
    mutate((root) => {
      if (mode === "replace") root.children = [];
      root.children.push(...nodes);
    });
  });
  closeModal();
}
