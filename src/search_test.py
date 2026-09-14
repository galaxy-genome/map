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
    check(page.evaluate("[...document.querySelectorAll('.sections details.grp')].filter(d => d.open).length") == 1,
          "every other section closes")
    check(box.is_hidden(), "box closes after a pick")
    page.wait_for_timeout(1500)
    searched = page.url
    page.select_option("#mat", "")
    page.select_option("#mat", label="Phosphorus")
    page.wait_for_timeout(1500)
    check(searched == page.url, f"URL matches picking it by hand ({searched} vs {page.url})")

    mbox = page.locator("#matPctMin")
    check(mbox.is_enabled() and mbox.input_value() != "", f"Min % arms at {mbox.input_value()}")
    check(mbox.get_attribute("placeholder") == "26–41", f"Min % spans Phosphorus ({mbox.get_attribute('placeholder')})")
    mbox.fill("40")
    page.wait_for_timeout(1500)
    check("mpct=40" in page.url, "Min % reaches the URL")
    page.goto(url + "?mat=Phosphorus&mpct=40&at=0,0&ly=300")
    page.wait_for_timeout(2500)
    check(page.input_value("#matPctMin") == "40", "mpct in a link fills the box")
    if SHOTS: page.screenshot(path=str(SHOTS / "mat-labels.png"))
    page.select_option("#mat", "")
    check(mbox.is_disabled(), "clearing the material disables Min %")

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
    page.goto(url + "?mat=Phosphorus")
    page.wait_for_timeout(1500)
    note = page.locator("#mat + p.note").inner_text()
    check("26–41%" in note and "Rock Planet 30%" in note, f"material note gives share and planets ({note!r})")
    mining = page.locator("details.grp>summary", has_text="Mining")
    mark = mining.locator(".secWiki")
    check(mark.evaluate("e => getComputedStyle(e).visibility") == "hidden", "section W hides until hover")
    mining.hover()
    check(mark.evaluate("e => getComputedStyle(e).visibility") == "visible", "section W shows on hover")
    was_open = mining.evaluate("s => s.parentElement.open")
    mark.click()
    page.wait_for_timeout(500)
    check(page.locator("#wikiPanel").is_visible()
          and page.locator("#wikiFrame").get_attribute("src").endswith("#Mining"),
          "Mining W opens the Mining guide")
    check(mining.evaluate("s => s.parentElement.open") == was_open, "section W leaves the section as it was")
    page.locator("details.grp>summary", has_text="Module Mods").locator(".secWiki").click(force=True)
    page.wait_for_timeout(300)
    check(page.locator("#wikiFrame").get_attribute("src").endswith("#Module_Mods"),
          "Module Mods W opens the Module Mods page")
    page.locator("details.grp>summary", has_text="Mining").locator(".secWiki").click(force=True)
    page.wait_for_timeout(300)
    mark.click()
    page.wait_for_timeout(300)
    check(page.locator("#wikiPanel").is_hidden(), "a second press on the same W closes the wiki")

    # One filter section open at a time; the route section keeps its own state.
    page.goto(url)
    page.wait_for_timeout(1500)
    route_open = page.evaluate("document.getElementById('routeSec').open")
    for name in ("Mining", "Trading"):
        page.locator("details.grp>summary", has_text=name).locator("span").click()
        page.wait_for_timeout(100)
    opened = page.evaluate("[...document.querySelectorAll('.sections details.grp')].filter(d => d.open)"
                           ".map(d => d.querySelector('summary > span').textContent)")
    check(opened == ["Trading"], f"opening a section closes the others ({opened})")
    check(page.evaluate("document.getElementById('routeSec').open") == route_open, "route section untouched")

    # Filters from two sections do not combine.
    page.locator("details.grp>summary", has_text="Mining").locator("span").click()
    page.select_option("#ore", label="Diamonds")
    page.wait_for_timeout(200)
    page.locator("details.grp>summary", has_text="Trading").locator("span").click()
    page.click('button[data-f="trophyBuyer"]')
    page.wait_for_timeout(200)
    check(page.input_value("#ore") == "" and page.get_attribute('button[data-f="trophyBuyer"]', "aria-pressed") == "true",
          "a Trading chip releases the Mining ore")
    page.locator("details.grp>summary", has_text="Module Mods").locator("span").click()
    page.select_option("#mat", label="Phosphorus")
    page.wait_for_timeout(200)
    check(page.get_attribute('button[data-f="trophyBuyer"]', "aria-pressed") == "false"
          and page.input_value("#mat") != "" and page.is_enabled("#matPctMin"),
          "a material releases the Trading chip and keeps its own Min %")
    page.fill("#matPctMin", "35")
    page.wait_for_timeout(200)
    check(page.input_value("#mat") != "", "Min % in the same section keeps the material")
    page.locator("details.grp>summary", has_text="Show me").locator("span").click()
    page.click('[data-preset]')
    page.wait_for_timeout(300)
    page.locator("details.grp>summary", has_text="Mining").locator("span").click()
    page.select_option("#ore", label="Painite")
    page.wait_for_timeout(300)
    check(page.input_value("#ore") != "" and page.locator('[data-preset][aria-pressed="true"]').count() == 0,
          "an ore releases a Show me preset and survives it")
    page.goto(url + "?ore=Painite&pct=40&mat=Iron")
    page.wait_for_timeout(2000)
    check(page.input_value("#ore") != "" and page.input_value("#mat") != "", "a link's combined filters are kept")
    page.goto(url + "?mat=Iron")
    page.wait_for_timeout(2500)
    check("at=0,0" in page.url and "ly=150" in page.url, f"a material link opens 150 ly around Sol ({page.url})")
    page.goto(url + "?ptype=WaterGiant")
    page.wait_for_timeout(2500)
    check("at=0,0" in page.url and "ly=150" in page.url, f"a planet type link opens 150 ly around Sol ({page.url})")
    page.goto(url + "?module=FuelScoop")
    page.wait_for_timeout(2500)
    check("at=0,0" in page.url and "ly=150" in page.url, f"a module link opens 150 ly around Sol ({page.url})")
    page.goto(url + "?ore=VoidOpal&at=0,0&ly=2000")
    page.wait_for_timeout(3000)
    check(page.is_disabled("#pctMin") and page.input_value("#pctMin") == "", "a deep ore disables Min %")
    groups = page.evaluate("[...document.querySelectorAll('#ore optgroup')].map(g => [g.label, [...g.children].map(o => o.textContent)])")
    check(len(groups) == 2 and groups[1][1] == ["Musgravite", "Void Opal"] and len(groups[0][1]) == 13,
          f"deep ores sit in their own group last ({[g[0] for g in groups]}, {groups[1][1] if len(groups) > 1 else None})")
    check(page.evaluate("document.querySelector('#ore').selectedOptions[0].textContent") == "Void Opal",
          "the link selected Void Opal inside its group")
    note = page.locator("#ore + p.note").inner_text()
    check("Seismic" in note, f"the Void Opal note explains deep ore ({note!r})")
    if SHOTS: page.screenshot(path=str(SHOTS / "void-opal.png"))
    page.goto(url + "?ore=Musgravite")
    page.wait_for_timeout(2500)
    check("at=0,0" in page.url and "ly=1100" in page.url, f"a deep ore link opens 1,100 ly around Sol ({page.url})")
    page.goto(url + "?system=Wolf%20851")
    page.wait_for_timeout(2500)
    tip = page.evaluate("(() => { showTip(byName.get('Wolf 851'), 10, 10); return document.getElementById('tip').innerText; })()")
    check("Void Opal" in tip and "Deep material" in tip, f"a catalogue tooltip names its deep ore ({tip[-80:]!r})")
    gen = page.evaluate("""(() => {
      for (const st of genVisible){
        const cx = (st.seed >>> 20) & 0xFFF, cy = (st.seed >>> 8) & 0xFFF;
        if ((cx + cy) % 10 === 2 && starBodies(st).belts.length){
          showGenTip(st, 10, 10); return document.getElementById('tip').innerText; }
      }
      return "no generated system in view";
    })()""")
    check("Musgravite" in gen and "Deep material" in gen, f"a generated tooltip names its deep ore ({gen[-80:]!r})")
    page.goto(url + "?ore=Painite&at=500,500&ly=300")
    page.wait_for_timeout(2500)
    check("at=500,500" in page.url and "ly=300" in page.url, "a link's own view wins")
    touch = b.new_page(viewport={"width": 400, "height": 800}, has_touch=True, is_mobile=True)
    touch.goto(url)
    touch.wait_for_timeout(1500)
    check(touch.evaluate("getComputedStyle(document.querySelector('.secWiki')).visibility") == "visible",
          "section W always shows on touch")
    page.goto(url)
    page.wait_for_timeout(1500)
    page.locator("details.grp>summary", has_text="Module Mods").locator("span").click()
    mm = page.locator("details.grp", has=page.locator("#mat"))
    copy = mm.locator('[data-preset="pEngineers"]')
    order = mm.evaluate("d => [...d.querySelectorAll('button.chip')].map(b => b.dataset.preset || b.dataset.f)")
    check(order[-2:] == ["pEngineers", "land"], f"Engineers sits above Landable planet ({order})")
    check(copy.locator(".n").inner_text() != "", "the copy carries the Engineers count")
    copy.click()
    page.wait_for_timeout(500)
    check(page.locator('[data-preset="pEngineers"][aria-pressed="true"]').count() == 2
          and page.is_checked("#spoilers"), "the copy presses both Engineers chips and shows spoilers")
    check(mm.evaluate("d => d.open"), "Module Mods stays open")
    page.locator("details.grp>summary", has_text="Show me").locator(".secWiki").click(force=True)
    page.wait_for_timeout(300)
    check(page.locator("#wikiFrame").get_attribute("src").endswith("#Galaxy_Genome_Map"),
          "Show me W opens the top of the Map page")
    check(not errors, f"no page errors {errors[:2]}")
    b.close()
srv.shutdown()
sys.exit(1 if fails else 0)
