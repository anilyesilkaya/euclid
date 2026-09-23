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
