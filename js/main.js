// Bootstrap.

import { subscribe } from "./state.js";
import * as render from "./render.js";
import * as tools from "./tools.js";
import * as ui from "./ui.js";
import * as exp from "./export.js";
import * as importer from "./import.js";
import * as layers from "./layers.js";

const svg = document.getElementById("canvas");
render.mount(svg);
tools.mount(svg);
ui.mount(document);
exp.mountPanel(
  document.getElementById("source"),
  document.getElementById("copy-btn"),
  document.getElementById("download-btn"),
  document.getElementById("tight-mode"),
);
importer.mountImport(document);
layers.mount(document);

// Re-render + refresh downstream views on every state change.
subscribe(() => {
  render.renderAll();
  ui.refreshPropertyPanel();
  exp.refreshSourcePanel();
  layers.refresh();
});

// Initial render.
render.renderAll();
ui.refreshPropertyPanel();
exp.refreshSourcePanel();
layers.refresh();
