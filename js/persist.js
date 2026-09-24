// Native document persistence: lossless save/open to a .euclid.json file, plus
// debounced autosave to localStorage with silent restore on reload.
//
// The doc tree in state.js is already plain JSON (structuredClone is used
// throughout), so the native format is just { version, doc }. Unlike SVG export
// (export.js), this round-trips the full model: connector {from,to} refs, the
// decomposed {tx,ty,rot,cx,cy} transforms, label/labelStyle, and group nesting.
//
// Patterns reused here:
//   - grid.js  — localStorage wrapped in try/catch so it degrades silently over
//                file:// (where localStorage may be unavailable).
//   - export.js — Blob -> URL.createObjectURL -> temp <a download> -> revoke.
//   - FileReader + <input type=file> for Open (the one genuinely new browser API).

import { getDoc, replaceRoot, clearSelection, emptyTransform, walk } from "./state.js";
import * as history from "./history.js";

const FORMAT_VERSION = 1;
const AUTOSAVE_KEY = "euclid.doc.autosave";
// The subscribe loop fires per drag-frame; a tight debounce would JSON.stringify
// the whole doc and hit localStorage many times per gesture. 400ms coalesces a
// gesture into a single trailing write.
const AUTOSAVE_DEBOUNCE = 400;

export class LoadError extends Error {
  constructor(message) { super(message); this.name = "LoadError"; }
}

let fileInput = null;
let autosaveTimer = null;

// --- Serialize ---

// pretty=true for human-readable file output; compact for autosave.
export function serializeDocument(pretty = false) {
  const payload = { version: FORMAT_VERSION, doc: getDoc() };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

// --- Parse + validate ---

// Parse a document string into a root node, or throw LoadError. Never returns
// a partially-valid tree — callers can pass the result straight to loadDocument.
export function parseDocument(text) {
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
      `This file was made by a newer version of Euclid (format v${version}). ` +
      `This build understands up to v${FORMAT_VERSION}.`,
    );
  }
  const root = payload.doc;
  if (!root || typeof root !== "object" ||
      root.id !== "root" || root.type !== "group" || !Array.isArray(root.children)) {
    throw new LoadError("Not a valid Euclid file (missing document root).");
  }
  normalize(root);
  return root;
}

// Defensive backfill so an older or hand-edited file can't crash render.js:
// every node needs id/type/attrs/transform.
function normalize(root) {
  walk(root, (n) => {
    if (typeof n !== "object" || n === null) return;
    if (n.attrs == null || typeof n.attrs !== "object") n.attrs = {};
    if (n.transform == null && n.type !== "connector") n.transform = emptyTransform();
    if (n.children != null && !Array.isArray(n.children)) n.children = [];
  });
}

// --- Load (the single choke point for applying a parsed doc) ---

export function loadDocument(root) {
  replaceRoot(root);       // swaps root, prunes dead selection, notifies subscribers
  clearSelection();        // a freshly-loaded document starts with nothing selected
  history.resetHistory();  // drop undo/redo so we can't undo into the prior document
}

// --- Save to file ---

export function saveToFile() {
  const text = serializeDocument(true);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "drawing.euclid.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Open from file ---

export function triggerOpen() {
  if (fileInput) fileInput.click();
}

export function openFromFile(file) {
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

// --- Autosave ---

function writeAutosave() {
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, serializeDocument(false));
  } catch {
    // localStorage full (QuotaExceededError) or unavailable (some file://
    // configs). Degrade silently — the user still has explicit Save-to-file.
  }
}

export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE);
}

// Restore the autosaved document on startup. Must run before the initial render
// in main.js. Any failure leaves the default empty doc — startup is never blocked.
export function restoreAutosave() {
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
    // Corrupt autosave — ignore and start clean rather than fail to load.
  }
}

// --- Wiring ---

export function mount(root) {
  const saveBtn = root.querySelector("#save-btn");
  const openBtn = root.querySelector("#open-btn");
  fileInput = root.querySelector("#open-file");

  if (saveBtn) saveBtn.addEventListener("click", saveToFile);
  if (openBtn) openBtn.addEventListener("click", triggerOpen);
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      openFromFile(file);
      // Reset so choosing the same file again re-fires 'change'.
      fileInput.value = "";
    });
  }
}
