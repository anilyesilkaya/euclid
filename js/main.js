// Bootstrap.

import { subscribe } from "./state.js";
import * as render from "./render.js";
import * as tools from "./tools.js";
import * as ui from "./ui.js";
import * as exp from "./export.js";
import * as importer from "./import.js";
import * as layers from "./layers.js";
import * as viewport from "./viewport.js";
import * as grid from "./grid.js";
import * as persist from "./persist.js";

const svg = document.getElementById("canvas");
render.mount(svg);
grid.mount(svg);
tools.mount(svg);
ui.mount(document);
ui.mountViewport(viewport, svg);
ui.mountGrid(grid);
exp.mountPanel(
  document.getElementById("source"),
  document.getElementById("copy-btn"),
  document.getElementById("download-btn"),
  document.getElementById("tight-mode"),
);
importer.mountImport(document);
layers.mount(document);
persist.mount(document);

// Restore the last autosaved document before the first render. Safe no-op if
// there's nothing saved or localStorage is unavailable (file://).
persist.restoreAutosave();

// Re-render + refresh downstream views on every state change.
subscribe(() => {
  render.renderAll();
  ui.refreshPropertyPanel();
  exp.refreshSourcePanel();
  layers.refresh();
  persist.scheduleAutosave();
});

// Initial render.
render.renderAll();
ui.refreshPropertyPanel();
exp.refreshSourcePanel();
layers.refresh();
