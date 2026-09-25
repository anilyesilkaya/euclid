(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // js/state.js
  var subscribers = /* @__PURE__ */ new Set();
  var doc = makeRoot();
  var selection = /* @__PURE__ */ new Set();
  function makeRoot() {
    return { id: "root", type: "group", attrs: {}, transform: emptyTransform(), children: [] };
  }
  function emptyTransform() {
    return { tx: 0, ty: 0, rot: 0, cx: 0, cy: 0 };
  }
  function newId(prefix = "n") {
    const rand = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2)).slice(0, 8);
    return `${prefix}_${rand}`;
  }
  function getDoc() {
    return doc;
  }
  function getSelection() {
    return selection;
  }
  function subscribe(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }
  function notify() {
    for (const cb of subscribers) cb();
  }
  function mutate(fn) {
    const draft = structuredClone(doc);
    fn(draft);
    doc = draft;
    notify();
  }
  function replaceRoot(newRoot) {
    doc = newRoot;
    const alive = /* @__PURE__ */ new Set();
    walk(doc, (n) => alive.add(n.id));
    const filtered = /* @__PURE__ */ new Set();
    for (const id of selection) if (alive.has(id)) filtered.add(id);
    selection = filtered;
    notify();
  }
  function snapshot() {
    return structuredClone(doc);
  }
  function setSelection(ids) {
    selection = new Set(ids);
    notify();
  }
  function toggleSelection(id) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    notify();
  }
  function clearSelection() {
    if (selection.size === 0) return;
    selection = /* @__PURE__ */ new Set();
    notify();
  }
  function walk(node, cb) {
    cb(node);
    if (node.children) for (const c of node.children) walk(c, cb);
  }
  function findNode(root, id) {
    if (root.id === id) return root;
    if (!root.children) return null;
    for (const c of root.children) {
      const hit = findNode(c, id);
      if (hit) return hit;
    }
    return null;
  }
  function findParent(root, id) {
    if (!root.children) return null;
    for (const c of root.children) {
      if (c.id === id) return root;
      const hit = findParent(c, id);
      if (hit) return hit;
    }
    return null;
  }
  function findPath(root, id, path = []) {
    if (root.id === id) return path;
    if (!root.children) return null;
    for (const c of root.children) {
      const hit = findPath(c, id, [...path, c]);
      if (hit) return hit;
    }
    return null;
  }
  function topAncestor(root, id) {
    const path = findPath(root, id);
    return path && path.length > 0 ? path[0] : null;
  }
  function removeByIds(root, ids) {
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

  // js/connectors.js
  function borderPoint(box, tx, ty) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hw = box.width / 2;
    const hh = box.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0 || hw === 0 && hh === 0) return { x: cx, y: cy };
    const sx = hw > 0 ? hw / Math.abs(dx) : Infinity;
    const sy = hh > 0 ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  function centerOf(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  function routeStraight(fromBox, toBox, fromPt, toPt) {
    const fromCenter = fromBox ? centerOf(fromBox) : fromPt;
    const toCenter = toBox ? centerOf(toBox) : toPt;
    if (!fromCenter || !toCenter) return { valid: false };
    const from = fromBox ? borderPoint(fromBox, toCenter.x, toCenter.y) : fromPt;
    const to = toBox ? borderPoint(toBox, fromCenter.x, fromCenter.y) : toPt;
    if (!from || !to) return { valid: false };
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, valid: true };
  }

  // js/render.js
  var SVG_NS = "http://www.w3.org/2000/svg";
  var HANDLE_SIZE = 8;
  var ROT_STEM_LEN = 24;
  var docLayer;
  var chromeHover;
  var chromeSelection;
  var chromeTransient;
  var canvasSvg;
  function mount(svg3) {
    canvasSvg = svg3;
    docLayer = svg3.querySelector("#doc-layer");
    const chrome = svg3.querySelector("#chrome-layer");
    chromeHover = document.createElementNS(SVG_NS, "g");
    chromeHover.setAttribute("id", "chrome-hover");
    chromeSelection = document.createElementNS(SVG_NS, "g");
    chromeSelection.setAttribute("id", "chrome-selection");
    chromeTransient = document.createElementNS(SVG_NS, "g");
    chromeTransient.setAttribute("id", "chrome-transient");
    chrome.appendChild(chromeHover);
    chrome.appendChild(chromeSelection);
    chrome.appendChild(chromeTransient);
  }
  function getTransientLayer() {
    return chromeTransient;
  }
  function getDocLayer() {
    return docLayer;
  }
  function setHoverOutline(id) {
    clearHoverOutline();
    if (!id) return;
    const el = docLayer.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (!el) return;
    const box = safeBBox(el);
    if (!(box.width > 0 || box.height > 0)) return;
    const wrap = document.createElementNS(SVG_NS, "g");
    const t = el.getAttribute("transform");
    if (t) wrap.setAttribute("transform", t);
    const outline = document.createElementNS(SVG_NS, "rect");
    outline.setAttribute("class", "hover-outline");
    outline.setAttribute("x", box.x);
    outline.setAttribute("y", box.y);
    outline.setAttribute("width", box.width);
    outline.setAttribute("height", box.height);
    wrap.appendChild(outline);
    chromeHover.appendChild(wrap);
  }
  function clearHoverOutline() {
    if (!chromeHover) return;
    while (chromeHover.firstChild) chromeHover.removeChild(chromeHover.firstChild);
  }
  function renderAll() {
    renderDoc();
    renderSelection();
  }
  function renderDoc() {
    while (docLayer.firstChild) docLayer.removeChild(docLayer.firstChild);
    const doc2 = getDoc();
    const connectorNodes = [];
    for (const child of doc2.children) {
      if (child.type === "connector") {
        connectorNodes.push(child);
        continue;
      }
      docLayer.appendChild(nodeToElement(child));
    }
    for (const node of connectorNodes) {
      const el = connectorElement(node);
      if (el) docLayer.appendChild(el);
    }
  }
  function connectorElement(node) {
    const geom = resolveConnector(node);
    if (!geom || !geom.valid) return null;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("data-id", node.id);
    line.setAttribute("data-connector", "1");
    line.setAttribute("x1", round(geom.x1));
    line.setAttribute("y1", round(geom.y1));
    line.setAttribute("x2", round(geom.x2));
    line.setAttribute("y2", round(geom.y2));
    for (const [k, v] of Object.entries(node.attrs || {})) {
      if (v === void 0 || v === null || v === "") continue;
      line.setAttribute(k, formatAttr(k, v));
    }
    if (node.arrowEnd) line.setAttribute("marker-end", "url(#arrow-end)");
    if (node.arrowStart) line.setAttribute("marker-start", "url(#arrow-start)");
    return line;
  }
  function resolveConnector(node) {
    const end = (e) => {
      if (e && e.ref != null) {
        const el = docLayer.querySelector(`[data-id="${cssEscape(e.ref)}"]`);
        if (!el) return { box: null, pt: null, missing: true };
        const bb = elementBBoxInCanvas(el);
        return bb ? { box: bb, pt: null } : { box: null, pt: null, missing: true };
      }
      return { box: null, pt: e ? { x: e.x, y: e.y } : null };
    };
    const a = end(node.from);
    const b = end(node.to);
    if (a.missing || b.missing) return { valid: false };
    return routeStraight(a.box, b.box, a.pt, b.pt);
  }
  function nodeToElement(node) {
    if (node.type === "group") {
      const g = document.createElementNS(SVG_NS, "g");
      applyCommon(g, node);
      for (const child of node.children) g.appendChild(nodeToElement(child));
      if (node.label) g.appendChild(labelElement(node, bboxOfGroupChildren(node)));
      return g;
    }
    if (node.type === "text") {
      const el2 = document.createElementNS(SVG_NS, "text");
      applyCommon(el2, node);
      el2.textContent = node.text ?? "";
      return el2;
    }
    const el = document.createElementNS(SVG_NS, node.type);
    applyCommon(el, node);
    if (node.label) {
      const wrap = document.createElementNS(SVG_NS, "g");
      wrap.setAttribute("data-id", node.id);
      wrap.setAttribute("data-wrapper", "label");
      const tstr = transformToString(node.transform);
      if (tstr) {
        wrap.setAttribute("transform", tstr);
        el.removeAttribute("transform");
      }
      wrap.appendChild(el);
      wrap.appendChild(labelElement(node, localBBoxOfShapeNode(node)));
      return wrap;
    }
    return el;
  }
  function labelElement(ownerNode, bbox) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("data-role", "label");
    t.setAttribute("data-owner", ownerNode.id);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    t.setAttribute("x", round(cx));
    t.setAttribute("y", round(cy));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("font-family", ownerNode.labelStyle?.["font-family"] || "sans-serif");
    t.setAttribute("font-size", ownerNode.labelStyle?.["font-size"] || 16);
    t.setAttribute("fill", ownerNode.labelStyle?.fill || "#000000");
    t.setAttribute("pointer-events", "none");
    t.textContent = ownerNode.label;
    return t;
  }
  function localBBoxOfShapeNode(node) {
    const a = node.attrs;
    if (node.type === "rect") return { x: a.x, y: a.y, width: a.width, height: a.height };
    if (node.type === "circle") return { x: a.cx - a.r, y: a.cy - a.r, width: a.r * 2, height: a.r * 2 };
    if (node.type === "ellipse") return { x: a.cx - a.rx, y: a.cy - a.ry, width: a.rx * 2, height: a.ry * 2 };
    if (node.type === "line") {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x, y, width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1) };
    }
    if (node.type === "polyline" && Array.isArray(a.points) && a.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of a.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  function bboxOfGroupChildren(group) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function rec(node) {
      const tx = node.transform?.tx || 0;
      const ty = node.transform?.ty || 0;
      if (node.type === "group") {
        if (!node.children) return;
        for (const c of node.children) rec(c);
        return;
      }
      let b;
      if (node.type === "text") {
        const size = node.attrs["font-size"] || 16;
        const w = String(node.text || "").length * size * 0.6;
        b = { x: node.attrs.x, y: node.attrs.y - size, width: w, height: size * 1.2 };
      } else {
        b = localBBoxOfShapeNode(node);
      }
      const x1 = b.x + tx, y1 = b.y + ty, x2 = x1 + b.width, y2 = y1 + b.height;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    if (group.children) for (const c of group.children) rec(c);
    if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  function applyCommon(el, node) {
    el.setAttribute("data-id", node.id);
    for (const [k, v] of Object.entries(node.attrs)) {
      if (v === void 0 || v === null || v === "") continue;
      el.setAttribute(k, formatAttr(k, v));
    }
    const t = transformToString(node.transform);
    if (t) el.setAttribute("transform", t);
  }
  function formatAttr(k, v) {
    if (k === "points" && Array.isArray(v)) {
      return v.map((p) => `${round(p[0])},${round(p[1])}`).join(" ");
    }
    if (typeof v === "number") return round(v);
    return String(v);
  }
  function transformToString(t) {
    if (!t) return "";
    const parts = [];
    if (t.tx || t.ty) parts.push(`translate(${round(t.tx)},${round(t.ty)})`);
    if (t.rot) parts.push(`rotate(${round(t.rot)},${round(t.cx)},${round(t.cy)})`);
    return parts.join(" ");
  }
  function round(n) {
    if (typeof n !== "number") return n;
    return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e3) / 1e3;
  }
  function renderSelection() {
    while (chromeSelection.firstChild) chromeSelection.removeChild(chromeSelection.firstChild);
    const sel = getSelection();
    if (sel.size === 0) return;
    const boxes = [];
    for (const id of sel) {
      const el = docLayer.querySelector(`[data-id="${cssEscape(id)}"]`);
      if (!el) continue;
      boxes.push({ id, el, box: safeBBox(el) });
    }
    if (boxes.length === 0) return;
    if (boxes.length === 1 && boxes[0].el.hasAttribute("data-connector")) {
      drawConnectorSelection(boxes[0]);
      return;
    }
    if (boxes.length === 1) {
      drawSingleSelectionChrome(boxes[0]);
    } else {
      drawMultiSelectionChrome(boxes);
    }
  }
  function drawConnectorSelection({ el }) {
    const overlay = document.createElementNS(SVG_NS, "line");
    overlay.setAttribute("class", "connector-selected");
    overlay.setAttribute("x1", el.getAttribute("x1"));
    overlay.setAttribute("y1", el.getAttribute("y1"));
    overlay.setAttribute("x2", el.getAttribute("x2"));
    overlay.setAttribute("y2", el.getAttribute("y2"));
    chromeSelection.appendChild(overlay);
  }
  function drawSingleSelectionChrome({ id, el, box }) {
    const wrap = document.createElementNS(SVG_NS, "g");
    wrap.setAttribute("data-role", "selection");
    wrap.setAttribute("data-id", id);
    const t = el.getAttribute("transform");
    if (t) wrap.setAttribute("transform", t);
    const outline = document.createElementNS(SVG_NS, "rect");
    outline.setAttribute("class", "selection-outline");
    outline.setAttribute("x", box.x);
    outline.setAttribute("y", box.y);
    outline.setAttribute("width", box.width);
    outline.setAttribute("height", box.height);
    wrap.appendChild(outline);
    const scale = pixelScaleOf(el);
    const hs = HANDLE_SIZE * scale;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const positions = [
      ["nw", box.x, box.y],
      ["n", cx, box.y],
      ["ne", box.x + box.width, box.y],
      ["e", box.x + box.width, cy],
      ["se", box.x + box.width, box.y + box.height],
      ["s", cx, box.y + box.height],
      ["sw", box.x, box.y + box.height],
      ["w", box.x, cy]
    ];
    for (const [dir, px, py] of positions) {
      const h = document.createElementNS(SVG_NS, "rect");
      h.setAttribute("class", `handle ${dir}`);
      h.setAttribute("data-role", "resize");
      h.setAttribute("data-handle", dir);
      h.setAttribute("data-id", id);
      h.setAttribute("x", px - hs / 2);
      h.setAttribute("y", py - hs / 2);
      h.setAttribute("width", hs);
      h.setAttribute("height", hs);
      wrap.appendChild(h);
    }
    const rotY = box.y - ROT_STEM_LEN * scale;
    const stem = document.createElementNS(SVG_NS, "line");
    stem.setAttribute("class", "rot-stem");
    stem.setAttribute("x1", cx);
    stem.setAttribute("y1", box.y);
    stem.setAttribute("x2", cx);
    stem.setAttribute("y2", rotY);
    wrap.appendChild(stem);
    const rot = document.createElementNS(SVG_NS, "circle");
    rot.setAttribute("class", "rot-handle");
    rot.setAttribute("data-role", "rotate");
    rot.setAttribute("data-id", id);
    rot.setAttribute("cx", cx);
    rot.setAttribute("cy", rotY);
    rot.setAttribute("r", hs / 2);
    wrap.appendChild(rot);
    chromeSelection.appendChild(wrap);
  }
  function drawMultiSelectionChrome(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { el, box } of boxes) {
      const corners = [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height]
      ];
      for (const [lx, ly] of corners) {
        const p = localToCanvas(el, lx, ly);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return;
    const wrap = document.createElementNS(SVG_NS, "g");
    wrap.setAttribute("data-role", "selection-multi");
    const w = maxX - minX;
    const h = maxY - minY;
    const outline = document.createElementNS(SVG_NS, "rect");
    outline.setAttribute("class", "selection-outline");
    outline.setAttribute("x", minX);
    outline.setAttribute("y", minY);
    outline.setAttribute("width", w);
    outline.setAttribute("height", h);
    wrap.appendChild(outline);
    const hs = HANDLE_SIZE * canvasPixelScale();
    const cx = minX + w / 2;
    const cy = minY + h / 2;
    const positions = [
      ["nw", minX, minY],
      ["n", cx, minY],
      ["ne", maxX, minY],
      ["e", maxX, cy],
      ["se", maxX, maxY],
      ["s", cx, maxY],
      ["sw", minX, maxY],
      ["w", minX, cy]
    ];
    for (const [dir, px, py] of positions) {
      const hnd = document.createElementNS(SVG_NS, "rect");
      hnd.setAttribute("class", `handle ${dir}`);
      hnd.setAttribute("data-role", "resize-multi");
      hnd.setAttribute("data-handle", dir);
      hnd.setAttribute("x", px - hs / 2);
      hnd.setAttribute("y", py - hs / 2);
      hnd.setAttribute("width", hs);
      hnd.setAttribute("height", hs);
      wrap.appendChild(hnd);
    }
    chromeSelection.appendChild(wrap);
  }
  function canvasPixelScale() {
    const ctm = canvasSvg.getScreenCTM();
    if (!ctm) return 1;
    const sx = Math.hypot(ctm.a, ctm.b);
    return sx > 0 ? 1 / sx : 1;
  }
  function safeBBox(el) {
    try {
      return el.getBBox();
    } catch {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }
  function localToCanvasMatrix(el) {
    const svgScreen = canvasSvg.getScreenCTM();
    const elScreen = el.getScreenCTM();
    if (!svgScreen || !elScreen) return null;
    return svgScreen.inverse().multiply(elScreen);
  }
  function elementBBoxInCanvas(el) {
    let b;
    try {
      b = el.getBBox();
    } catch {
      return null;
    }
    const M = localToCanvasMatrix(el);
    if (!M) return null;
    const corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height]
    ];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [lx, ly] of corners) {
      const pt = canvasSvg.createSVGPoint();
      pt.x = lx;
      pt.y = ly;
      const q = pt.matrixTransform(M);
      if (q.x < x1) x1 = q.x;
      if (q.y < y1) y1 = q.y;
      if (q.x > x2) x2 = q.x;
      if (q.y > y2) y2 = q.y;
    }
    return { x1, y1, x2, y2, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  function localToCanvas(el, x, y) {
    const pt = canvasSvg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const M = localToCanvasMatrix(el);
    if (!M) return { x, y };
    const back = pt.matrixTransform(M);
    return { x: back.x, y: back.y };
  }
  function pixelScaleOf(el) {
    const ctm = el.getScreenCTM();
    if (!ctm) return 1;
    const sx = Math.hypot(ctm.a, ctm.b);
    return sx > 0 ? 1 / sx : 1;
  }
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
  function toCanvasPoint(evt) {
    const pt = canvasSvg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = canvasSvg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // js/history.js
  var MAX = 200;
  var past = [];
  var future = [];
  var pending = null;
  function beginTransaction() {
    pending = snapshot();
  }
  function ensureTransaction() {
    if (pending === null) pending = snapshot();
  }
  function commit(_label) {
    if (pending === null) return;
    past.push(pending);
    if (past.length > MAX) past.shift();
    future.length = 0;
    pending = null;
  }
  function abort() {
    pending = null;
  }
  function record(mutFn) {
    beginTransaction();
    try {
      mutFn();
      commit();
    } catch (e) {
      abort();
      throw e;
    }
  }
  function undo() {
    if (past.length === 0) return false;
    future.push(snapshot());
    const prev = past.pop();
    replaceRoot(prev);
    return true;
  }
  function redo() {
    if (future.length === 0) return false;
    past.push(snapshot());
    const next = future.pop();
    replaceRoot(next);
    return true;
  }
  function resetHistory() {
    past.length = 0;
    future.length = 0;
    pending = null;
  }

  // js/guides.js
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  var CLASS = "align-guide";
  var TICK_CLASS = "align-tick";
  var TICK_HALF = 4;
  var LINE_KIND = ["edge", "center", "edge"];
  function xLines(b) {
    return [b.x, b.x + b.width / 2, b.x + b.width];
  }
  function yLines(b) {
    return [b.y, b.y + b.height / 2, b.y + b.height];
  }
  function computeSnap({ movingBBox, stationaryBBoxes, canvasBBox, threshold }) {
    if (!movingBBox) return { dx: 0, dy: 0, guides: [] };
    const candidates = stationaryBBoxes.map((b) => ({ ...b, _isCanvas: false }));
    if (canvasBBox) candidates.push({ ...canvasBBox, _isCanvas: true });
    const movXs = xLines(movingBBox);
    const movYs = yLines(movingBBox);
    let bestX = null;
    let bestY = null;
    const scoreX = (dist, kindPair) => dist - (kindPair === "center-center" ? 1e-6 : 0);
    for (const sb of candidates) {
      const sxs = xLines(sb);
      for (let mi = 0; mi < 3; mi++) {
        for (let si = 0; si < 3; si++) {
          const delta = sxs[si] - movXs[mi];
          const dist = Math.abs(delta);
          if (dist > threshold) continue;
          const kindPair = `${LINE_KIND[mi]}-${LINE_KIND[si]}`;
          const score = scoreX(dist, kindPair);
          if (bestX === null || score < bestX.score) {
            bestX = { delta, score };
          }
        }
      }
      const sys = yLines(sb);
      for (let mi = 0; mi < 3; mi++) {
        for (let si = 0; si < 3; si++) {
          const delta = sys[si] - movYs[mi];
          const dist = Math.abs(delta);
          if (dist > threshold) continue;
          const kindPair = `${LINE_KIND[mi]}-${LINE_KIND[si]}`;
          const score = scoreX(dist, kindPair);
          if (bestY === null || score < bestY.score) {
            bestY = { delta, score };
          }
        }
      }
    }
    const dx = bestX ? bestX.delta : 0;
    const dy = bestY ? bestY.delta : 0;
    const snapped = { x: movingBBox.x + dx, y: movingBBox.y + dy, width: movingBBox.width, height: movingBBox.height };
    const guides = [];
    const EPS = 0.5;
    const snapXs = xLines(snapped);
    const snapYs = yLines(snapped);
    for (const sb of candidates) {
      const sxs = xLines(sb);
      for (let mi = 0; mi < 3; mi++) {
        const mx = snapXs[mi];
        for (let si = 0; si < 3; si++) {
          const sx = sxs[si];
          if (Math.abs(mx - sx) >= EPS) continue;
          const kind = LINE_KIND[mi] === "center" && LINE_KIND[si] === "center" ? "center" : "edge";
          const y1 = sb._isCanvas ? snapped.y : Math.min(snapped.y, sb.y);
          const y2 = sb._isCanvas ? snapped.y + snapped.height : Math.max(snapped.y + snapped.height, sb.y + sb.height);
          const g = { orient: "v", kind, x: sx, y1, y2 };
          if (kind === "center") {
            g.centers = [
              { x: sx, y: snapped.y + snapped.height / 2 },
              ...sb._isCanvas ? [] : [{ x: sx, y: sb.y + sb.height / 2 }]
            ];
          }
          guides.push(g);
        }
      }
      const sys = yLines(sb);
      for (let mi = 0; mi < 3; mi++) {
        const my = snapYs[mi];
        for (let si = 0; si < 3; si++) {
          const sy = sys[si];
          if (Math.abs(my - sy) >= EPS) continue;
          const kind = LINE_KIND[mi] === "center" && LINE_KIND[si] === "center" ? "center" : "edge";
          const x1 = sb._isCanvas ? snapped.x : Math.min(snapped.x, sb.x);
          const x2 = sb._isCanvas ? snapped.x + snapped.width : Math.max(snapped.x + snapped.width, sb.x + sb.width);
          const g = { orient: "h", kind, y: sy, x1, x2 };
          if (kind === "center") {
            g.centers = [
              { x: snapped.x + snapped.width / 2, y: sy },
              ...sb._isCanvas ? [] : [{ x: sb.x + sb.width / 2, y: sy }]
            ];
          }
          guides.push(g);
        }
      }
    }
    return { dx, dy, guides: dedupGuides(guides) };
  }
  function dedupGuides(guides) {
    const byKey = /* @__PURE__ */ new Map();
    for (const g of guides) {
      const key = g.orient === "v" ? `v:${r(g.x)}:${r(g.y1)}:${r(g.y2)}` : `h:${r(g.y)}:${r(g.x1)}:${r(g.x2)}`;
      const prev = byKey.get(key);
      if (!prev || g.kind === "center" && prev.kind !== "center") {
        byKey.set(key, g);
      }
    }
    return [...byKey.values()];
  }
  function r(n) {
    return Math.round(n * 100) / 100;
  }
  function drawGuides(guides) {
    clearGuides();
    const layer = getTransientLayer();
    for (const g of guides) {
      const line = document.createElementNS(SVG_NS2, "line");
      line.setAttribute("class", `${CLASS} ${g.kind === "center" ? "center" : "edge"}`);
      if (g.orient === "v") {
        line.setAttribute("x1", g.x);
        line.setAttribute("y1", g.y1);
        line.setAttribute("x2", g.x);
        line.setAttribute("y2", g.y2);
      } else {
        line.setAttribute("x1", g.x1);
        line.setAttribute("y1", g.y);
        line.setAttribute("x2", g.x2);
        line.setAttribute("y2", g.y);
      }
      layer.appendChild(line);
      if (g.kind === "center" && g.centers) {
        for (const c of g.centers) layer.appendChild(centerTick(c.x, c.y));
      }
    }
  }
  function centerTick(cx, cy) {
    const g = document.createElementNS(SVG_NS2, "g");
    g.setAttribute("class", TICK_CLASS);
    const h = document.createElementNS(SVG_NS2, "line");
    h.setAttribute("x1", cx - TICK_HALF);
    h.setAttribute("y1", cy);
    h.setAttribute("x2", cx + TICK_HALF);
    h.setAttribute("y2", cy);
    const v = document.createElementNS(SVG_NS2, "line");
    v.setAttribute("x1", cx);
    v.setAttribute("y1", cy - TICK_HALF);
    v.setAttribute("x2", cx);
    v.setAttribute("y2", cy + TICK_HALF);
    g.appendChild(h);
    g.appendChild(v);
    return g;
  }
  function clearGuides() {
    const layer = getTransientLayer();
    const olds = layer.querySelectorAll("." + CLASS + ", ." + TICK_CLASS);
    for (const el of olds) el.remove();
  }

  // js/grid.js
  var grid_exports = {};
  __export(grid_exports, {
    getGridSize: () => getGridSize,
    getState: () => getState,
    isSnap: () => isSnap,
    isVisible: () => isVisible,
    mount: () => mount2,
    onStateChange: () => onStateChange,
    setSnap: () => setSnap,
    setVisible: () => setVisible,
    snapDelta: () => snapDelta,
    snapPoint: () => snapPoint,
    snapScalar: () => snapScalar,
    toggleSnap: () => toggleSnap,
    toggleVisible: () => toggleVisible
  });
  var GRID_SIZE = 10;
  var STORAGE_VISIBLE = "euclid.grid.visible";
  var STORAGE_SNAP = "euclid.grid.snap";
  var gridRect = null;
  var visible = false;
  var snap = false;
  var listeners = [];
  function mount2(svg3) {
    gridRect = svg3.querySelector("#grid-rect");
    visible = readBool(STORAGE_VISIBLE, false);
    snap = readBool(STORAGE_SNAP, false);
    applyVisible();
    emit();
  }
  function onStateChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }
  function emit() {
    const s = getState();
    for (const fn of listeners) fn(s);
  }
  function getGridSize() {
    return GRID_SIZE;
  }
  function isVisible() {
    return visible;
  }
  function isSnap() {
    return snap;
  }
  function getState() {
    return { visible, snap };
  }
  function setVisible(on) {
    visible = !!on;
    applyVisible();
    writeBool(STORAGE_VISIBLE, visible);
    emit();
  }
  function setSnap(on) {
    snap = !!on;
    writeBool(STORAGE_SNAP, snap);
    emit();
  }
  function toggleVisible() {
    setVisible(!visible);
  }
  function toggleSnap() {
    setSnap(!snap);
  }
  function applyVisible() {
    if (gridRect) gridRect.style.display = visible ? "" : "none";
  }
  function snapScalar(v) {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
  }
  function snapPoint(x, y) {
    if (!snap) return { x, y };
    return { x: snapScalar(x), y: snapScalar(y) };
  }
  function snapDelta(bbox) {
    if (!snap || !bbox) return { dx: 0, dy: 0 };
    return {
      dx: snapScalar(bbox.x) - bbox.x,
      dy: snapScalar(bbox.y) - bbox.y
    };
  }
  function readBool(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  }
  function writeBool(key, val) {
    try {
      window.localStorage.setItem(key, val ? "1" : "0");
    } catch {
    }
  }

  // js/tools.js
  var CANVAS_BBOX = { x: 0, y: 0, width: 1e3, height: 700 };
  var SNAP_THRESHOLD = 6;
  var DRAG_THRESHOLD = 3;
  var hoveredId = null;
  var SVG_NS3 = "http://www.w3.org/2000/svg";
  var DEFAULT_STYLE = {
    fill: "#88ccee",
    stroke: "#222222",
    "stroke-width": 2,
    opacity: 1
  };
  var LINE_STYLE = {
    fill: "none",
    stroke: "#222222",
    "stroke-width": 2,
    opacity: 1
  };
  var TEXT_DEFAULTS = {
    "font-family": "sans-serif",
    "font-size": 20,
    fill: "#000000"
  };
  var CONNECTOR_STYLE = {
    fill: "none",
    stroke: "#222222",
    "stroke-width": 2
  };
  var currentTool = "select";
  var canvasSvg2;
  var polylineInProgress = null;
  var gesture = null;
  var downClient = null;
  function mount3(svg3) {
    canvasSvg2 = svg3;
    svg3.addEventListener("pointerdown", onPointerDown);
    svg3.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    svg3.addEventListener("pointerleave", () => {
      if (!gesture) setHover(null);
    });
    svg3.addEventListener("dblclick", onDoubleClick);
    svg3.addEventListener("contextmenu", onContextMenu);
  }
  function setTool(name) {
    if (currentTool === name) return;
    cancelPolyline();
    currentTool = name;
    canvasSvg2.classList.toggle("draw-mode", name !== "select");
    setHover(null);
    document.dispatchEvent(new CustomEvent("tool-changed", { detail: name }));
  }
  function getTool() {
    return currentTool;
  }
  function onPointerDown(e) {
    if (e.button !== 0) return;
    const p = toCanvasPoint(e);
    const target = e.target;
    setHover(null);
    downClient = { x: e.clientX, y: e.clientY };
    const role = target.getAttribute && target.getAttribute("data-role");
    if (role === "resize") return startResize(e, target, p);
    if (role === "resize-multi") return startResizeMulti(e, target, p);
    if (role === "rotate") return startRotate(e, target, p);
    if (currentTool === "select") return handleSelectDown(e, p, target);
    if (currentTool === "polyline") return handlePolylineDown(e, p);
    if (currentTool === "text") return handleTextDown(e, p);
    if (currentTool === "connector") return startConnector(e, p, target);
    return startDraw(e, p);
  }
  function onPointerMove(e) {
    const p = toCanvasPoint(e);
    if (polylineInProgress) {
      updatePolylinePreview(p);
    }
    if (!gesture) {
      updateHover(e);
      return;
    }
    const dx = p.x - gesture.origin.x;
    const dy = p.y - gesture.origin.y;
    gesture.last = p;
    if (!gesture.moved && downClient) {
      const sdx = e.clientX - downClient.x;
      const sdy = e.clientY - downClient.y;
      if (Math.hypot(sdx, sdy) <= DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.type === "move") {
        canvasSvg2.classList.add("dragging");
        canvasSvg2.classList.toggle("will-duplicate", !!gesture.duplicate);
        beginMovePayload(e);
      }
    }
    if (gesture.type === "draw") {
      updateDraw(p, e);
    } else if (gesture.type === "move") {
      updateMove(dx, dy, e);
    } else if (gesture.type === "resize") {
      updateResize(p, e);
    } else if (gesture.type === "rotate") {
      updateRotate(p, e);
    } else if (gesture.type === "marquee") {
      updateMarquee(p);
    } else if (gesture.type === "connector") {
      updateConnector(p, e);
    }
  }
  function updateHover(e) {
    if (currentTool !== "select") {
      setHover(null);
      return;
    }
    const role = e.target.getAttribute && e.target.getAttribute("data-role");
    if (role === "resize" || role === "resize-multi" || role === "rotate") {
      setHover(null);
      return;
    }
    const hit = hitTest(e.target);
    const id = hit ? pickSelectionId(hit.id) : null;
    setHover(id);
    const dup = (e.ctrlKey || e.metaKey) && id;
    canvasSvg2.classList.toggle("will-duplicate", !!dup);
  }
  function setHover(id) {
    canvasSvg2.classList.toggle("over-shape", !!id && currentTool === "select");
    if (!id) canvasSvg2.classList.remove("will-duplicate");
    if (id === hoveredId) return;
    hoveredId = id;
    if (id && !getSelection().has(id)) setHoverOutline(id);
    else clearHoverOutline();
  }
  function onPointerUp(e) {
    downClient = null;
    canvasSvg2.classList.remove("dragging", "will-duplicate");
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.type === "draw") {
      finishDraw(g);
    } else if (g.type === "marquee") {
      finishMarquee(g, e.shiftKey);
    } else if (g.type === "connector") {
      finishConnector(g, e);
    } else if (g.type === "move") {
      if (g.moved && g.ids.length > 0) commit(g.type);
      else abort();
    } else if (g.type === "resize" || g.type === "rotate") {
      if (g.moved) commit(g.type);
      else abort();
      if (g.type === "rotate") hideRotationReadout();
    }
    clearTransient();
  }
  function onContextMenu(e) {
    e.preventDefault();
    if (currentTool !== "select") {
      closeContextMenu();
      return;
    }
    const hit = hitTest(e.target);
    if (!hit) {
      closeContextMenu();
      return;
    }
    const id = pickSelectionId(hit.id);
    if (!getSelection().has(id)) setSelection([id]);
    openContextMenu(e.clientX, e.clientY, id);
  }
  function onDoubleClick(e) {
    if (polylineInProgress) {
      commitPolyline();
      return;
    }
    if (currentTool !== "select") return;
    const hit = hitTest(e.target);
    if (!hit) return;
    const node = findNode(getDoc(), hit.id);
    if (!node) return;
    if (node.type === "text") {
      openTextEditor(node);
      return;
    }
    if (node.type !== "group") {
      setSelection([node.id]);
      openLabelEditor(node);
      return;
    }
    const path = findPath(getDoc(), hit.id);
    if (!path) return;
    const sel = getSelection();
    const target = sel.has(path[0]?.id) && path.length > 1 ? path[1].id : path[0].id;
    setSelection([target]);
  }
  function handleSelectDown(e, p, target) {
    const hit = hitTest(target);
    if (!hit) {
      if (!e.shiftKey) clearSelection();
      startMarquee(p);
      return;
    }
    const id = pickSelectionId(hit.id);
    const sel = getSelection();
    const dup = e.ctrlKey || e.metaKey;
    if (e.shiftKey) {
      toggleSelection(id);
    } else if (dup) {
      if (!sel.has(id)) setSelection([id]);
    } else if (!sel.has(id)) {
      setSelection([id]);
    }
    startMove(p, e);
  }
  function pickSelectionId(leafId) {
    const top = topAncestor(getDoc(), leafId);
    return top ? top.id : leafId;
  }
  function hitTest(target) {
    const docLayer2 = getDocLayer();
    let el = target;
    while (el && el !== docLayer2 && el !== canvasSvg2) {
      if (el.getAttribute && el.hasAttribute("data-id") && docLayer2.contains(el)) {
        return { id: el.getAttribute("data-id"), el };
      }
      el = el.parentNode;
    }
    return null;
  }
  function startMove(p, e) {
    const sel = [...getSelection()];
    if (sel.length === 0) return;
    beginTransaction();
    gesture = {
      type: "move",
      origin: p,
      last: p,
      moved: false,
      duplicate: !!(e && (e.ctrlKey || e.metaKey)),
      initialSel: sel,
      ids: [],
      orig: /* @__PURE__ */ new Map(),
      movingUnion: null,
      stationaryBBoxes: []
    };
  }
  function beginMovePayload(e) {
    const g = gesture;
    if (g.duplicate) {
      const newIds = [];
      mutate((root) => {
        const topIds = /* @__PURE__ */ new Set();
        for (const id of g.initialSel) {
          const path = findPath(root, id);
          if (path && path.length) topIds.add(path[0].id);
        }
        for (const child of root.children) {
          if (!topIds.has(child.id)) continue;
          const copy = deepReId(child);
          root.children.push(copy);
          newIds.push(copy.id);
        }
      });
      if (newIds.length) setSelection(newIds);
    }
    computeMovePayload(g);
  }
  function computeMovePayload(g) {
    const doc2 = getDoc();
    const movingTopIds = /* @__PURE__ */ new Set();
    for (const id of getSelection()) {
      const top = topAncestor(doc2, id);
      if (top && top.type !== "connector") movingTopIds.add(top.id);
    }
    const orig = /* @__PURE__ */ new Map();
    const movingBBoxes = [];
    for (const id of movingTopIds) {
      const node = findNode(doc2, id);
      if (!node) continue;
      orig.set(id, { tx: node.transform?.tx || 0, ty: node.transform?.ty || 0 });
      const el = getDocLayer().querySelector(`[data-id="${cssEscape2(id)}"]`);
      const b = el && elementBBoxInCanvas(el);
      if (b) movingBBoxes.push({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
    }
    const movingUnion = unionOfBBoxes(movingBBoxes);
    const stationaryBBoxes = [];
    for (const child of doc2.children) {
      if (movingTopIds.has(child.id)) continue;
      const el = getDocLayer().querySelector(`[data-id="${cssEscape2(child.id)}"]`);
      const b = el && elementBBoxInCanvas(el);
      if (b) stationaryBBoxes.push({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 });
    }
    g.ids = [...movingTopIds];
    g.orig = orig;
    g.movingUnion = movingUnion;
    g.stationaryBBoxes = stationaryBBoxes;
  }
  function deepReId(node) {
    const copy = structuredClone(node);
    walk(copy, (n) => {
      n.id = newId(n.type === "group" ? "g" : "n");
    });
    return copy;
  }
  function updateMove(dx, dy, e) {
    const { ids, orig, movingUnion, stationaryBBoxes } = gesture;
    let snapDx = 0, snapDy = 0;
    if (movingUnion && !e?.altKey) {
      const proposed = {
        x: movingUnion.x + dx,
        y: movingUnion.y + dy,
        width: movingUnion.width,
        height: movingUnion.height
      };
      const snap2 = computeSnap({
        movingBBox: proposed,
        stationaryBBoxes,
        canvasBBox: CANVAS_BBOX,
        threshold: SNAP_THRESHOLD
      });
      snapDx = snap2.dx;
      snapDy = snap2.dy;
      drawGuides(snap2.guides);
      if (isSnap()) {
        const g = snapDelta(proposed);
        if (snapDx === 0) snapDx = g.dx;
        if (snapDy === 0) snapDy = g.dy;
      }
    } else {
      clearGuides();
    }
    const finalDx = dx + snapDx;
    const finalDy = dy + snapDy;
    mutate((root) => {
      for (const id of ids) {
        const node = findNode(root, id);
        if (!node) continue;
        if (!node.transform) node.transform = emptyTransform();
        const o = orig.get(id);
        node.transform.tx = o.tx + finalDx;
        node.transform.ty = o.ty + finalDy;
      }
    });
  }
  function unionOfBBoxes(bboxes) {
    if (!bboxes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bboxes) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  function startMarquee(p) {
    gesture = { type: "marquee", origin: p, last: p, moved: false };
    const rect = document.createElementNS(SVG_NS3, "rect");
    rect.setAttribute("class", "marquee");
    rect.setAttribute("x", p.x);
    rect.setAttribute("y", p.y);
    rect.setAttribute("width", 0);
    rect.setAttribute("height", 0);
    gesture.el = rect;
    getTransientLayer().appendChild(rect);
  }
  function updateMarquee(p) {
    const { origin, el } = gesture;
    const x = Math.min(origin.x, p.x);
    const y = Math.min(origin.y, p.y);
    const w = Math.abs(p.x - origin.x);
    const h = Math.abs(p.y - origin.y);
    el.setAttribute("x", x);
    el.setAttribute("y", y);
    el.setAttribute("width", w);
    el.setAttribute("height", h);
  }
  function finishMarquee(g, additive) {
    if (!g.moved) return;
    const x1 = Math.min(g.origin.x, g.last.x);
    const y1 = Math.min(g.origin.y, g.last.y);
    const x2 = Math.max(g.origin.x, g.last.x);
    const y2 = Math.max(g.origin.y, g.last.y);
    const doc2 = getDoc();
    const hits = [];
    const docLayer2 = getDocLayer();
    for (const child of doc2.children) {
      const el = docLayer2.querySelector(`[data-id="${cssEscape2(child.id)}"]`);
      if (!el) continue;
      const bbox = elementBBoxInCanvas(el);
      if (!bbox) continue;
      if (bbox.x1 >= x1 && bbox.y1 >= y1 && bbox.x2 <= x2 && bbox.y2 <= y2) {
        hits.push(child.id);
      }
    }
    if (additive) {
      const merged = /* @__PURE__ */ new Set([...getSelection(), ...hits]);
      setSelection([...merged]);
    } else {
      setSelection(hits);
    }
  }
  function startDraw(e, p) {
    if (isSnap() && !e.altKey) p = snapPoint(p.x, p.y);
    const id = newId();
    const node = seedNodeFor(currentTool, id, p);
    if (!node) return;
    beginTransaction();
    mutate((root) => {
      root.children.push(node);
    });
    gesture = { type: "draw", origin: p, last: p, moved: false, id, tool: currentTool };
  }
  function seedNodeFor(tool, id, p) {
    const base = { id, type: tool, transform: emptyTransform() };
    const style = tool === "line" ? { ...LINE_STYLE } : { ...DEFAULT_STYLE };
    if (tool === "rect") {
      return { ...base, attrs: { x: p.x, y: p.y, width: 0, height: 0, rx: 0, ry: 0, ...style } };
    }
    if (tool === "circle") {
      return { ...base, attrs: { cx: p.x, cy: p.y, r: 0, ...style } };
    }
    if (tool === "ellipse") {
      return { ...base, attrs: { cx: p.x, cy: p.y, rx: 0, ry: 0, ...style } };
    }
    if (tool === "line") {
      return { ...base, attrs: { x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...style } };
    }
    return null;
  }
  function updateDraw(p, e) {
    const { origin, id, tool } = gesture;
    if (isSnap() && !e.altKey) p = snapPoint(p.x, p.y);
    let dx = p.x - origin.x;
    let dy = p.y - origin.y;
    if (e.shiftKey && (tool === "rect" || tool === "ellipse" || tool === "circle")) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    mutate((root) => {
      const n = findNode(root, id);
      if (!n) return;
      if (tool === "rect") {
        n.attrs.x = Math.min(origin.x, origin.x + dx);
        n.attrs.y = Math.min(origin.y, origin.y + dy);
        n.attrs.width = Math.abs(dx);
        n.attrs.height = Math.abs(dy);
      } else if (tool === "ellipse") {
        n.attrs.cx = origin.x + dx / 2;
        n.attrs.cy = origin.y + dy / 2;
        n.attrs.rx = Math.abs(dx) / 2;
        n.attrs.ry = Math.abs(dy) / 2;
      } else if (tool === "circle") {
        n.attrs.cx = origin.x + dx / 2;
        n.attrs.cy = origin.y + dy / 2;
        n.attrs.r = Math.min(Math.abs(dx), Math.abs(dy)) / 2;
      } else if (tool === "line") {
        let ex = p.x, ey = p.y;
        if (e.shiftKey) {
          const ang = Math.atan2(p.y - origin.y, p.x - origin.x);
          const step = Math.PI / 4;
          const snapped = Math.round(ang / step) * step;
          const dist = Math.hypot(p.x - origin.x, p.y - origin.y);
          ex = origin.x + Math.cos(snapped) * dist;
          ey = origin.y + Math.sin(snapped) * dist;
        }
        n.attrs.x2 = ex;
        n.attrs.y2 = ey;
      }
    });
  }
  function finishDraw(g) {
    const { id, tool } = g;
    const doc2 = getDoc();
    const node = findNode(doc2, id);
    if (!node) {
      abort();
      return;
    }
    const empty = isEmptyShape(node, tool);
    if (empty) {
      mutate((root) => {
        const idx = root.children.findIndex((c) => c.id === id);
        if (idx >= 0) root.children.splice(idx, 1);
      });
      abort();
      return;
    }
    commit("draw " + tool);
    setSelection([id]);
  }
  function isEmptyShape(node, tool) {
    if (tool === "rect") return !(node.attrs.width > 0 && node.attrs.height > 0);
    if (tool === "ellipse") return !(node.attrs.rx > 0 && node.attrs.ry > 0);
    if (tool === "circle") return !(node.attrs.r > 0);
    if (tool === "line") return node.attrs.x1 === node.attrs.x2 && node.attrs.y1 === node.attrs.y2;
    if (tool === "polyline") return !node.attrs.points || node.attrs.points.length < 2;
    return false;
  }
  function startConnector(e, p, target) {
    const hit = hitTest(target);
    const fromId = hit ? pickSelectionId(hit.id) : null;
    gesture = {
      type: "connector",
      origin: p,
      last: p,
      moved: false,
      from: fromId ? { ref: fromId } : { x: p.x, y: p.y },
      fromAnchor: fromId ? anchorOfShape(fromId) : { x: p.x, y: p.y },
      toId: null
    };
    const line = document.createElementNS(SVG_NS3, "line");
    line.setAttribute("class", "connector-preview");
    gesture.previewEl = line;
    getTransientLayer().appendChild(line);
    updateConnectorPreview(p);
  }
  function updateConnector(p, e) {
    const hit = hitTest(e.target);
    let toId = hit ? pickSelectionId(hit.id) : null;
    if (toId && gesture.from.ref === toId) toId = null;
    gesture.toId = toId;
    highlightConnectTarget(toId);
    updateConnectorPreview(p);
  }
  function updateConnectorPreview(p) {
    const fromBox = gesture.from.ref ? shapeBox(gesture.from.ref) : null;
    const toBox = gesture.toId ? shapeBox(gesture.toId) : null;
    const fromPt = gesture.from.ref ? null : { x: gesture.from.x, y: gesture.from.y };
    const toPt = { x: p.x, y: p.y };
    const g = routeStraight(fromBox, toBox, fromPt, toPt);
    if (!g.valid) return;
    const line = gesture.previewEl;
    line.setAttribute("x1", g.x1);
    line.setAttribute("y1", g.y1);
    line.setAttribute("x2", g.x2);
    line.setAttribute("y2", g.y2);
  }
  function finishConnector(g, e) {
    clearConnectTargetHighlight();
    const hit = hitTest(e.target);
    let toId = hit ? pickSelectionId(hit.id) : null;
    if (toId && g.from.ref === toId) toId = null;
    const dist = Math.hypot(g.last.x - g.origin.x, g.last.y - g.origin.y);
    const hasAttachment = !!g.from.ref || !!toId;
    if (!hasAttachment || dist < 4 && !toId) return;
    const to = toId ? { ref: toId } : { x: round2(g.last.x), y: round2(g.last.y) };
    const from = g.from.ref ? { ref: g.from.ref } : { x: round2(g.from.x), y: round2(g.from.y) };
    const id = newId("c");
    const node = {
      id,
      type: "connector",
      from,
      to,
      arrowEnd: true,
      attrs: { ...CONNECTOR_STYLE }
    };
    record(() => {
      mutate((root) => {
        root.children.push(node);
      });
    });
    setSelection([id]);
  }
  function shapeBox(id) {
    const el = getDocLayer().querySelector(`[data-id="${cssEscape2(id)}"]`);
    if (!el) return null;
    const b = elementBBoxInCanvas(el);
    return b ? { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 } : null;
  }
  function anchorOfShape(id) {
    const b = shapeBox(id);
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
  }
  function highlightConnectTarget(id) {
    clearConnectTargetHighlight();
    if (id) setHoverOutline(id);
  }
  function clearConnectTargetHighlight() {
    clearHoverOutline();
  }
  function handlePolylineDown(e, p) {
    if (!polylineInProgress) {
      const id = newId();
      beginTransaction();
      const node = {
        id,
        type: "polyline",
        transform: emptyTransform(),
        attrs: { points: [[p.x, p.y]], fill: "none", stroke: "#222222", "stroke-width": 2, opacity: 1 }
      };
      mutate((root) => {
        root.children.push(node);
      });
      polylineInProgress = { id };
      ensurePolylinePreview();
    } else {
      mutate((root) => {
        const n = findNode(root, polylineInProgress.id);
        if (n) n.attrs.points.push([p.x, p.y]);
      });
    }
  }
  function ensurePolylinePreview() {
    if (!polylineInProgress) return;
    if (polylineInProgress.previewEl) return;
    const line = document.createElementNS(SVG_NS3, "line");
    line.setAttribute("class", "rubber");
    polylineInProgress.previewEl = line;
    getTransientLayer().appendChild(line);
  }
  function updatePolylinePreview(p) {
    if (!polylineInProgress) return;
    const node = findNode(getDoc(), polylineInProgress.id);
    if (!node || !node.attrs.points.length) return;
    const last = node.attrs.points[node.attrs.points.length - 1];
    const line = polylineInProgress.previewEl;
    if (!line) return;
    line.setAttribute("x1", last[0]);
    line.setAttribute("y1", last[1]);
    line.setAttribute("x2", p.x);
    line.setAttribute("y2", p.y);
  }
  function commitPolyline() {
    if (!polylineInProgress) return;
    const id = polylineInProgress.id;
    const node = findNode(getDoc(), id);
    polylineInProgress = null;
    clearTransient();
    if (!node || !node.attrs.points || node.attrs.points.length < 2) {
      mutate((root) => {
        const idx = root.children.findIndex((c) => c.id === id);
        if (idx >= 0) root.children.splice(idx, 1);
      });
      abort();
      return;
    }
    commit("draw polyline");
    setSelection([id]);
  }
  function cancelPolyline() {
    if (!polylineInProgress) return;
    const id = polylineInProgress.id;
    const node = findNode(getDoc(), id);
    polylineInProgress = null;
    clearTransient();
    if (node && node.attrs.points && node.attrs.points.length >= 2) {
      commit("draw polyline");
      setSelection([id]);
    } else {
      mutate((root) => {
        const idx = root.children.findIndex((c) => c.id === id);
        if (idx >= 0) root.children.splice(idx, 1);
      });
      abort();
    }
  }
  function startResize(e, handleEl, p) {
    const dir = handleEl.getAttribute("data-handle");
    const id = handleEl.getAttribute("data-id");
    const node = findNode(getDoc(), id);
    if (!node) return;
    beginTransaction();
    gesture = {
      type: "resize",
      origin: p,
      last: p,
      moved: false,
      id,
      dir,
      orig: cloneShape(node)
      // We resize in the shape's local coordinate space (pre-transform).
      // For rotated shapes, we need to convert screen deltas back into local via inverse of the transform.
      // For v1 simplicity, resize uses canvas-space deltas and treats them as local deltas;
      // this is correct for un-rotated shapes and acceptable for slightly-rotated ones.
    };
    if (node.type === "group") {
      const el = getDocLayer().querySelector(`[data-id="${cssEscape2(id)}"]`);
      gesture.origSubtree = structuredClone(node);
      gesture.localBBox = el ? safeGetBBox(el) : null;
    }
  }
  function safeGetBBox(el) {
    try {
      return el.getBBox();
    } catch {
      return null;
    }
  }
  function startResizeMulti(e, handleEl, p) {
    const dir = handleEl.getAttribute("data-handle");
    const doc2 = getDoc();
    const topIds = /* @__PURE__ */ new Set();
    for (const id of getSelection()) {
      const top = topAncestor(doc2, id);
      if (top && top.type !== "connector") topIds.add(top.id);
    }
    if (topIds.size === 0) return;
    const snapshots = /* @__PURE__ */ new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of topIds) {
      const node = findNode(doc2, id);
      if (!node) continue;
      snapshots.set(id, structuredClone(node));
      const el = getDocLayer().querySelector(`[data-id="${cssEscape2(id)}"]`);
      const b = el && elementBBoxInCanvas(el);
      if (!b) continue;
      if (b.x1 < minX) minX = b.x1;
      if (b.y1 < minY) minY = b.y1;
      if (b.x2 > maxX) maxX = b.x2;
      if (b.y2 > maxY) maxY = b.y2;
    }
    if (!isFinite(minX)) return;
    beginTransaction();
    gesture = {
      type: "resize",
      origin: p,
      last: p,
      moved: false,
      dir,
      multi: {
        ids: [...topIds],
        snapshots,
        bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      }
    };
  }
  function cloneShape(node) {
    return {
      attrs: { ...node.attrs, points: node.attrs.points ? node.attrs.points.map((p) => [...p]) : void 0 },
      transform: { ...node.transform }
    };
  }
  function updateResize(p, _e) {
    const { id, dir, origin, orig } = gesture;
    if (isSnap() && !_e?.altKey) p = snapPoint(p.x, p.y);
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    if (gesture.multi) {
      const { ids, snapshots, bbox } = gesture.multi;
      const { sx, sy, ax, ay } = computeScale(bbox, dir, dx, dy, _e?.shiftKey);
      mutate((root) => {
        for (const nid of ids) {
          const n = findNode(root, nid);
          const snap2 = snapshots.get(nid);
          if (!n || !snap2) continue;
          n.attrs = structuredClone(snap2.attrs);
          n.transform = structuredClone(snap2.transform);
          if (snap2.children) n.children = structuredClone(snap2.children);
          scaleSubtree(n, ax, ay, sx, sy);
        }
      });
      return;
    }
    if (gesture.origSubtree && gesture.localBBox) {
      const { sx, sy, ax, ay } = computeScale(gesture.localBBox, dir, dx, dy, _e?.shiftKey);
      mutate((root) => {
        const n = findNode(root, id);
        if (!n || !n.children) return;
        n.children = structuredClone(gesture.origSubtree.children);
        for (const c of n.children) scaleSubtree(c, ax, ay, sx, sy);
      });
      return;
    }
    mutate((root) => {
      const n = findNode(root, id);
      if (!n) return;
      resizeNode(n, orig, dir, dx, dy);
    });
  }
  function resizeNode(n, orig, dir, dx, dy) {
    const west = dir.includes("w");
    const east = dir.includes("e");
    const north = dir.includes("n");
    const south = dir.includes("s");
    const applyBox = (x, y, w, h) => {
      let nx = x, ny = y, nw = w, nh = h;
      if (west) {
        nx = x + dx;
        nw = w - dx;
      }
      if (east) {
        nw = w + dx;
      }
      if (north) {
        ny = y + dy;
        nh = h - dy;
      }
      if (south) {
        nh = h + dy;
      }
      if (nw < 0) {
        nx += nw;
        nw = -nw;
      }
      if (nh < 0) {
        ny += nh;
        nh = -nh;
      }
      return { x: nx, y: ny, w: nw, h: nh };
    };
    if (n.type === "rect") {
      const r3 = applyBox(orig.attrs.x, orig.attrs.y, orig.attrs.width, orig.attrs.height);
      n.attrs.x = r3.x;
      n.attrs.y = r3.y;
      n.attrs.width = r3.w;
      n.attrs.height = r3.h;
    } else if (n.type === "ellipse") {
      const bx = orig.attrs.cx - orig.attrs.rx;
      const by = orig.attrs.cy - orig.attrs.ry;
      const bw = orig.attrs.rx * 2;
      const bh = orig.attrs.ry * 2;
      const r3 = applyBox(bx, by, bw, bh);
      n.attrs.cx = r3.x + r3.w / 2;
      n.attrs.cy = r3.y + r3.h / 2;
      n.attrs.rx = r3.w / 2;
      n.attrs.ry = r3.h / 2;
    } else if (n.type === "circle") {
      const bx = orig.attrs.cx - orig.attrs.r;
      const by = orig.attrs.cy - orig.attrs.r;
      const bw = orig.attrs.r * 2;
      const bh = orig.attrs.r * 2;
      const r3 = applyBox(bx, by, bw, bh);
      const side = Math.min(r3.w, r3.h);
      n.attrs.cx = r3.x + r3.w / 2;
      n.attrs.cy = r3.y + r3.h / 2;
      n.attrs.r = side / 2;
    } else if (n.type === "line") {
      const bx = Math.min(orig.attrs.x1, orig.attrs.x2);
      const by = Math.min(orig.attrs.y1, orig.attrs.y2);
      const bw = Math.abs(orig.attrs.x2 - orig.attrs.x1);
      const bh = Math.abs(orig.attrs.y2 - orig.attrs.y1);
      const r3 = applyBox(bx, by, bw, bh);
      const sx = bw ? (orig.attrs.x1 - bx) / bw : 0;
      const sy = bh ? (orig.attrs.y1 - by) / bh : 0;
      const ex = bw ? (orig.attrs.x2 - bx) / bw : 0;
      const ey = bh ? (orig.attrs.y2 - by) / bh : 0;
      n.attrs.x1 = r3.x + sx * r3.w;
      n.attrs.y1 = r3.y + sy * r3.h;
      n.attrs.x2 = r3.x + ex * r3.w;
      n.attrs.y2 = r3.y + ey * r3.h;
    } else if (n.type === "polyline") {
      const pts = orig.attrs.points;
      if (!pts) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const bw = maxX - minX, bh = maxY - minY;
      const r3 = applyBox(minX, minY, bw, bh);
      const sx = bw ? r3.w / bw : 1;
      const sy = bh ? r3.h / bh : 1;
      n.attrs.points = pts.map(([x, y]) => [r3.x + (x - minX) * sx, r3.y + (y - minY) * sy]);
    }
  }
  function scaleSubtree(node, ax, ay, sx, sy) {
    if (!node.transform) node.transform = emptyTransform();
    const t = node.transform;
    t.tx = ax + ((t.tx || 0) - ax) * sx;
    t.ty = ay + ((t.ty || 0) - ay) * sy;
    if (t.rot) {
      t.cx = (t.cx || 0) * sx;
      t.cy = (t.cy || 0) * sy;
    }
    scaleGeom(node, sx, sy);
    if (node.children) for (const c of node.children) scaleSubtree(c, 0, 0, sx, sy);
  }
  function scaleGeom(node, sx, sy) {
    const a = node.attrs;
    const avg = (Math.abs(sx) + Math.abs(sy)) / 2;
    if (node.type === "rect") {
      a.x *= sx;
      a.y *= sy;
      a.width *= sx;
      a.height *= sy;
    } else if (node.type === "ellipse") {
      a.cx *= sx;
      a.cy *= sy;
      a.rx *= sx;
      a.ry *= sy;
    } else if (node.type === "circle") {
      a.cx *= sx;
      a.cy *= sy;
      a.r *= avg;
    } else if (node.type === "line") {
      a.x1 *= sx;
      a.y1 *= sy;
      a.x2 *= sx;
      a.y2 *= sy;
    } else if (node.type === "polyline" && Array.isArray(a.points)) {
      a.points = a.points.map(([x, y]) => [x * sx, y * sy]);
    } else if (node.type === "text") {
      a.x *= sx;
      a.y *= sy;
      if (a["font-size"]) a["font-size"] *= avg;
    }
  }
  function computeScale(bbox, dir, dx, dy, shift) {
    const west = dir.includes("w"), east = dir.includes("e");
    const north = dir.includes("n"), south = dir.includes("s");
    const { x, y, width: w, height: h } = bbox;
    const ax = west ? x + w : east ? x : x + w / 2;
    const ay = north ? y + h : south ? y : y + h / 2;
    let nw = w, nh = h;
    if (east) nw = w + dx;
    else if (west) nw = w - dx;
    if (south) nh = h + dy;
    else if (north) nh = h - dy;
    let sx = (east || west) && w ? nw / w : 1;
    let sy = (north || south) && h ? nh / h : 1;
    if (shift && (east || west) && (north || south)) {
      const s = Math.max(Math.abs(sx), Math.abs(sy));
      sx = s;
      sy = s;
    }
    const MIN = 0.02;
    sx = Math.max(sx, MIN);
    sy = Math.max(sy, MIN);
    return { sx, sy, ax, ay };
  }
  function startRotate(e, handleEl, p) {
    const id = handleEl.getAttribute("data-id");
    const el = getDocLayer().querySelector(`[data-id="${cssEscape2(id)}"]`);
    const node = findNode(getDoc(), id);
    if (!el || !node) return;
    const b = el.getBBox();
    const localCx = b.x + b.width / 2;
    const localCy = b.y + b.height / 2;
    const centerCanvas = localToCanvasPoint(el, localCx, localCy);
    beginTransaction();
    gesture = {
      type: "rotate",
      origin: p,
      last: p,
      moved: false,
      id,
      center: centerCanvas,
      localCx,
      localCy,
      startAngle: Math.atan2(p.y - centerCanvas.y, p.x - centerCanvas.x),
      originalRot: node.transform?.rot || 0
    };
  }
  function updateRotate(p, e) {
    const { id, center, startAngle, originalRot, localCx, localCy } = gesture;
    const ang = Math.atan2(p.y - center.y, p.x - center.x);
    const delta = (ang - startAngle) * 180 / Math.PI;
    let newRot = originalRot + delta;
    if (e.shiftKey) {
      const step = e.ctrlKey || e.metaKey ? 1 : 22.5;
      newRot = Math.round(newRot / step) * step;
    }
    mutate((root) => {
      const n = findNode(root, id);
      if (!n) return;
      if (!n.transform) n.transform = emptyTransform();
      n.transform.rot = newRot;
      n.transform.cx = localCx;
      n.transform.cy = localCy;
    });
    showRotationReadout(newRot, p);
  }
  var rotationReadoutEl = null;
  function showRotationReadout(deg, p) {
    if (!rotationReadoutEl) {
      rotationReadoutEl = document.createElement("div");
      rotationReadoutEl.className = "rotation-readout";
      document.body.appendChild(rotationReadoutEl);
    }
    rotationReadoutEl.textContent = formatAngle(deg);
    const s = canvasToScreen(p);
    rotationReadoutEl.style.left = `${s.x + 16}px`;
    rotationReadoutEl.style.top = `${s.y + 16}px`;
  }
  function hideRotationReadout() {
    if (rotationReadoutEl) {
      try {
        rotationReadoutEl.remove();
      } catch {
      }
      rotationReadoutEl = null;
    }
  }
  function formatAngle(deg) {
    let a = (deg % 360 + 360) % 360;
    a = Math.round(a * 10) / 10;
    if (a === 360) a = 0;
    return `${a}\xB0`;
  }
  function canvasToScreen(pt) {
    const ctm = canvasSvg2.getScreenCTM();
    if (!ctm) return { x: pt.x, y: pt.y };
    const sp = canvasSvg2.createSVGPoint();
    sp.x = pt.x;
    sp.y = pt.y;
    const r3 = sp.matrixTransform(ctm);
    return { x: r3.x, y: r3.y };
  }
  function localToCanvasPoint(el, x, y) {
    const svg3 = canvasSvg2;
    const pt = svg3.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const M = localToCanvasMatrix(el);
    if (!M) return { x, y };
    const back = pt.matrixTransform(M);
    return { x: back.x, y: back.y };
  }
  function clearTransient() {
    const layer = getTransientLayer();
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }
  function cssEscape2(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  function handleTextDown(e, p) {
    const id = newId("t");
    beginTransaction();
    const node = {
      id,
      type: "text",
      transform: emptyTransform(),
      attrs: {
        x: p.x,
        y: p.y,
        "font-family": TEXT_DEFAULTS["font-family"],
        "font-size": TEXT_DEFAULTS["font-size"],
        fill: TEXT_DEFAULTS.fill
      },
      text: ""
    };
    mutate((root) => {
      root.children.push(node);
    });
    commit("create text");
    setSelection([id]);
    openTextEditor(node);
  }
  var editorEl = null;
  var editorTargetId = null;
  var editorMode = null;
  function openTextEditor(node) {
    editorTargetId = node.id;
    editorMode = "text-node";
    showEditor(node.text || "", () => positionForTextNode(node));
  }
  function openLabelEditor(node) {
    editorTargetId = node.id;
    editorMode = "label";
    showEditor(node.label || "", () => positionForLabel(node));
  }
  function showEditor(initial, positionFn) {
    if (editorEl) {
      try {
        editorEl.remove();
      } catch {
      }
      editorEl = null;
    }
    const el = document.createElement("div");
    el.className = "text-edit-overlay";
    el.contentEditable = "true";
    el.textContent = initial;
    document.body.appendChild(el);
    editorEl = el;
    Object.assign(el.style, positionFn());
    el.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        commitTextEditor();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        cancelTextEditor();
      }
    });
    setTimeout(() => {
      if (!editorEl || editorEl !== el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      el.addEventListener("blur", () => commitTextEditor(), { once: true });
    }, 0);
  }
  function positionForTextNode(node) {
    const svg3 = canvasSvg2;
    const pt = svg3.createSVGPoint();
    pt.x = node.attrs.x;
    pt.y = node.attrs.y;
    const ctm = svg3.getScreenCTM();
    const screen = pt.matrixTransform(ctm);
    const size = node.attrs["font-size"] || 20;
    const screenSize = size * ctm.a;
    return {
      left: `${screen.x}px`,
      top: `${screen.y - screenSize}px`,
      fontFamily: node.attrs["font-family"] || "sans-serif",
      fontSize: `${screenSize}px`,
      color: node.attrs.fill || "#000"
    };
  }
  function positionForLabel(node) {
    const svg3 = canvasSvg2;
    const ctm = svg3.getScreenCTM();
    const style = node.labelStyle || {};
    const size = style["font-size"] || 16;
    const screenSize = size * (ctm?.a || 1);
    const base = {
      fontFamily: style["font-family"] || "sans-serif",
      fontSize: `${screenSize}px`,
      color: style.fill || "#000",
      transform: "translate(-50%, -50%)",
      textAlign: "center"
    };
    const labelDom = getDocLayer().querySelector(`text[data-role="label"][data-owner="${cssEscape2(node.id)}"]`);
    if (labelDom) {
      const r3 = labelDom.getBoundingClientRect();
      return { ...base, left: `${r3.left + r3.width / 2}px`, top: `${r3.top + r3.height / 2}px` };
    }
    const shapeDom = getDocLayer().querySelector(`[data-id="${cssEscape2(node.id)}"]`);
    if (shapeDom) {
      const r3 = shapeDom.getBoundingClientRect();
      return { ...base, left: `${r3.left + r3.width / 2}px`, top: `${r3.top + r3.height / 2}px` };
    }
    return { ...base, left: `50%`, top: `50%` };
  }
  function commitTextEditor() {
    if (!editorEl || !editorTargetId) return closeTextEditor();
    const value = editorEl.textContent;
    const id = editorTargetId;
    const mode = editorMode;
    closeTextEditor();
    if (mode === "text-node") {
      if (!value || !value.trim()) {
        record(() => {
          mutate((root) => {
            const idx = root.children.findIndex((c) => c.id === id);
            if (idx >= 0) root.children.splice(idx, 1);
          });
        });
        return;
      }
      record(() => {
        mutate((root) => {
          const n = findNode(root, id);
          if (n) n.text = value;
        });
      });
    } else if (mode === "label") {
      record(() => {
        mutate((root) => {
          const n = findNode(root, id);
          if (!n) return;
          if (value && value.trim()) n.label = value;
          else delete n.label;
        });
      });
    }
  }
  function cancelTextEditor() {
    const id = editorTargetId;
    const mode = editorMode;
    closeTextEditor();
    if (mode === "text-node") {
      const node = findNode(getDoc(), id);
      if (node && !node.text) {
        record(() => {
          mutate((root) => {
            const idx = root.children.findIndex((c) => c.id === id);
            if (idx >= 0) root.children.splice(idx, 1);
          });
        });
      }
    }
  }
  function closeTextEditor() {
    if (editorEl) {
      try {
        editorEl.remove();
      } catch {
      }
    }
    editorEl = null;
    editorTargetId = null;
    editorMode = null;
  }
  function isTextEditing() {
    return editorEl !== null;
  }
  var ctxMenuEl = null;
  function openContextMenu(clientX, clientY, anchorId) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.setAttribute("role", "menu");
    const items = [
      { label: "Bring to Front", action: () => zOrder("front") },
      { label: "Bring Forward", action: () => zOrder("forward") },
      { label: "Send Backward", action: () => zOrder("backward") },
      { label: "Send to Back", action: () => zOrder("back") }
    ];
    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-menu-item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        closeContextMenu();
        it.action();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const { innerWidth: vw, innerHeight: vh } = window;
    const r3 = menu.getBoundingClientRect();
    const left = Math.min(clientX, vw - r3.width - 4);
    const top = Math.min(clientY, vh - r3.height - 4);
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${Math.max(0, top)}px`;
    ctxMenuEl = menu;
    setTimeout(() => {
      window.addEventListener("pointerdown", onDismissContext, true);
      window.addEventListener("keydown", onDismissContextKey, true);
      window.addEventListener("blur", closeContextMenu, true);
    }, 0);
  }
  function onDismissContext(e) {
    if (ctxMenuEl && ctxMenuEl.contains(e.target)) return;
    closeContextMenu();
  }
  function onDismissContextKey(e) {
    if (e.key === "Escape") closeContextMenu();
  }
  function closeContextMenu() {
    if (!ctxMenuEl) return;
    try {
      ctxMenuEl.remove();
    } catch {
    }
    ctxMenuEl = null;
    window.removeEventListener("pointerdown", onDismissContext, true);
    window.removeEventListener("keydown", onDismissContextKey, true);
    window.removeEventListener("blur", closeContextMenu, true);
  }
  function zOrder(op) {
    const sel = [...getSelection()];
    if (sel.length === 0) return;
    const doc2 = getDoc();
    const topIds = /* @__PURE__ */ new Set();
    for (const id of sel) {
      const top = topAncestor(doc2, id);
      if (top) topIds.add(top.id);
    }
    if (topIds.size === 0) return;
    record(() => {
      mutate((root) => {
        const kids = root.children;
        const moving = kids.filter((c) => topIds.has(c.id));
        if (moving.length === 0) return;
        const stationary = kids.filter((c) => !topIds.has(c.id));
        if (op === "front") {
          root.children = [...stationary, ...moving];
        } else if (op === "back") {
          root.children = [...moving, ...stationary];
        } else if (op === "forward") {
          const arr = kids.slice();
          for (let i = arr.length - 1; i >= 0; i--) {
            if (!topIds.has(arr[i].id)) continue;
            const j = i + 1;
            if (j >= arr.length) continue;
            if (topIds.has(arr[j].id)) continue;
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          root.children = arr;
        } else if (op === "backward") {
          const arr = kids.slice();
          for (let i = 0; i < arr.length; i++) {
            if (!topIds.has(arr[i].id)) continue;
            const j = i - 1;
            if (j < 0) continue;
            if (topIds.has(arr[j].id)) continue;
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          root.children = arr;
        }
      });
    });
  }

  // js/align.js
  var CANVAS = { x: 0, y: 0, width: 1e3, height: 700 };
  function align(op) {
    const doc2 = getDoc();
    const topIds = topAncestorIds([...getSelection()], doc2);
    if (topIds.length === 0) return;
    const items = [];
    for (const id of topIds) {
      const el = getDocLayer().querySelector(`[data-id="${cssEscape3(id)}"]`);
      if (!el) continue;
      const bbox = elementBBoxInCanvas(el);
      if (!bbox) continue;
      items.push({ id, bbox });
    }
    if (items.length === 0) return;
    const isDistribute = op === "dist-h" || op === "dist-v";
    if (isDistribute && items.length < 3) return;
    const ref = items.length === 1 ? CANVAS : unionBBox(items.map((i) => i.bbox));
    const deltas = /* @__PURE__ */ new Map();
    if (isDistribute) {
      computeDistributeDeltas(items, op, deltas);
    } else {
      for (const it of items) {
        const { dx, dy } = alignDelta(it.bbox, ref, op);
        deltas.set(it.id, { dx, dy });
      }
    }
    let anyMove = false;
    for (const { dx, dy } of deltas.values()) {
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        anyMove = true;
        break;
      }
    }
    if (!anyMove) return;
    record(() => {
      mutate((root) => {
        for (const [id, d] of deltas) {
          const n = findNode(root, id);
          if (!n) continue;
          if (!n.transform) n.transform = emptyTransform();
          n.transform.tx = (n.transform.tx || 0) + d.dx;
          n.transform.ty = (n.transform.ty || 0) + d.dy;
        }
      });
    });
  }
  function alignDelta(b, ref, op) {
    switch (op) {
      case "left":
        return { dx: ref.x - b.x, dy: 0 };
      case "right":
        return { dx: ref.x + ref.width - (b.x + b.width), dy: 0 };
      case "center-h":
        return { dx: ref.x + ref.width / 2 - (b.x + b.width / 2), dy: 0 };
      case "top":
        return { dx: 0, dy: ref.y - b.y };
      case "bottom":
        return { dx: 0, dy: ref.y + ref.height - (b.y + b.height) };
      case "middle-v":
        return { dx: 0, dy: ref.y + ref.height / 2 - (b.y + b.height / 2) };
    }
    return { dx: 0, dy: 0 };
  }
  function computeDistributeDeltas(items, op, deltas) {
    const axis = op === "dist-h" ? "x" : "y";
    const size = axis === "x" ? "width" : "height";
    const sorted = items.map((it) => ({ ...it, center: it.bbox[axis] + it.bbox[size] / 2 })).sort((a, b) => a.center - b.center);
    const first = sorted[0].center;
    const last = sorted[sorted.length - 1].center;
    const step = (last - first) / (sorted.length - 1);
    for (let i = 0; i < sorted.length; i++) {
      const target = first + step * i;
      const delta = target - sorted[i].center;
      deltas.set(sorted[i].id, axis === "x" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    }
  }
  function unionBBox(bboxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bboxes) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  function topAncestorIds(ids, root) {
    const set = /* @__PURE__ */ new Set();
    const order = [];
    for (const c of root.children) {
      for (const id of ids) {
        const path = findPath(root, id);
        if (!path || path.length === 0) continue;
        if (path[0].id === c.id && !set.has(c.id)) {
          set.add(c.id);
          order.push(c.id);
        }
      }
    }
    return order;
  }
  function cssEscape3(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  // js/persist.js
  var FORMAT_VERSION = 1;
  var AUTOSAVE_KEY = "euclid.doc.autosave";
  var AUTOSAVE_DEBOUNCE = 400;
  var LoadError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "LoadError";
    }
  };
  var fileInput = null;
  var autosaveTimer = null;
  function serializeDocument(pretty = false) {
    const payload = { version: FORMAT_VERSION, doc: getDoc() };
    return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  }
  function parseDocument(text) {
    let payload;
    try {
      payload = JSON.parse(String(text ?? ""));
    } catch {
      throw new LoadError("Not a valid Euclid file (could not parse JSON).");
    }
    if (!payload || typeof payload !== "object") {
      throw new LoadError("Not a valid Euclid file (unexpected structure).");
    }
    const version = payload.version;
    if (typeof version !== "number" || !Number.isFinite(version)) {
      throw new LoadError("Not a valid Euclid file (missing version).");
    }
    if (version > FORMAT_VERSION) {
      throw new LoadError(
        `This file was made by a newer version of Euclid (format v${version}). This build understands up to v${FORMAT_VERSION}.`
      );
    }
    const root = payload.doc;
    if (!root || typeof root !== "object" || root.id !== "root" || root.type !== "group" || !Array.isArray(root.children)) {
      throw new LoadError("Not a valid Euclid file (missing document root).");
    }
    normalize(root);
    return root;
  }
  function normalize(root) {
    walk(root, (n) => {
      if (typeof n !== "object" || n === null) return;
      if (n.attrs == null || typeof n.attrs !== "object") n.attrs = {};
      if (n.transform == null && n.type !== "connector") n.transform = emptyTransform();
      if (n.children != null && !Array.isArray(n.children)) n.children = [];
    });
  }
  function loadDocument(root) {
    replaceRoot(root);
    clearSelection();
    resetHistory();
  }
  function saveToFile() {
    const text = serializeDocument(true);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "drawing.euclid.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function triggerOpen() {
    if (fileInput) fileInput.click();
  }
  function openFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadDocument(parseDocument(reader.result));
      } catch (err) {
        const msg = err instanceof LoadError ? err.message : "Could not open this file.";
        alert(msg);
      }
    };
    reader.onerror = () => alert("Could not read this file.");
    reader.readAsText(file);
  }
  function writeAutosave() {
    try {
      window.localStorage.setItem(AUTOSAVE_KEY, serializeDocument(false));
    } catch {
    }
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE);
  }
  function restoreAutosave() {
    let text = null;
    try {
      text = window.localStorage.getItem(AUTOSAVE_KEY);
    } catch {
      return;
    }
    if (!text) return;
    try {
      loadDocument(parseDocument(text));
    } catch {
    }
  }
  function mount4(root) {
    const saveBtn = root.querySelector("#save-btn");
    const openBtn2 = root.querySelector("#open-btn");
    fileInput = root.querySelector("#open-file");
    if (saveBtn) saveBtn.addEventListener("click", saveToFile);
    if (openBtn2) openBtn2.addEventListener("click", triggerOpen);
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        openFromFile(file);
        fileInput.value = "";
      });
    }
  }

  // js/ui.js
  var TOOL_KEYS = { v: "select", r: "rect", e: "ellipse", c: "circle", l: "line", p: "polyline", t: "text", x: "connector" };
  var propsEmpty;
  var propsForm;
  var pFill;
  var pFillNone;
  var pStroke;
  var pStrokeNone;
  var pStrokeWidth;
  var pOpacity;
  var pOpacityNum;
  var pText;
  var pFontSize;
  var pFontFamily;
  var pTextColor;
  var pRotation;
  var clipboard = null;
  var gridApi = null;
  function mount5(root) {
    wireToolbar(root);
    wireProperties(root);
    wireKeyboard();
    wireCollapsibles(root);
    document.addEventListener("tool-changed", (e) => reflectToolInUI(e.detail));
    reflectToolInUI(getTool());
  }
  function wireCollapsibles(root) {
    const side = root.querySelector("#side");
    const toggles = root.querySelectorAll(".section-toggle[data-section]");
    const sectionOf = { layers: "#layers-section", source: "#source-section" };
    const sync = (name) => {
      const section = root.querySelector(sectionOf[name]);
      const btn = root.querySelector(`.section-toggle[data-section="${name}"]`);
      if (!section || !btn) return;
      const collapsed2 = section.classList.contains("collapsed");
      btn.setAttribute("aria-expanded", String(!collapsed2));
      side?.classList.toggle(`${name}-collapsed`, collapsed2);
    };
    for (const btn of toggles) {
      const name = btn.dataset.section;
      sync(name);
      btn.addEventListener("click", () => {
        root.querySelector(sectionOf[name])?.classList.toggle("collapsed");
        sync(name);
      });
    }
  }
  function mountViewport(viewport, svg3) {
    const readout = document.getElementById("zoom-readout");
    viewport.mount(svg3, (_scale) => {
      if (readout) readout.textContent = `${viewport.getZoomPercent()}%`;
    });
    const byId = (id) => document.getElementById(id);
    byId("zoom-in")?.addEventListener("click", () => viewport.zoomInCentered());
    byId("zoom-out")?.addEventListener("click", () => viewport.zoomOutCentered());
    byId("zoom-fit")?.addEventListener("click", () => viewport.fit());
    readout?.addEventListener("click", () => viewport.resetZoom());
    viewport.fit();
  }
  function mountGrid(grid) {
    gridApi = grid;
    const gridBtn = document.getElementById("grid-toggle");
    const snapBtn = document.getElementById("snap-toggle");
    const reflect = ({ visible: visible2, snap: snap2 }) => {
      gridBtn?.setAttribute("aria-pressed", String(visible2));
      gridBtn?.classList.toggle("active", visible2);
      snapBtn?.setAttribute("aria-pressed", String(snap2));
      snapBtn?.classList.toggle("active", snap2);
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
    document.querySelectorAll("#toolbar .tool").forEach((b) => {
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
      if (v === null) return;
      ensureTransaction();
      pOpacity.value = v;
      applyToSelection("opacity", v);
    });
    pOpacityNum.addEventListener("change", () => {
      const v = clampOpacity(pOpacityNum.value);
      if (v === null) {
        pOpacityNum.value = pOpacity.value;
        return;
      }
      pOpacityNum.value = v;
      pOpacity.value = v;
      historyCommitAfter(() => applyToSelection("opacity", v));
    });
    for (const input of [pFill, pStroke, pStrokeWidth, pOpacity, pTextColor]) {
      input.addEventListener("pointerdown", () => beginTransaction());
    }
    pText.addEventListener("input", () => applyTextContent(pText.value));
    pText.addEventListener("change", () => historyCommitAfter(() => applyTextContent(pText.value)));
    pText.addEventListener("pointerdown", () => beginTransaction());
    pFontSize.addEventListener("input", () => applyFontSize(Number(pFontSize.value)));
    pFontSize.addEventListener("change", () => historyCommitAfter(() => applyFontSize(Number(pFontSize.value))));
    pFontSize.addEventListener("pointerdown", () => beginTransaction());
    pFontFamily.addEventListener("change", () => historyRecord(() => applyFontFamily(pFontFamily.value)));
    pTextColor.addEventListener("input", () => applyTextColor(pTextColor.value));
    pTextColor.addEventListener("change", () => historyCommitAfter(() => applyTextColor(pTextColor.value)));
    pRotation.addEventListener("input", () => {
      const deg = normalizeAngle(pRotation.value);
      if (deg === null) return;
      ensureTransaction();
      applyRotation(deg);
    });
    pRotation.addEventListener("change", () => {
      const deg = normalizeAngle(pRotation.value);
      if (deg === null) {
        refreshPropertyPanel();
        return;
      }
      pRotation.value = deg;
      ensureTransaction();
      applyRotation(deg);
      commit();
    });
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
          n.labelStyle = { ...n.labelStyle || {}, "font-size": value };
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
          n.labelStyle = { ...n.labelStyle || {}, "font-family": value };
        }
      }
    });
  }
  function applyRotation(deg) {
    const ids = [...getSelection()];
    if (ids.length === 0) return;
    const docLayer2 = document.getElementById("doc-layer");
    mutate((root) => {
      for (const id of ids) {
        const n = findNode(root, id);
        if (!n) continue;
        if (!n.transform) n.transform = emptyTransform();
        const el = docLayer2?.querySelector(`[data-id="${cssEscapeLocal(id)}"]`);
        if (el && typeof el.getBBox === "function") {
          try {
            const b = el.getBBox();
            n.transform.cx = b.x + b.width / 2;
            n.transform.cy = b.y + b.height / 2;
          } catch {
          }
        }
        n.transform.rot = deg;
      }
    });
  }
  function cssEscapeLocal(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
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
          n.labelStyle = { ...n.labelStyle || {}, fill: value };
        }
      }
    });
  }
  function historyCommitAfter(fn) {
    fn();
    commit("prop edit");
  }
  function historyRecord(fn) {
    beginTransaction();
    fn();
    commit("prop edit");
  }
  function applyToSelection(key, value) {
    const ids = [...getSelection()];
    if (ids.length === 0) return;
    mutate((root) => {
      for (const id of ids) {
        const n = findNode(root, id);
        if (!n) continue;
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
  function refreshPropertyPanel() {
    const ids = [...getSelection()];
    if (ids.length === 0) {
      propsEmpty.hidden = false;
      propsForm.hidden = true;
      return;
    }
    propsEmpty.hidden = true;
    propsForm.hidden = false;
    const canDistribute = ids.length >= 3;
    document.querySelectorAll('#align-grid .align-btn[data-align^="dist-"]').forEach((b) => {
      b.disabled = !canDistribute;
    });
    const doc2 = getDoc();
    let sample = null;
    for (const id of ids) {
      const n = findNode(doc2, id);
      if (!n) continue;
      sample = firstShape(n);
      if (sample) break;
    }
    if (!sample) return;
    const fill = sample.attrs.fill ?? "#000000";
    const stroke = sample.attrs.stroke ?? "#000000";
    const sw = sample.attrs["stroke-width"] ?? 1;
    const op = sample.attrs.opacity ?? 1;
    pFillNone.checked = fill === "none";
    pFill.value = normalizeColor(fill, "#88ccee");
    pStrokeNone.checked = stroke === "none";
    pStroke.value = normalizeColor(stroke, "#222222");
    pStrokeWidth.value = sw;
    pOpacity.value = op;
    pOpacityNum.value = round22(op);
    const firstSel = findNode(doc2, ids[0]);
    const rot = firstSel?.transform?.rot || 0;
    if (document.activeElement !== pRotation) pRotation.value = normalizeAngle(rot) ?? 0;
    const firstId = [...getSelection()][0];
    const firstNode = firstId ? findNode(doc2, firstId) : null;
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
  function round22(n) {
    return Math.round(Number(n) * 100) / 100;
  }
  function normalizeAngle(raw) {
    if (raw === "" || raw === null || raw === void 0) return null;
    let n = Number(raw);
    if (!Number.isFinite(n)) return null;
    n = (n % 360 + 360) % 360;
    if (n > 180) n -= 360;
    return Math.round(n * 10) / 10;
  }
  function clampOpacity(raw) {
    if (raw === "" || raw === null || raw === void 0) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }
  function normalizeColor(v, fallback) {
    if (typeof v !== "string") return fallback;
    if (v === "none") return fallback;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return "#" + v.slice(1).split("").map((c) => c + c).join("").toLowerCase();
    }
    return fallback;
  }
  function wireKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (isEditableTarget(e.target)) return;
      if (isTextEditing()) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (TOOL_KEYS[k]) {
          setTool(TOOL_KEYS[k]);
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Escape") {
        cancelPolyline();
        setTool("select");
        clearSelection();
        e.preventDefault();
        return;
      }
      if (e.key === "F2") {
        const ids = [...getSelection()];
        if (ids.length === 1) {
          const n = findNode(getDoc(), ids[0]);
          if (n) openLabelEditor(n);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelection();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        undo();
        e.preventDefault();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || e.key.toLowerCase() === "z" && e.shiftKey)) {
        redo();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        selectAll();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        duplicateSelection();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        copySelection();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        pasteClipboard();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
        groupSelection();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "g" && e.shiftKey) {
        ungroupSelection();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        saveToFile();
        e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        triggerOpen();
        e.preventDefault();
        return;
      }
      if (mod && (e.key === "'" || e.key === '"')) {
        if (gridApi) {
          e.shiftKey ? gridApi.toggleSnap() : gridApi.toggleVisible();
        }
        e.preventDefault();
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        nudge(dx, dy);
        e.preventDefault();
        return;
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
  function deleteSelection() {
    const ids = new Set(getSelection());
    if (ids.size === 0) return;
    record(() => {
      mutate((root) => {
        removeByIds(root, ids);
        const alive = /* @__PURE__ */ new Set();
        walk(root, (n) => alive.add(n.id));
        const orphaned = /* @__PURE__ */ new Set();
        walk(root, (n) => {
          if (n.type !== "connector") return;
          const fromDead = n.from?.ref != null && !alive.has(n.from.ref);
          const toDead = n.to?.ref != null && !alive.has(n.to.ref);
          if (fromDead || toDead) orphaned.add(n.id);
        });
        if (orphaned.size) removeByIds(root, orphaned);
      });
    });
    clearSelection();
  }
  function selectAll() {
    const doc2 = getDoc();
    setSelection(doc2.children.map((c) => c.id));
  }
  function duplicateSelection() {
    const ids = [...getSelection()];
    if (ids.length === 0) return;
    const newIds = [];
    record(() => {
      mutate((root) => {
        const seen = /* @__PURE__ */ new Set();
        const topIds = /* @__PURE__ */ new Set();
        for (const id of ids) {
          const path = findPath(root, id);
          if (!path || path.length === 0) continue;
          topIds.add(path[0].id);
        }
        for (const id of topIds) {
          const node = findNode(root, id);
          if (!node) continue;
          const copy = deepReId2(node);
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
  function deepReId2(node) {
    const copy = structuredClone(node);
    walk(copy, (n) => {
      n.id = newId(n.type === "group" ? "g" : "n");
    });
    return copy;
  }
  function copySelection() {
    const ids = [...getSelection()];
    if (ids.length === 0) return;
    const doc2 = getDoc();
    const nodes = [];
    const topIds = /* @__PURE__ */ new Set();
    for (const id of ids) {
      const path = findPath(doc2, id);
      if (!path || path.length === 0) continue;
      topIds.add(path[0].id);
    }
    for (const id of topIds) {
      const n = findNode(doc2, id);
      if (n) nodes.push(structuredClone(n));
    }
    clipboard = nodes;
  }
  function pasteClipboard() {
    if (!clipboard || clipboard.length === 0) return;
    const newIds = [];
    record(() => {
      mutate((root) => {
        for (const src of clipboard) {
          const copy = deepReId2(src);
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
    record(() => {
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
    record(() => {
      mutate((root) => {
        const topIds = /* @__PURE__ */ new Set();
        for (const id of ids) {
          const path = findPath(root, id);
          if (!path || path.length === 0) continue;
          topIds.add(path[0].id);
        }
        const orderedTops = root.children.filter((c) => topIds.has(c.id));
        if (orderedTops.length < 2) return;
        root.children = root.children.filter((c) => !topIds.has(c.id));
        const group = {
          id: gId,
          type: "group",
          attrs: {},
          transform: emptyTransform(),
          children: orderedTops
        };
        const insertAt = root.children.length;
        root.children.splice(insertAt, 0, group);
      });
    });
    setSelection([gId]);
  }
  function ungroupSelection() {
    const ids = [...getSelection()];
    if (ids.length === 0) return;
    const releasedIds = [];
    record(() => {
      mutate((root) => {
        for (const id of ids) {
          const node = findNode(root, id);
          if (!node || node.type !== "group") continue;
          const parent = findParent(root, id);
          if (!parent) continue;
          const idx = parent.children.indexOf(node);
          if (idx < 0) continue;
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

  // js/export.js
  var DEFAULT_VIEWBOX = { x: 0, y: 0, width: 1e3, height: 700 };
  var TIGHT_PADDING = 8;
  var INDENT = "  ";
  var tightMode = false;
  var GEOMETRY_ATTRS = [
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "x1",
    "y1",
    "x2",
    "y2",
    "points",
    "d"
  ];
  var TEXT_ATTRS = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline"
  ];
  var PRESENTATION_ATTRS = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "opacity"
  ];
  var DEFAULTS = {
    opacity: 1,
    "fill-opacity": 1,
    "stroke-opacity": 1,
    rx: 0,
    ry: 0
  };
  function serialize() {
    const doc2 = getDoc();
    const vb2 = tightMode ? computeTightViewBox() : DEFAULT_VIEWBOX;
    const vbStr = `${round3(vb2.x)} ${round3(vb2.y)} ${round3(vb2.width)} ${round3(vb2.height)}`;
    const lines = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbStr}">`
    ];
    lines.push(...arrowDefs(doc2));
    for (const child of doc2.children) {
      lines.push(...emitNode(child, 1));
    }
    lines.push(`</svg>`);
    return lines.join("\n") + "\n";
  }
  function arrowDefs(doc2) {
    const needsEnd = doc2.children.some((c) => c.type === "connector" && c.arrowEnd);
    const needsStart = doc2.children.some((c) => c.type === "connector" && c.arrowStart);
    if (!needsEnd && !needsStart) return [];
    const out = [`${INDENT}<defs>`];
    const marker = (id) => [
      `${INDENT}${INDENT}<marker id="${id}" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">`,
      `${INDENT}${INDENT}${INDENT}<path d="M0 0L10 5L0 10z" fill="context-stroke"/>`,
      `${INDENT}${INDENT}</marker>`
    ];
    if (needsEnd) out.push(...marker("arrow-end"));
    if (needsStart) out.push(...marker("arrow-start"));
    out.push(`${INDENT}</defs>`);
    return out;
  }
  function setTightMode(on) {
    tightMode = !!on;
    refreshSourcePanel();
  }
  function computeTightViewBox() {
    const docLayer2 = document.getElementById("doc-layer");
    const canvasSvg3 = docLayer2?.ownerSVGElement;
    if (!docLayer2 || !canvasSvg3) return DEFAULT_VIEWBOX;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of docLayer2.children) {
      const bb = elementBBoxInCanvas(el);
      if (!bb) continue;
      if (bb.width === 0 && bb.height === 0) continue;
      if (bb.x1 < minX) minX = bb.x1;
      if (bb.y1 < minY) minY = bb.y1;
      if (bb.x2 > maxX) maxX = bb.x2;
      if (bb.y2 > maxY) maxY = bb.y2;
    }
    if (!isFinite(minX)) return DEFAULT_VIEWBOX;
    return {
      x: minX - TIGHT_PADDING,
      y: minY - TIGHT_PADDING,
      width: maxX - minX + TIGHT_PADDING * 2,
      height: maxY - minY + TIGHT_PADDING * 2
    };
  }
  function emitNode(node, depth) {
    const pad = INDENT.repeat(depth);
    if (node.type === "connector") {
      const g = resolveConnector(node);
      if (!g || !g.valid) return [];
      const parts = [
        `x1="${round3(g.x1)}"`,
        `y1="${round3(g.y1)}"`,
        `x2="${round3(g.x2)}"`,
        `y2="${round3(g.y2)}"`
      ];
      for (const k of PRESENTATION_ATTRS) {
        if (!(k in (node.attrs || {}))) continue;
        const v = node.attrs[k];
        if (isDefault(k, v)) continue;
        parts.push(`${k}="${formatValue(k, v)}"`);
      }
      if (node.arrowEnd) parts.push(`marker-end="url(#arrow-end)"`);
      if (node.arrowStart) parts.push(`marker-start="url(#arrow-start)"`);
      return [`${pad}<line ${parts.join(" ")}/>`];
    }
    const attrs = buildAttrs(node);
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    if (node.type === "group") {
      const children = node.children || [];
      const labelChild = node.label ? labelChildFor(node) : null;
      if (children.length === 0 && !labelChild) {
        return [`${pad}<g${attrStr}/>`];
      }
      const out = [`${pad}<g${attrStr}>`];
      for (const child of children) out.push(...emitNode(child, depth + 1));
      if (labelChild) out.push(...emitNode(labelChild, depth + 1));
      out.push(`${pad}</g>`);
      return out;
    }
    if (node.type === "text") {
      const inner = escapeXmlText(String(node.text ?? ""));
      return [`${pad}<text${attrStr}>${inner}</text>`];
    }
    if (node.label) {
      const wrapper = {
        type: "group",
        attrs: {},
        transform: null,
        children: [{ ...node, label: void 0 }],
        label: void 0
      };
      const label = labelChildFor(node);
      const out = [`${pad}<g>`];
      out.push(...emitNode(wrapper.children[0], depth + 1));
      out.push(...emitNode(label, depth + 1));
      out.push(`${pad}</g>`);
      return out;
    }
    return [`${pad}<${node.type}${attrStr}/>`];
  }
  function labelChildFor(ownerNode) {
    const bbox = localBBoxOfNode(ownerNode);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const style = ownerNode.labelStyle || {};
    return {
      type: "text",
      attrs: {
        x: cx,
        y: cy,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-family": style["font-family"] || "sans-serif",
        "font-size": style["font-size"] || 16,
        fill: style.fill || "#000000"
      },
      transform: null,
      text: ownerNode.label
    };
  }
  function localBBoxOfNode(node) {
    if (node.type === "group") {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const rec = (n) => {
        const tx = n.transform?.tx || 0;
        const ty = n.transform?.ty || 0;
        if (n.type === "group") {
          (n.children || []).forEach(rec);
          return;
        }
        const b = localBBoxOfNode(n);
        const x1 = b.x + tx, y1 = b.y + ty, x2 = x1 + b.width, y2 = y1 + b.height;
        if (x1 < minX) minX = x1;
        if (y1 < minY) minY = y1;
        if (x2 > maxX) maxX = x2;
        if (y2 > maxY) maxY = y2;
      };
      (node.children || []).forEach(rec);
      if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    const a = node.attrs;
    if (node.type === "rect") return { x: a.x, y: a.y, width: a.width, height: a.height };
    if (node.type === "circle") return { x: a.cx - a.r, y: a.cy - a.r, width: a.r * 2, height: a.r * 2 };
    if (node.type === "ellipse") return { x: a.cx - a.rx, y: a.cy - a.ry, width: a.rx * 2, height: a.ry * 2 };
    if (node.type === "line") {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x, y, width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1) };
    }
    if (node.type === "polyline" && Array.isArray(a.points) && a.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of a.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    if (node.type === "text") {
      const size = a["font-size"] || 16;
      const w = String(node.text || "").length * size * 0.6;
      return { x: a.x, y: a.y - size, width: w, height: size * 1.2 };
    }
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  function escapeXmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function buildAttrs(node) {
    const attrs = [];
    const emit2 = (k, v) => attrs.push(`${k}="${formatValue(k, v)}"`);
    for (const k of GEOMETRY_ATTRS) {
      if (!(k in node.attrs)) continue;
      const v = node.attrs[k];
      if (isDefault(k, v)) continue;
      emit2(k, v);
    }
    for (const k of TEXT_ATTRS) {
      if (!(k in node.attrs)) continue;
      const v = node.attrs[k];
      if (isDefault(k, v)) continue;
      emit2(k, v);
    }
    for (const k of PRESENTATION_ATTRS) {
      if (!(k in node.attrs)) continue;
      const v = node.attrs[k];
      if (isDefault(k, v)) continue;
      emit2(k, v);
    }
    for (const [k, v] of Object.entries(node.attrs)) {
      if (GEOMETRY_ATTRS.includes(k) || TEXT_ATTRS.includes(k) || PRESENTATION_ATTRS.includes(k)) continue;
      if (isDefault(k, v)) continue;
      emit2(k, v);
    }
    const tStr = transformString(node.transform);
    if (tStr) attrs.push(`transform="${tStr}"`);
    return attrs;
  }
  function isDefault(k, v) {
    if (v === void 0 || v === null || v === "") return true;
    if (k in DEFAULTS && v === DEFAULTS[k]) return true;
    return false;
  }
  function formatValue(k, v) {
    if (k === "points" && Array.isArray(v)) {
      return v.map((p) => `${round3(p[0])},${round3(p[1])}`).join(" ");
    }
    if (typeof v === "number") return String(round3(v));
    return escapeXml(String(v));
  }
  function round3(n) {
    if (typeof n !== "number") return n;
    if (Math.abs(n) < 1e-9) return 0;
    return Math.round(n * 1e3) / 1e3;
  }
  function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function transformString(t) {
    if (!t) return "";
    const parts = [];
    if (t.tx || t.ty) parts.push(`translate(${round3(t.tx)},${round3(t.ty)})`);
    if (t.rot) parts.push(`rotate(${round3(t.rot)},${round3(t.cx)},${round3(t.cy)})`);
    return parts.join(" ");
  }
  var sourcePanel;
  var debounceTimer = null;
  function mountPanel(preEl, copyBtn, downloadBtn, tightToggle) {
    sourcePanel = preEl;
    if (tightToggle) {
      tightToggle.checked = tightMode;
      tightToggle.addEventListener("change", () => setTightMode(tightToggle.checked));
    }
    copyBtn.addEventListener("click", async () => {
      const text = serialize();
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch {
      }
      if (!ok) ok = fallbackCopy(text);
      if (ok) flashButton(copyBtn);
    });
    downloadBtn.addEventListener("click", () => {
      const text = serialize();
      const blob = new Blob([text], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "canvas.svg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
      flashButton(downloadBtn);
    });
    refreshSourcePanel();
  }
  function refreshSourcePanel() {
    if (!sourcePanel) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      sourcePanel.textContent = serialize();
    }, 40);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
  function flashButton(btn) {
    btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), 200);
  }

  // js/import.js
  var SUPPORTED_SHAPES = /* @__PURE__ */ new Set(["rect", "circle", "ellipse", "line", "polyline", "text", "path"]);
  var SUPPORTED_CONTAINERS = /* @__PURE__ */ new Set(["g"]);
  var IGNORABLE = /* @__PURE__ */ new Set(["title", "desc", "metadata", "style", "defs"]);
  var PAINT_SERVER_ELEMENTS = /* @__PURE__ */ new Set([
    "linearGradient",
    "radialGradient",
    "pattern",
    "filter",
    "clipPath",
    "mask",
    "symbol",
    "marker",
    "use",
    "image"
  ]);
  var SHAPE_ATTRS = {
    rect: ["x", "y", "width", "height", "rx", "ry"],
    circle: ["cx", "cy", "r"],
    ellipse: ["cx", "cy", "rx", "ry"],
    line: ["x1", "y1", "x2", "y2"],
    polyline: ["points"],
    text: ["x", "y"],
    path: ["d"]
  };
  var PRESENTATION_ATTRS2 = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline"
  ];
  var ImportError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ImportError";
    }
  };
  function parseSvgToNodes(source) {
    const trimmed = String(source ?? "").trim();
    if (!trimmed) throw new ImportError("Empty input");
    const parser = new DOMParser();
    const doc2 = parser.parseFromString(trimmed, "image/svg+xml");
    const parseErr = doc2.querySelector("parsererror");
    if (parseErr) {
      throw new ImportError("XML parse error: " + (parseErr.textContent || "").trim().slice(0, 200));
    }
    const root = doc2.documentElement;
    if (!root || root.localName !== "svg") {
      throw new ImportError(`Root element must be <svg> (got <${root?.localName || "empty"}>)`);
    }
    preflightRejectPaintServers(root);
    inlineStyleClasses(root);
    const nodes = [];
    for (const child of Array.from(root.children)) {
      const parsed = parseElement(child);
      if (parsed) nodes.push(parsed);
    }
    if (nodes.length === 0) throw new ImportError("No supported elements found");
    return nodes;
  }
  function preflightRejectPaintServers(root) {
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      for (const child of Array.from(el.children)) {
        const name = child.localName;
        if (PAINT_SERVER_ELEMENTS.has(name)) {
          throw new ImportError(
            `<${name}> is not supported \u2014 gradients, patterns, filters, clip paths, masks, <use>, and <image> can't be represented in this editor's model.`
          );
        }
        for (const key of ["fill", "stroke"]) {
          const v = child.getAttribute(key);
          if (v && /url\s*\(/i.test(v)) {
            throw new ImportError(
              `${key}="${v}" references a paint server (gradient/pattern) \u2014 not supported.`
            );
          }
        }
        const style = child.getAttribute("style");
        if (style && /url\s*\(/i.test(style)) {
          throw new ImportError(
            `style="${style.slice(0, 80)}..." references a paint server (gradient/pattern) \u2014 not supported.`
          );
        }
        stack.push(child);
      }
    }
  }
  function inlineStyleClasses(root) {
    const styleEls = root.getElementsByTagName("style");
    if (styleEls.length === 0) return;
    const classMap = /* @__PURE__ */ new Map();
    for (const styleEl of Array.from(styleEls)) {
      const css = styleEl.textContent || "";
      parseCssRules(css, classMap);
    }
    if (classMap.size === 0) return;
    const all = root.getElementsByTagName("*");
    for (const el of Array.from(all)) {
      const cls = el.getAttribute("class");
      if (!cls) continue;
      const classes = cls.trim().split(/\s+/);
      const merged = {};
      for (const c of classes) {
        const decls = classMap.get(c);
        if (!decls) continue;
        Object.assign(merged, decls);
      }
      for (const [key, value] of Object.entries(merged)) {
        if (!PRESENTATION_ATTRS2.includes(key)) continue;
        if (el.hasAttribute(key)) continue;
        const inline = el.getAttribute("style");
        if (inline && new RegExp(`(?:^|;)\\s*${escapeReForCss(key)}\\s*:`).test(inline)) continue;
        el.setAttribute(key, value);
      }
    }
  }
  function parseCssRules(css, out) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(stripped)) !== null) {
      const selector = m[1].trim();
      const body = m[2];
      if (!selector || selector.startsWith("@")) continue;
      const classNames = [];
      for (const sel of selector.split(",")) {
        const s = sel.trim();
        const cm = /^\.([A-Za-z_][\w-]*)$/.exec(s);
        if (cm) classNames.push(cm[1]);
      }
      if (classNames.length === 0) continue;
      const decls = {};
      for (const decl of body.split(";")) {
        const idx = decl.indexOf(":");
        if (idx < 0) continue;
        const key = decl.slice(0, idx).trim();
        const value = decl.slice(idx + 1).trim();
        if (!key || value === "") continue;
        decls[key] = value;
      }
      for (const name of classNames) {
        const prev = out.get(name);
        out.set(name, prev ? { ...prev, ...decls } : decls);
      }
    }
  }
  function escapeReForCss(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function parseElement(el) {
    const name = el.localName;
    if (IGNORABLE.has(name)) return null;
    if (SUPPORTED_CONTAINERS.has(name)) return parseGroup(el);
    if (SUPPORTED_SHAPES.has(name)) return parseShape(el);
    throw new ImportError(`Unsupported element <${name}> \u2014 this editor only handles rect, circle, ellipse, line, polyline, text, g.`);
  }
  function parseGroup(el) {
    const children = [];
    for (const c of Array.from(el.children)) {
      const parsed = parseElement(c);
      if (parsed) children.push(parsed);
    }
    return {
      id: newId("g"),
      type: "group",
      attrs: readPresentation(el),
      transform: parseTransform(el.getAttribute("transform")),
      children
    };
  }
  function parseShape(el) {
    const type = el.localName;
    const attrs = {};
    for (const key of SHAPE_ATTRS[type]) {
      const raw = el.getAttribute(key);
      if (raw == null) continue;
      if (key === "points") {
        attrs.points = parsePoints(raw);
      } else if (key === "d") {
        attrs.d = String(raw).trim();
      } else {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) attrs[key] = n;
      }
    }
    Object.assign(attrs, readPresentation(el));
    const node = {
      id: newId(type === "text" ? "t" : "n"),
      type,
      attrs,
      transform: parseTransform(el.getAttribute("transform"))
    };
    if (type === "text") {
      node.text = (el.textContent || "").replace(/\s+/g, " ").trim();
    }
    return node;
  }
  function readPresentation(el) {
    const out = {};
    for (const key of PRESENTATION_ATTRS2) {
      const raw = el.getAttribute(key);
      if (raw == null) continue;
      out[key] = coerceAttrValue(key, raw);
    }
    const style = el.getAttribute("style");
    if (style) {
      for (const decl of style.split(";")) {
        const idx = decl.indexOf(":");
        if (idx < 0) continue;
        const key = decl.slice(0, idx).trim();
        const val = decl.slice(idx + 1).trim();
        if (!key || val === "") continue;
        if (!PRESENTATION_ATTRS2.includes(key)) continue;
        if (out[key] !== void 0) continue;
        out[key] = coerceAttrValue(key, val);
      }
    }
    return out;
  }
  function coerceAttrValue(key, raw) {
    if (key === "font-size" || key === "stroke-width" || key === "opacity" || key === "fill-opacity" || key === "stroke-opacity") {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) return n;
    }
    return raw;
  }
  function parsePoints(raw) {
    const tokens = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const pts = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) pts.push([tokens[i], tokens[i + 1]]);
    return pts;
  }
  function parseTransform(raw) {
    const t = emptyTransform();
    if (!raw) return t;
    let M = [1, 0, 0, 1, 0, 0];
    const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const fn = m[1].toLowerCase();
      const args = m[2].trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (fn === "translate") {
        const tx = args[0] || 0;
        const ty = args.length > 1 ? args[1] : 0;
        M = mul(M, [1, 0, 0, 1, tx, ty]);
      } else if (fn === "rotate") {
        const deg = args[0] || 0;
        const cx = args[1] || 0;
        const cy = args[2] || 0;
        const rad = deg * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        let R = [1, 0, 0, 1, cx, cy];
        R = mul(R, [cos, sin, -sin, cos, 0, 0]);
        R = mul(R, [1, 0, 0, 1, -cx, -cy]);
        M = mul(M, R);
      } else if (fn === "matrix") {
        if (args.length !== 6) {
          throw new ImportError(`matrix() expects 6 numbers, got ${args.length}.`);
        }
        M = mul(M, args);
      } else if (fn === "scale" || fn === "skewx" || fn === "skewy") {
        throw new ImportError(
          `Transform '${fn}()' can't be represented \u2014 this editor only supports translation and rotation.`
        );
      } else {
        throw new ImportError(`Unsupported transform '${fn}()'.`);
      }
    }
    return decomposeRigid(M);
  }
  function mul(A, B) {
    const [a1, b1, c1, d1, e1, f1] = A;
    const [a2, b2, c2, d2, e2, f2] = B;
    return [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1
    ];
  }
  function decomposeRigid(M) {
    const [a, b, c, d, e, f] = M;
    const EPS = 1e-4;
    if (Math.abs(a - d) > EPS || Math.abs(b + c) > EPS) {
      throw new ImportError(
        "Transform contains scale or shear \u2014 only translation and rotation are supported."
      );
    }
    const det = a * d - b * c;
    if (Math.abs(det - 1) > EPS) {
      const scale = Math.sqrt(Math.abs(det));
      throw new ImportError(
        `Transform includes scaling (factor ~${scale.toFixed(3)}) \u2014 only translation and rotation are supported.`
      );
    }
    const t = emptyTransform();
    t.tx = e;
    t.ty = f;
    const rad = Math.atan2(b, a);
    t.rot = rad * 180 / Math.PI;
    t.cx = 0;
    t.cy = 0;
    if (Math.abs(t.rot) < 1e-6) t.rot = 0;
    if (Math.abs(t.tx) < 1e-9) t.tx = 0;
    if (Math.abs(t.ty) < 1e-9) t.ty = 0;
    return t;
  }
  var modal;
  var textarea;
  var errorBox;
  var confirmBtn;
  var cancelBtn;
  var openBtn;
  function mountImport(root) {
    modal = root.querySelector("#import-modal");
    textarea = root.querySelector("#import-text");
    errorBox = root.querySelector("#import-error");
    confirmBtn = root.querySelector("#import-confirm");
    cancelBtn = root.querySelector("#import-cancel");
    openBtn = root.querySelector("#import-btn");
    openBtn.addEventListener("click", openModal);
    cancelBtn.addEventListener("click", closeModal);
    confirmBtn.addEventListener("click", runImport);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (modal.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runImport();
      }
    });
  }
  function openModal() {
    errorBox.hidden = true;
    errorBox.textContent = "";
    modal.hidden = false;
    setTimeout(() => textarea.focus(), 0);
  }
  function closeModal() {
    modal.hidden = true;
  }
  function runImport() {
    errorBox.hidden = true;
    errorBox.textContent = "";
    let nodes;
    try {
      nodes = parseSvgToNodes(textarea.value);
    } catch (err) {
      errorBox.textContent = err instanceof ImportError ? err.message : String(err);
      errorBox.hidden = false;
      return;
    }
    const mode = modal.querySelector('input[name="import-mode"]:checked').value;
    record(() => {
      mutate((root) => {
        if (mode === "replace") root.children = [];
        root.children.push(...nodes);
      });
    });
    closeModal();
  }

  // js/layers.js
  var collapsed = /* @__PURE__ */ new Set();
  var listEl;
  function mount6(root) {
    listEl = root.querySelector("#layers-list");
    if (!listEl) return;
    listEl.addEventListener("click", onClick);
    listEl.addEventListener("contextmenu", onContext);
  }
  function refresh() {
    if (!listEl) return;
    const doc2 = getDoc();
    const sel = getSelection();
    const alive = /* @__PURE__ */ new Set();
    walkDoc(doc2, (n) => alive.add(n.id));
    for (const id of collapsed) if (!alive.has(id)) collapsed.delete(id);
    listEl.innerHTML = "";
    if (!doc2.children || doc2.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "layers-empty";
      empty.textContent = "No layers";
      listEl.appendChild(empty);
      return;
    }
    for (let i = doc2.children.length - 1; i >= 0; i--) {
      renderNode(doc2.children[i], 0, sel, listEl);
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
    caret.innerHTML = isGroup ? `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 4.5 L6 8 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` : "";
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
      case "rect":
        return s(`<rect x="2" y="3" width="10" height="8" ${stroke}/>`);
      case "circle":
        return s(`<circle cx="7" cy="7" r="5" ${stroke}/>`);
      case "ellipse":
        return s(`<ellipse cx="7" cy="7" rx="5.5" ry="3.5" ${stroke}/>`);
      case "line":
        return s(`<line x1="2" y1="11" x2="12" y2="3" ${stroke}/>`);
      case "connector":
        return s(`<line x1="2" y1="11" x2="10" y2="3" ${stroke}/><path d="M8,1.5 12,3 10.5,6.5z" fill="currentColor"/>`);
      case "polyline":
        return s(`<polyline points="2,10 5,5 9,8 12,3" ${stroke}/>`);
      case "path":
        return s(`<path d="M2,10 C4,4 9,4 12,10" ${stroke}/>`);
      case "text":
        return s(`<text x="7" y="11" text-anchor="middle" font-family="serif" font-size="12" font-weight="700" fill="currentColor">T</text>`);
      case "group":
        return s(`<rect x="2" y="4" width="8" height="7" ${stroke}/><rect x="4" y="2" width="8" height="7" ${stroke}/>`);
      default:
        return s(`<circle cx="7" cy="7" r="1.5" fill="currentColor"/>`);
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
      return { text: `Group \xB7 ${n} item${n === 1 ? "" : "s"}`, placeholder: true };
    }
    return { text: capitalize(node.type), placeholder: true };
  }
  function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
  }
  function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }
  function walkDoc(node, cb) {
    cb(node);
    if (node.children) for (const c of node.children) walkDoc(c, cb);
  }
  function onClick(e) {
    const caret = e.target.closest('[data-role="caret"]');
    if (caret) {
      const row2 = caret.closest(".layer-row");
      if (row2) toggleCollapse(row2.dataset.id);
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

  // js/viewport.js
  var viewport_exports = {};
  __export(viewport_exports, {
    fit: () => fit,
    getZoomPercent: () => getZoomPercent,
    mount: () => mount7,
    resetZoom: () => resetZoom,
    setZoomPercent: () => setZoomPercent,
    zoomInCentered: () => zoomInCentered,
    zoomOutCentered: () => zoomOutCentered
  });
  var WORLD = { x: 0, y: 0, width: 1e3, height: 700 };
  var MIN_SCALE = 0.1;
  var MAX_SCALE = 16;
  var ZOOM_STEP = 1.2;
  var svg;
  var vb = { ...WORLD };
  var onChange = null;
  var panning = null;
  var spaceDown = false;
  function mount7(svgEl, changeCb) {
    svg = svgEl;
    onChange = changeCb || null;
    applyViewBox();
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("pointermove", onPointerMove2);
    window.addEventListener("pointerup", onPointerUpCapture, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
  }
  function applyViewBox() {
    svg.setAttribute("viewBox", `${r2(vb.x)} ${r2(vb.y)} ${r2(vb.width)} ${r2(vb.height)}`);
    if (onChange) onChange(getScale());
  }
  function getScale() {
    const rect = svg.getBoundingClientRect();
    return rect.width > 0 && vb.width > 0 ? rect.width / vb.width : 1;
  }
  function getZoomPercent() {
    return Math.round(getScale() * 100);
  }
  function zoomAtWorld(wx, wy, factor) {
    const curScale = getScale();
    let targetScale = clamp(curScale * factor, MIN_SCALE, MAX_SCALE);
    if (targetScale === curScale) return;
    const rect = svg.getBoundingClientRect();
    const newW = rect.width / targetScale;
    const newH = rect.height / targetScale;
    const fx = (wx - vb.x) / vb.width;
    const fy = (wy - vb.y) / vb.height;
    vb = { x: wx - fx * newW, y: wy - fy * newH, width: newW, height: newH };
    applyViewBox();
  }
  function clientToWorld(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    return { x: vb.x + fx * vb.width, y: vb.y + fy * vb.height };
  }
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const w = clientToWorld(e.clientX, e.clientY);
      const factor = Math.pow(ZOOM_STEP, -e.deltaY / 100);
      zoomAtWorld(w.x, w.y, factor);
    } else {
      const scale = getScale();
      let dx = e.deltaX, dy = e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      vb = { ...vb, x: vb.x + dx / scale, y: vb.y + dy / scale };
      applyViewBox();
    }
  }
  function onPointerDownCapture(e) {
    const isMiddle = e.button === 1;
    const isSpaceLeft = e.button === 0 && spaceDown;
    if (!isMiddle && !isSpaceLeft) return;
    e.preventDefault();
    e.stopPropagation();
    panning = { startClientX: e.clientX, startClientY: e.clientY, startVb: { ...vb } };
    svg.classList.add("panning");
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
    }
  }
  function onPointerMove2(e) {
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
  function onKeyDown(e) {
    if (e.code === "Space" && !isEditable(e.target)) {
      spaceDown = true;
      svg.classList.add("space-pan");
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "0") {
      e.preventDefault();
      fit();
    } else if (e.key === ")" || e.shiftKey && e.key === "0") {
      e.preventDefault();
      resetZoom();
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
  function centerWorld() {
    return { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  }
  function zoomInCentered() {
    const c = centerWorld();
    zoomAtWorld(c.x, c.y, ZOOM_STEP);
  }
  function zoomOutCentered() {
    const c = centerWorld();
    zoomAtWorld(c.x, c.y, 1 / ZOOM_STEP);
  }
  function resetZoom() {
    const rect = svg.getBoundingClientRect();
    const c = centerWorld();
    const newW = rect.width, newH = rect.height;
    vb = { x: c.x - newW / 2, y: c.y - newH / 2, width: newW, height: newH };
    applyViewBox();
  }
  function fit() {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      vb = { ...WORLD };
      return applyViewBox();
    }
    const margin = 0.06;
    const worldAR = WORLD.width / WORLD.height;
    const viewAR = rect.width / rect.height;
    let w, h;
    if (viewAR > worldAR) {
      h = WORLD.height * (1 + margin * 2);
      w = h * viewAR;
    } else {
      w = WORLD.width * (1 + margin * 2);
      h = w / viewAR;
    }
    vb = { x: WORLD.x + WORLD.width / 2 - w / 2, y: WORLD.y + WORLD.height / 2 - h / 2, width: w, height: h };
    applyViewBox();
  }
  function setZoomPercent(pct) {
    const target = clamp(pct / 100, MIN_SCALE, MAX_SCALE);
    const c = centerWorld();
    zoomAtWorld(c.x, c.y, target / getScale());
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function r2(n) {
    return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e3) / 1e3;
  }

  // js/main.js
  var svg2 = document.getElementById("canvas");
  mount(svg2);
  mount2(svg2);
  mount3(svg2);
  mount5(document);
  mountViewport(viewport_exports, svg2);
  mountGrid(grid_exports);
  mountPanel(
    document.getElementById("source"),
    document.getElementById("copy-btn"),
    document.getElementById("download-btn"),
    document.getElementById("tight-mode")
  );
  mountImport(document);
  mount6(document);
  mount4(document);
  restoreAutosave();
  subscribe(() => {
    renderAll();
    refreshPropertyPanel();
    refreshSourcePanel();
    refresh();
    scheduleAutosave();
  });
  renderAll();
  refreshPropertyPanel();
  refreshSourcePanel();
  refresh();
})();
