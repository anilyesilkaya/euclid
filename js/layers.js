// Illustrator-style layers panel. Renders the doc tree top-down with front-on-top order
// (i.e., last child in state = first row in the panel, matching paint stack visuals).

import { getDoc, getSelection, setSelection, toggleSelection } from "./state.js";
import { openContextMenu } from "./tools.js";

const collapsed = new Set(); // group ids currently collapsed in the panel

let listEl;

export function mount(root) {
  listEl = root.querySelector("#layers-list");
  if (!listEl) return;
  listEl.addEventListener("click", onClick);
  listEl.addEventListener("contextmenu", onContext);
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
