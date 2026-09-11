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
;globalThis.__T__ = { cellStars, starBodies, cellFromName, showGenTip, passesGenerated };`;

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
const star = { seed: 1075197696, raw: "Quarkstar", type: "Quark star",
               name: "Test AA-AA A1", x: 100, z: 200, fuel: false };
ok("starBodies on a generated star", () => {
  const b = T.starBodies(star);
  if (typeof b.scan !== "number" || Number.isNaN(b.scan)) throw new Error("bad scan");
  return `scan ${b.scan.toLocaleString()} CR, ${b.planets.length} planets`;
});
ok("the star's own value is counted", () => {
  const b = T.starBodies({ ...star, seed: star.seed + 1 });
  const planets = b.planets.reduce((s, p) => s + p.scan, 0);
  if (b.scan - planets !== 1800000) throw new Error(`star value ${b.scan - planets}`);
  return "Quark star adds 1,800,000";
});
ok("showGenTip renders", () => T.showGenTip(star, 100, 100));
ok("passesGenerated with a star filter", () => T.passesGenerated(star));
process.exit(fail ? 1 : 0);
