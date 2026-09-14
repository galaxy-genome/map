"""Drive the search box in a real browser: open it, find a filter and a system, pick each."""
import functools, http.server, pathlib, sys, threading
from playwright.sync_api import sync_playwright

DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs"
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
    type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}),
    directory=str(DOCS)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_port}/"

fails = []
def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what)
    if not ok: fails.append(what)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    page = b.new_page(viewport={"width": 1300, "height": 850})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_selector("#findBtn")
    page.wait_for_timeout(1500)

    box = page.locator("#findBox")
    check(box.is_hidden(), "search box starts hidden")
    spoil, btn = page.locator(".spoilRow .spoil").bounding_box(), page.locator("#findBtn").bounding_box()
    check(abs((spoil["y"] + spoil["height"] / 2) - (btn["y"] + btn["height"] / 2)) < 6,
          "search icon on the show spoilers row")
    page.click("#findBtn")
    check(box.is_visible(), "icon opens the box")
    check(page.evaluate("document.activeElement.id") == "find", "box takes focus")

    hits = page.locator('.hits[data-for="find"] li')
    page.fill("#find", "phosph")
    page.wait_for_timeout(300)
    first = hits.first.inner_text() if hits.count() else ""
    check("Phosphorus" in first, f"'phosph' offers the material first ({first!r})")
    if SHOTS: page.screenshot(path=str(SHOTS / "search-filter.png"))
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(page.input_value("#mat") != "", "Enter selects Material to dig")
    check(page.evaluate("document.getElementById('mat').closest('details').open"), "its section opens")
    check(page.evaluate("[...document.querySelectorAll('details.grp')].filter(d => d.open).length") == 1,
          "every other section closes")
    check(box.is_hidden(), "box closes after a pick")
    page.wait_for_timeout(1500)
    searched = page.url
    page.select_option("#mat", "")
    page.select_option("#mat", label="Phosphorus")
    page.wait_for_timeout(1500)
    check(searched == page.url, f"URL matches picking it by hand ({searched} vs {page.url})")

    for q, sel, what in [("trophies", 'button[data-f="trophyBuyer"]', "Trading chip"),
                         ("clear route", "#clearRoute", "Clear route"),
                         ("high-value", "[data-preset]", "Show me preset"),
                         ("whole galaxy", "#toAll", "Jump to")]:
        page.click("#findBtn")
        page.fill("#find", q)
        page.wait_for_timeout(300)
        t = hits.first.inner_text() if hits.count() else ""
        check(q.split()[0] in t.lower(), f"'{q}' offers {what} ({t!r})")
        page.click("#findGo")
        page.wait_for_timeout(300)
        check(box.is_hidden(), f"search icon in the box picks {what}")
        if what == "Trading chip":
            check(page.get_attribute(sel, "aria-pressed") == "true", "Trading chip was pressed")

    page.click("#findBtn")
    page.fill("#find", "Sirius")
    page.wait_for_timeout(800)
    t = hits.first.inner_text() if hits.count() else ""
    check("Sirius" in t, f"'Sirius' offers the system ({t!r})")
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)
    check(page.input_value("#from") == "Sirius", "a system pick sets the current system")

    page.click("#findBtn")
    page.fill("#find", "Ic-Jr C1")
    page.wait_for_timeout(2500)
    check("ly=" in page.url and "at=" in page.url, "typing a generated name moves the view")
    if SHOTS: page.screenshot(path=str(SHOTS / "search-system.png"))
    check(not errors, f"no page errors {errors[:2]}")
    b.close()
srv.shutdown()
sys.exit(1 if fails else 0)
