// Connector geometry — pure functions, no DOM.
//
// A connector links two endpoints. Each endpoint is either attached to a shape
// (routed to the nearest point on that shape's axis-aligned bounding box, draw.io
// "floating" style) or pinned to a free point. Geometry is always derived from the
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

// Resolve a straight connector's two endpoints.
//   fromBox / toBox : canvas-space AABBs of attached shapes, or null if that end
//                     is a free point.
//   fromPt / toPt   : free-point fallbacks {x,y} (used when the box is null).
// Returns { x1, y1, x2, y2, valid }. valid is false when an endpoint can't be
// resolved (e.g. an attached shape that no longer exists).
export function routeStraight(fromBox, toBox, fromPt, toPt) {
  const fromCenter = fromBox ? centerOf(fromBox) : fromPt;
  const toCenter = toBox ? centerOf(toBox) : toPt;
  if (!fromCenter || !toCenter) return { valid: false };

  const from = fromBox ? borderPoint(fromBox, toCenter.x, toCenter.y) : fromPt;
  const to = toBox ? borderPoint(toBox, fromCenter.x, fromCenter.y) : toPt;
  if (!from || !to) return { valid: false };

  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, valid: true };
}

// --- Orthogonal (elbow) routing ---------------------------------------------
//
// Route two endpoints with axis-aligned segments (draw.io "orthogonal" edges).
// Each attached endpoint leaves from the midpoint of the box edge that faces the
// far endpoint (or the nearest waypoint); the exit points are then joined by
// horizontal/vertical legs. Optional `waypoints` ([{x,y},...] in canvas space)
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

// Corner sequence joining exit A (leaving along dirA) to exit B (leaving along
// dirB). Same exit axis → an S-shape through the midline; differing axes → a
// single-corner L. Returns {x,y} points including both endpoints.
function elbowPoints(a, dirA, b, dirB) {
  const horizA = dirA === "e" || dirA === "w";
  const horizB = dirB === "e" || dirB === "w";
  const pts = [a];
  if (horizA && horizB) {
    const midX = (a.x + b.x) / 2;
    pts.push({ x: midX, y: a.y }, { x: midX, y: b.y });
  } else if (!horizA && !horizB) {
    const midY = (a.y + b.y) / 2;
    pts.push({ x: a.x, y: midY }, { x: b.x, y: midY });
  } else if (horizA && !horizB) {
    pts.push({ x: b.x, y: a.y });
  } else {
    pts.push({ x: a.x, y: b.y });
  }
  pts.push(b);
  return pts;
}

function approx(a, b) { return Math.abs(a - b) < 1e-6; }

// Drop coincident points and collapse three collinear points to two, so the
// emitted polyline carries only real corners.
function cleanPath(pts) {
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && approx(last.x, p.x) && approx(last.y, p.y)) continue;
    dedup.push({ x: p.x, y: p.y });
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

export function routeOrthogonal(fromBox, toBox, fromPt, toPt, waypoints) {
  const fromCenter = fromBox ? centerOf(fromBox) : fromPt;
  const toCenter = toBox ? centerOf(toBox) : toPt;
  if (!fromCenter || !toCenter) return { valid: false };

  const wps = Array.isArray(waypoints)
    ? waypoints.filter(w => w && isFinite(w.x) && isFinite(w.y))
    : [];

  // Aim each exit at the nearest fixed target (first/last waypoint, else the
  // opposite end's center) so the connector leaves toward where it's going.
  const firstTarget = wps.length ? wps[0] : toCenter;
  const lastTarget = wps.length ? wps[wps.length - 1] : fromCenter;
  const a = fromBox ? orthExit(fromBox, firstTarget) : { pt: fromPt, dir: dirToward(fromPt, firstTarget) };
  const b = toBox ? orthExit(toBox, lastTarget) : { pt: toPt, dir: dirToward(toPt, lastTarget) };
  if (!a.pt || !b.pt) return { valid: false };

  let raw;
  if (wps.length === 0) {
    raw = elbowPoints(a.pt, a.dir, b.pt, b.dir);
  } else {
    // Chain A → waypoints → B, orthogonalizing each leg with an alternating
    // staircase corner so no segment runs diagonally.
    const anchors = [a.pt, ...wps, b.pt];
    raw = [anchors[0]];
    for (let i = 0; i < anchors.length - 1; i++) {
      const p = anchors[i], q = anchors[i + 1];
      if (!approx(p.x, q.x) && !approx(p.y, q.y)) {
        raw.push(i % 2 === 0 ? { x: q.x, y: p.y } : { x: p.x, y: q.y });
      }
      raw.push(q);
    }
  }

  const points = cleanPath(raw).map(p => [p.x, p.y]);
  return { points, valid: true };
}
