// Raster/SVG image placement: from a URL, a file picked from disk, or a file
// dropped onto the canvas. Images become `image` nodes whose geometry is
// a plain x/y/width/height box (handled like a rect by bbox/resize/scale code).
//
// Local files are always embedded as data: URLs so Save/Export stay
// self-contained. Remote URLs are embedded too when the server allows a CORS
// fetch; otherwise the node links to the URL (the image still renders, but the
// exported SVG depends on that URL staying reachable).

import { mutate, newId, emptyTransform, setSelection } from "./state.js";
import * as history from "./history.js";

const MAX_FIT = 0.6;  // fit a new image within 60% of the visible canvas
const LARGE_BYTES = 4 * 1024 * 1024;

let canvasSvg;
let modal, urlInput, embedChk, browseBtn, fileInput, preview, previewImg, previewMeta,
  errorBox, confirmBtn, cancelBtn, openBtn;
// The image currently staged in the modal: { href, width, height, linked }.
let pending = null;
let loadToken = 0;

export function mountImage(root, svg) {
  canvasSvg = svg;
  modal = root.querySelector("#image-modal");
  urlInput = root.querySelector("#image-url");
  embedChk = root.querySelector("#image-embed");
  browseBtn = root.querySelector("#image-browse");
  fileInput = root.querySelector("#image-file");
  preview = root.querySelector("#image-preview");
  previewImg = root.querySelector("#image-preview-img");
  previewMeta = root.querySelector("#image-preview-meta");
  errorBox = root.querySelector("#image-error");
  confirmBtn = root.querySelector("#image-confirm");
  cancelBtn = root.querySelector("#image-cancel");
  openBtn = root.querySelector("#image-btn");

  openBtn.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", confirm);
  browseBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) stageFile(file);
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter loads the URL; a second Enter on the already-loaded URL places it.
    if (pending && pending.source === urlInput.value.trim()) confirm(); else stageUrl();
  });
  urlInput.addEventListener("change", stageUrl);
  embedChk.addEventListener("change", () => {
    if (pending && pending.source) { pending = null; stageUrl(); }
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  });

  // Drop an image file anywhere on the canvas (or into the open modal) to place it.
  for (const target of [svg, modal]) {
    target.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    target.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      // Always claim a file drop — otherwise the browser navigates to the file.
      e.preventDefault();
      const file = firstImageFile(e.dataTransfer);
      if (target === modal) {
        if (file) stageFile(file); else showError("Only image files can be placed.");
        return;
      }
      if (!file) { alert("Only image files can be placed."); return; }
      readFile(file).then(placeImage, (err) => alert(err.message));
    });
  }
}

function openModal() {
  reset();
  modal.hidden = false;
  setTimeout(() => urlInput.focus(), 0);
}

function closeModal() {
  modal.hidden = true;
  loadToken++;
}

function reset() {
  pending = null;
  loadToken++;
  urlInput.value = "";
  showError("");
  preview.hidden = true;
  previewImg.removeAttribute("src");
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

function setPending(img) {
  pending = img;
  previewImg.src = img.href;
  const source = !img.linked ? `embedded, ${formatBytes(dataUrlBytes(img.href))}`
    : embedChk.checked ? "linked by URL (the server doesn't allow embedding)"
    : "linked by URL";
  previewMeta.textContent = `${img.width} × ${img.height} px · ${source}`;
  preview.hidden = false;
  showError("");
}

async function stageUrl() {
  const raw = urlInput.value.trim();
  if (!raw) return;
  if (pending && pending.source === raw) return;
  pending = null;
  const token = ++loadToken;
  showError("");
  try {
    const img = await loadFromUrl(raw, embedChk.checked);
    if (token !== loadToken) return;
    img.source = raw;
    setPending(img);
  } catch (err) {
    if (token !== loadToken) return;
    pending = null;
    preview.hidden = true;
    showError(err.message);
  }
}

async function stageFile(file) {
  const token = ++loadToken;
  showError("");
  try {
    const img = await readFile(file);
    if (token !== loadToken) return;
    urlInput.value = "";
    setPending(img);
  } catch (err) {
    if (token !== loadToken) return;
    showError(err.message);
  }
}

// Place the staged image. A URL typed but not yet loaded is loaded first, so
// clicking Place straight after typing works in one click.
async function confirm() {
  if (!pending) {
    if (!urlInput.value.trim()) { showError("Enter an image URL or choose a file."); return; }
    await stageUrl();
  }
  if (!pending || modal.hidden) return;
  placeImage(pending);
  closeModal();
}

// --- Loading ---

// Resolve a URL into { href, width, height, linked }. Tries to fetch and inline
// the bytes when `embed` is set; falls back to linking if CORS blocks the fetch.
export async function loadFromUrl(raw, embed = true) {
  let url;
  try {
    url = new URL(raw, document.baseURI);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!["http:", "https:", "data:", "blob:", "file:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL scheme "${url.protocol}" — use http(s) or data: URLs.`);
  }
  if (url.protocol === "data:") {
    if (!/^data:image\//i.test(url.href)) throw new Error("data: URL is not an image.");
    return { ...(await measure(url.href)), href: url.href, linked: false };
  }
  // Measure first so a bad URL fails with a clear message whether or not we embed.
  const size = await measure(url.href).catch(() => {
    throw new Error("Couldn't load an image from that URL.");
  });
  if (embed && url.protocol !== "file:") {
    try {
      const res = await fetch(url.href, { mode: "cors" });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith("image/")) {
          return { ...size, href: await blobToDataUrl(blob), linked: false };
        }
      }
    } catch { /* CORS / network refusal — fall back to linking */ }
  }
  return { ...size, href: url.href, linked: true };
}

// Read a File/Blob into { href (data URL), width, height, linked: false }.
export async function readFile(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error(`"${file.name || "File"}" is not an image.`);
  }
  const href = await blobToDataUrl(file);
  const size = await measure(href).catch(() => {
    throw new Error(`Couldn't decode "${file.name || "image"}".`);
  });
  return { ...size, href, linked: false };
}

function measure(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // SVGs without intrinsic size report 0 — give them a sensible default box.
      const width = img.naturalWidth || 300;
      const height = img.naturalHeight || 150;
      resolve({ width, height });
    };
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(blob);
  });
}

// --- Placement ---

// Insert an image node centered in the visible canvas, scaled down (never up)
// to fit, and select it.
export function placeImage({ href, width, height, linked }) {
  const view = visibleBox();
  const fit = Math.min(1, (view.width * MAX_FIT) / width, (view.height * MAX_FIT) / height);
  const w = width * fit, h = height * fit;
  const node = {
    id: newId("img"),
    type: "image",
    attrs: {
      x: round(view.x + (view.width - w) / 2),
      y: round(view.y + (view.height - h) / 2),
      width: round(w),
      height: round(h),
      href,
      // The box always equals the drawn image; aspect is kept by the resize gesture.
      preserveAspectRatio: "none",
    },
    transform: emptyTransform(),
  };
  history.record(() => {
    mutate((root) => { root.children.push(node); });
  });
  setSelection([node.id]);
  if (!linked && dataUrlBytes(href) > LARGE_BYTES) {
    console.warn("Euclid: large embedded image — it may exceed the autosave limit; use Save to keep it.");
  }
  return node;
}

function visibleBox() {
  const vb = canvasSvg?.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
  return { x: 0, y: 0, width: 1000, height: 700 };
}

// --- Helpers ---

function hasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}

function firstImageFile(dt) {
  if (!dt) return null;
  for (const f of Array.from(dt.files || [])) if (f.type.startsWith("image/")) return f;
  for (const item of Array.from(dt.items || [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

function dataUrlBytes(href) {
  if (!href.startsWith("data:")) return 0;
  const comma = href.indexOf(",");
  return Math.floor((href.length - comma - 1) * 3 / 4);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function round(n) { return Math.round(n * 100) / 100; }
