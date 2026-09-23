// Palette buttons, property panel, keyboard shortcuts, grouping, and clipboard.

import {
  getDoc, getSelection, setSelection, clearSelection,
  mutate, newId, findNode, findParent, findPath, walk, removeByIds, emptyTransform,
} from "./state.js";
import * as history from "./history.js";
import { setTool, getTool, cancelPolyline, isTextEditing, openLabelEditor } from "./tools.js";
import { align } from "./align.js";

const TOOL_KEYS = { v: "select", r: "rect", e: "ellipse", l: "line", p: "polyline", t: "text" };

let propsEmpty, propsForm, pFill, pFillNone, pStroke, pStrokeNone, pStrokeWidth, pOpacity, pOpacityNum;
let pText, pFontSize, pFontFamily, pTextColor, pRotation;
let clipboard = null;
let gridApi = null;   // set by mountGrid; used by keyboard shortcuts

export function mount(root) {
  wireToolbar(root);
  wireProperties(root);
  wireKeyboard();
  wireCollapsibles(root);
  document.addEventListener("tool-changed", (e) => reflectToolInUI(e.detail));
  reflectToolInUI(getTool());
}

// Collapsible side sections (Layers, SVG source). The section's own `collapsed`
// class hides its body; a matching class on #side re-flows the grid so the
// expanded section takes the freed space. Initial state comes from the markup.
function wireCollapsibles(root) {
  const side = root.querySelector("#side");
  const toggles = root.querySelectorAll(".section-toggle[data-section]");
  const sectionOf = { layers: "#layers-section", source: "#source-section" };

  const sync = (name) => {
    const section = root.querySelector(sectionOf[name]);
    const btn = root.querySelector(`.section-toggle[data-section="${name}"]`);
    if (!section || !btn) return;
    const collapsed = section.classList.contains("collapsed");
    btn.setAttribute("aria-expanded", String(!collapsed));
    side?.classList.toggle(`${name}-collapsed`, collapsed);
  };

  for (const btn of toggles) {
    const name = btn.dataset.section;
    sync(name); // reflect initial markup state onto #side + aria
    btn.addEventListener("click", () => {
      root.querySelector(sectionOf[name])?.classList.toggle("collapsed");
      sync(name);
    });
  }
}

// Wire the zoom controls to the viewport module. The readout updates via the
// change callback the viewport fires on every view change.
export function mountViewport(viewport, svg) {
  const readout = document.getElementById("zoom-readout");
  viewport.mount(svg, (_scale) => {
    if (readout) readout.textContent = `${viewport.getZoomPercent()}%`;
  });

  const byId = (id) => document.getElementById(id);
  byId("zoom-in")?.addEventListener("click", () => viewport.zoomInCentered());
  byId("zoom-out")?.addEventListener("click", () => viewport.zoomOutCentered());
  byId("zoom-fit")?.addEventListener("click", () => viewport.fit());
  // Click the percentage to reset to 100%.
  readout?.addEventListener("click", () => viewport.resetZoom());

  // Start framed to the world.
  viewport.fit();
}

// Wire the grid + snap toggle buttons to the grid module. Button pressed-state
// mirrors the module's state via its change callback (also fires on mount so the
// buttons reflect any persisted preference).
export function mountGrid(grid) {
  gridApi = grid;
  const gridBtn = document.getElementById("grid-toggle");
  const snapBtn = document.getElementById("snap-toggle");

  const reflect = ({ visible, snap }) => {
    gridBtn?.setAttribute("aria-pressed", String(visible));
    gridBtn?.classList.toggle("active", visible);
    snapBtn?.setAttribute("aria-pressed", String(snap));
    snapBtn?.classList.toggle("active", snap);
  };
  grid.onStateChange(reflect);
  reflect(grid.getState());

  gridBtn?.addEventListener("click", () => grid.toggleVisible());
  snapBtn?.addEventListener("click", () => grid.toggleSnap());
}

function wireToolbar(root) {
  const btns = root.querySelectorAll("#toolbar .tool");
  for (const b of btns) {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  }
}

function reflectToolInUI(tool) {
  document.querySelectorAll("#toolbar .tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
}

function wireProperties(root) {
  propsEmpty = root.querySelector("#props-empty");
  propsForm = root.querySelector("#props-form");
  pFill = root.querySelector("#p-fill");
  pFillNone = root.querySelector("#p-fill-none");
  pStroke = root.querySelector("#p-stroke");
  pStrokeNone = root.querySelector("#p-stroke-none");
  pStrokeWidth = root.querySelector("#p-stroke-width");
  pOpacity = root.querySelector("#p-opacity");
  pOpacityNum = root.querySelector("#p-opacity-num");
  pText = root.querySelector("#p-text");
  pFontSize = root.querySelector("#p-font-size");
  pFontFamily = root.querySelector("#p-font-family");
  pTextColor = root.querySelector("#p-text-color");
  pRotation = root.querySelector("#p-rotation");

  pFill.addEventListener("input", () => applyToSelection("fill", pFill.value));
  pFill.addEventListener("change", () => historyCommitAfter(() => applyToSelection("fill", pFill.value)));
  pFillNone.addEventListener("change", () => historyRecord(() => applyToSelection("fill", pFillNone.checked ? "none" : pFill.value)));
  pStroke.addEventListener("input", () => applyToSelection("stroke", pStroke.value));
  pStroke.addEventListener("change", () => historyCommitAfter(() => applyToSelection("stroke", pStroke.value)));
  pStrokeNone.addEventListener("change", () => historyRecord(() => applyToSelection("stroke", pStrokeNone.checked ? "none" : pStroke.value)));
  pStrokeWidth.addEventListener("input", () => applyToSelection("stroke-width", Number(pStrokeWidth.value)));
  pStrokeWidth.addEventListener("change", () => historyCommitAfter(() => applyToSelection("stroke-width", Number(pStrokeWidth.value))));
  pOpacity.addEventListener("input", () => {
    pOpacityNum.value = pOpacity.value;
    applyToSelection("opacity", Number(pOpacity.value));
  });
  pOpacity.addEventListener("change", () => historyCommitAfter(() => applyToSelection("opacity", Number(pOpacity.value))));
  pOpacityNum.addEventListener("input", () => {
    const v = clampOpacity(pOpacityNum.value);
    if (v === null) return; // mid-typing / invalid — wait
    history.ensureTransaction();
    pOpacity.value = v;
    applyToSelection("opacity", v);
  });
  pOpacityNum.addEventListener("change", () => {
    const v = clampOpacity(pOpacityNum.value);
    if (v === null) { pOpacityNum.value = pOpacity.value; return; } // revert bad entry
    pOpacityNum.value = v;
    pOpacity.value = v;
    historyCommitAfter(() => applyToSelection("opacity", v));
  });

  // On mousedown of a slider/color, open a transaction so the drag becomes one history entry.
  for (const input of [pFill, pStroke, pStrokeWidth, pOpacity, pTextColor]) {
    input.addEventListener("pointerdown", () => history.beginTransaction());
  }

  // Text content: for text nodes writes .text; for other nodes writes .label.
  pText.addEventListener("input", () => applyTextContent(pText.value));
  pText.addEventListener("change", () => historyCommitAfter(() => applyTextContent(pText.value)));
  pText.addEventListener("pointerdown", () => history.beginTransaction());

  pFontSize.addEventListener("input", () => applyFontSize(Number(pFontSize.value)));
  pFontSize.addEventListener("change", () => historyCommitAfter(() => applyFontSize(Number(pFontSize.value))));
  pFontSize.addEventListener("pointerdown", () => history.beginTransaction());

  pFontFamily.addEventListener("change", () => historyRecord(() => applyFontFamily(pFontFamily.value)));

  pTextColor.addEventListener("input", () => applyTextColor(pTextColor.value));
  pTextColor.addEventListener("change", () => historyCommitAfter(() => applyTextColor(pTextColor.value)));

  // Rotation (degrees). Live-preview on input, one history entry per edit.
  pRotation.addEventListener("input", () => {
    const deg = normalizeAngle(pRotation.value);
    if (deg === null) return;
    history.ensureTransaction();
    applyRotation(deg);
  });
  pRotation.addEventListener("change", () => {
    const deg = normalizeAngle(pRotation.value);
    if (deg === null) { refreshPropertyPanel(); return; } // revert bad entry
    pRotation.value = deg;
    history.ensureTransaction(); // in case no `input` opened one (spinner, paste)
    applyRotation(deg);
    history.commit();
  });

  // Align buttons.
  const alignGrid = root.querySelector("#align-grid");
  alignGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".align-btn");
    if (!btn || btn.disabled) return;
    align(btn.dataset.align);
  });
}

function applyTextContent(value) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      if (n.type === "text") {
        n.text = value;
      } else {
        if (value && value.trim()) n.label = value;
        else delete n.label;
      }
    }
  });
}

function applyFontSize(value) {
  if (!(value > 0)) return;
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      if (n.type === "text") {
        n.attrs["font-size"] = value;
      } else if (n.label) {
        n.labelStyle = { ...(n.labelStyle || {}), "font-size": value };
      }
    }
  });
}

function applyFontFamily(value) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      if (n.type === "text") {
        n.attrs["font-family"] = value;
      } else if (n.label) {
        n.labelStyle = { ...(n.labelStyle || {}), "font-family": value };
      }
    }
  });
}

function applyRotation(deg) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  const docLayer = document.getElementById("doc-layer");
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      if (!n.transform) n.transform = emptyTransform();
      // Pivot around the shape's local bbox center — same convention as the
      // rotate handle in tools.js. Read it from the rendered element.
      const el = docLayer?.querySelector(`[data-id="${cssEscapeLocal(id)}"]`);
      if (el && typeof el.getBBox === "function") {
        try {
          const b = el.getBBox();
          n.transform.cx = b.x + b.width / 2;
          n.transform.cy = b.y + b.height / 2;
        } catch { /* not measurable — keep existing pivot */ }
      }
      n.transform.rot = deg;
    }
  });
}

function cssEscapeLocal(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

function applyTextColor(value) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      if (n.type === "text") {
        n.attrs.fill = value;
      } else if (n.label) {
        n.labelStyle = { ...(n.labelStyle || {}), fill: value };
      }
    }
  });
}

let commitScheduled = false;
function historyCommitAfter(fn) {
  fn();
  history.commit("prop edit");
}
function historyRecord(fn) {
  history.beginTransaction();
  fn();
  history.commit("prop edit");
}

function applyToSelection(key, value) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  mutate((root) => {
    for (const id of ids) {
      const n = findNode(root, id);
      if (!n) continue;
      // For groups, apply presentation to descendant shapes (skip nested-group opacity for opacity which is already valid on <g>).
      if (n.type === "group" && key !== "opacity") {
        walk(n, (node) => {
          if (node.type !== "group") node.attrs[key] = value;
        });
      } else {
        n.attrs[key] = value;
      }
    }
  });
}

export function refreshPropertyPanel() {
  const ids = [...getSelection()];
  if (ids.length === 0) {
    propsEmpty.hidden = false;
    propsForm.hidden = true;
    return;
  }
  propsEmpty.hidden = true;
  propsForm.hidden = false;

  // Distribute needs 3+ items; align always works (single-item aligns to canvas).
  const canDistribute = ids.length >= 3;
  document.querySelectorAll('#align-grid .align-btn[data-align^="dist-"]').forEach(b => {
    b.disabled = !canDistribute;
  });

  // Read from the first selected shape (or first descendant shape of a selected group).
  const doc = getDoc();
  let sample = null;
  for (const id of ids) {
    const n = findNode(doc, id);
    if (!n) continue;
    sample = firstShape(n);
    if (sample) break;
  }
  if (!sample) return;

  const fill = sample.attrs.fill ?? "#000000";
  const stroke = sample.attrs.stroke ?? "#000000";
  const sw = sample.attrs["stroke-width"] ?? 1;
  const op = sample.attrs.opacity ?? 1;

  pFillNone.checked = (fill === "none");
  pFill.value = normalizeColor(fill, "#88ccee");
  pStrokeNone.checked = (stroke === "none");
  pStroke.value = normalizeColor(stroke, "#222222");
  pStrokeWidth.value = sw;
  pOpacity.value = op;
  pOpacityNum.value = round2(op);

  // Rotation — read from the first selected node's transform. Don't clobber the
  // field while the user is typing in it (refresh fires on every live-preview mutate).
  const firstSel = findNode(doc, ids[0]);
  const rot = firstSel?.transform?.rot || 0;
  if (document.activeElement !== pRotation) pRotation.value = normalizeAngle(rot) ?? 0;

  // Text fields — read from the first selected node.
  const firstId = [...getSelection()][0];
  const firstNode = firstId ? findNode(doc, firstId) : null;
  if (!firstNode) return;
  if (firstNode.type === "text") {
    pText.value = firstNode.text ?? "";
    pFontSize.value = firstNode.attrs["font-size"] ?? 20;
    pFontFamily.value = firstNode.attrs["font-family"] ?? "sans-serif";
    pTextColor.value = normalizeColor(firstNode.attrs.fill, "#000000");
  } else {
    pText.value = firstNode.label ?? "";
    const ls = firstNode.labelStyle || {};
    pFontSize.value = ls["font-size"] ?? 16;
    pFontFamily.value = ls["font-family"] ?? "sans-serif";
    pTextColor.value = normalizeColor(ls.fill, "#000000");
  }
}

function firstShape(node) {
  if (node.type !== "group") return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const s = firstShape(c);
    if (s) return s;
  }
  return null;
}

// Parse the opacity number box → a clamped 0..1 number, or null if not yet a
// valid number (empty / mid-typing) so callers can hold off applying.
function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Parse the rotation box → degrees in (-180, 180], or null if not yet valid.
function normalizeAngle(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  n = ((n % 360) + 360) % 360;   // 0..360
  if (n > 180) n -= 360;         // -180..180 for a friendly readout
  return Math.round(n * 10) / 10;
}

function clampOpacity(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeColor(v, fallback) {
  if (typeof v !== "string") return fallback;
  if (v === "none") return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    // #abc -> #aabbcc
    return "#" + v.slice(1).split("").map(c => c + c).join("").toLowerCase();
  }
  return fallback;
}

// --- Keyboard ---

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (isEditableTarget(e.target)) return;
    if (isTextEditing()) return;

    const mod = e.ctrlKey || e.metaKey;

    // Tool shortcuts (no modifier).
    if (!mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); e.preventDefault(); return; }
    }

    if (e.key === "Escape") {
      cancelPolyline();
      setTool("select");
      clearSelection();
      e.preventDefault(); return;
    }

    if (e.key === "F2") {
      const ids = [...getSelection()];
      if (ids.length === 1) {
        const n = findNode(getDoc(), ids[0]);
        if (n) openLabelEditor(n);
      }
      e.preventDefault(); return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      deleteSelection();
      e.preventDefault(); return;
    }

    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      history.undo(); e.preventDefault(); return;
    }
    if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      history.redo(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      selectAll(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      duplicateSelection(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      copySelection(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      pasteClipboard(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
      groupSelection(); e.preventDefault(); return;
    }
    if (mod && e.key.toLowerCase() === "g" && e.shiftKey) {
      ungroupSelection(); e.preventDefault(); return;
    }
    // Ctrl+'  toggles grid; Ctrl+Shift+'  toggles snap-to-grid.
    if (mod && (e.key === "'" || e.key === '"')) {
      if (gridApi) { e.shiftKey ? gridApi.toggleSnap() : gridApi.toggleVisible(); }
      e.preventDefault(); return;
    }

    // Arrow nudge.
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      nudge(dx, dy);
      e.preventDefault(); return;
    }
  });
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

// --- Commands ---

function deleteSelection() {
  const ids = new Set(getSelection());
  if (ids.size === 0) return;
  history.record(() => {
    mutate((root) => { removeByIds(root, ids); });
  });
  clearSelection();
}

function selectAll() {
  const doc = getDoc();
  setSelection(doc.children.map(c => c.id));
}

function duplicateSelection() {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  const newIds = [];
  history.record(() => {
    mutate((root) => {
      // Duplicate each top-level selected node. For robustness we work on top ancestors.
      const seen = new Set();
      const topIds = new Set();
      for (const id of ids) {
        const path = findPath(root, id);
        if (!path || path.length === 0) continue;
        topIds.add(path[0].id);
      }
      for (const id of topIds) {
        const node = findNode(root, id);
        if (!node) continue;
        const copy = deepReId(node);
        // Nudge duplicates so they aren't perfectly stacked.
        if (!copy.transform) copy.transform = emptyTransform();
        copy.transform.tx = (copy.transform.tx || 0) + 10;
        copy.transform.ty = (copy.transform.ty || 0) + 10;
        root.children.push(copy);
        newIds.push(copy.id);
      }
    });
  });
  setSelection(newIds);
}

function deepReId(node) {
  const copy = structuredClone(node);
  walk(copy, (n) => { n.id = newId(n.type === "group" ? "g" : "n"); });
  return copy;
}

function copySelection() {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  const doc = getDoc();
  const nodes = [];
  const topIds = new Set();
  for (const id of ids) {
    const path = findPath(doc, id);
    if (!path || path.length === 0) continue;
    topIds.add(path[0].id);
  }
  for (const id of topIds) {
    const n = findNode(doc, id);
    if (n) nodes.push(structuredClone(n));
  }
  clipboard = nodes;
}

function pasteClipboard() {
  if (!clipboard || clipboard.length === 0) return;
  const newIds = [];
  history.record(() => {
    mutate((root) => {
      for (const src of clipboard) {
        const copy = deepReId(src);
        if (!copy.transform) copy.transform = emptyTransform();
        copy.transform.tx = (copy.transform.tx || 0) + 10;
        copy.transform.ty = (copy.transform.ty || 0) + 10;
        root.children.push(copy);
        newIds.push(copy.id);
      }
    });
  });
  setSelection(newIds);
}

function nudge(dx, dy) {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  history.record(() => {
    mutate((root) => {
      for (const id of ids) {
        const path = findPath(root, id);
        if (!path || path.length === 0) continue;
        const top = path[0];
        if (!top.transform) top.transform = emptyTransform();
        top.transform.tx = (top.transform.tx || 0) + dx;
        top.transform.ty = (top.transform.ty || 0) + dy;
      }
    });
  });
}

function groupSelection() {
  const ids = [...getSelection()];
  if (ids.length < 2) return;
  const gId = newId("g");
  history.record(() => {
    mutate((root) => {
      // Collect the top-level nodes to group (in current paint order).
      const topIds = new Set();
      for (const id of ids) {
        const path = findPath(root, id);
        if (!path || path.length === 0) continue;
        topIds.add(path[0].id);
      }
      const orderedTops = root.children.filter(c => topIds.has(c.id));
      if (orderedTops.length < 2) return;
      root.children = root.children.filter(c => !topIds.has(c.id));
      const group = {
        id: gId,
        type: "group",
        attrs: {},
        transform: emptyTransform(),
        children: orderedTops,
      };
      // Insert at the position of the topmost (last painted) member.
      const insertAt = root.children.length; // append; groups always land on top
      root.children.splice(insertAt, 0, group);
    });
  });
  setSelection([gId]);
}

function ungroupSelection() {
  const ids = [...getSelection()];
  if (ids.length === 0) return;
  const releasedIds = [];
  history.record(() => {
    mutate((root) => {
      for (const id of ids) {
        const node = findNode(root, id);
        if (!node || node.type !== "group") continue;
        const parent = findParent(root, id);
        if (!parent) continue;
        const idx = parent.children.indexOf(node);
        if (idx < 0) continue;
        // Bake group's transform onto each child by composing with the child's transform (translate + rotate).
        // Simple case: only translate — add group.tx to each child.tx. Rotation composition of two rotates
        // is non-trivial; for v1 we bake translation only and drop group rotation.
        const gtx = node.transform?.tx || 0;
        const gty = node.transform?.ty || 0;
        for (const c of node.children) {
          if (!c.transform) c.transform = emptyTransform();
          c.transform.tx = (c.transform.tx || 0) + gtx;
          c.transform.ty = (c.transform.ty || 0) + gty;
          releasedIds.push(c.id);
        }
        parent.children.splice(idx, 1, ...node.children);
      }
    });
  });
  setSelection(releasedIds);
}
