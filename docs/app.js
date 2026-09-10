// ---- the populated-space grid ----------------------------------------------
// The game fills the galaxy from a 2048x2048 density bitmap: a cell with any
// density generates stars. Those stars are not in the catalogue, so routing on
// catalogue systems alone reports "unreachable" for almost everywhere. The grid
// is the real reachability graph, and one cell is one map pixel: 43.74 ly.
const GRID = 2048, CELL_LY = 43.74, DIAG_LY = CELL_LY * Math.SQRT2;
let cellBits = null;        // 1 = the cell generates stars
let mainBits = null;        // 1 = the cell is in the component that contains Sol

function bitAt(bits, x, y){
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return 0;
  const i = y * GRID + x;
  return (bits[i >> 3] >> (i & 7)) & 1;
}

async function loadGrid(){
  const read = async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = GRID;
    const g = c.getContext("2d", {willReadFrequently: true});
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, GRID, GRID).data;
    const bits = new Uint8Array((GRID * GRID) >> 3);
    for (let i = 0; i < GRID * GRID; i++)
      if (px[i * 4] > 127) bits[i >> 3] |= 1 << (i & 7);
    return bits;
  };
  [cellBits, mainBits] = await Promise.all([read("data/cells.png"), read("data/reachable.png")]);
}

const cellOf = (x, z) => [Math.floor(x / CELL_LY + 1025), Math.floor(-z / CELL_LY + 1591)];
const cellCentre = (cx, cy) => [(cx + 0.5 - 1025) * CELL_LY, -(cy + 0.5 - 1591) * CELL_LY];

// Whether a jump range can step between neighbouring cells at all.
const canStep = range => range >= CELL_LY;

// A* across populated cells. Returns the cell path, or null.
// `weight` inflates the heuristic. 1 is optimal; above that trades a slightly
// longer path for a far smaller search, which across 40,000 ly is the difference
// between milliseconds and giving up.
function gridRoute(from, to, range, weight = 1.35, budget = 3000000){
  if (!cellBits) return null;
  const [sx, sy] = from, [tx, ty] = to;
  if (!bitAt(cellBits, sx, sy) || !bitAt(cellBits, tx, ty)) return null;
  const diagonal = range >= DIAG_LY;

  const idx = (x, y) => y * GRID + x;
  const came = new Int32Array(GRID * GRID).fill(-1);
  const g = new Float64Array(GRID * GRID).fill(Infinity);
  // Binary heap over (priority, cell). A linear scan for the minimum turns a
  // cross-galaxy search into minutes; this keeps it in milliseconds.
  const heapP = [], heapV = [];
  const push = (p, v) => {
    heapP.push(p); heapV.push(v);
    let i = heapP.length - 1;
    while (i > 0){
      const parent = (i - 1) >> 1;
      if (heapP[parent] <= heapP[i]) break;
      [heapP[parent], heapP[i]] = [heapP[i], heapP[parent]];
      [heapV[parent], heapV[i]] = [heapV[i], heapV[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heapV[0], n = heapP.length - 1;
    heapP[0] = heapP[n]; heapV[0] = heapV[n];
    heapP.pop(); heapV.pop();
    let i = 0;
    for (;;){
      const l = 2*i + 1, r = l + 1;
      let m = i;
      if (l < heapP.length && heapP[l] < heapP[m]) m = l;
      if (r < heapP.length && heapP[r] < heapP[m]) m = r;
      if (m === i) break;
      [heapP[m], heapP[i]] = [heapP[i], heapP[m]];
      [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
      i = m;
    }
    return top;
  };

  push(0, idx(sx, sy));
  g[idx(sx, sy)] = 0;
  const h = (x, y) => Math.hypot(x - tx, y - ty);
  let visited = 0;

  while (heapP.length){
    const cur = pop();
    if (cur === idx(tx, ty)) break;
    if (++visited > budget) return null;
    const cx = cur % GRID, cy = (cur / GRID) | 0;
    for (let dy = -1; dy <= 1; dy++){
      for (let dx = -1; dx <= 1; dx++){
        if (!dx && !dy) continue;
        if (!diagonal && dx && dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!bitAt(cellBits, nx, ny)) continue;
        const n = idx(nx, ny);
        const step = g[cur] + (dx && dy ? Math.SQRT2 : 1);
        if (step < g[n]){
          g[n] = step; came[n] = cur;
          push(step + weight * h(nx, ny), n);
        }
      }
    }
  }
  const goal = idx(tx, ty);
  if (came[goal] === -1 && goal !== idx(sx, sy)) return null;
  const path = [];
  for (let i = goal; i !== -1; i = came[i]) path.push([i % GRID, (i / GRID) | 0]);
  return path.reverse();
}

// Is the destination in the same body of populated space as Sol? One lookup,
// so an impossible trip is answered before any search runs.
function inMainComponent(x, z){
  const [cx, cy] = cellOf(x, z);
  return !!bitAt(mainBits, cx, cy);
}

// ---- generated systems ------------------------------------------------------
// Most of the galaxy is not in the star catalogue. The game scatters stars
// through it from a density map, seeded per cell, so the same cell always holds
// the same stars. Nothing here is downloaded: it is regenerated on demand.

const GEN = {
  side: null,        // stars per side, 0..10, one byte per cell
  zones: null,       // RGB gate per cell, three bytes
  cache: new Map(),  // cell key -> generated stars, capped below
  CAP: 3000,
};

// The game's own PRNG: BitmapData.noise seeded per cell, walked as a stream.
class Rndm {
  constructor(seed){
    this.x = (seed <= 0 ? -seed + 1 : seed) >>> 0;
    this.p = 0;
    this.buf = [];
  }
  byte(){ this.x = (this.x * 16807) % 2147483647; return this.x % 256; }
  random(){
    this.p = (this.p + 1) % 200000;
    while (this.buf.length <= this.p){
      const r = this.byte(), g = this.byte(), b = this.byte(), a = this.byte();
      this.buf.push(((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
    }
    return (this.buf[this.p] * 0.999999999999998 + 1e-15) / 4294967295;
  }
  float(a, b){ return this.random() * (b - a) + a; }
  integer(a, b){ return Math.floor(this.float(a, b)); }
}

let starTotal = 0;
function starChanceTotal(){
  if (!starTotal) starTotal = D.starTable.reduce((s, t) => s + t[1], 0);
  return starTotal;
}

function starGetType(rng){
  const roll = rng.float(0, starChanceTotal());
  let low = 0, high = 0;
  for (const t of D.starTable){
    high += t[1];
    if (roll >= low && roll <= high) return t;
    low += t[1];
  }
  return D.starTable[D.starTable.length - 1];
}

// StarGroups.GetByZone: keep drawing until a type suits this part of the galaxy.
function starByZone(rng, r, g, b){
  for (;;){
    const t = starGetType(rng);
    const zone = t[2];
    if (zone === "NoZone") return t;
    const gate = zone === "Center" ? r : zone === "OuterArmSide" ? g
               : zone === "AnomalyZones" ? b : -1;
    if (rng.integer(0, 255) <= gate) return t;
    if (rng.integer(0, 255) < 25) return t;
  }
}

// ---- sector naming ----------------------------------------------------------
const ZONE_LEN = 10000, ZONE_ANGLE = Math.PI / 6;

function sectorId(cx, cy){
  let a = Math.PI - Math.atan2(-(1591 - cy), 1025 - cx);
  if (a < 0) a += Math.PI * 2;
  const zone = Math.trunc(a / ZONE_ANGLE);
  let r = Math.trunc(Math.hypot(1025 - cx, 1591 - cy));
  r = Math.trunc(r / (ZONE_LEN / CELL_LY));
  const i = zone * 8 + r;
  return i >= D.sectorAnchors.sectors.length ? 0 : i;
}

function sectorName(cx, cy){
  const i = sectorId(cx, cy);
  const dx = D.sectorAnchors.x[i] - cx, dy = D.sectorAnchors.y[i] - cy;
  const q = (dx < 0 && dy > 0) ? 4 : (dx > 0 && dy > 0) ? 1
          : (dx < 0 && dy < 0) ? 3 : (dx > 0 && dy < 0) ? 2 : 1;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const pair = n => String.fromCharCode((n / 26 | 0) + 65) + String.fromCharCode(n % 26 + 97);
  return {zone: D.sectorAnchors.sectors[i],
          sector: `${pair(ax)}-${pair(ay)} ${String.fromCharCode(q + 65)}`};
}

// A name carries its own coordinates, so finding a system is arithmetic rather
// than a search: decode the sector, the offsets and the quadrant.
function cellFromName(name){
  const m = /^(.+?)\s+([A-Z][a-z])-([A-Z][a-z])\s+([A-E])(\d+)$/.exec(name.trim());
  if (!m) return null;
  const [, zone, ax, ay, quad, n] = m;
  const i = D.sectorAnchors.sectors.findIndex(
    s => s.toLowerCase() === zone.toLowerCase());
  if (i < 0 || D.sectorAnchors.x[i] === -1) return null;
  const val = p => (p.charCodeAt(0) - 65) * 26 + (p.charCodeAt(1) - 97);
  // The quadrant letter says which side of its anchor the cell sits on:
  // B dx>0 dy>0, C dx>0 dy<0, D dx<0 dy<0, E dx<0 dy>0.
  const q = quad.charCodeAt(0) - 65;
  const sx = q >= 3 ? 1 : -1;
  const sy = (q === 2 || q === 3) ? 1 : -1;
  return {cx: D.sectorAnchors.x[i] + sx * val(ax),
          cy: D.sectorAnchors.y[i] + sy * val(ay),
          index: +n};
}

// ---- generating a cell ------------------------------------------------------
async function loadGenerationMaps(){
  if (GEN.side) return;
  const read = async (src, channels) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = GRID;
    const g = c.getContext("2d", {willReadFrequently: true});
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, GRID, GRID).data;
    const out = new Uint8Array(GRID * GRID * channels);
    for (let i = 0; i < GRID * GRID; i++)
      for (let ch = 0; ch < channels; ch++) out[i * channels + ch] = px[i * 4 + ch];
    return out;
  };
  const [side, zones] = await Promise.all(
    [read("data/side.webp", 1), read("data/zones.webp", 3)]);
  GEN.side = side;
  GEN.zones = zones;
}

// The stars inside one cell. Deterministic, so the cache is only about speed.
function cellStars(cx, cy){
  if (!GEN.side || cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return [];
  const key = cy * GRID + cx;
  const hit = GEN.cache.get(key);
  if (hit) return hit;

  const side = GEN.side[key];
  if (!side) return [];
  const rng = new Rndm(cx * 10000 + cy);                 // GetSectorId
  const r = GEN.zones[key * 3], g = GEN.zones[key * 3 + 1], b = GEN.zones[key * 3 + 2];
  const step = 1 / side;
  const real = catalogueInCell(cx, cy);
  const name = sectorName(cx, cy);

  let gx = cx + step / 2, gy = cy, out = [];
  for (let i = 0; i < side * side; i++){
    const x = gx + rng.float(0, step / 1.3);
    const y = gy + rng.float(0, step / 1.3);
    let clash = false;
    for (const [rx, ry] of real)
      if (step * step / 2 > (rx - x) ** 2 + (ry - y) ** 2){ clash = true; break; }
    if (!clash){
      const t = starByZone(rng, r, g, b);
      out.push({
        x: (x - 1025) * CELL_LY, z: (1591 - y) * CELL_LY,
        type: t[4], colour: t[3], fuel: !!t[5], raw: t[0],
        name: `${name.zone} ${name.sector}${i}`,
        seed: (((cx & 0xFFF) << 20) + ((cy & 0xFFF) << 8) + ((real.length + i) & 0xFF)) >>> 0,
      });
    }
    gx += step;
    if (gx > cx + 1){ gx = cx + step / 2; gy += step; }
  }
  if (GEN.cache.size > GEN.CAP) GEN.cache.clear();
  GEN.cache.set(key, out);
  return out;
}

// Catalogue stars occupy their cell, and generated ones are not placed on top.
let catalogueCells = null;
function catalogueInCell(cx, cy){
  if (!catalogueCells){
    catalogueCells = new Map();
    for (const s of S){
      const px = s[X] / CELL_LY + 1025, py = 1591 - s[Z] / CELL_LY;
      const k = (py | 0) * GRID + (px | 0);
      let bucket = catalogueCells.get(k);
      if (!bucket) catalogueCells.set(k, bucket = []);
      bucket.push([px, py]);
    }
  }
  return catalogueCells.get(cy * GRID + cx) || [];
}



// ---- a system's bodies ------------------------------------------------------
// StarSystemGenerator, as the game runs it. Every system that has no hand-built
// entry gets its planets and belts this way, catalogued or not, so this is what
// lets a generated system carry the same detail as a named one.
const SEGMENTS = 500, SEGMENT_LEN = 10;

function genGetRandomStar(rng, starType){
  const rows = D.gen.luminosity[starType] || [];
  const i = rng.integer(0, rows.length);
  return rows[i] !== undefined ? rows[i] : 1;
}

function genBodyType(rng){
  const table = D.gen.bodies;
  const total = table.reduce((s, b) => s + b[1], 0);
  const roll = rng.float(0, total);
  let low = 0, high = 0;
  for (const b of table){
    high += b[1];
    if (roll >= low && roll <= high) return b;
    low += b[1];
  }
  return table[table.length - 1];
}

function genStarPairs(rng, starType, includeSelf){
  const list = D.gen.binaries;
  const stars = includeSelf ? [starType] : [];
  let low = 0, total = 0;
  for (const [name, chance] of list){
    if (name === starType) low = total;
    total += chance;
  }
  while (rng.float(0, 100) < 100 / (Math.max(0.5, stars.length) * 6) && stars.length < 3){
    const roll = rng.integer(low, total);
    let acc = 0;
    for (const [name, chance] of list){
      acc += chance;
      if (roll < acc){ genGetRandomStar(rng, name); stars.push(name); low = acc; break; }
    }
  }
  return stars;
}

function genMaterials(rng){
  const all = D.gen.minerals;
  const pool = all.length - D.gen.uncommon;
  const idx = [...Array(pool).keys()];
  const picked = [];
  while (picked.length < 3) picked.push(all[idx.splice(rng.integer(0, idx.length), 1)[0]]);
  return picked;
}

// Cheap ore takes the larger share; the percentages follow from the prices.
function orePercents(triple){
  const costs = triple.map(t => t[1]);
  const hi = Math.max(...costs), lo = Math.min(...costs);
  const w = costs.map(c => hi - c + lo);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map(v => Math.floor(100 * v / sum));
}

function systemBodies(seed, starType){
  const rng = new Rndm(seed);
  rng.integer(0, 1);                      // MakePlanetsFromDB bails after two draws
  rng.float(0, Math.PI * 2);
  const lum = genGetRandomStar(rng, starType);
  return generateBodies(rng, starType, lum, 0, -1, {planets: [], belts: []});
}

function generateBodies(rng, starType, lum, group, budget, out){
  rng.float(0, Math.PI * 2);
  const stars = genStarPairs(rng, starType, true);
  for (const _ of stars) rng.integer(-2147483647, 2147483646);
  if (rng.integer(0, 100) < 10) return out;

  let count;
  if (budget === -1){ count = rng.integer(1, 15); budget = 15; }
  else count = rng.integer(1, budget);

  const L = lum * 3.846e26;
  const occupied = new Array(SEGMENTS), temps = new Array(SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++){
    const d = SEGMENT_LEN * (i + 1) * 299792000;
    temps[i] = Math.trunc((L * 0.7 / (16 * Math.PI * d * d * (5.67 / 1e8))) ** 0.25 + 40);
    occupied[i] = i < 3;
  }

  let belts = 0;
  for (let n = 0; n < count; n++){
    const body = genBodyType(rng);
    const minWidth = 100 / SEGMENT_LEN + 2;
    let width = Math.trunc(rng.integer(100, 3000) / SEGMENT_LEN), run = 0;
    const slots = [];
    for (let j = 4; j < SEGMENTS; j++)
      if (!occupied[j] && temps[j] > body[2] && temps[j] < body[3]) slots.push(j);
    if (!slots.length) continue;
    const pick = rng.integer(0, slots.length);
    const isBelt = body[0] === "Asteroids";
    if (isBelt){
      if (belts > 1 || group > 0) continue;
      while (run < width && pick + run < SEGMENTS && occupied[pick + run] === false) run++;
      run -= 8;
      if (run < minWidth) continue;
      belts++;
      while (run > 0){ run--; occupied[pick + run] = true; }
    }
    const slot = slots[pick];
    occupied[slot] = true;
    budget--;
    rng.float(0, Math.PI * 2);
    rng.integer(-2147483647, 2147483646);
    const orbit = slot * SEGMENT_LEN + 25;
    if (isBelt){
      const triple = genMaterials(rng);
      out.belts.push({orbit, ores: triple.map((t, i) =>
        ({name: t[0], pct: orePercents(triple)[i]}))});
    } else {
      out.planets.push({orbit, type: body[4], scan: body[5], landable: !!body[6]});
    }
  }

  if (group < 3){
    const companions = genStarPairs(rng, starType, false);
    if (companions.length){
      const l2 = genGetRandomStar(rng, companions[0]);
      generateBodies(rng, companions[0], l2, group + 1, budget, out);
    }
  }
  return out;
}


// Bodies are only produced when something asks for them, and remembered after.
const bodyCache = new Map();
function starBodies(star){
  let b = bodyCache.get(star.seed);
  if (!b){
    b = systemBodies(star.seed, star.raw);
    b.scan = b.planets.reduce((s, p) => s + p.scan, 0);
    b.landable = b.planets.filter(p => p.landable).length;
    // A screenful can be tens of thousands of systems, so the cache has to be
    // bigger than one screen or it thrashes and nothing is ever reused.
    if (bodyCache.size > 120000) bodyCache.clear();
    bodyCache.set(star.seed, b);
  }
  return b;
}

const D = window.__GG__;
const [NAME,X,Z,LY,TY,FUEL,SEC,PL,BE,LA,ST,EN,SCAN,AUTH,ORE,PTY,PUR,FAC,GATE,OP] =
  [...Array(20).keys()];
const S = D.systems, PAL = D.palette;
// Language. Names come from the game's own text, so the map speaks whatever the
// player's copy of the game speaks. A key missing in one language falls back to
// English rather than showing an identifier.
const LANG_NAME = {en:"English", ru:"\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
                   es:"Espa\u00f1ol", pt:"Portugu\u00eas", cn:"\u4e2d\u6587"};
const LANG_FLAG = {en:"\u{1F1EC}\u{1F1E7}", ru:"\u{1F1F7}\u{1F1FA}", es:"\u{1F1EA}\u{1F1F8}",
                   pt:"\u{1F1F5}\u{1F1F9}", cn:"\u{1F1E8}\u{1F1F3}"};
let lang = "en";
try { lang = localStorage.getItem("gg.lang") || "en"; } catch (_) {}
if (!D.langCodes.includes(lang)) lang = "en";
const t = key => (D.langs[lang] || {})[key] || D.langs.en[key] || key;
const ui = slot => (D.ui[lang] || D.ui.en)[slot] || D.ui.en[slot] || slot;
const fmt = (slot, vals) =>
  ui(slot).replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? "");
// Locale-aware digits: Russian groups with spaces, German with dots.
const num = n => Number(n).toLocaleString(lang === "cn" ? "zh" : lang);
// Russian needs three plural forms where English needs two; Intl knows which.
const plural = (family, n) => {
  const cat = new Intl.PluralRules(lang === "cn" ? "zh" : lang).select(n);
  return fmt(`${family}_${cat}`, {n: num(n)});
};
const named = (keys, fallback) => keys.map((k, i) => k ? t(k) : fallback[i]);

let TYPES = named(D.typeKeys, D.types);
let ORES = named(D.oreKeys, D.ores);
let PTYPES = named(D.ptypeKeys, D.ptypes);
let MODULES = named(D.moduleKeys, D.modules);
const SEC_SLOT = {H:"secHigh", M:"secMedium", L:"secLow", A:"secAnarchy", C:"secConflict"};
const byName = new Map(S.map(s => [s[NAME], s]));
const indexOfName = new Map(S.map((s, i) => [s[NAME], i]));
// Alias lookup for the hover panel: system index -> {kind: [names]}
const aliasBySystem = new Map();
for (const [label, si, kind] of D.aliases){
  let e = aliasBySystem.get(si);
  if (!e) aliasBySystem.set(si, e = {});
  (e[kind] || (e[kind] = [])).push(label);
}
const ALIAS_SLOT = {station: "stations", body: "bodies",
                    engineer: "engineer", landmark: "landmark"};
const aliasList = new Map();          // system index -> [[label, kind], ...]
for (const [label, si, kind] of D.aliases){
  let l = aliasList.get(si);
  if (!l) aliasList.set(si, l = []);
  l.push([label, kind]);
}

const cv = document.getElementById("sky"), ctx = cv.getContext("2d");
const tip = document.getElementById("tip");
let W = 0, H = 0, dpr = 1;
// view: world (ly) -> screen. scale = px per ly.
let cx = 0, cz = 0, scale = 4, scaleSet = false;
const HOME_LY = 150;                      // light years across the window at home zoom
const scaleFor = lyAcross => W / lyAcross;
const filters = new Set();
// Hand-placed discoveries stay hidden until asked for: named landmarks, warp
// gates and engineer postings are things the game means you to find.
let spoilers = false;
// Everything the sidebar can narrow by. Empty / null means "don't care".
const F = {sec:new Set(), purp:new Set(), fac:new Set(),
           ore:-1, ptype:-1, startype:-1, module:-1, fullOnly:false,
           lyMin:null, lyMax:null, scanMin:null, plMin:null,
           pctMin:null, laMin:null};

// Richest showing of ore `oi` in this system, or 0 if it has none.
function orePct(s, oi){
  const a = s[OP];
  for (let i = 0; i < a.length; i += 2) if (a[i] === oi) return a[i + 1];
  return 0;
}

function resize(){
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cv.style.width = W + "px"; cv.style.height = H + "px";
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!scaleSet){ scale = scaleFor(HOME_LY); scaleSet = true; }
  draw();
}
const sx = wx => (wx - cx) * scale + W / 2;
const sy = wz => (cz - wz) * scale + H / 2;
const wxOf = px => (px - W / 2) / scale + cx;
const wzOf = py => cz - (py - H / 2) / scale;

function passes(s){
  if (filters.has("fuel")    && !s[FUEL]) return false;
  if (filters.has("station") && !s[ST])   return false;
  if (filters.has("belt")    && !s[BE])   return false;
  if (filters.has("land")    && !s[LA])   return false;
  if (filters.has("eng")     && !s[EN])   return false;
  if (filters.has("gate")    && !s[GATE]) return false;
  if (filters.has("auth")    && !s[AUTH]) return false;
  if (F.sec.size  && !F.sec.has(s[SEC] || "-"))          return false;
  if (F.ore    >= 0 && !(s[ORE] >> F.ore    & 1))         return false;
  if (F.ptype  >= 0 && !(s[PTY] >> F.ptype  & 1))         return false;
  if (F.startype >= 0 && s[TY] !== F.startype)            return false;
  if (F.module >= 0){
    const stock = D.sysModules[s[NAME]];
    if (!stock) return false;
    const inFull = stock[0].includes(F.module);
    if (!(inFull || (!F.fullOnly && stock[1].includes(F.module)))) return false;
  }
  if (F.purp.size && ![...F.purp].some(i => s[PUR] >> i & 1)) return false;
  if (F.fac.size  && ![...F.fac ].some(i => s[FAC] >> i & 1)) return false;
  if (F.lyMin   != null && s[LY]   < F.lyMin)   return false;
  if (F.lyMax   != null && s[LY]   > F.lyMax)   return false;
  if (F.scanMin != null && s[SCAN] < F.scanMin) return false;
  if (F.plMin   != null && s[PL]   < F.plMin)   return false;
  if (F.ore >= 0 && F.pctMin != null && orePct(s, F.ore) < F.pctMin) return false;
  if (F.laMin   != null && s[LA]   < F.laMin)   return false;
  return true;
}

function anyFilter(){
  return filters.size || F.sec.size || F.purp.size || F.fac.size ||
         F.ore >= 0 || F.ptype >= 0 || F.startype >= 0 || F.module >= 0 ||
         [F.lyMin,F.lyMax,F.scanMin,F.plMin,F.pctMin,F.laMin].some(v => v != null);
}

function gridStep(){
  const target = 120 / scale;                 // aim for ~120px between lines
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (pow * m >= target) return pow * m;
  return pow * 10;
}

function drawGrid(){
  const step = gridStep();
  const x0 = Math.floor(wxOf(0) / step) * step, x1 = wxOf(W);
  const z1 = Math.floor(wzOf(H) / step) * step, z0 = wzOf(0);
  ctx.lineWidth = 1;
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.fillStyle = "#3f6a78";
  for (let x = x0; x <= x1; x += step){
    const p = Math.round(sx(x)) + .5;
    ctx.strokeStyle = x === 0 ? "rgba(30,147,166,.55)" : "rgba(23,113,128,.22)";
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
    ctx.fillText(String(Math.round(x)), p + 4, H - 8);
  }
  for (let z = z1; z <= z0; z += step){
    const p = Math.round(sy(z)) + .5;
    ctx.strokeStyle = z === 0 ? "rgba(30,147,166,.55)" : "rgba(23,113,128,.22)";
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
    ctx.fillText(String(Math.round(z)), 236, p - 5);
  }
}

function hex(px, py, r, colour){
  ctx.beginPath();
  for (let i = 0; i < 6; i++){
    const a = Math.PI / 6 + i * Math.PI / 3;
    const qx = px + r * Math.cos(a), qy = py + r * Math.sin(a);
    i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy);
  }
  ctx.closePath();
  ctx.strokeStyle = colour; ctx.lineWidth = 1.4; ctx.stroke();
}

let visible = [], focused = null, focusStart = 0, focusRAF = 0;
let genVisible = [];              // generated stars currently on screen
const GEN_SCALE = 0.6;            // px per ly at which generated stars appear
const FLASH_MS = 1500, FLASHES = 3;
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
function draw(){
  ctx.fillStyle = "#04060e"; ctx.fillRect(0, 0, W, H);
  drawGrid();

  // warp gates first, so markers sit on top
  ctx.strokeStyle = "rgba(255,171,61,.7)"; ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 5]);
  for (const [a, b] of (spoilers ? D.gates : [])){
    const A = byName.get(a), B = byName.get(b);
    if (!A || !B) continue;
    ctx.beginPath(); ctx.moveTo(sx(A[X]), sy(A[Z])); ctx.lineTo(sx(B[X]), sy(B[Z])); ctx.stroke();
  }
  ctx.setLineDash([]);

  visible = [];
  const pad = 40, labels = [];
  for (const s of S){
    const px = sx(s[X]), py = sy(s[Z]);
    if (px < -pad || px > W + pad || py < -pad || py > H + pad) continue;
    const ok = passes(s);
    visible.push(s);
    const col = PAL[s[TY]];
    if (!ok){
      ctx.fillStyle = "rgba(95,127,142,.18)";
      ctx.beginPath(); ctx.arc(px, py, 1.4, 0, 6.283); ctx.fill();
      continue;
    }
    const r = 1.6 + Math.min(s[PL], 8) * .22;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
    const flagEng = s[EN] && spoilers;
    if (s[ST] || flagEng) hex(px, py, 7, flagEng ? "#ffab3d" : "rgba(53,224,245,.85)");
    if (F.ore >= 0){
      const pct = orePct(s, F.ore);
      if (pct) labels.push([px, py, pct + "%", s[NAME]]);
    } else if (scale > 2.2 && (s[ST] || s[EN] || s[LY] === 0)){
      labels.push([px, py, null, s[NAME]]);
    }
  }
  // The percentage leads in amber, the system name follows in the usual ink.
  ctx.font = '11px "JetBrains Mono", monospace';
  for (const [px, py, pct, name] of labels){
    let x = px + 10;
    if (pct){
      ctx.fillStyle = "#ffab3d";
      ctx.fillText(pct, x, py + 4);
      x += ctx.measureText(pct + " ").width;
    }
    ctx.fillStyle = "rgba(188,219,230,.78)";
    ctx.fillText(name, x, py + 4);
  }

  // named landmarks
  ctx.fillStyle = "rgba(255,171,61,.85)";
  ctx.font = '600 11px "Oxanium", sans-serif';
  for (const [n, mx, my, desc] of (spoilers ? D.points : [])){
    const px = sx(mx), py = sy(my);
    if (px < 0 || px > W || py < 0 || py > H) continue;
    ctx.beginPath(); ctx.arc(px, py, 3, 0, 6.283); ctx.stroke();
    ctx.fillText(desc.toUpperCase(), px + 8, py - 6);
  }

  drawGenerated();
  drawRoute();

  if (focused){
    // Three pulses over 1.5s, then it stops drawing itself. The map already
    // labels the system, so the ring carries no text.
    const t = (performance.now() - focusStart) / FLASH_MS;
    const a = calm ? 1 - t : Math.abs(Math.sin(t * Math.PI * FLASHES));
    const px = sx(focused[X]), py = sy(focused[Z]);
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.strokeStyle = "#35e0f5"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(px, py, 14, 0, 6.283); ctx.stroke();
    ctx.globalAlpha = Math.max(0, a) * .4;
    ctx.beginPath(); ctx.arc(px, py, 22 + (1 - a) * 6, 0, 6.283); ctx.stroke();
    ctx.restore();
  }

  document.getElementById("scl").textContent = num(Math.round(W / scale));
  document.getElementById("shown").textContent =
    num(visible.filter(passes).length) + " " + ui("of") + " " + num(S.length);
}

function pickGenerated(mx, my){
  let best = null, bd = 12 * 12;
  for (const st of genVisible){
    const dx = sx(st.x) - mx, dy = sy(st.z) - my, d = dx*dx + dy*dy;
    if (d < bd){ bd = d; best = st; }
  }
  return best;
}

function showGenTip(st, mx, my){
  const b = starBodies(st);
  const ore = b.belts.flatMap(belt =>
    belt.ores.map(o => `${t("Goods" + o.name) || o.name} ${o.pct}%`));
  tip.innerHTML = `<h3>${st.name}${coords(st.x, st.z)}</h3><dl>` +
    row("starType", st.type) +
    row("security", ui("secAnarchy")) +
    (st.fuel ? row("fuel", "\u2713") : "") +
    row("distance", `${num(Math.round(Math.hypot(st.x, st.z)))} ly`) +
    (b.planets.length
      ? row("planets", b.planets.length + (b.landable ? ` (${b.landable})` : "")) : "") +
    (b.belts.length ? row("belts", b.belts.length) : "") +
    (b.scan ? row("fullScan", `${num(b.scan)} CR`) : "") +
    `</dl>` + (ore.length ? `<div class="ore">${ore.join(" &middot; ")}</div>` : "");
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(mx + 16, window.innerWidth - r.width - 10) + "px";
  tip.style.top  = Math.min(my + 16, window.innerHeight - r.height - 10) + "px";
}

function pick(mx, my){
  let best = null, bd = 14 * 14;
  for (const s of visible){
    if (!passes(s)) continue;
    const dx = sx(s[X]) - mx, dy = sy(s[Z]) - my, d = dx * dx + dy * dy;
    if (d < bd){ bd = d; best = s; }
  }
  return best;
}

// Which factions hold stations here, in the game's own words.
function factionsOf(s){
  const out = [];
  D.factionKeys.forEach((key, i) => { if (s[FAC] >> i & 1) out.push(t(key)); });
  return out.join(", ");
}

const row = (slot, value) => `<dt>${ui(slot)}</dt><dd>${value}</dd>`;
// The map's own coordinates, which is how the game labels its grid.
const coords = (x, z) =>
  `<span class="coords">${num(Math.round(x))}, ${num(Math.round(z))}</span>`;

function showTip(s, mx, my){
  const ore = D.oreDetail[s[NAME]];
  const alias = aliasBySystem.get(indexOfName.get(s[NAME])) || {};
  const aliasRows = ["station", "body", "engineer", "landmark"]
    .filter(k => alias[k] && !(SPOILER_ALIAS.has(k) && !spoilers))
    .map(k => `<dt>${ui(ALIAS_SLOT[k])}</dt><dd>${alias[k].slice(0, 6).join(", ")}` +
              `${alias[k].length > 6 ? ` +${alias[k].length - 6}` : ""}</dd>`)
    .join("");
  // A row is only worth its line when it says something. Nothing the system
  // does not have is listed.
  tip.innerHTML =
    `<h3>${s[NAME]}${coords(s[X], s[Z])}</h3><dl>` +
    row("starType", TYPES[s[TY]]) +
    row("security", ui(SEC_SLOT[s[SEC]] || "secAnarchy")) +
    (s[FUEL] ? row("fuel", "\u2713") : "") +
    row("distance", `${num(s[LY])} ly`) +
    (s[PL] ? row("planets", s[PL] + (s[LA] ? ` (${s[LA]})` : "")) : "") +
    (s[BE] ? row("belts", s[BE]) : "") +
    (s[ST] ? row("stations", s[ST]) : "") +
    (factionsOf(s) ? row("faction", factionsOf(s)) : "") +
    (s[SCAN] ? row("fullScan", `${num(s[SCAN])} CR`) : "") +
    (aliasRows ? `<dt class="rule"></dt><dd class="rule"></dd>` + aliasRows : "") +
    `</dl>` +
    (ore ? `<div class="ore">${ore.join(" &middot; ")}</div>` : "");
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(mx + 16, window.innerWidth - r.width - 10) + "px";
  tip.style.top  = Math.min(my + 16, window.innerHeight - r.height - 10) + "px";
}

let drag = null;
cv.addEventListener("pointerdown", e => {
  drag = {x: e.clientX, y: e.clientY, cx, cz, moved: false};
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener("pointermove", e => {
  if (drag){
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    cx = drag.cx - dx / scale; cz = drag.cz + dy / scale;
    tip.style.display = "none";
    draw();
    return;
  }
  document.getElementById("cur").textContent =
    num(Math.round(wxOf(e.clientX))) + ", " + num(Math.round(wzOf(e.clientY)));
  const s = pick(e.clientX, e.clientY);
  if (s){ showTip(s, e.clientX, e.clientY); return; }
  const gen = pickGenerated(e.clientX, e.clientY);
  gen ? showGenTip(gen, e.clientX, e.clientY) : (tip.style.display = "none");
});
// A single click fills whichever end is next; a double click always sets the
// origin, so the single action is held briefly to see if a second arrives.
let clickTimer = 0;
addEventListener("pointerup", e => {
  const wasDrag = drag && drag.moved;
  drag = null;
  if (wasDrag || e.target !== cv) return;
  const target = pick(e.clientX, e.clientY) || pickGenerated(e.clientX, e.clientY);
  if (!target) return;
  if (clickTimer){
    // Double click restarts the journey: new origin, no destination, no route.
    clearTimeout(clickTimer); clickTimer = 0;
    routeTo = null;
    document.getElementById("to").value = "";
    setEnd("from", target);
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = 0;
    setEnd(routeFrom == null ? "from" : "to", target);
  }, 220);
});
cv.addEventListener("dblclick", e => e.preventDefault());
cv.addEventListener("pointerleave", () => { tip.style.display = "none"; });

cv.addEventListener("wheel", e => {
  e.preventDefault();
  const wx = wxOf(e.clientX), wz = wzOf(e.clientY);
  scale *= Math.exp(-e.deltaY * .0016);
  scale = Math.max(.0012, Math.min(scale, 40));
  cx = wx - (e.clientX - W / 2) / scale;
  cz = wz + (e.clientY - H / 2) / scale;
  tip.style.display = "none";
  draw();
}, {passive: false});

function goto(x, z, sc){ cx = x; cz = z; scale = sc; draw(); }

// Land close enough that the system is unmistakable, then flash the ring out.
function focusOn(s){
  focused = s;
  focusStart = performance.now();
  goto(s[X], s[Z], 14);
  cancelAnimationFrame(focusRAF);
  const step = () => {
    if (!focused) return;
    if (performance.now() - focusStart >= FLASH_MS){ focused = null; draw(); return; }
    draw();
    focusRAF = requestAnimationFrame(step);
  };
  focusRAF = requestAnimationFrame(step);
}
document.getElementById("zin").onclick    = () => { scale = Math.min(scale * 1.6, 40); draw(); };
document.getElementById("zout").onclick   = () => { scale = Math.max(scale / 1.6, .0012); draw(); };
const clearFocus = () => { focused = null; cancelAnimationFrame(focusRAF); };
document.getElementById("zreset").onclick = () => { clearFocus(); goto(0, 0, scaleFor(HOME_LY)); };
document.getElementById("toSol").onclick  = () => { clearFocus(); goto(0, 0, scaleFor(HOME_LY)); };
// Centre of the deep-space cluster: 21 systems and 35 stations inside about 60 ly.
document.getElementById("toVoid").onclick = () => {
  clearFocus(); goto(-2232, -3987, scaleFor(HOME_LY));
};
document.getElementById("toAll").onclick  = () => { clearFocus(); goto(-8000, 6000, .0022); };

for (const b of document.querySelectorAll(".chip[data-f]")){
  b.onclick = () => {
    const f = b.dataset.f, on = b.getAttribute("aria-pressed") === "true";
    b.setAttribute("aria-pressed", String(!on));
    on ? filters.delete(f) : filters.add(f);
    draw();
  };
}

function fill(sel, items, labelOf){
  const el = document.getElementById(sel);
  items.forEach((v, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = labelOf ? labelOf(v) : v;
    el.append(o);
  });
  el.onchange = () => { F[sel === "startype" ? "startype" : sel] =
    el.value === "" ? -1 : +el.value; draw(); };
}
fill("ore", ORES);
fill("ptype", PTYPES);

// Star class only earns a filter because StarHunter expeditions name one, so the
// list is those classes, rarest first, with how many the expedition asks for.
{
  const el = document.getElementById("startype");
  let impossible = 0;
  for (const [label, need, have, ti] of D.hunt){
    const o = document.createElement("option");
    o.value = ti;
    o.textContent = `${label} — ${have} ${ui("hSystems").toLowerCase()}` +
                    (need > 1 ? ` (${need})` : "");
    if (have === 0 || have < need){ o.textContent += "  \u26a0"; impossible++; }
    if (ti < 0) o.disabled = true;
    el.append(o);
  }
  el.onchange = () => { F.startype = el.value === "" ? -1 : +el.value; draw(); };
  document.getElementById("huntNote").innerHTML =
    ui("huntNote") + ` <b>\u26a0 ` +
    fmt("huntWarn", {n: impossible, total: D.hunt.length}) + `</b>`;
}

// Multi-select pill groups. `bucket` is the Set the group writes into;
// `keyOf` maps a button to whatever passes() looks for.
// A single hover panel serves every control that names a data-help key.
const helpBox = document.getElementById("help");
// A help value is either literal data or {k: slot} pointing at a translated string.
const say = v => {
  if (!v || typeof v !== "object") return v;
  if (v.k) return ui(v.k);                                   // this tool's own words
  if (v.g) return t(v.g);                                    // the game's own words
  if (v.mods) return v.mods.map(t).join(", ") || "\u2014";   // module lists translate too
  return v;
};

function showHelp(key, el){
  const h = D.help[key];
  if (!h) return;
  helpBox.innerHTML = `<h4>${say(h.title)}</h4><dl>` +
    h.rows.map(([k, v]) => `<dt>${say(k)}</dt><dd>${say(v)}</dd>`).join("") + "</dl>";
  helpBox.style.display = "block";
  const r = el.getBoundingClientRect(), b = helpBox.getBoundingClientRect();
  helpBox.style.left = Math.min(r.right + 10, window.innerWidth - b.width - 10) + "px";
  helpBox.style.top = Math.max(8, Math.min(r.top, window.innerHeight - b.height - 10)) + "px";
}
function bindHelp(el, key){
  el.dataset.help = key;
  el.addEventListener("pointerenter", () => showHelp(key, el));
  el.addEventListener("pointerleave", () => { helpBox.style.display = "none"; });
  el.addEventListener("focus", () => showHelp(key, el));
  el.addEventListener("blur", () => { helpBox.style.display = "none"; });
}
for (const el of document.querySelectorAll("[data-help]")) bindHelp(el, el.dataset.help);

function pillGroup(hostId, items, bucket, perRow, keyOf = i => i, helpOf = null){
  const box = document.getElementById(hostId);
  let row = null;
  items.forEach((label, i) => {
    if (!row || row.children.length === perRow){
      row = document.createElement("div"); row.className = "row"; box.append(row);
    }
    const b = document.createElement("button");
    b.className = "pill"; b.type = "button"; b.textContent = label;
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => {
      const on = b.getAttribute("aria-pressed") === "true";
      b.setAttribute("aria-pressed", String(!on));
      on ? bucket.delete(keyOf(i)) : bucket.add(keyOf(i));
      draw();
    };
    if (helpOf) bindHelp(b, helpOf(i));
    row.append(b);
  });
}

const SECS = [["H","secHigh"],["M","secMedium"],["L","secLow"],
              ["A","secAnarchy"],["C","secConflict"]];
pillGroup("secRow", SECS.map(x => ui(x[1])), F.sec, 3, i => SECS[i][0],
          i => "sec:" + SECS[i][0]);
pillGroup("purpRow", D.purposeSlots.map(ui), F.purp, 2, i => i,
          i => "purp:" + D.purposes[i]);
pillGroup("facRow", D.factionKeys.map(t), F.fac, 2, i => i,
          i => "fac:" + D.factions[i]);

// The two dropdowns explain the option you land on, under the control.
function bindSelectHelp(id, prefix, names){
  const el = document.getElementById(id);
  const note = document.createElement("p");
  note.className = "note"; el.after(note);
  const update = () => {
    const h = el.value === "" ? null : D.help[prefix + names[+el.value]];
    note.innerHTML = h ? h.rows.map(([k, v]) => `${say(k)}: ${say(v)}`).join("<br>") : "";
  };
  el.addEventListener("change", update);
  update();
}
bindSelectHelp("ore", "ore:", D.oreRaw);
{
  // Selecting an ore arms the min-% box at the poorest value in the galaxy,
  // so it starts showing everything and only ever narrows.
  const sel = document.getElementById("ore"), box = document.getElementById("pctMin");
  sel.addEventListener("change", () => {
    if (sel.value === ""){
      box.disabled = true; box.value = ""; box.placeholder = "pick an ore";
      F.pctMin = null;
    } else {
      const lo = D.oreMin[+sel.value];
      box.disabled = false; box.value = lo; box.placeholder = String(lo);
      F.pctMin = lo;
    }
    draw();
  });
}
bindSelectHelp("ptype", "pt:", D.ptypeRaw);

// Module availability. Full grade means the shop sells every class; the rest is
// capped below class 4, which is why some stations stop at grade 3.
{
  const sel = document.getElementById("module");
  MODULES.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = m;
    sel.append(o);
  });
  const note = document.getElementById("moduleNote");
  const fullBtn = document.getElementById("fullOnly");
  const update = () => {
    if (F.module < 0){ note.textContent = ""; draw(); return; }
    let full = 0, capped = 0;
    for (const st of Object.values(D.sysModules)){
      if (st[0].includes(F.module)) full++;
      else if (st[1].includes(F.module)) capped++;
    }
    note.innerHTML = `${ui("hFullGrade")}: ${full}` +
                     (capped ? ` · ${ui("hCapped")}: ${capped}` : "");
    draw();
  };
  sel.onchange = () => { F.module = sel.value === "" ? -1 : +sel.value; update(); };
  fullBtn.onclick = () => {
    F.fullOnly = fullBtn.getAttribute("aria-pressed") !== "true";
    fullBtn.setAttribute("aria-pressed", String(F.fullOnly));
    draw();
  };
}

for (const id of ["lyMin","lyMax","scanMin","plMin","pctMin","laMin"]){
  document.getElementById(id).oninput = e => {
    F[id] = e.target.value === "" ? null : +e.target.value;
    draw();
  };
}

document.getElementById("reset").onclick = () => {
  filters.clear();
  F.sec.clear(); F.purp.clear(); F.fac.clear();
  F.ore = F.ptype = F.startype = F.module = -1;
  F.fullOnly = false;
  for (const k of ["lyMin","lyMax","scanMin","plMin","pctMin","laMin"]){
    F[k] = null; document.getElementById(k).value = "";
  }
  for (const el of document.querySelectorAll('[aria-pressed="true"]'))
    el.setAttribute("aria-pressed", "false");
  for (const el of document.querySelectorAll("#ore,#ptype,#startype,#module")) el.value = "";
  draw();
};

// Both route boxes share one autocomplete. A system matches on its own name or
// on any alias — a body, a station, its catalogue designation. Aliases show
// indented under the system they belong to, and selecting either picks the system.
const SPOILER_ALIAS = new Set(["engineer", "landmark"]);

function bindSearch(id){
  const input = document.getElementById(id);
  const list = document.querySelector(`.hits[data-for="${id}"]`);
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = "";
    if (q.length < 2) return;

    // A system matches on its own name — and then shows everything it contains.
    // An alias match pulls in its system too, listed with the alias that matched.
    const groups = new Map();
    const add = (si, entry) => {
      let list = groups.get(si);
      if (!list) groups.set(si, list = []);
      if (entry && !list.some(e => e[0] === entry[0])) list.push(entry);
    };
    for (let i = 0; i < S.length && groups.size < 10; i++)
      if (S[i][NAME].toLowerCase().includes(q)){
        add(i, null);
        for (const [label, kind] of (aliasList.get(i) || [])){
          if (SPOILER_ALIAS.has(kind) && !spoilers) continue;
          add(i, [label, kind]);
        }
      }
    for (const [label, si, kind] of D.aliases){
      if (groups.size >= 10 && !groups.has(si)) continue;
      if (SPOILER_ALIAS.has(kind) && !spoilers) continue;
      if (!label.toLowerCase().includes(q)) continue;
      add(si, [label, kind]);
    }

    // A generated name is self-describing, so resolve it directly instead of
    // searching two and a half million of them.
    const decoded = cellFromName(q);
    if (decoded){
      const star = (cellStars(decoded.cx, decoded.cy) || [])
        .find(st => st.name.toLowerCase() === q);
      if (star){
        const li = document.createElement("li");
        li.innerHTML = `${star.name}<span class="ly">${num(Math.round(
          Math.hypot(star.x, star.z)))} ly</span>`;
        li.onclick = () => {
          list.innerHTML = "";
          clearFocus();
          goto(star.x, star.z, Math.max(scale, 6));
          setEnd(id, star);
        };
        list.append(li);
      }
    }

    for (const [si, hits] of groups){
      const head = document.createElement("li");
      head.innerHTML = `${S[si][NAME]}<span class="ly">${num(S[si][LY])} ly</span>`;
      head.onclick = () => { list.innerHTML = ""; setEnd(id, S[si]); focusOn(S[si]); };
      list.append(head);
      for (const [label, kind] of hits.slice(0, 8)){
        const sub = document.createElement("li");
        sub.className = "sub";
        sub.innerHTML = `<b>${label}</b><em>${kind}</em>`;
        sub.onclick = head.onclick;
        list.append(sub);
      }
    }
  });
}
bindSearch("from");
bindSearch("to");

addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "+" || e.key === "=") document.getElementById("zin").click();
  if (e.key === "-") document.getElementById("zout").click();
  if (e.key === "0") document.getElementById("zreset").click();
});

const counts = {catalogue:0, fuel:0, station:0, belt:0, land:0, eng:0, gate:0, auth:0};
counts.catalogue = S.length;
for (const s of S){
  if (s[FUEL]) counts.fuel++;
  if (s[ST]) counts.station++;
  if (s[BE]) counts.belt++;
  if (s[LA]) counts.land++;
  if (s[EN]) counts.eng++;
  if (s[GATE]) counts.gate++;
  if (s[AUTH]) counts.auth++;
}
for (const [k, v] of Object.entries(counts))
  document.querySelector(`[data-n="${k}"]`).textContent = v.toLocaleString();
document.getElementById("count").textContent = S.length.toLocaleString() + " reachable systems";

addEventListener("resize", resize);


// Generated stars are produced from their cell's seed as the view needs them.
// Below GEN_SCALE a cell is a few pixels wide and drawing 100 stars into it is
// noise, so the catalogue alone is shown.
let genLoading = false;
function drawGenerated(){
  genVisible = [];
  // Generated systems can never host a mission, a station or an engineer, so
  // that filter simply hides them.
  if (scale < GEN_SCALE || filters.has("catalogue")) return;
  if (!GEN.side){
    // The two generation maps are about 1 MB and only matter once you are
    // zoomed in far enough to see individual stars, so they load on demand.
    if (!genLoading){
      genLoading = true;
      loadGenerationMaps().then(draw).catch(() => {}).finally(() => { genLoading = false; });
    }
    return;
  }
  const pad = 40;
  const x0 = Math.floor((wxOf(-pad) / CELL_LY) + 1025);
  const x1 = Math.ceil((wxOf(W + pad) / CELL_LY) + 1025);
  const y0 = Math.floor(1591 - (wzOf(-pad) / CELL_LY));
  const y1 = Math.ceil(1591 - (wzOf(H + pad) / CELL_LY));
  const deep = needsBodies();
  if ((x1 - x0) * (y1 - y0) > 1600) return;
  // Answering a planet-level filter costs about 50us per system, which is more
  // than a frame's worth over a wide view. So the work is time-boxed and the
  // rest is picked up on the next frame, filling in rather than blanking out.
  const deadline = deep ? performance.now() + 90 : Infinity;
  let ranOut = false;

  for (let cy = y0; cy <= y1 && !ranOut; cy++){
    for (let cx = x0; cx <= x1; cx++){
      if (deep && performance.now() > deadline){ ranOut = true; break; }
      for (const st of cellStars(cx, cy)){
        const px = sx(st.x), py = sy(st.z);
        if (px < -pad || px > W + pad || py < -pad || py > H + pad) continue;
        if (!passesGenerated(st, deep)) continue;
        genVisible.push(st);
        ctx.fillStyle = st.colour;
        ctx.beginPath(); ctx.arc(px, py, 2.0, 0, 6.283); ctx.fill();
      }
    }
  }
  // With an ore selected the percentage leads, exactly as it does for the
  // catalogued systems, so the two read the same way.
  if (F.ore >= 0){
    ctx.font = '10px "JetBrains Mono", monospace';
    for (const st of genVisible){
      const pct = generatedOrePct(st, F.ore);
      if (!pct) continue;
      const px = sx(st.x) + 8, py = sy(st.z) + 3;
      ctx.fillStyle = "#ffab3d";
      ctx.fillText(pct + "%", px, py);
      ctx.fillStyle = "rgba(150,180,195,.6)";
      ctx.fillText(st.name, px + ctx.measureText(pct + "%  ").width, py);
    }
  } else if (scale > 4){
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(150,180,195,.55)";
    for (const st of genVisible) ctx.fillText(st.name, sx(st.x) + 8, sy(st.z) + 3);
  }
  if (ranOut) requestAnimationFrame(draw);
}

// The richest showing of an ore in a generated system, 0 when it has none.
function generatedOrePct(st, oreIndex){
  const want = D.oreRaw[oreIndex];
  let best = 0;
  for (const belt of starBodies(st).belts)
    for (const o of belt.ores) if (o.name === want && o.pct > best) best = o.pct;
  return best;
}


// Which filters a generated system can be judged on at all. It never has a
// station, an engineer, a gate or a hand-built body, so those simply exclude it.
const IMPOSSIBLE = ["catalogue", "station", "eng", "gate", "auth"];

function needsBodies(){
  return F.ore >= 0 || F.ptype >= 0 || F.scanMin != null || F.plMin != null ||
         F.laMin != null || filters.has("belt") || filters.has("land");
}

function passesGenerated(st, deep){
  for (const f of IMPOSSIBLE) if (filters.has(f)) return false;
  if (F.purp.size || F.fac.size || F.module >= 0) return false;
  if (filters.has("fuel") && !st.fuel) return false;
  if (F.startype >= 0 && TYPES[F.startype] !== st.type) return false;
  if (F.sec.size && !F.sec.has("A")) return false;          // generated space is Anarchy
  const ly = Math.hypot(st.x, st.z);
  if (F.lyMin != null && ly < F.lyMin) return false;
  if (F.lyMax != null && ly > F.lyMax) return false;
  if (!deep) return true;

  const b = starBodies(st);
  if (filters.has("belt") && !b.belts.length) return false;
  if (filters.has("land") && !b.landable) return false;
  if (F.plMin != null && b.planets.length < F.plMin) return false;
  if (F.laMin != null && b.landable < F.laMin) return false;
  if (F.scanMin != null && b.scan < F.scanMin) return false;
  if (F.ptype >= 0 && !b.planets.some(p => p.type === PTYPES[F.ptype])) return false;
  if (F.ore >= 0){
    const best = generatedOrePct(st, F.ore);
    if (!best) return false;
    if (F.pctMin != null && best < F.pctMin) return false;
  }
  return true;
}

// ---- routing ---------------------------------------------------------------
// A route is a sequence of systems, and a system is a system: whether it came
// from the star catalogue or from the galaxy's generator makes no difference to
// how you fly between them.
//
// Two tiers, because the galaxy holds millions of systems and a cross-galaxy
// trip is thousands of jumps:
//
//   coarse  A* over populated cells (43.74 ly each) to find the corridor
//   fine    generate the systems inside that corridor and route through them
//
// A short trip skips the coarse tier: the corridor is just the cells around the
// two ends.

let jumpLy = +(localStorage.getItem("gg.jump") || 10);
let routeFrom = null, routeTo = null;      // {name, x, z}
let routePath = null, routeGates = null, routePartial = false;
let routeBusy = false;

const MAX_CORRIDOR_CELLS = 8000;           // beyond this the fine tier is refused
const CORRIDOR_PAD = 0;                    // the jump range already widens it

function endpointOf(source){
  return Array.isArray(source)
    ? {name: source[NAME], x: source[X], z: source[Z], row: source}
    : {name: source.name, x: source.x, z: source.z};
}

// ---- the corridor ----------------------------------------------------------
function corridorCells(from, to, range){
  const a = cellOf(from.x, from.z), b = cellOf(to.x, to.z);
  const reach = Math.max(1, Math.ceil(range / CELL_LY)) + CORRIDOR_PAD;
  const cells = new Set();
  const add = (cx, cy) => {
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++)
        if (bitAt(cellBits, cx + dx, cy + dy)) cells.add((cy + dy) * GRID + cx + dx);
  };
  // Near neighbours need no coarse search; the box around both ends is enough.
  if (Math.abs(a[0] - b[0]) <= reach * 2 && Math.abs(a[1] - b[1]) <= reach * 2){
    for (let cy = Math.min(a[1], b[1]) - reach; cy <= Math.max(a[1], b[1]) + reach; cy++)
      for (let cx = Math.min(a[0], b[0]) - reach; cx <= Math.max(a[0], b[0]) + reach; cx++)
        if (bitAt(cellBits, cx, cy)) cells.add(cy * GRID + cx);
    return {cells, coarse: null};
  }
  const coarse = gridRoute(a, b, range);
  if (!coarse) return {cells: null, coarse: null};
  for (const [cx, cy] of coarse) add(cx, cy);
  add(a[0], a[1]); add(b[0], b[1]);
  return {cells, coarse};
}

// Every system inside the corridor, catalogued and generated alike.
let nodeByName = new Map();
function corridorSystems(cells){
  const nodes = [];
  const byCell = new Map();
  nodeByName = new Map();
  for (const key of cells){
    const cx = key % GRID, cy = (key / GRID) | 0;
    const bucket = [];
    for (const s of catalogueByCell(cx, cy)) bucket.push(nodes.push(
      {name: s[NAME], x: s[X], z: s[Z], row: s}) - 1);
    for (const st of cellStars(cx, cy)) bucket.push(nodes.push(
      {name: st.name, x: st.x, z: st.z, gen: st}) - 1);
    byCell.set(key, bucket);
  }
  nodes.forEach((nd, i) => nodeByName.set(nd.name, i));
  return {nodes, byCell};
}

let catalogueCellIndex = null;
function catalogueByCell(cx, cy){
  if (!catalogueCellIndex){
    catalogueCellIndex = new Map();
    for (const s of S){
      const [x, y] = cellOf(s[X], s[Z]);
      const k = y * GRID + x;
      let b = catalogueCellIndex.get(k);
      if (!b) catalogueCellIndex.set(k, b = []);
      b.push(s);
    }
  }
  return catalogueCellIndex.get(cy * GRID + cx) || [];
}

// ---- the search ------------------------------------------------------------
// Fewest jumps first, shortest distance among equals. A layered walk gives both
// without a priority queue, because every edge costs exactly one jump.
function searchSystems(nodes, byCell, startIdx, goalIdx, range){
  const n = nodes.length;
  const jumps = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const gate = new Uint8Array(n);
  const done = new Uint8Array(n);
  const reach = Math.max(1, Math.ceil(range / CELL_LY));
  const r2 = range * range;
  const goal = nodes[goalIdx];

  // Every edge costs one jump, so the fewest jumps that can still remain is the
  // straight-line distance over the jump range. That heuristic is admissible,
  // which keeps the answer optimal while steering the search down the corridor
  // instead of expanding every system in it.
  // A slight inflation breaks the ties that otherwise spread the frontier across
  // the whole corridor. The path stays within a jump or two of optimal.
  const W = 1.2;
  const heur = i => W * Math.hypot(nodes[i].x - goal.x, nodes[i].z - goal.z) / range;

  const heapF = [], heapV = [];
  const push = (f, v) => {
    heapF.push(f); heapV.push(v);
    let i = heapF.length - 1;
    while (i > 0){
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapV[p], heapV[i]] = [heapV[i], heapV[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heapV[0], last = heapF.length - 1;
    heapF[0] = heapF[last]; heapV[0] = heapV[last];
    heapF.pop(); heapV.pop();
    let i = 0;
    for (;;){
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heapF.length && heapF[l] < heapF[m]) m = l;
      if (r < heapF.length && heapF[r] < heapF[m]) m = r;
      if (m === i) break;
      [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
      [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
      i = m;
    }
    return top;
  };

  jumps[startIdx] = 0; dist[startIdx] = 0;
  push(heur(startIdx), startIdx);
  let reached = false;
  while (heapF.length){
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goalIdx){ reached = true; break; }
    const node = nodes[i];
    const [cx, cy] = cellOf(node.x, node.z);
    for (let dy = -reach; dy <= reach; dy++){
      for (let dx = -reach; dx <= reach; dx++){
        const bucket = byCell.get((cy + dy) * GRID + cx + dx);
        if (!bucket) continue;
        for (const j of bucket){
          if (j === i || done[j]) continue;
          const ddx = nodes[j].x - node.x, ddz = nodes[j].z - node.z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > r2) continue;
          const nj = jumps[i] + 1, nd = dist[i] + Math.sqrt(d2);
          if (jumps[j] === -1 || nj < jumps[j] || (nj === jumps[j] && nd < dist[j])){
            jumps[j] = nj; dist[j] = nd; prev[j] = i; gate[j] = 0;
            push(nj + heur(j), j);
          }
        }
      }
    }
    for (const name of (gateLinks.get(node.name) || [])){
      const j = nodeByName.get(name);
      if (j === undefined || done[j]) continue;
      const nj = jumps[i] + 1;
      if (jumps[j] === -1 || nj < jumps[j]){
        jumps[j] = nj; dist[j] = dist[i]; prev[j] = i; gate[j] = 1;
        push(nj + heur(j), j);
      }
    }
  }

  let target = goalIdx, partial = false;
  if (!reached){
    partial = true;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++){
      if (jumps[i] === -1) continue;
      const d = Math.hypot(nodes[i].x - goal.x, nodes[i].z - goal.z);
      if (d < bd){ bd = d; best = i; }
    }
    target = best;
  }
  if (target < 0) return null;
  const path = [], gates = [];
  for (let i = target; i !== -1; i = prev[i]){ path.push(nodes[i]); gates.push(gate[i]); }
  path.reverse(); gates.reverse();
  return {path, gates, partial, total: dist[target]};
}

// Warp gates join two named systems; they are edges like any other.
const gateLinks = new Map();
for (const [a, b] of D.gates){
  if (!gateLinks.has(a)) gateLinks.set(a, []);
  if (!gateLinks.has(b)) gateLinks.set(b, []);
  gateLinks.get(a).push(b);
  gateLinks.get(b).push(a);
}

function nearestNode(nodes, p){
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++){
    const d = Math.hypot(nodes[i].x - p.x, nodes[i].z - p.z);
    if (d < bd){ bd = d; best = i; }
  }
  return best;
}

// ---- driving it ------------------------------------------------------------
async function recomputeRoute(){
  const note = document.getElementById("routeNote");
  routePath = null; routeGates = null; routePartial = false;
  if (!routeFrom || !routeTo){ note.textContent = ""; draw(); return; }
  if (routeFrom.name === routeTo.name){ note.textContent = ui("sameSystem"); draw(); return; }
  if (routeBusy) return;
  routeBusy = true;
  note.textContent = ui("plotting");
  try {
    if (!cellBits) await loadGrid();
    if (!GEN.side) await loadGenerationMaps();

    if (!inMainComponent(routeTo.x, routeTo.z) &&
        inMainComponent(routeFrom.x, routeFrom.z)){
      note.innerHTML = "<b>" + ui("isolated") + "</b>";
      draw();
      return;
    }
    const {cells, coarse} = corridorCells(routeFrom, routeTo, jumpLy);
    if (!cells){
      note.innerHTML = "<b>" + fmt("noRoute", {ly: jumpLy}) + "</b> " + ui("isolated");
      draw();
      return;
    }
    if (cells.size > MAX_CORRIDOR_CELLS){
      // Too far to trace system by system; report the corridor instead.
      const ly = Math.round(coarse.length * CELL_LY);
      routePath = coarse.map(([cx, cy]) => {
        const [x, z] = cellCentre(cx, cy);
        return {x, z, name: "", coarse: true};
      });
      routeGates = routePath.map(() => 0);
      note.innerHTML = fmt("approxRoute",
        {jumps: plural("jumps", Math.ceil(ly / jumpLy)), ly: num(ly)});
      draw();
      return;
    }
    const {nodes, byCell} = corridorSystems(cells);
    const a = nearestNode(nodes, routeFrom), b = nearestNode(nodes, routeTo);
    if (a < 0 || b < 0){ note.textContent = ui("sameSystem"); draw(); return; }
    const r = searchSystems(nodes, byCell, a, b, jumpLy);
    if (!r){ note.innerHTML = "<b>" + fmt("noRoute", {ly: jumpLy}) + "</b>"; draw(); return; }

    routePath = r.path; routeGates = r.gates; routePartial = r.partial;
    const jumpsN = r.path.length - 1;
    if (jumpsN === 0){
      routePath = null;
      note.innerHTML = "<b>" +
        fmt("nothingInRange", {ly: jumpLy, sys: routeFrom.name}) + "</b>";
      draw();
      return;
    }
    const viaGates = r.gates.reduce((s, g) => s + g, 0);
    const gateNote = viaGates ? " &middot; " + fmt("viaGate", {n: viaGates}) : "";
    if (r.partial){
      const stop = r.path[r.path.length - 1];
      const gap = Math.hypot(routeTo.x - stop.x, routeTo.z - stop.z);
      note.innerHTML =
        `<b>${fmt("noRoute", {ly: jumpLy})}</b> ` +
        fmt("stopsAt", {sys: stop.name, jumps: plural("jumps", jumpsN),
                        ly: num(Math.round(r.total))}) +
        `<br><b>${fmt("short", {ly: num(Math.round(gap)), sys: routeTo.name})}</b>`;
    } else {
      note.innerHTML = fmt("routeOk",
        {jumps: plural("jumps", jumpsN), ly: num(Math.round(r.total))}) + gateNote;
    }
  } finally {
    routeBusy = false;
    draw();
  }
}

function setEnd(which, source){
  const p = endpointOf(source);
  if (which === "from"){ routeFrom = p; document.getElementById("from").value = p.name; }
  else { routeTo = p; document.getElementById("to").value = p.name; }
  recomputeRoute();
}

function clearRoute(){
  routeFrom = routeTo = routePath = routeGates = null;
  document.getElementById("from").value = "";
  document.getElementById("to").value = "";
  document.getElementById("routeNote").textContent = "";
  draw();
}

// ---- drawing ---------------------------------------------------------------
function drawRoute(){
  if (!routePath || routePath.length < 2) return;
  ctx.save();
  ctx.lineWidth = 2.2; ctx.lineJoin = "round";
  for (let k = 1; k < routePath.length; k++){
    const a = routePath[k - 1], b = routePath[k];
    const viaGate = routeGates && routeGates[k];
    ctx.strokeStyle = b.coarse ? "rgba(79,195,255,.55)"
                    : viaGate ? "#4fc3ff" : "#ffab3d";
    ctx.setLineDash(b.coarse ? [2, 6] : viaGate ? [3, 4] : routePartial ? [7, 5] : []);
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sy(a.z)); ctx.lineTo(sx(b.x), sy(b.z));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (!routePath[0].coarse){
    for (let k = 1; k < routePath.length - 1; k++)
      hex(sx(routePath[k].x), sy(routePath[k].z), 6, "rgba(255,171,61,.9)");
    marker(sx(routePath[0].x), sy(routePath[0].z), "#ff9f2e", -1);
    const e = routePath[routePath.length - 1];
    marker(sx(e.x), sy(e.z), "#4fc3ff", 1);
  }
  ctx.restore();
}

// The game marks each end with a solid kite; origin amber, destination blue.
function marker(px, py, colour, dir){
  const h = 20, w = 11;
  ctx.beginPath();
  ctx.moveTo(px, py - dir * 6);
  ctx.lineTo(px - w / 2, py - dir * (6 + h * .45));
  ctx.lineTo(px, py - dir * (6 + h));
  ctx.lineTo(px + w / 2, py - dir * (6 + h * .45));
  ctx.closePath();
  ctx.fillStyle = colour; ctx.fill();
}


// ---- controls --------------------------------------------------------------
addEventListener("keydown", e => { if (e.key === "Escape"){ clearRoute(); focused = null; } });
document.getElementById("clearRoute").onclick = clearRoute;

const jumpBox = document.getElementById("jump");
jumpBox.value = jumpLy;
jumpBox.addEventListener("input", () => {
  const v = +jumpBox.value;
  if (!(v > 0)) return;
  jumpLy = v;
  try { localStorage.setItem("gg.jump", String(v)); } catch (_) {}
  cells = null;                       // the coarse grid is sized to the jump range
  recomputeRoute();
});

{
  const sel = document.getElementById("lang");
  for (const code of D.langCodes){
    const o = document.createElement("option");
    o.value = code; o.textContent = `${LANG_FLAG[code] || ""} ${LANG_NAME[code] || code}`.trim();
    if (code === lang) o.selected = true;
    sel.append(o);
  }
  const applyUI = () => {
    for (const el of document.querySelectorAll("[data-ui]"))
      el.textContent = ui(el.dataset.ui);
    for (const el of document.querySelectorAll("[data-ui-ph]"))
      el.placeholder = ui(el.dataset.uiPh);
    for (const el of document.querySelectorAll("[data-ui-title]"))
      el.title = ui(el.dataset.uiTitle);
    for (const el of document.querySelectorAll("[data-ui-aria]"))
      el.setAttribute("aria-label", ui(el.dataset.uiAria));
    document.documentElement.lang = lang === "cn" ? "zh" : lang;
    document.title = ui("title");
    document.getElementById("count").firstChild.textContent =
      num(S.length) + " " + ui("systems");
  };
  sel.addEventListener("change", () => {
    lang = sel.value;
    try { localStorage.setItem("gg.lang", lang); } catch (_) {}
    TYPES = named(D.typeKeys, D.types);
    ORES = named(D.oreKeys, D.ores);
    PTYPES = named(D.ptypeKeys, D.ptypes);
    MODULES = named(D.moduleKeys, D.modules);
    for (const [id, list] of [["ore", ORES], ["ptype", PTYPES], ["module", MODULES]]){
      const el = document.getElementById(id);
      [...el.options].forEach((o, i) => { if (i) o.textContent = list[i - 1]; });
    }
    document.querySelectorAll("#secRow .pill").forEach((b, i) => b.textContent = ui(SECS[i][1]));
    document.querySelectorAll("#purpRow .pill").forEach((b, i) => b.textContent = ui(D.purposeSlots[i]));
    document.querySelectorAll("#facRow .pill").forEach((b, i) => b.textContent = t(D.factionKeys[i]));
    applyUI();
    draw();
  });
  applyUI();
}

resize();   // first paint, once route state exists

// Spoiler toggle: landmarks, gates, engineers and expedition targets.
{
  const box = document.getElementById("spoilers");
  const hideable = [...document.querySelectorAll(
    '[data-f="eng"],[data-f="gate"],[data-spoiler]')];
  const apply = () => {
    spoilers = box.checked;
    for (const el of hideable){
      el.classList.toggle("hidden", !spoilers);
      if (!spoilers && el.getAttribute("aria-pressed") === "true"){
        el.setAttribute("aria-pressed", "false");
        filters.delete(el.dataset.f);
      }
      if (!spoilers && el.hasAttribute("data-spoiler")){
        const sel2 = el.querySelector("select");
        if (sel2 && sel2.value !== ""){ sel2.value = ""; F.startype = -1; }
      }
    }
    recomputeRoute();
    draw();
  };
  try { box.checked = localStorage.getItem("gg.spoilers") === "1"; } catch (_) {}
  box.addEventListener("change", () => {
    try { localStorage.setItem("gg.spoilers", box.checked ? "1" : "0"); } catch (_) {}
    apply();
  });
  apply();
}
