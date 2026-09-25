// Illustrator-style layers panel. Renders the doc tree top-down with front-on-top order
// (i.e., last child in state = first row in the panel, matching paint stack visuals).

import { getDoc, getSelection, setSelection, toggleSelection, mutate, findNode, findParent } from "./state.js";
import * as history from "./history.js";
import { openContextMenu } from "./tools.js";

const collapsed = new Set(); // group ids currently collapsed in the panel
const DRAG_THRESHOLD = 4;    // px the pointer must travel before a drag "takes"

let listEl;
// Drag-to-reorder state.
let dragCandidate = null;    // { id, startX, startY } between pointerdown and threshold
let drag = null;             // active drag: { id, parent, siblingRows, indicator, dropIndex }
let suppressClick = false;   // set true after a real drag so the trailing click doesn't reselect

export function mount(root) {
  listEl = root.querySelector("#layers-list");
  if (!listEl) return;
  listEl.addEventListener("click", onClick);
  listEl.addEventListener("contextmenu", onContext);
  listEl.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

export function refresh() {
  if (!listEl) return;
  const doc = getDoc();
  const sel = getSelection();
  // Purge stale collapsed entries so ids of deleted groups don't linger.
  const alive = new Set();
  walkDoc(doc, (n) => alive.add(n.id));
  for (const id of collapsed) if (!alive.has(id)) collapsed.delete(id);

  listEl.innerHTML = "";
  if (!doc.children || doc.children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "layers-empty";
    empty.textContent = "No layers";
    listEl.appendChild(empty);
    return;
  }
  // Render top-down = reverse of paint order (last painted = topmost row).
  for (let i = doc.children.length - 1; i >= 0; i--) {
    renderNode(doc.children[i], 0, sel, listEl);
  }
}

function renderNode(node, depth, sel, container) {
  const row = document.createElement("div");
  const isGroup = node.type === "group";
  const isCollapsed = isGroup && collapsed.has(node.id);
  row.className = "layer-row" + (sel.has(node.id) ? " selected" : "") + (isCollapsed ? " collapsed" : "");
  row.dataset.id = node.id;
  row.style.paddingLeft = `${4 + depth * 14}px`;

  const caret = document.createElement("span");
  caret.className = "layer-caret" + (isGroup ? "" : " leaf");
  caret.innerHTML = isGroup
    ? `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 4.5 L6 8 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : "";
  if (isGroup) caret.dataset.role = "caret";
  row.appendChild(caret);

  const icon = document.createElement("span");
  icon.className = "layer-icon";
  icon.innerHTML = iconFor(node);
  row.appendChild(icon);

  const name = document.createElement("span");
  const label = labelFor(node);
  name.className = "layer-name" + (label.placeholder ? " placeholder" : "");
  name.textContent = label.text;
  row.appendChild(name);

  container.appendChild(row);

  if (isGroup && !isCollapsed && node.children) {
    for (let i = node.children.length - 1; i >= 0; i--) {
      renderNode(node.children[i], depth + 1, sel, container);
    }
  }
}

function iconFor(node) {
  const s = (path) => `<svg viewBox="0 0 14 14" width="12" height="12">${path}</svg>`;
  const stroke = `fill="none" stroke="currentColor" stroke-width="1.4"`;
  switch (node.type) {
    case "rect":     return s(`<rect x="2" y="3" width="10" height="8" ${stroke}/>`);
    case "circle":   return s(`<circle cx="7" cy="7" r="5" ${stroke}/>`);
    case "ellipse":  return s(`<ellipse cx="7" cy="7" rx="5.5" ry="3.5" ${stroke}/>`);
    case "line":     return s(`<line x1="2" y1="11" x2="12" y2="3" ${stroke}/>`);
    case "connector":return s(`<line x1="2" y1="11" x2="10" y2="3" ${stroke}/><path d="M8,1.5 12,3 10.5,6.5z" fill="currentColor"/>`);
    case "polyline": return s(`<polyline points="2,10 5,5 9,8 12,3" ${stroke}/>`);
    case "path":     return s(`<path d="M2,10 C4,4 9,4 12,10" ${stroke}/>`);
    case "text":     return s(`<text x="7" y="11" text-anchor="middle" font-family="serif" font-size="12" font-weight="700" fill="currentColor">T</text>`);
    case "group":    return s(`<rect x="2" y="4" width="8" height="7" ${stroke}/><rect x="4" y="2" width="8" height="7" ${stroke}/>`);
    default:         return s(`<circle cx="7" cy="7" r="1.5" fill="currentColor"/>`);
  }
}

function labelFor(node) {
  if (node.type === "text") {
    const t = (node.text || "").trim();
    return t ? { text: truncate(t, 40) } : { text: "<empty text>", placeholder: true };
  }
  if (node.label) return { text: truncate(node.label, 40) };
  if (node.type === "group") {
    const n = node.children?.length || 0;
    return { text: `Group · ${n} item${n === 1 ? "" : "s"}`, placeholder: true };
  }
  return { text: capitalize(node.type), placeholder: true };
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function walkDoc(node, cb) {
  cb(node);
  if (node.children) for (const c of node.children) walkDoc(c, cb);
}

// --- Event handlers ---

function onClick(e) {
  // A drag just finished — swallow the synthetic click so it doesn't reselect.
  if (suppressClick) { suppressClick = false; e.stopPropagation(); return; }
  const caret = e.target.closest('[data-role="caret"]');
  if (caret) {
    const row = caret.closest(".layer-row");
    if (row) toggleCollapse(row.dataset.id);
    e.stopPropagation();
    return;
  }
  const row = e.target.closest(".layer-row");
  if (!row) return;
  const id = row.dataset.id;
  if (!id) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    toggleSelection(id);
  } else {
    setSelection([id]);
  }
}

function onContext(e) {
  const row = e.target.closest(".layer-row");
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.id;
  if (!id) return;
  if (!getSelection().has(id)) setSelection([id]);
  openContextMenu(e.clientX, e.clientY, id);
}

function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  refresh();
}

// --- Drag to reorder ---
//
// Pointer-based (not HTML5 DnD) so it works uniformly and is scriptable in tests.
// Reordering is constrained to SIBLINGS under the same parent — the common case
// (restacking root layers, or reordering within a group). Cross-parent reparenting
// is intentionally out of scope for now; a drop is only shown among the dragged
// row's own siblings. Panel order is top-down = reverse paint order, so the
// top-most sibling row is the LAST child in state.

function onPointerDown(e) {
  if (e.button !== 0) return;
  // Don't start a drag from the collapse caret — that's a click affordance.
  if (e.target.closest('[data-role="caret"]')) return;
  const row = e.target.closest(".layer-row");
  if (!row || !row.dataset.id) return;
  dragCandidate = { id: row.dataset.id, startX: e.clientX, startY: e.clientY };
}

function onPointerMove(e) {
  if (!drag) {
    if (!dragCandidate) return;
    const dx = e.clientX - dragCandidate.startX;
    const dy = e.clientY - dragCandidate.startY;
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    if (!beginDrag(dragCandidate.id)) { dragCandidate = null; return; }
  }
  updateDropTarget(e.clientY);
}

function onPointerUp() {
  dragCandidate = null;
  if (!drag) return;
  const d = drag;
  endDrag();
  commitReorder(d);
}

// Snapshot the dragged node's parent + the DOM rows of its siblings (self excluded).
// Returns false if the node can't be reordered (e.g. a lone child).
function beginDrag(id) {
  const doc = getDoc();
  const node = findNode(doc, id);
  if (!node) return false;
  const parent = findParent(doc, id) || doc;
  if (!parent.children || parent.children.length < 2) return false;

  const row = listEl.querySelector(`.layer-row[data-id="${cssEscape(id)}"]`);
  if (!row) return false;
  row.classList.add("dragging");

  // Sibling rows (excluding the dragged one), in panel/DOM order (top-down).
  const siblingIds = new Set(parent.children.map(c => c.id));
  const siblingRows = [...listEl.querySelectorAll(".layer-row")]
    .filter(r => r.dataset.id !== id && siblingIds.has(r.dataset.id));

  const indicator = document.createElement("div");
  indicator.className = "layer-drop-indicator";
  listEl.appendChild(indicator);

  listEl.classList.add("reordering");
  drag = { id, parent, siblingRows, indicator, dropIndex: 0 };
  suppressClick = true;
  return true;
}

// Map the pointer's Y to an insertion slot among the sibling rows (0..N), and
// place the indicator line at that boundary. dropIndex counts, top-down, how many
// sibling rows sit above the pointer — i.e. the gap the dragged row would land in.
function updateDropTarget(clientY) {
  const rows = drag.siblingRows;
  let idx = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = i; break; }
  }
  drag.dropIndex = idx;

  const listRect = listEl.getBoundingClientRect();
  let top;
  if (rows.length === 0) {
    top = 2;
  } else if (idx >= rows.length) {
    const r = rows[rows.length - 1].getBoundingClientRect();
    top = r.bottom - listRect.top + listEl.scrollTop;
  } else {
    const r = rows[idx].getBoundingClientRect();
    top = r.top - listRect.top + listEl.scrollTop;
  }
  drag.indicator.style.top = `${top}px`;
}

function endDrag() {
  const row = listEl.querySelector(`.layer-row[data-id="${cssEscape(drag.id)}"]`);
  if (row) row.classList.remove("dragging");
  try { drag.indicator.remove(); } catch { /* already gone */ }
  listEl.classList.remove("reordering");
  drag = null;
}

// Rebuild the parent's children from the new sibling order. siblingRows are in
// panel order (top-down); state paint order is the reverse. Insert the dragged id
// at dropIndex within the top-down sibling sequence, then reverse to paint order.
function commitReorder(d) {
  const topDownSiblings = d.siblingRows.map(r => r.dataset.id);
  topDownSiblings.splice(d.dropIndex, 0, d.id);
  const newPaintOrder = topDownSiblings.slice().reverse();

  const parentId = d.parent.id;
  const doc = getDoc();
  const parentNow = parentId === doc.id ? doc : findNode(doc, parentId);
  if (!parentNow || !parentNow.children) return;
  // No-op if the order is unchanged.
  const current = parentNow.children.map(c => c.id);
  if (current.length === newPaintOrder.length && current.every((id, i) => id === newPaintOrder[i])) return;

  history.record(() => {
    mutate((root) => {
      const parent = parentId === root.id ? root : findNode(root, parentId);
      if (!parent || !parent.children) return;
      const byId = new Map(parent.children.map(c => [c.id, c]));
      const reordered = newPaintOrder.map(id => byId.get(id)).filter(Boolean);
      // Guard: only swap in the rebuilt array if it accounts for every child.
      if (reordered.length === parent.children.length) parent.children = reordered;
    });
  });
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
