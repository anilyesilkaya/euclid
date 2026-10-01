# Euclid

**A lightweight vector and diagram editor for humans and AI agents.**

Create technical diagrams and illustrations, edit SVG visually, and export clean, portable SVG — with no account, backend, framework, or runtime dependencies.

**Live demo:** [euclid.yesilkaya.dev](https://euclid.yesilkaya.dev)

Euclid is designed for the space between a diagramming tool and a general-purpose vector editor: structured diagrams, technical illustrations, block diagrams, figures, and other SVG graphics that should remain easy to understand, edit, version, and reuse.

The long-term direction is to make the same structured graphics model available to both humans through the browser UI and LLMs through an MCP server.

---

## Why Euclid?

There are already excellent vector editors and diagramming tools. Euclid is not intended to reproduce all of Illustrator, Figma, Inkscape, or diagrams.net.

Instead, it focuses on a smaller problem:

> **How quickly can you create a clean, editable technical SVG without opening a heavyweight design application?**

Euclid prioritizes:

- **Clean SVG output** — your drawing remains portable and inspectable.
- **Structured graphics** — shapes, paths, connectors, groups, gradients, and transforms are represented explicitly instead of being treated as opaque pixels.
- **Direct manipulation** — familiar selection, resize, rotate, anchor editing, alignment, grouping, and snapping.
- **Technical diagrams** — first-class connectors, labels, orthogonal routing, alignment, and distribution.
- **Local-first operation** — no account, cloud service, or server is required.
- **A small architecture** — the browser application has no runtime framework dependencies.
- **AI-ready semantics** — the document model is designed so an LLM can eventually manipulate the same objects as a human editor rather than generating raw SVG strings.

---

## Features

### Drawing

- Rectangle
- Rounded rectangle
- Ellipse
- Circle
- Line
- Polyline
- Text
- Pen / Bézier paths
- Straight and orthogonal connectors

Hold `Shift` while drawing to constrain rectangles and ellipses to squares and circles, or lines to 45° increments.

### Vector editing

Euclid provides two Illustrator-style selection modes:

- **Selection (`V`)** — move, resize, and rotate whole objects.
- **Direct Selection (`A`)** — edit path anchors and Bézier handles.

Pen paths use a structured anchor model. SVG path data is derived from that model rather than being manually edited as a raw `d` string.

You can:

- Drag anchors and control points
- Break smooth handle pairs with `Alt`
- Delete anchors and handles
- Convert closed paths between point-editing and shape-style manipulation
- Apply live corner rounding to closed paths

### Diagramming

Connectors are first-class objects rather than static lines.

They can:

- Attach to shapes
- Re-route when shapes move or resize
- Use straight or orthogonal routing
- Carry arrowheads
- Carry labels
- Use editable orthogonal waypoints

This makes Euclid suitable for architecture diagrams, signal-processing chains, flow diagrams, block diagrams, and technical documentation.

### Layout and manipulation

- Move, resize, and rotate
- Multi-selection
- Marquee selection
- Group / ungroup
- Alignment and distribution
- Smart alignment guides
- Grid and snap-to-grid
- Layer reordering
- Zoom and pan
- Transform Again (`Ctrl+D`)
- Duplicate while moving or rotating

### Styling

- Fill and stroke
- Linear gradients
- Opacity
- Stroke width
- Dash styles
- Line caps
- Line joins
- Rectangle corner radius
- Font family
- Font size
- Font color
- Bold / italic
- Text alignment

### Persistence

Euclid has two complementary formats:

#### `.euclid.json`

The native format preserves the complete editable document model.

Use it when you want a lossless round trip back into Euclid.

#### SVG

SVG is the portable output format.

Euclid provides:

- Always-current SVG source
- Copy SVG
- Download SVG
- Tight `viewBox` export
- SVG import

---

## Human + AI graphics

Euclid is being designed so that humans and LLM agents can eventually manipulate the same graphics model.

The intended architecture is:

```text
                    Human
                      │
                      ▼
               ┌─────────────┐
               │  Euclid UI  │
               └──────┬──────┘
                      │
                      ▼
              ┌───────────────┐
              │ Euclid model  │
              │               │
              │ shapes        │
              │ paths         │
              │ connectors    │
              │ groups        │
              │ gradients     │
              │ transforms    │
              └───────┬───────┘
                      │
            ┌─────────┴─────────┐
            ▼                   ▼
      SVG renderer          MCP server
                                │
                                ▼
                       LLMs and AI agents
```

The goal is **not** to ask an LLM to generate a large opaque SVG string.

Instead, an agent should be able to perform structured operations such as:

```json
{
  "operations": [
    {
      "op": "create_rectangle",
      "x": 100,
      "y": 100,
      "width": 180,
      "height": 80,
      "label": "Transmitter"
    },
    {
      "op": "create_rectangle",
      "x": 400,
      "y": 100,
      "width": 180,
      "height": 80,
      "label": "Receiver"
    },
    {
      "op": "connect",
      "from": "Transmitter",
      "to": "Receiver",
      "route": "orthogonal",
      "label": "Channel"
    }
  ]
}
```

The result remains a normal Euclid document that a human can continue editing visually.

### Planned MCP interface

The MCP server is not yet part of the current release.

The intended API is deliberately small and semantic, for example:

```text
euclid.create_document()
euclid.get_document()

euclid.apply_operations(...)
euclid.find_objects(...)
euclid.inspect_selection(...)

euclid.import_svg(...)
euclid.export_svg(...)
euclid.render_preview(...)
```

Rather than exposing every toolbar action as a separate MCP tool, `apply_operations(...)` can support typed operations such as:

```text
create
delete
move
resize
rotate
style
set_text
connect
disconnect
group
ungroup
align
distribute
edit_path
```

This keeps the interface compact while preserving the meaning of the drawing.

---

## Architecture

Euclid keeps one authoritative document tree in `state.js`.

Every other subsystem reads from that tree.

```text
                       ┌──────────────┐
                       │  state.js    │
                       │ document tree│
                       └───────┬──────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
      render.js              ui.js              export.js
          │
          ├── paths.js
          ├── paint.js
          ├── connectors.js
          ├── guides.js
          └── grid.js
```

All document mutations pass through `mutate(fn)`:

```js
export function mutate(fn) {
  const draft = structuredClone(doc);
  fn(draft);
  doc = draft;
  notify();
}
```

This is intentionally simple.

For the small-to-medium technical drawings Euclid targets, clarity of the model is more important than building a complex incremental graphics engine prematurely.

### Derived data

A recurring architectural principle in Euclid is:

> **Store semantic information; derive rendering information.**

Examples:

- Bézier paths store anchors; SVG `d` is derived.
- Gradients live in the object model; `<linearGradient>` definitions are derived.
- Connectors store relationships and waypoints; connector geometry is derived from the current shapes.
- SVG is an output representation, not the application's internal source of truth.

This same principle is intended to underpin the MCP interface.

---

## Getting started

Clone the repository:

```bash
git clone https://github.com/anilyesilkaya/euclid.git
cd euclid
```

Install the development dependency:

```bash
npm install
```

Build the browser bundle:

```bash
npm run build
```

Then open:

```text
index.html
```

in a modern browser.

The generated bundle works over the `file://` protocol, so no web server is required for normal use.

### Development

The source of truth is the modular JavaScript under `js/`.

Run:

```bash
npm run watch
```

to rebuild automatically while editing.

If you want to load the ES modules directly during development, serve the directory with any simple static server, for example:

```bash
python -m http.server
```

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `V` | Selection tool |
| `A` | Direct Selection tool |
| `R` | Rectangle |
| `E` | Ellipse |
| `C` | Circle |
| `L` | Line |
| `X` | Connector |
| `P` | Polyline |
| `N` | Pen |
| `T` | Text |
| `Esc` | Cancel current tool / finish path |
| `Enter` | Finish current pen path |
| `F2` | Rename selected shape label |
| `Delete` / `Backspace` | Delete selection |
| `Ctrl+S` | Save `.euclid.json` |
| `Ctrl+O` | Open `.euclid.json` |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+A` | Select all top-level nodes |
| `Ctrl+D` | Transform Again |
| `Ctrl+C` / `Ctrl+V` | Copy / paste |
| `Ctrl+Shift+V` | Paste in place |
| `Ctrl+G` | Group |
| `Ctrl+Shift+G` | Ungroup |
| `Ctrl+'` | Toggle grid |
| `Ctrl+Shift+'` | Toggle snap-to-grid |
| `Ctrl +` / `Ctrl -` | Zoom |
| `Ctrl+0` | Fit to view |
| `Ctrl+Shift+0` | Reset to 100% |
| Arrow keys | Nudge 1 px |
| `Shift` + Arrow keys | Nudge 10 px |

Additional gesture modifiers:

- Hold `Shift` while drawing to constrain geometry.
- Hold `Alt` while moving to bypass snapping.
- `Ctrl`-drag a selection to duplicate while moving.
- `Alt`-drag the rotate handle to rotate a duplicate.
- Hold `Shift` while rotating to snap to 22.5° increments.
- Hold `Shift+Ctrl` while rotating for 1° fine steps.
- Hold `Alt` while editing a Bézier handle to break the smooth handle pair.

---

## SVG import

The importer is deliberately strict.

If Euclid cannot represent something faithfully, it reports the unsupported feature instead of silently dropping it.

### Supported

- `rect`
- `circle`
- `ellipse`
- `line`
- `polyline`
- `text`
- `path`
- `g`
- `title`
- `desc`
- `metadata`
- class-based `<style>`
- `<defs>` containing supported styles or linear gradients
- linear gradients
- `translate()`
- `rotate()`
- rigid `matrix()` transforms

Adobe Illustrator SVG exports using class-based styles are supported.

### Currently rejected

- Radial gradients
- Patterns
- Filters
- Clip paths
- Masks
- `<use>`
- `<image>`
- `<symbol>`
- `<marker>`
- Unsupported paint-server references
- Transforms containing scale or shear

The intent is to reject unsupported semantics clearly rather than produce a drawing that only looks approximately correct.

---

## Project layout

```text
index.html              Browser application shell
styles.css              Application styling

js/
  main.js               Bootstrap and subscriptions
  state.js              Authoritative document tree
  history.js            Undo / redo
  render.js             SVG DOM rendering
  tools.js              Drawing and pointer interaction
  ui.js                 Toolbar and property panel
  export.js             SVG serialization
  import.js             Strict SVG parser
  persist.js            Save / open / autosave
  paths.js              Structured Bézier path model
  paint.js              Gradient model
  layers.js             Layers panel
  align.js              Alignment and distribution
  guides.js             Smart alignment guides
  grid.js               Grid and snapping
  viewport.js           Zoom and pan
  connectors.js         Connector geometry

tools/
  shot.mjs              Browser screenshot helper
```

`js/euclid.bundle.js` is a generated build artifact loaded by `index.html`.

---

## Scope

Euclid is intentionally **not** trying to become a complete replacement for Illustrator, Figma, Inkscape, or diagrams.net.

The target is narrower:

```text
technical documentation
        │
        ├── block diagrams
        ├── architecture diagrams
        ├── scientific figures
        ├── engineering illustrations
        ├── flow diagrams
        └── simple vector artwork
                  │
                  ▼
             clean SVG
```

That scope provides a simple feature filter:

> Does this feature materially improve technical drawing, structured vector editing, or AI-assisted graphics?

If yes, it belongs in the conversation.

If not, Euclid probably does not need it.

---

## Direction

The next major architectural step is to separate the reusable document and geometry logic from the browser UI:

```text
                    euclid-core
                   /           \
                  /             \
          euclid-web           euclid-mcp
```

`euclid-core` would contain the model and semantic operations.

`euclid-web` would remain the lightweight visual editor.

`euclid-mcp` would expose the same capabilities to LLMs and AI agents.

This would allow workflows such as:

> "Draw an OFDM transmitter with an LDPC encoder, QAM modulator, OFDM modulator, and RF front end. Use orthogonal connectors and evenly space the blocks."

The agent could create the diagram through Euclid's structured graphics operations, after which the user could continue editing the result manually in the browser.

That human–AI round trip is the long-term goal of the project.

---

## License

MIT — see [LICENSE](LICENSE).
