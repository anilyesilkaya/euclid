// Viewport: owns the canvas SVG viewBox — zoom and pan.
//
// The document model lives in user-unit "canvas space" (the fixed 1000x700
// world). Zoom/pan is purely a *view* concern: we move the viewBox window over
// that world and never touch the model. Because every gesture in tools.js and
// every measurement in render.js goes through getScreenCTM()/viewBox math, they
// keep working unchanged at any zoom or scroll offset.
//
// The serializer's DEFAULT_VIEWBOX (0 0 1000 700) is intentionally NOT tied to
// this — exported SVG always frames the world, not the current view.

const WORLD = { x: 0, y: 0, width: 1000, height: 700 };
const MIN_SCALE = 0.1;   // 10%
const MAX_SCALE = 16;    // 1600%
const ZOOM_STEP = 1.2;   // multiplicative step for buttons / keyboard

let svg;
// Current viewBox in world units. scale = world-units-per-... no: scale is
// screenPx/worldUnit derived from viewport width / vb.width. We store the
// viewBox directly and derive scale on demand.
let vb = { ...WORLD };

let onChange = null;     // callback fired after any view change (updates readout)

// Pan gesture state
let panning = null;      // { startClientX, startClientY, startVb } while dragging
let spaceDown = false;

export function mount(svgEl, changeCb) {
  svg = svgEl;
  onChange = changeCb || null;

  applyViewBox();

  // Wheel: Ctrl/Cmd+wheel = zoom at cursor; plain wheel = pan (trackpad two-finger).
  svg.addEventListener("wheel", onWheel, { passive: false });

  // Middle-mouse drag, or Space+left-drag, pans. Capture phase so we can claim
  // the gesture before tools.js sees the pointerdown.
  svg.addEventListener("pointerdown", onPointerDownCapture, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUpCapture, true);

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}

// --- viewBox application & readout ---

function applyViewBox() {
  svg.setAttribute("viewBox", `${r(vb.x)} ${r(vb.y)} ${r(vb.width)} ${r(vb.height)}`);
  if (onChange) onChange(getScale());
}

function getScale() {
  // Screen px per world unit along X (uniform — preserveAspectRatio keeps it square).
  const rect = svg.getBoundingClientRect();
  return rect.width > 0 && vb.width > 0 ? rect.width / vb.width : 1;
}

export function getZoomPercent() {
  return Math.round(getScale() * 100);
}

// --- zoom primitives ---

// Zoom so that world point (wx, wy) stays under the same screen pixel.
function zoomAtWorld(wx, wy, factor) {
  const curScale = getScale();
  let targetScale = clamp(curScale * factor, MIN_SCALE, MAX_SCALE);
  if (targetScale === curScale) return;
  const rect = svg.getBoundingClientRect();
  // New viewBox dimensions from target scale (screenPx / scale = worldUnits).
  const newW = rect.width / targetScale;
  const newH = rect.height / targetScale;
  // Fraction of the point within the current viewBox — keep it fixed.
  const fx = (wx - vb.x) / vb.width;
  const fy = (wy - vb.y) / vb.height;
  vb = { x: wx - fx * newW, y: wy - fy * newH, width: newW, height: newH };
  applyViewBox();
}

// Convert a client (screen) point to world coords under the current viewBox.
function clientToWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  return { x: vb.x + fx * vb.width, y: vb.y + fy * vb.height };
}

// --- wheel ---

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Zoom at cursor. deltaY<0 = wheel up = zoom in.
    const w = clientToWorld(e.clientX, e.clientY);
    const factor = Math.pow(ZOOM_STEP, -e.deltaY / 100);
    zoomAtWorld(w.x, w.y, factor);
  } else {
    // Pan. Convert pixel deltas to world units. Shift swaps axes (common on
    // mice with only a vertical wheel who want horizontal scroll).
    const scale = getScale();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
    vb = { ...vb, x: vb.x + dx / scale, y: vb.y + dy / scale };
    applyViewBox();
  }
}

// --- pan via pointer (middle mouse, or Space+left) ---

function onPointerDownCapture(e) {
  const isMiddle = e.button === 1;
  const isSpaceLeft = e.button === 0 && spaceDown;
  if (!isMiddle && !isSpaceLeft) return;
  // Claim the gesture: stop tools.js from starting a draw/marquee/move.
  e.preventDefault();
  e.stopPropagation();
  panning = { startClientX: e.clientX, startClientY: e.clientY, startVb: { ...vb } };
  svg.classList.add("panning");
  try { svg.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
}

function onPointerMove(e) {
  if (!panning) return;
  const scale = getScale();
  const dx = (e.clientX - panning.startClientX) / scale;
  const dy = (e.clientY - panning.startClientY) / scale;
  vb = { ...vb, x: panning.startVb.x - dx, y: panning.startVb.y - dy };
  applyViewBox();
}

function onPointerUpCapture(e) {
  if (!panning) return;
  panning = null;
  svg.classList.remove("panning");
  e.stopPropagation();
}

// --- keyboard ---

function onKeyDown(e) {
  if (e.code === "Space" && !isEditable(e.target)) {
    spaceDown = true;
    svg.classList.add("space-pan");
    // Don't preventDefault globally — only matters over canvas; harmless otherwise.
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === "0") {           // Ctrl+0 → fit
    e.preventDefault();
    fit();
  } else if (e.key === ")" || (e.shiftKey && e.key === "0")) {
    e.preventDefault();
    resetZoom();               // Ctrl+Shift+0 → 100%
  } else if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    zoomInCentered();
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    zoomOutCentered();
  }
}

function onKeyUp(e) {
  if (e.code === "Space") {
    spaceDown = false;
    svg.classList.remove("space-pan");
  }
}

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// --- public commands (buttons + keyboard) ---

function centerWorld() {
  return { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
}

export function zoomInCentered() {
  const c = centerWorld();
  zoomAtWorld(c.x, c.y, ZOOM_STEP);
}
export function zoomOutCentered() {
  const c = centerWorld();
  zoomAtWorld(c.x, c.y, 1 / ZOOM_STEP);
}

// Reset to 100% (1 world unit = 1 screen px), centered on the current view center.
export function resetZoom() {
  const rect = svg.getBoundingClientRect();
  const c = centerWorld();
  const newW = rect.width, newH = rect.height;
  vb = { x: c.x - newW / 2, y: c.y - newH / 2, width: newW, height: newH };
  applyViewBox();
}

// Fit the whole world (1000x700) into the viewport with a small margin.
export function fit() {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) { vb = { ...WORLD }; return applyViewBox(); }
  const margin = 0.06; // 6% breathing room
  const worldAR = WORLD.width / WORLD.height;
  const viewAR = rect.width / rect.height;
  let w, h;
  if (viewAR > worldAR) {
    // Viewport wider than world → height-constrained.
    h = WORLD.height * (1 + margin * 2);
    w = h * viewAR;
  } else {
    w = WORLD.width * (1 + margin * 2);
    h = w / viewAR;
  }
  vb = { x: WORLD.x + WORLD.width / 2 - w / 2, y: WORLD.y + WORLD.height / 2 - h / 2, width: w, height: h };
  applyViewBox();
}

// Set an exact zoom percentage, keeping the view center fixed.
export function setZoomPercent(pct) {
  const target = clamp(pct / 100, MIN_SCALE, MAX_SCALE);
  const c = centerWorld();
  zoomAtWorld(c.x, c.y, target / getScale());
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r(n) { return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1000) / 1000; }
