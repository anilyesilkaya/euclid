// Structured path model — the source of truth for pen-drawn paths.
//
// A pen path stores an ordered anchor list on the node as `node.anchors`, plus a
// boolean `node.closed`. Each anchor is:
//   { x, y, cin?: {x, y}, cout?: {x, y} }
// where `cin` is the incoming bézier control handle (governs the curve arriving
// at this anchor from the previous one) and `cout` is the outgoing control handle
// (governs the curve leaving toward the next). A corner anchor has neither handle;
// a smooth anchor has mirrored cin/cout.
//
// The SVG `d` string is *derived* from this model at render/export time — never
// stored — so node editing (M6 part 2) only ever mutates anchors. Imported paths
// that carry a raw `attrs.d` and no `anchors` are left untouched.

function round(n) {
  if (typeof n !== "number") return n;
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1000) / 1000;
}

// Build an SVG path `d` string from a structured anchor list.
// A segment uses a cubic (C) when either endpoint carries a matching handle,
// otherwise a straight line (L). A missing handle defaults to its own anchor
// point, which degenerates the cubic cleanly. `closed` appends the wrap segment
// (honoring the last→first handles) and a Z.
//
// `cornerRadius` (> 0) rounds "hard" corners: a vertex that is itself a corner
// (no handles) *and* is bordered by two straight segments is trimmed back along
// each edge by the radius (clamped to half of each adjacent edge so neighbouring
// fillets never overlap) and joined with a quadratic fillet through the corner.
// Vertices touched by a curve, and open-path endpoints, are left sharp. The
// radius is a live render/export parameter — anchors are never mutated.
export function anchorsToPath(anchors, closed, cornerRadius = 0) {
  if (!Array.isArray(anchors) || anchors.length === 0) return "";
  if (cornerRadius > 0) {
    const rounded = anchorsToRoundedPath(anchors, closed, cornerRadius);
    if (rounded) return rounded;
  }
  const p = (n) => round(n);
  const out = [`M ${p(anchors[0].x)} ${p(anchors[0].y)}`];
  const seg = (a, b) => {
    const hasCurve = a.cout || b.cin;
    if (!hasCurve) return `L ${p(b.x)} ${p(b.y)}`;
    const c1 = a.cout || { x: a.x, y: a.y };
    const c2 = b.cin || { x: b.x, y: b.y };
    return `C ${p(c1.x)} ${p(c1.y)} ${p(c2.x)} ${p(c2.y)} ${p(b.x)} ${p(b.y)}`;
  };
  for (let i = 1; i < anchors.length; i++) {
    out.push(seg(anchors[i - 1], anchors[i]));
  }
  if (closed && anchors.length > 1) {
    out.push(seg(anchors[anchors.length - 1], anchors[0]));
    out.push("Z");
  }
  return out.join(" ");
}

// Rounded-corner variant. Returns a `d` string, or "" if there's nothing to
// round (fewer than 2 anchors) so the caller falls back to the plain builder.
function anchorsToRoundedPath(anchors, closed, radius) {
  const n = anchors.length;
  if (n < 2) return "";
  const p = (v) => round(v);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const prevIdx = (i) => (i - 1 + n) % n;
  const nextIdx = (i) => (i + 1) % n;

  // Is vertex i a roundable hard corner? Needs neighbours (interior for open
  // paths), no handles of its own, and straight segments on both sides.
  function roundInfo(i) {
    if (!closed && (i === 0 || i === n - 1)) return null;
    const v = anchors[i];
    if (!v || v.cin || v.cout) return null;
    const pv = anchors[prevIdx(i)];
    const nx = anchors[nextIdx(i)];
    if (!pv || !nx) return null;
    // A neighbouring outgoing/incoming handle would make the shared segment a
    // curve — don't trim into a curve.
    if (pv.cout || nx.cin) return null;
    const dPrev = dist(pv, v);
    const dNext = dist(v, nx);
    if (dPrev < 1e-6 || dNext < 1e-6) return null;
    const t = Math.min(radius, dPrev / 2, dNext / 2);
    if (t < 1e-4) return null;
    const uPrev = { x: (pv.x - v.x) / dPrev, y: (pv.y - v.y) / dPrev };
    const uNext = { x: (nx.x - v.x) / dNext, y: (nx.y - v.y) / dNext };
    return {
      A: { x: v.x + uPrev.x * t, y: v.y + uPrev.y * t }, // approach (from prev)
      B: { x: v.x + uNext.x * t, y: v.y + uNext.y * t }, // depart (toward next)
      V: { x: v.x, y: v.y },
    };
  }

  const info = anchors.map((_, i) => roundInfo(i));
  // Something must actually round, else let the plain builder handle it.
  if (!info.some(Boolean)) return "";

  const start = info[0] ? info[0].B : anchors[0];
  const out = [`M ${p(start.x)} ${p(start.y)}`];

  const segStr = (a, b, approach) => {
    const hasCurve = a.cout || b.cin;
    if (!hasCurve) return `L ${p(approach.x)} ${p(approach.y)}`;
    const c1 = a.cout || { x: a.x, y: a.y };
    const c2 = b.cin || { x: b.x, y: b.y };
    return `C ${p(c1.x)} ${p(c1.y)} ${p(c2.x)} ${p(c2.y)} ${p(b.x)} ${p(b.y)}`;
  };

  const segCount = closed ? n : n - 1;
  for (let s = 0; s < segCount; s++) {
    const i = s;
    const j = closed ? nextIdx(s) : s + 1;
    const approach = info[j] ? info[j].A : anchors[j];
    out.push(segStr(anchors[i], anchors[j], approach));
    if (info[j]) out.push(`Q ${p(info[j].V.x)} ${p(info[j].V.y)} ${p(info[j].B.x)} ${p(info[j].B.y)}`);
  }
  if (closed) out.push("Z");
  return out.join(" ");
}

// Axis-aligned bounding box of an anchor list, including bézier control handles
// (a conservative box — control points bound the curve). Used for selection
// chrome and label centering on structured paths.
export function anchorsBBox(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const a of anchors) {
    if (!a || !isFinite(a.x) || !isFinite(a.y)) continue;
    acc(a.x, a.y);
    if (a.cin && isFinite(a.cin.x) && isFinite(a.cin.y)) acc(a.cin.x, a.cin.y);
    if (a.cout && isFinite(a.cout.x) && isFinite(a.cout.y)) acc(a.cout.x, a.cout.y);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
