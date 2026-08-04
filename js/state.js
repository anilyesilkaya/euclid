// Document tree + selection + observer pub/sub.
// The tree here is authoritative. render.js, ui.js, export.js all read from it.

const subscribers = new Set();

let doc = makeRoot();
let selection = new Set();

function makeRoot() {
  return { id: "root", type: "group", attrs: {}, transform: emptyTransform(), children: [] };
}

export function emptyTransform() {
  return { tx: 0, ty: 0, rot: 0, cx: 0, cy: 0 };
}

export function newId(prefix = "n") {
  const rand = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2)).slice(0, 8);
  return `${prefix}_${rand}`;
}

export function getDoc() { return doc; }
export function getSelection() { return selection; }

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function notify() {
  for (const cb of subscribers) cb();
}

// Every write goes through here. fn receives a deep-cloned root and mutates it in place.
export function mutate(fn) {
  const draft = structuredClone(doc);
  fn(draft);
  doc = draft;
  notify();
}

// History uses these to swap the root wholesale.
export function replaceRoot(newRoot) {
  doc = newRoot;
  // Purge selection entries that no longer exist.
  const alive = new Set();
  walk(doc, (n) => alive.add(n.id));
  const filtered = new Set();
  for (const id of selection) if (alive.has(id)) filtered.add(id);
  selection = filtered;
  notify();
}

export function snapshot() {
  return structuredClone(doc);
}

// Selection API — not part of doc, not part of history.
export function setSelection(ids) {
  selection = new Set(ids);
  notify();
}
export function toggleSelection(id) {
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  notify();
}
export function clearSelection() {
  if (selection.size === 0) return;
  selection = new Set();
  notify();
}

// Tree helpers.
export function walk(node, cb) {
  cb(node);
  if (node.children) for (const c of node.children) walk(c, cb);
}

export function findNode(root, id) {
  if (root.id === id) return root;
  if (!root.children) return null;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root, id) {
  if (!root.children) return null;
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = findParent(c, id);
    if (hit) return hit;
  }
  return null;
}

// Return [rootChild, ..., node] — the ancestor chain (root excluded).
export function findPath(root, id, path = []) {
  if (root.id === id) return path;
  if (!root.children) return null;
  for (const c of root.children) {
    const hit = findPath(c, id, [...path, c]);
    if (hit) return hit;
  }
  return null;
}

// Top-level ancestor of id (the child of root that contains id, or id itself if top-level).
export function topAncestor(root, id) {
  const path = findPath(root, id);
  return path && path.length > 0 ? path[0] : null;
}

// Remove nodes with given ids from the tree; return array of {parent, index, node} for each removed.
export function removeByIds(root, ids) {
  const removed = [];
  function rec(parent) {
    if (!parent.children) return;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const c = parent.children[i];
      if (ids.has(c.id)) {
        removed.push({ parent, index: i, node: c });
        parent.children.splice(i, 1);
      } else {
        rec(c);
      }
    }
  }
  rec(root);
  return removed;
}
