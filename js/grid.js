// Grid + snap-to-grid.
//
// The grid is a pure VIEW concern (like viewport.js): it lives in document/world
// units, is drawn once as an SVG <pattern>, and scales with the viewBox on zoom —
// so nothing here re-runs on pan/zoom. The model is never touched, and export
// walks the model, so the grid never leaks into exported SVG.
//
// Snapping is opt-in and independent of visibility (you can snap to an invisible
// grid, or show a grid you don't snap to — matching draw.io). Gesture code in
// tools.js calls snapPoint()/snapDelta() and honors the same Alt-to-bypass
// convention already used for smart guides.

const GRID_SIZE = 10;        // world units per minor cell; matches #grid-minor in the markup
const STORAGE_VISIBLE = "euclid.grid.visible";
const STORAGE_SNAP = "euclid.grid.snap";

let gridRect = null;         // the <rect fill="url(#grid-major)"> overlay
let visible = false;
let snap = false;
const listeners = [];        // fired after visible/snap changes so the UI can reflect state

export function mount(svg) {
  gridRect = svg.querySelector("#grid-rect");

  // Restore persisted preferences (localStorage is unavailable over some file://
  // configurations — degrade silently to defaults).
  visible = readBool(STORAGE_VISIBLE, false);
  snap = readBool(STORAGE_SNAP, false);
  applyVisible();
  emit();
}

// Register a listener called with {visible, snap} on every change.
export function onStateChange(fn) {
  if (typeof fn === "function") listeners.push(fn);
}
function emit() {
  const s = getState();
  for (const fn of listeners) fn(s);
}

// --- state ---

export function getGridSize() { return GRID_SIZE; }
export function isVisible() { return visible; }
export function isSnap() { return snap; }
export function getState() { return { visible, snap }; }

export function setVisible(on) {
  visible = !!on;
  applyVisible();
  writeBool(STORAGE_VISIBLE, visible);
  emit();
}

export function setSnap(on) {
  snap = !!on;
  writeBool(STORAGE_SNAP, snap);
  emit();
}

export function toggleVisible() { setVisible(!visible); }
export function toggleSnap() { setSnap(!snap); }

function applyVisible() {
  if (gridRect) gridRect.style.display = visible ? "" : "none";
}

// --- snapping primitives (used by tools.js gestures) ---

// Round a single scalar to the nearest grid line.
export function snapScalar(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

// Snap an absolute point to the nearest grid intersection. No-op unless snap is on.
export function snapPoint(x, y) {
  if (!snap) return { x, y };
  return { x: snapScalar(x), y: snapScalar(y) };
}

// Given a bbox at its dragged (proposed) position, return the (dx, dy) that would
// align its top-left corner to the grid. No-op unless snap is on. Callers add this
// to their raw delta — the same shape guides.computeSnap() returns.
export function snapDelta(bbox) {
  if (!snap || !bbox) return { dx: 0, dy: 0 };
  return {
    dx: snapScalar(bbox.x) - bbox.x,
    dy: snapScalar(bbox.y) - bbox.y,
  };
}

function readBool(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch { return fallback; }
}
function writeBool(key, val) {
  try { window.localStorage.setItem(key, val ? "1" : "0"); } catch { /* ignore */ }
}
