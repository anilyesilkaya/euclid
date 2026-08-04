"""Verify SVG import: modal, append/replace, strict error on unsupported."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import re, time, sys, json

URL = "http://localhost:8765/"
OUT = Path(r"C:\Users\ayesilka\AppData\Local\Temp\claude\svg-canvas-verify-import")
OUT.mkdir(parents=True, exist_ok=True)

steps = []
def rec(marker, msg, evidence=None):
    steps.append((marker, msg, evidence))
    print(f"{marker} {msg}")
    if evidence:
        print("    " + evidence.replace("\n", "\n    "))

def get_source(page):
    time.sleep(0.15)
    return page.eval_on_selector("#source", "el => el.textContent")

console_errors = []
page_errors = []

# --- Test fixtures ---
GOOD_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="10" y="10" width="80" height="60" fill="#ff0000" stroke="#000000" stroke-width="2"/>
  <circle cx="150" cy="50" r="30" fill="#00aa00"/>
  <g transform="translate(20,20)">
    <ellipse cx="50" cy="30" rx="40" ry="20" fill="#0000ff"/>
    <line x1="0" y1="0" x2="100" y2="60" stroke="#000000" stroke-width="3"/>
  </g>
  <polyline points="10,80 30,60 50,80 70,60" fill="none" stroke="#800080" stroke-width="2"/>
  <text x="100" y="90" font-size="14" fill="#000000">HELLO</text>
</svg>"""

BAD_PATH_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="red"/>
  <path d="M10 10 L90 90"/>
</svg>"""

BAD_TRANSFORM_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="red" transform="scale(2)"/>
</svg>"""

MALFORMED_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="80" height="80" fill="red"
</svg>"""

def open_modal(page):
    page.click("#import-btn")
    page.wait_for_selector("#import-modal:not([hidden])", timeout=2000)

def set_import_text(page, text):
    page.fill("#import-text", text)

def submit(page):
    page.click("#import-confirm")
    time.sleep(0.2)

def modal_visible(page):
    return not page.eval_on_selector("#import-modal", "e => e.hidden")

def get_error(page):
    hidden = page.eval_on_selector("#import-error", "e => e.hidden")
    if hidden: return None
    return page.eval_on_selector("#import-error", "e => e.textContent")

def get_child_counts(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('#doc-layer > *')).map(e => e.localName)")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(f"[{m.type}] {m.text}") if m.type in ("error","warning") else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(URL, wait_until="load")
    time.sleep(0.25)

    # --- Probe 1: Import button exists in source panel head ---
    if page.locator("#import-btn").count() == 1:
        rec("✅", "Import button present")
    else:
        rec("❌", "Import button missing")

    # --- Probe 2: Clicking Import opens the modal ---
    open_modal(page)
    if modal_visible(page):
        rec("✅", "Import modal opens")
    else:
        rec("❌", "Import modal did not open")

    # --- Probe 3: Escape closes modal ---
    page.keyboard.press("Escape")
    time.sleep(0.15)
    if not modal_visible(page):
        rec("✅", "Escape closes modal")
    else:
        rec("❌", "Escape did NOT close modal")

    # --- Probe 4: Import a well-formed SVG in Append mode ---
    open_modal(page)
    set_import_text(page, GOOD_SVG)
    # Ensure Append mode
    page.check('input[name="import-mode"][value="append"]')
    submit(page)
    err = get_error(page)
    if err:
        rec("❌", f"Good SVG produced an error: {err}")
    else:
        kids = get_child_counts(page)
        # We expect: rect, circle (as bare shape or wrapped), g (with translate), polyline, text
        # But shape wrappers only wrap labeled shapes, so all top-level should be exactly one of each type.
        expected_types = {"rect", "circle", "g", "polyline", "text"}
        got_types = set(kids)
        # The g child is a group (with a translate) containing ellipse+line; those shouldn't be top-level.
        if expected_types.issubset(got_types) and "ellipse" not in got_types and "line" not in got_types:
            rec("✅", f"Good SVG appended; top-level children: {kids}")
        else:
            rec("❌", f"Import produced wrong tree: {kids}")

    # --- Probe 5: Source panel now contains the imported geometry ---
    src = get_source(page)
    if all(s in src for s in ['<rect', '<circle', '<ellipse', '<line', '<polyline', '<text', 'HELLO']):
        rec("✅", "Source panel reflects all imported primitives + text content")
    else:
        rec("❌", f"Source missing imported content", src[:800])

    # --- Probe 6: Translate preserved on the imported group ---
    if 'translate(20,20)' in src:
        rec("✅", "Group translate(20,20) preserved in source")
    else:
        rec("❌", f"Group translate not preserved", src[:800])

    # --- Probe 7: Fill color preserved on the red rect ---
    if 'fill="#ff0000"' in src or 'fill="red"' in src:
        rec("✅", "Red rect fill preserved")
    else:
        rec("❌", "Red rect fill not preserved", src[:800])

    # --- Probe 8: Undo removes the whole import as one entry ---
    # Move focus off the source panel (which is tabindex) to the canvas:
    page.locator("#canvas").click(position={"x": 5, "y": 5})
    time.sleep(0.05)
    page.keyboard.press("Escape")
    time.sleep(0.05)
    page.keyboard.press("Control+z")
    time.sleep(0.2)
    kids_after = get_child_counts(page)
    if kids_after == []:
        rec("✅", "Undo removed all imported nodes in one step")
    else:
        rec("❌", f"Undo did not clear import; remaining kids: {kids_after}")

    # --- Probe 9: Replace mode wipes existing content first ---
    # Set up: import once (append), then import again in replace mode.
    open_modal(page)
    set_import_text(page, GOOD_SVG)
    page.check('input[name="import-mode"][value="append"]')
    submit(page)
    time.sleep(0.15)
    n1 = len(get_child_counts(page))
    open_modal(page)
    set_import_text(page, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="lime"/></svg>')
    page.check('input[name="import-mode"][value="replace"]')
    submit(page)
    time.sleep(0.15)
    kids = get_child_counts(page)
    if kids == ["rect"] and n1 > 1:
        rec("✅", f"Replace mode wiped previous {n1} nodes; now exactly 1 rect")
    else:
        rec("❌", f"Replace produced wrong tree: {kids} (was {n1} before)")

    # Clear canvas for remaining error-path probes.
    page.locator("#canvas").click(position={"x": 5, "y": 5})
    time.sleep(0.05)
    page.keyboard.press("Escape")
    page.keyboard.press("Control+z")
    time.sleep(0.2)
    page.keyboard.press("Control+z")  # extra just in case
    time.sleep(0.2)

    # --- Probe 10: Unsupported <path> is rejected with a specific error ---
    open_modal(page)
    set_import_text(page, BAD_PATH_SVG)
    submit(page)
    err = get_error(page)
    if err and "path" in err.lower() and modal_visible(page):
        rec("✅", f"<path> rejected with error: {err[:80]}")
    else:
        rec("❌", f"Expected rejection of <path>; got err={err!r} modal_open={modal_visible(page)}")

    # Modal should still be open — the doc should be unchanged.
    kids = get_child_counts(page)
    if not kids:
        rec("✅", "Failed import left the document untouched")
    else:
        rec("❌", f"Failed import mutated document: {kids}")

    page.click("#import-cancel")
    time.sleep(0.1)

    # --- Probe 11: Unsupported transform is rejected ---
    open_modal(page)
    set_import_text(page, BAD_TRANSFORM_SVG)
    submit(page)
    err = get_error(page)
    if err and "scale" in err.lower():
        rec("✅", f"scale() transform rejected: {err[:80]}")
    else:
        rec("❌", f"scale() not properly rejected: err={err!r}")
    page.click("#import-cancel")
    time.sleep(0.1)

    # --- Probe 12: Malformed XML is rejected ---
    open_modal(page)
    set_import_text(page, MALFORMED_SVG)
    submit(page)
    err = get_error(page)
    if err and "parse" in err.lower():
        rec("✅", f"Malformed XML rejected: {err[:80]}")
    else:
        rec("❌", f"Malformed XML not properly rejected: err={err!r}")
    page.click("#import-cancel")
    time.sleep(0.1)

    # --- Probe 13: Empty input is rejected ---
    open_modal(page)
    set_import_text(page, "   ")
    submit(page)
    err = get_error(page)
    if err and "empty" in err.lower():
        rec("✅", f"Empty input rejected: {err[:80]}")
    else:
        rec("❌", f"Empty input not rejected: err={err!r}")
    page.click("#import-cancel")

    # --- Probe 14: <title>/<desc> are silently ignored (they carry no geometry) ---
    open_modal(page)
    set_import_text(page, '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <title>Test</title>
  <desc>should be ignored</desc>
  <rect x="10" y="10" width="80" height="80" fill="yellow"/>
</svg>''')
    page.check('input[name="import-mode"][value="replace"]')
    submit(page)
    time.sleep(0.15)
    kids = get_child_counts(page)
    if kids == ["rect"]:
        rec("✅", f"<title>/<desc> silently ignored; result: {kids}")
    else:
        rec("❌", f"title/desc handling wrong: {kids}")

    page.screenshot(path=str(OUT / "final.png"), full_page=True)

    if page_errors:
        rec("⚠️", "Uncaught page errors", "\n".join(page_errors))
    if console_errors:
        rec("⚠️", "Console errors", "\n".join(console_errors[:10]))
    browser.close()

print("\n=== SUMMARY ===")
fails = sum(1 for m,_,_ in steps if m == "❌")
warns = sum(1 for m,_,_ in steps if m == "⚠️")
oks = sum(1 for m,_,_ in steps if m == "✅")
print(f"✅ {oks}   ❌ {fails}   ⚠️ {warns}")
sys.exit(0 if fails == 0 else 1)
