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
export function anchorsToPath(anchors, closed) {
  if (!Array.isArray(anchors) || anchors.length === 0) return "";
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
