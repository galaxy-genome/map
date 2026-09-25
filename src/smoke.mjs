// Load the bundle against a stub DOM and drive the paths that only run on
// interaction, because `node --check` proves syntax and nothing else.
import { readFileSync } from "fs";

const DOCS = new URL("../docs/", import.meta.url);
const read = f => readFileSync(new URL(f, DOCS), "utf8");

const node = () => {
  const self = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    options: [], children: [], value: "", textContent: "", innerHTML: "", checked: false,
    hidden: false, disabled: false, width: 0, height: 0,
    appendChild: node, append(){}, prepend(){}, remove(){}, insertBefore(){},
    after(){}, before(){}, replaceWith(){}, cloneNode: node,
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    setAttribute(){}, getAttribute: () => null, removeAttribute(){},
    querySelector: node, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => new Proxy({}, { get: () => () => ({ width: 0 }) }),
    setPointerCapture(){}, scrollIntoView(){}, focus(){}, click(){},
    firstChild: { textContent: "" },
    [Symbol.toPrimitive]: () => "",
  };
  return self;
};

globalThis.window = globalThis;
globalThis.document = {
  getElementById: node, querySelector: node, querySelectorAll: () => [],
  createElement: node, head: node(), body: node(), documentElement: node(),
  addEventListener(){}, title: "",
};
globalThis.location = { search: "", hash: "", hostname: "x", protocol: "http:" };
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener(){} });
globalThis.localStorage = { getItem: () => null, setItem(){} };
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1400; globalThis.innerHeight = 900;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.performance = { now: () => 0 };
globalThis.Image = class { set src(v){} decode(){ return Promise.resolve(); } };
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
globalThis.CSS = { escape: s => s };

const galaxy = JSON.parse(read("data/galaxy.json"));
const lang = JSON.parse(read("data/lang/en.json"));
galaxy.langs = { en: lang.strings };
galaxy.ui = { en: lang.ui };
globalThis.__GG__ = galaxy;

// expose the functions worth exercising
const src = read("app.js") + `
;globalThis.__T__ = { cellStars, starBodies, cellFromName, showGenTip, passesGenerated, passes,
                      systemValue, setScanner: i => { scanner = i; },
                      fitToMatches, currentParams, F, filters,
                      view: () => ({ cx, cz, scale, W, focused }),
                      setGenMaps: (side, zones) => { GEN.side = side; GEN.zones = zones; GEN.cache.clear(); } };`;

let fail = 0;
const ok = (label, fn) => {
  try { const v = fn(); console.log(`  ok    ${label}${v === undefined ? "" : "  " + v}`); }
  catch (e) { console.log(`  FAIL  ${label}  ${e.constructor.name}: ${e.message}`); fail++; }
};

ok("bundle loads", () => { new Function(src)(); });
const T = globalThis.__T__ || {};
ok("cellFromName decodes a generated name", () => {
  const c = T.cellFromName("Actox Bw-Ar D68");
  if (!c) throw new Error("returned null");
  return `cell ${c.cx},${c.cy} index ${c.index}`;
});
// The generation bitmaps cannot be decoded here, so build a star by hand. This
// is the path that only runs on hover, where a syntax check proves nothing.
// Placed well outside both pre-explored radii, or every body would scan for
// nothing and the value assertions below would pass vacuously.
const star = { seed: 1075197696, raw: "Quarkstar", type: "Quark star",
               name: "Test AA-AA A1", x: 4000, z: 6000, fuel: false };
const nearSol = { ...star, seed: star.seed + 2, x: 100, z: 200 };
const nearVoid = { ...star, seed: star.seed + 3, x: -2274, z: -3980 };
ok("starBodies on a generated star", () => {
  const b = T.starBodies(star);
  if (typeof b.scan !== "number" || Number.isNaN(b.scan)) throw new Error("bad scan");
  return `scan ${b.scan.toLocaleString()} CR, ${b.planets.length} planets`;
});
ok("every star in the system is counted, not just the primary", () => {
  const b = T.starBodies({ ...star, seed: star.seed + 1 });
  const planets = b.planets.reduce((s, p) => s + p.scan, 0);
  const cost = globalThis.__GG__.starCost || {};
  const stars = b.stars.reduce((s, t) => s + (cost[t] || 0), 0);
  if (b.scan !== planets + stars)
    throw new Error(`scan ${b.scan} != ${planets} planets + ${stars} stars`);
  if (!b.stars.length) throw new Error("no stars recorded");
  return `${b.stars.length} star(s) worth ${stars.toLocaleString()}`;
});
ok("a system near Sol is explored and pays nothing", () => {
  const b = T.starBodies(nearSol);
  if (!b.explored || b.scan !== 0) throw new Error(`explored ${b.explored}, scan ${b.scan}`);
  return "0 CR inside 300 ly of Sol";
});
ok("a system near The Void is explored too", () => {
  const b = T.starBodies(nearVoid);
  if (!b.explored || b.scan !== 0) throw new Error(`explored ${b.explored}, scan ${b.scan}`);
  return "0 CR inside 150 ly of The Void";
});
// The generator exists twice: gen.py builds the database, app.js draws the map.
// Nothing forces them to agree, and when they silently disagreed the map showed
// a galaxy the game does not have. gen_cases.json is what Python produces
// (tools/port/gen_cases.py), materials included.
ok("the JS generator matches the Python one", () => {
  const cases = JSON.parse(read("../src/gen_cases.json"));
  const wrong = [];
  for (const c of cases){
    const b = T.starBodies({ seed: c.seed, raw: c.raw, x: 9e4, z: 9e4,
                             name: "x", type: "x", fuel: false });
    const got = JSON.stringify({
      stars: b.stars,
      planets: b.planets.map(p => [p.type.replace(/ /g, ""), p.orbit,
                                   Math.floor(Math.min(p.reach, 1e6))]),
      belts: b.belts.map(t => t.ores.map(o => o.name)),
      materials: b.planets.map(p => p.mats),
    });
    const want = JSON.stringify({
      stars: c.stars, planets: c.planets, belts: c.belts, materials: c.materials,
    });
    if (got !== want) wrong.push({ seed: c.seed, got, want });
  }
  if (wrong.length)
    throw new Error(`${wrong.length}/${cases.length} differ, first: `
      + `seed ${wrong[0].seed}\n    js  ${wrong[0].got}\n    py  ${wrong[0].want}`);
  return `${cases.length} systems identical`;
});
// The cell walk exists twice as well: cellgen.py places the stars the database
// holds, cellStars the ones the map draws. cell_cases.json is Python's answer for
// 300 cells (gen_cases.py), with the side and zone values the map decodes from
// its bitmaps, which Node cannot decode.
ok("the JS cell walk matches the Python one", () => {
  const cases = JSON.parse(read("../src/cell_cases.json"));
  const GRID = 2048, side = new Uint8Array(GRID * GRID), zones = new Uint8Array(GRID * GRID * 3);
  for (const c of cases){
    side[c.cy * GRID + c.cx] = c.side;
    zones.set(c.zone, (c.cy * GRID + c.cx) * 3);
  }
  T.setGenMaps(side, zones);
  const wrong = [];
  for (const c of cases){
    const got = T.cellStars(c.cx, c.cy).map(s => [s.x, s.z, s.raw, s.seed]);
    const same = (g, w) => g && Math.abs(g[0] - w[0]) < 1e-3 && Math.abs(g[1] - w[1]) < 1e-3
                           && g[2] === w[2] && g[3] === w[3];
    const at = c.stars.findIndex((w, i) => !same(got[i], w));
    if (at >= 0 || got.length !== c.stars.length)
      wrong.push({ cell: `${c.cx},${c.cy}`, at, got: JSON.stringify(got[at] || `${got.length} stars`),
                   want: JSON.stringify(c.stars[at] || `${c.stars.length} stars`) });
  }
  if (wrong.length)
    throw new Error(`${wrong.length}/${cases.length} cells differ, first: ${wrong[0].cell} star ${wrong[0].at}\n    js  ${wrong[0].got}\n    py  ${wrong[0].want}`);
  return `${cases.length} cells, ${cases.reduce((n, c) => n + c.stars.length, 0)} stars identical`;
});
// The scanner is the one input that changes what a system is worth, and four
// filters, two tooltips and nine chip counts read the same function for it.
ok("the scanner moves value from the trip to the arrival", () => {
  const at = i => { T.setScanner(i); return T.systemValue(star); };
  const none = at(0), best = at(4);
  T.setScanner(1);
  if (none.full !== best.full) throw new Error("the full value must not depend on the scanner");
  if (best.arrival < none.arrival) throw new Error("a longer scanner cannot bank less");
  if (none.arrival > none.full || best.arrival > best.full)
    throw new Error("arrival exceeds the system total");
  return `none ${none.arrival.toLocaleString()} / 1A ${best.arrival.toLocaleString()} `
       + `of ${none.full.toLocaleString()} CR, ${none.hops} vs ${best.hops} hops`;
});
ok("a catalogue row values the same way a generated one does", () => {
  const G = globalThis.__GG__;
  const [SCAN, STARV, PB] = [12, 20, 21];
  const rich = G.systems.filter(s => s[SCAN] > 0).sort((a, b) => b[SCAN] - a[SCAN]);
  let checked = 0;
  for (const s of rich.slice(0, 400)){
    const v = T.systemValue(s);
    let want = s[STARV];
    for (let i = 0; i < s[PB].length; i += 2)
      if (s[PB][i] <= G.scanners[1][1]) want += s[PB][i + 1];
    if (v.arrival !== want)
      throw new Error(`${s[0]}: arrival ${v.arrival} != ${want}`);
    if (v.arrival > v.full || v.reach > v.full)
      throw new Error(`${s[0]}: ${v.arrival}/${v.reach} exceeds ${v.full}`);
    checked++;
  }
  return `${checked} systems agree at the 1D`;
});
// A filter answers with a set. Landing on one member of it was the old bug, and
// it is invisible to every other check here.
ok("a filter frames its whole answer, not one system", () => {
  const G = globalThis.__GG__;
  T.F.valMin = 1000000;
  T.fitToMatches();
  const v = T.view();
  const hit = G.systems.filter(s => T.passes(s));
  const ly = hit.map(s => s[3]).sort((a, b) => a - b);
  const want = Math.max(ly[ly.length >> 1] * 4, 300);
  const across = v.W / v.scale;
  T.F.valMin = null;
  if (Math.abs(across - want) > 1)
    throw new Error(`framed ${across.toFixed(0)} ly, expected ${want}`);
  if (Math.abs(v.cz) > 1) throw new Error(`not centred on Sol: z ${v.cz}`);
  if (!v.focused.length) throw new Error("nothing flashed");
  return `${hit.length} matches, ${across.toFixed(0)} ly across, `
       + `${v.focused.length} flashed`;
});
ok("the address bar carries the view", () => {
  const p = T.currentParams();
  if (!p.has("at") || !p.has("ly")) throw new Error("no centre or zoom in the URL");
  return `at=${p.get("at")} ly=${p.get("ly")}`;
});
ok("showGenTip renders", () => T.showGenTip(star, 100, 100));
ok("passesGenerated with a star filter", () => T.passesGenerated(star));
process.exit(fail ? 1 : 0);
