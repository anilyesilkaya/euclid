// Connector geometry — pure functions, no DOM.
//
// A connector links two endpoints. Each endpoint is either attached to a shape
// — at a fixed connection point ("port", draw.io "fixed" style) or routed to the
// nearest point on the shape's axis-aligned bounding box (draw.io "floating"
// style) — or pinned to a free point. Geometry is always derived from the
// live shape boxes — never stored — so connectors re-route automatically whenever a
// shape moves, resizes, or rotates and the canvas re-renders.

// Point on the border of an axis-aligned box (center c, half-extents hw/hh) along
// the ray from the box center toward (tx, ty). Falls back to the center for a
// degenerate (zero-size) box or a target at the center.
export function borderPoint(box, tx, ty) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if ((dx === 0 && dy === 0) || (hw === 0 && hh === 0)) return { x: cx, y: cy };
  // Largest scale s such that (cx+dx*s, cy+dy*s) is still inside the box on both axes.
  const sx = hw > 0 ? hw / Math.abs(dx) : Infinity;
  const sy = hh > 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// --- Connection points (ports) ----------------------------------------------
//
// A port is a fixed spot on a shape, stored as fractions {x, y} of the shape's
// LOCAL (pre-transform) bbox — so it rides along when the shape moves, resizes,
// or rotates. Rect-like shapes offer three points per side (draw.io's default);
// ellipses offer eight points on the curve itself; anything else offers its
// four side midpoints.

const SIDE_PORTS = [
  { x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 },
];
const RECT_PORTS = [
  { x: 0.25, y: 0 }, { x: 0.5, y: 0 }, { x: 0.75, y: 0 },
  { x: 1, y: 0.25 }, { x: 1, y: 0.5 }, { x: 1, y: 0.75 },
  { x: 0.75, y: 1 }, { x: 0.5, y: 1 }, { x: 0.25, y: 1 },
  { x: 0, y: 0.75 }, { x: 0, y: 0.5 }, { x: 0, y: 0.25 },
];
const D = 0.5 - Math.SQRT1_2 / 2;  // 45° on an ellipse inscribed in the unit box
const ELLIPSE_PORTS = [
  { x: 0.5, y: 0 }, { x: 1 - D, y: D }, { x: 1, y: 0.5 }, { x: 1 - D, y: 1 - D },
  { x: 0.5, y: 1 }, { x: D, y: 1 - D }, { x: 0, y: 0.5 }, { x: D, y: D },
];

export function portsFor(type) {
  if (type === "connector") return [];
  if (type === "rect" || type === "image") return RECT_PORTS;
  if (type === "ellipse" || type === "circle") return ELLIPSE_PORTS;
  return SIDE_PORTS;
}

// Outward direction (local space) of a port: the box side it sits nearest to.
export function portNormal(port) {
  const d = [
    [port.y, 0, -1],      // top
    [1 - port.x, 1, 0],   // right
    [1 - port.y, 0, 1],   // bottom
    [port.x, -1, 0],      // left
  ].reduce((best, c) => (c[0] < best[0] ? c : best));
  return { x: d[1], y: d[2] };
}

// Dominant-axis compass direction of a vector.
export function dirOf(v) {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? "e" : "w";
  return v.y >= 0 ? "s" : "n";
}

// Resolve a straight connector's two endpoints.
//   fromBox / toBox   : canvas-space AABBs of attached shapes, or null if that end
//                       is a free point.
//   fromPt / toPt     : free-point fallbacks {x,y} (used when the box is null).
//   fromPort / toPort : canvas-space {x,y} of a fixed connection point, or null
//                       to float on the box border.
// Returns { x1, y1, x2, y2, valid }. valid is false when an endpoint can't be
// resolved (e.g. an attached shape that no longer exists).
export function routeStraight(fromBox, toBox, fromPt, toPt, fromPort = null, toPort = null) {
  // A floating end aims at the other end's fixed point when it has one.
  const fromAim = fromPort || (fromBox ? centerOf(fromBox) : fromPt);
  const toAim = toPort || (toBox ? centerOf(toBox) : toPt);
  if (!fromAim || !toAim) return { valid: false };

  const from = fromPort || (fromBox ? borderPoint(fromBox, toAim.x, toAim.y) : fromPt);
  const to = toPort || (toBox ? borderPoint(toBox, fromAim.x, fromAim.y) : toPt);
  if (!from || !to) return { valid: false };

  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, valid: true };
}

// --- Orthogonal (elbow) routing ---------------------------------------------
//
// Route two endpoints with axis-aligned segments (draw.io "orthogonal" edges).
// Each attached endpoint leaves from its connection point, or else from the
// midpoint of the box edge that faces the far endpoint (or the nearest
// waypoint); the exit points are then joined by horizontal/vertical legs. Optional `waypoints` ([{x,y},...] in canvas space)
// force the path through fixed points — the interactive-drag layer (M4 part 2)
// stores them; part 1 already honors them if present.
//
// Returns { points: [[x,y],...], valid }. `points` always has ≥2 entries.

// Midpoint of the box edge facing `toward`, plus the exit direction (n/s/e/w).
function orthExit(box, toward) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { pt: { x: box.x + box.width, y: cy }, dir: "e" }
      : { pt: { x: box.x, y: cy }, dir: "w" };
  }
  return dy >= 0
    ? { pt: { x: cx, y: box.y + box.height }, dir: "s" }
    : { pt: { x: cx, y: box.y }, dir: "n" };
}

// Dominant-axis direction from `from` toward `to` — used for free (unattached)
// endpoints, which have no box edge to exit from.
function dirToward(from, to) {
  const dx = (to?.x ?? from.x) - from.x;
  const dy = (to?.y ?? from.y) - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "e" : "w";
  return dy >= 0 ? "s" : "n";
}

// An attached end first runs this many canvas units straight out of its side
// before turning, so the route never hugs or doubles back along the shape.
const STUB = 20;
const DIR_VEC = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };

function step(pt, dir, d) {
  const v = DIR_VEC[dir];
  return { x: pt.x + v.x * d, y: pt.y + v.y * d };
}

// Whether the axis-aligned segment p→q passes through the interior of `box`
// (running along its border doesn't count).
function segHitsBox(p, q, box) {
  const e = 1e-6;
  return Math.max(p.x, q.x) > box.x + e && Math.min(p.x, q.x) < box.x + box.width - e &&
         Math.max(p.y, q.y) > box.y + e && Math.min(p.y, q.y) < box.y + box.height - e;
}

// Rank a raw corner list: crossing a shape is worst, then turning back on
// itself, then each bend; ties go to the shorter path.
function routeCost(pts, boxes) {
  let hits = 0, reversals = 0, bends = 0, length = 0;
  let prev = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const v = { x: q.x - p.x, y: q.y - p.y };
    const len = Math.abs(v.x) + Math.abs(v.y);
    if (len < 1e-6) continue;
    length += len;
    for (const box of boxes) if (segHitsBox(p, q, box)) hits++;
    if (prev) {
      const dot = prev.x * v.x + prev.y * v.y;
      if (dot < 0) reversals++;
      else if (dot === 0) bends++;
    }
    prev = v;
  }
  return hits * 1e6 + reversals * 1e5 + bends * 200 + length;
}

// Orthogonal path between exit A and exit B (each { pt, dir, box }; box is
// null for a free end). Attached ends get a stub out of their side; the stubs
// are then joined by whichever S- or L-shaped elbow avoids the shapes, doesn't
// double back, and has the fewest bends. Returns {x,y} points incl. endpoints.
function elbowRoute(a, b) {
  const a1 = a.box ? step(a.pt, a.dir, STUB) : a.pt;
  const b1 = b.box ? step(b.pt, b.dir, STUB) : b.pt;
  const mx = (a1.x + b1.x) / 2, my = (a1.y + b1.y) / 2;
  const sH = [{ x: mx, y: a1.y }, { x: mx, y: b1.y }];  // across, over, across
  const sV = [{ x: a1.x, y: my }, { x: b1.x, y: my }];  // down, over, down
  const lH = [{ x: b1.x, y: a1.y }];                    // across, then down
  const lV = [{ x: a1.x, y: b1.y }];                    // down, then across
  const horizA = a.dir === "e" || a.dir === "w";
  const horizB = b.dir === "e" || b.dir === "w";
  // Candidate order breaks ties toward the shape that fits the exit sides.
  const candidates = horizA && horizB ? [sH, lH, lV, sV]
    : !horizA && !horizB ? [sV, lV, lH, sH]
    : horizA ? [lH, lV, sH, sV] : [lV, lH, sV, sH];
  const boxes = [a.box, b.box].filter(Boolean);
  let best = null, bestCost = Infinity;
  for (const mid of candidates) {
    const pts = [a.pt, a1, ...mid, b1, b.pt];
    const cost = routeCost(pts, boxes);
    if (cost < bestCost) { bestCost = cost; best = pts; }
  }
  return best;
}

function approx(a, b) { return Math.abs(a - b) < 1e-6; }

// Drop coincident points and collapse three collinear points to two, so the
// emitted polyline carries only real corners. Each point may carry a `seg` tag
// (the anchor-interval index of the segment arriving at it); it's preserved so
// callers can map a rendered segment back to a waypoint insert position.
function cleanPath(pts) {
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && approx(last.x, p.x) && approx(last.y, p.y)) continue;
    dedup.push({ x: p.x, y: p.y, seg: p.seg });
  }
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = out[out.length - 1];
    const cur = dedup[i];
    const next = dedup[i + 1];
    if (prev && next) {
      const collinearH = approx(prev.y, cur.y) && approx(cur.y, next.y);
      const collinearV = approx(prev.x, cur.x) && approx(cur.x, next.x);
      if (collinearH || collinearV) continue; // redundant midpoint on a straight leg
    }
    out.push(cur);
  }
  return out.length >= 2 ? out : dedup;
}

// fromPort / toPort: canvas-space {x, y, dir} of a fixed connection point (the
// connector leaves it along `dir`), or null to exit from the facing edge.
export function routeOrthogonal(fromBox, toBox, fromPt, toPt, waypoints, fromPort = null, toPort = null) {
  const fromCenter = fromPort || (fromBox ? centerOf(fromBox) : fromPt);
  const toCenter = toPort || (toBox ? centerOf(toBox) : toPt);
  if (!fromCenter || !toCenter) return { valid: false };

  const wps = Array.isArray(waypoints)
    ? waypoints.filter(w => w && isFinite(w.x) && isFinite(w.y))
    : [];

  // Aim each exit at the nearest fixed target (first/last waypoint, else the
  // opposite end's center) so the connector leaves toward where it's going.
  const firstTarget = wps.length ? wps[0] : toCenter;
  const lastTarget = wps.length ? wps[wps.length - 1] : fromCenter;
  const a = fromPort ? { pt: { x: fromPort.x, y: fromPort.y }, dir: fromPort.dir }
    : fromBox ? orthExit(fromBox, firstTarget) : { pt: fromPt, dir: dirToward(fromPt, firstTarget) };
  const b = toPort ? { pt: { x: toPort.x, y: toPort.y }, dir: toPort.dir }
    : toBox ? orthExit(toBox, lastTarget) : { pt: toPt, dir: dirToward(toPt, lastTarget) };
  a.box = fromBox;
  b.box = toBox;
  if (!a.pt || !b.pt) return { valid: false };

  // Build the raw corner list, tagging each point with `seg` = the anchor
  // interval its arriving segment lies in. Interval i sits between anchors[i]
  // and anchors[i+1]; a point dropped on a segment in interval i inserts at
  // waypoint index i (waypoints are anchors[1..wps.length]).
  let raw;
  if (wps.length === 0) {
    raw = elbowRoute(a, b).map(p => ({ ...p, seg: 0 }));
  } else {
    const anchors = [a.pt, ...wps, b.pt];
    raw = [{ x: anchors[0].x, y: anchors[0].y, seg: 0 }];
    for (let i = 0; i < anchors.length - 1; i++) {
      const p = anchors[i], q = anchors[i + 1];
      if (!approx(p.x, q.x) && !approx(p.y, q.y)) {
        const c = i % 2 === 0 ? { x: q.x, y: p.y } : { x: p.x, y: q.y };
        raw.push({ ...c, seg: i });
      }
      raw.push({ x: q.x, y: q.y, seg: i });
    }
  }

  const clean = cleanPath(raw);
  const points = clean.map(p => [p.x, p.y]);
  // segInsert[i] = waypoint insert index for a point dropped on segment i
  // (between points[i] and points[i+1]); taken from the segment's end tag.
  const segInsert = [];
  for (let i = 1; i < clean.length; i++) segInsert.push(clean[i].seg ?? wps.length);
  return { points, segInsert, valid: true };
}
