# Euclid

A tiny, zero-dependency SVG editor that runs in the browser. Draw primitives, arrange them, edit properties, and copy or download the clean SVG source — no build step, no framework, no server-side anything.

**Live demo: [euclid.yesilkaya.dev](https://euclid.yesilkaya.dev)**

## Features

- **Shapes** — rectangle, ellipse (hold `Shift` for a circle), circle (hold `Shift` for a perfect circle), line, polyline, and text
- **Pen / bézier paths** — click to drop corner anchors, click-drag to pull smooth bézier handles, click the first anchor to close; finish with `Enter`, double-click, or `Esc`. Paths are a structured anchor model, so the SVG `d` is always derived, never hand-edited
- **Path point editing** — a lone selected pen path gets Illustrator-style node chrome: drag anchors and control points to reshape (the opposite handle mirrors for smoothness; `Alt` breaks the pair), double-click an anchor to delete it or a control point to retract it — all under any rotation
- **Closed-path extras** — flip a closed path between **Edit points** and **Convert to shape** (get a normal bbox with resize + rotate, non-destructively), and dial in a **corner radius** that fillets its hard corners live
- **Connectors** — draw an edge between two shapes; it attaches to each shape's bounding box and re-routes automatically as the shapes move, resize, or rotate. Choose **straight** or **orthogonal (elbow)** routing, toggle arrowheads at either end, and add a mid-edge label. Orthogonal connectors are editable — drag a segment to bend it (adds a waypoint), drag a waypoint to move it, double-click to delete. Arrowheads stay a fixed size at any zoom, and deleting an attached shape cleans up its connectors
- **Direct manipulation** — move, resize (8 handles), rotate; resizing a group or multi-selection scales the whole set about the union bbox's fixed anchor
- **Selection** — click, shift-click, and drag-marquee, with group descent on double-click
- **Smart alignment guides** — Figma/PowerPoint-style edge and center snapping to nearby objects and the canvas
- **Grid & snap-to-grid** — toggleable document-space grid with independent snap-to-grid; both persist across sessions
- **Zoom & pan** — Ctrl/⌘+wheel to zoom at the cursor, two-finger/middle-mouse/Space-drag to pan, plus zoom controls with Fit and a click-to-reset readout
- **Alignment & distribution** — 6 align ops plus horizontal/vertical distribute
- **Grouping** — `Ctrl+G` / `Ctrl+Shift+G`
- **Layers panel** — drag rows to reorder within a parent, plus right-click ordering (bring to front / send to back / forward / backward) and collapse/expand groups
- **Labels on shapes & connectors** — double-click any shape or connector to type a centered label; labels travel with the object on export
- **Properties panel** — fill, stroke, stroke width, opacity (slider + number), rotation, font family/size/color, connector routing/arrows, and closed-path shape/corner-radius controls; collapsible Layers and SVG-source sections
- **Save / open / autosave** — lossless native `.euclid.json` format (`Ctrl+S` / `Ctrl+O`) that round-trips everything, with debounced autosave to `localStorage` and silent restore on reload
- **Live SVG source** — always-current source pane with Copy / Download / tight-viewBox toggle
- **Import** — paste SVG markup; supports Adobe Illustrator exports (class-based `<style>` inlining, `matrix()` transforms that decompose to translate + rotation)
- **Undo/redo** — one entry per gesture, up to 200 steps

## Getting started

Just open `index.html` in a browser — double-click it or drag it onto a browser
window. No server required. The page loads a prebuilt bundle (`js/euclid.bundle.js`),
which works over the `file://` protocol.

Requires a modern browser (`structuredClone`, `crypto.randomUUID`).

### Editing the source

The source of truth is the modular `js/*.js` files. `index.html` loads the bundled
output, so after changing any module, rebuild it:

```bash
npm install      # once, installs esbuild
npm run build    # regenerate js/euclid.bundle.js
```

Use `npm run watch` to rebuild automatically on save. (Because ES modules can't be
fetched over `file://`, the modular sources themselves need a static server — e.g.
`python -m http.server` — if you want to load them un-bundled during development.)

## Keyboard shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `R` `E` `C` `L` `X` `P` `N` `T` | Rect / Ellipse / Circle / Line / Connector / Polyline / Pen / Text tool |
| `Esc` | Cancel current tool → Select; also cancels an in-progress polyline or finalizes a pen path |
| `Enter` | Finish the in-progress pen path |
| `F2` | Rename label on selected shape |
| `Delete` / `Backspace` | Delete selection |
| `Ctrl+S` / `Ctrl+O` | Save / open a `.euclid.json` document |
| `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) | Undo / Redo |
| `Ctrl+A` | Select all top-level nodes |
| `Ctrl+D` | Duplicate selection |
| `Ctrl+C` / `Ctrl+V` | Copy / Paste |
| `Ctrl+G` / `Ctrl+Shift+G` | Group / Ungroup |
| `Ctrl+'` / `Ctrl+Shift+'` | Toggle grid / snap-to-grid |
| `Ctrl +` / `Ctrl -` | Zoom in / out |
| `Ctrl+0` / `Ctrl+Shift+0` | Fit to view / reset to 100% |
| Arrow keys | Nudge selection 1px (hold `Shift` for 10px) |

While drawing: hold `Shift` to constrain rect/ellipse to a square/circle, or a line to 45° increments. With the pen, click for corners and click-drag for smooth bézier handles; click the first anchor to close the path. While moving: hold `Alt` to bypass snapping (both smart guides and grid). Ctrl+drag a selection to duplicate it as you move. While editing path points, hold `Alt` to break a smooth anchor's handle pair.

While rotating: a live angle readout follows the handle; hold `Shift` to snap to 22.5° increments, or `Shift`+`Ctrl` for 1° fine steps.

Zoom with Ctrl/⌘+wheel (at the cursor); pan with a two-finger scroll, middle-mouse drag, or `Space`+drag.

## Import support

The importer is deliberately strict — anything it can't represent throws a specific error instead of silently dropping data.

**Supported:** `rect`, `circle`, `ellipse`, `line`, `polyline`, `text`, `path`, `g`, `title`/`desc`/`metadata` (ignored), `<style>` and `<defs>` containing only styles, `transform` composed of `translate()`, `rotate()`, and rigid `matrix()`.

**Rejected with a clear message:** gradients, patterns, filters, clip paths, masks, `<use>`, `<image>`, `<symbol>`, `<marker>`, `url(#...)` paint references, and any transform that includes scale or shear.

Illustrator's default "SVG 1.1" export (with `.st0 { fill: #... }` class styling) works out of the box.

## Project layout

```
index.html          entry point; wires up the toolbar, canvas, panels
styles.css          all styling (dark UI, light canvas)
js/
  euclid.bundle.js  generated single-file bundle loaded by index.html (npm run build)
  main.js           bootstrap — mount modules and wire the pub/sub loop
  state.js          document tree + selection + observer subscribe/notify
  history.js        snapshot-based undo/redo (200-entry ring)
  render.js         SVG DOM rendering + selection chrome + coord conversion
  tools.js          pointer/keyboard state machine for every tool + gestures
  ui.js             toolbar, property panel, keyboard shortcuts, clipboard
  export.js         hand-written SVG serializer + live source panel + copy/download
  import.js         strict SVG parser (with Illustrator class inlining)
  persist.js        native .euclid.json save/open + debounced localStorage autosave
  paths.js          structured pen-path anchor model ↔ SVG path `d` (with rounding)
  layers.js         Illustrator-style layers panel (drag + context-menu reorder)
  align.js          alignment + distribution ops
  guides.js         smart snapping guides drawn during drag
  grid.js           document-space grid + snap-to-grid (pure view concern)
  viewport.js       zoom/pan of the canvas viewBox (never touches the model)
  connectors.js     pure connector geometry — straight + orthogonal routing
```

Architecture note: `state.js` holds the authoritative doc tree; every other module reads from it and re-renders on `subscribe()`. All mutations go through `mutate(fn)`, which deep-clones the root, mutates a draft, then swaps it and notifies subscribers.

## License

MIT — see [LICENSE](LICENSE).
