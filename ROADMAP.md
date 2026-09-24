# Euclid Roadmap — converging toward draw.io / Illustrator

This is the long-term plan for growing Euclid from a capable zero-dependency SVG
editor into a draw.io / Illustrator-class tool. It sequences work across four
areas: foundational editor gaps, draw.io diagramming, Illustrator vector
editing, and styling polish.

## Where Euclid is today

Shapes, auto-routing connectors, direct manipulation (move / resize / rotate),
smart alignment guides, grid + snap-to-grid, zoom / pan, align + distribute,
groups, layers panel, labels on shapes, live SVG source, strict SVG import,
undo/redo, and — as of Milestone 1 — a lossless native `.euclid.json`
save/open format with debounced autosave.

## Architecture invariants (respect throughout)

- The root doc tree in `state.js` is authoritative; every module reads it and
  re-renders on `subscribe()`.
- All writes go through `mutate(fn)` (deep-clone root → mutate draft → swap →
  notify). History is snapshot-based, one entry per gesture.
- `index.html` loads the **bundled** `js/euclid.bundle.js`, so **every source
  change requires `npm run build`**. The committed bundle is a tracked
  generated artifact and conflicts on every multi-branch merge — rebuild after
  each merge.
- After any UI/UX change, verify in the browser with Playwright.

---

## Phase 1 — Foundational editor (highest leverage)

- **M1 — Native save / open / autosave.** ✅ **Done.** Lossless
  `.euclid.json` format (`{version, doc}`), Save (download) / Open (file),
  debounced autosave to localStorage with silent restore on reload.
  `js/persist.js` + `history.resetHistory()`; Ctrl+S / Ctrl+O shortcuts.
- **M2 — Group & multi-select resize.** Replace the deferred `resizeNode` stub
  (`tools.js`) and wire functional handles on the multi-selection chrome
  (`render.js`). Scale group children via the group transform / proportional
  geometry; honor Shift for aspect lock.
- **M3 — Layer drag-to-reorder.** Add drag reordering in `layers.js` (today
  z-order is context-menu only), reusing the existing `zOrder` mutations.

## Phase 2 — draw.io diagramming

- **M4 — Orthogonal (elbow) connector routing + waypoints.** Extend the pure
  geometry in `connectors.js` with an elbow router and optional stored
  waypoints; add a routing-style choice in the property panel.
- **M5 — Connector labels + arrowhead UI.** Expose the existing
  `arrowStart` / `arrowEnd` model flags in the panel, plus a mid-edge label
  (reuse the label editor from `tools.js`).

## Phase 3 — Illustrator vector editing

- **M6 — Pen / bézier path tool + path-point editing.** A real `path` drawing
  tool and node editing (the `path` type already renders / imports; add
  creation and anchor / handle manipulation in `tools.js` + `render.js`).
- **M7 — Gradients.** A paint-server model (currently rejected on import by
  design in `import.js`), fill / stroke gradient UI, and export / import support.
- **M10 — Illustrator-style rotate + copy and "Transform Again."** Make the
  transform-with-duplicate and repeat behaviors match Adobe Illustrator:
  - **Alt/Option-drag during a transform duplicates.** Today Euclid only
    duplicate-drags on *move* (Ctrl-drag). Extend duplicate-on-drag to the
    **rotate** (and later scale) gestures, and align the modifier with
    Illustrator's Alt/Option.
  - **Ctrl+D = "Transform Again."** Repeat the *last transform* (move, rotate,
    or scale — including a duplicate) on the current selection, enabling
    step-and-repeat (e.g. rotate-and-copy 15° twelve times to make a clock
    face / radial pattern). Today Ctrl+D is a fixed duplicate at (+10, +10);
    this item redefines it to replay the last recorded transform delta.
  - Requires storing a "last transform" descriptor (kind + delta + pivot) when
    a gesture ends, and a repeat op that re-applies it (optionally
    re-duplicating) via `mutate`.

## Phase 4 — Styling & polish (small, high-visibility; can interleave)

- **M8 — Extended styling UI.** Dash / linecap / linejoin, rounded corners
  (rx / ry), font weight / style, text alignment. Export / import already
  preserve these attrs; this is mostly property-panel wiring in `ui.js` +
  `index.html`.
- **M9 — Circle tool.** ✅ **Done.** Added the toolbar button (Circle (C),
  hold Shift for a perfect circle) + `TOOL_KEYS` `c` binding; the `circle`
  type was already handled in draw / resize / render / import.

---

## Sequencing rationale

M1 makes the app trustworthy with real work (nothing else matters if you can't
keep your drawing). M2 / M3 remove the most-felt editing friction. Phases 2–4
then deepen the two "personalities" — diagramming vs. vector art — on that
stable base. The Phase 4 styling items are small and high-visibility, so they
can be interleaved opportunistically between larger milestones.
