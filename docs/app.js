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
  [cellBits, mainBits] = await Promise.all([read("data/cells.png?v=568f0ad36f"), read("data/reachable.png?v=568f0ad36f")]);
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
  CAP: 20000,
};

// The Park-Miller start noise() uses for a uint seed: noise() takes an int, and
// every seed of 2^31 or more (a negative int) gives the one bitmap from 2147483646.
const noiseSeed = seed => seed >= 2147483648 ? 2147483646 : (seed || 1);

// The noise bitmap is transparent, so Flash stores it premultiplied and
// getPixel32 converts back, moving some colour bytes by one: ROUND_TRIP[a * 256 + c]
// is what reads back for colour c at alpha a (rndm.py's premultiply.bin).
let ROUND_TRIP = null;
function pixelFromBytes(r, g, b, a){
  if (!ROUND_TRIP) ROUND_TRIP = Uint8Array.from(atob(D.gen.roundTrip), ch => ch.charCodeAt(0));
  const t = a * 256;
  return ((a << 24) | (ROUND_TRIP[t + r] << 16) | (ROUND_TRIP[t + g] << 8) | ROUND_TRIP[t + b]) >>> 0;
}

// The game's own PRNG: BitmapData.noise seeded per cell, walked as a stream.
class Rndm {
  constructor(seed){
    this.x = noiseSeed(seed >>> 0);
    this.p = 0;
    this.buf = [];
  }
  byte(){ this.x = (this.x * 16807) % 2147483647; return this.x % 256; }
  random(){
    this.p = (this.p + 1) % 200000;
    while (this.buf.length <= this.p){
      const r = this.byte(), g = this.byte(), b = this.byte(), a = this.byte();
      this.buf.push(pixelFromBytes(r, g, b, a));
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
// What a person typed, however much of it there is, as regions rather than as a
// list of cells. A pair is a base-26 number, so a pair that has been typed fixes
// one coordinate exactly and one that has not spans the sector: the answer is at
// most four rectangles, whatever the prefix, and it takes no searching to find
// them.
//
// Case is arithmetic here: a pair's first character is a digit, so an uppercase
// D is 3 and a lowercase d is 35. Both are legal names, so both are offered.
//
// Returns {cx0, cy0, cx1, cy1, index, sector} boxes in cell coordinates.
function regionsFromName(name){
  const m = /^(.+?)(?:\s+(\S?)(\S?)(?:-(\S?)(\S?))?(?:\s+([A-Ea-e])(\d*))?)?$/
    .exec(name.trim());
  if (!m) return [];
  const [, zone, a0, a1, b0, b1, quad, n] = m.map(v => v || undefined);
  const z = (zone || "").toLowerCase();
  const out = [];
  D.sectorAnchors.sectors.forEach((nm, i) => {
    if (D.sectorAnchors.x[i] === -1 || !D.sectorLive[i]) return;
    if (!nm.toLowerCase().startsWith(z)) return;
    const box = D.sectorBounds[i];
    if (!box) return;
    const [xlo, xhi, ylo, yhi] = box;
    const ax = D.sectorAnchors.x[i], ay = D.sectorAnchors.y[i];

    // A pair that is complete is a number; a pair that is half typed is the
    // 26 numbers its first digit allows; a pair that is missing is anything.
    const both = c => c === c.toUpperCase() ? [c, c.toLowerCase()] : [c, c.toUpperCase()];
    const spans = (c0, c1) => {
      if (!c0) return null;                                  // no constraint
      return [...new Set(both(c0))].map(h => {
        const base = (h.charCodeAt(0) - 65) * 26;
        return c1 ? [base + c1.toLowerCase().charCodeAt(0) - 97,
                     base + c1.toLowerCase().charCodeAt(0) - 97]
                  : [base, base + 25];
      });
    };
    const xs = spans(a0, a1), ys = spans(b0, b1);
    for (const q of (quad ? [quad.toUpperCase()] : [..."BCDE"])){
      const k = q.charCodeAt(0) - 65;
      const sx = k >= 3 ? 1 : -1, sy = (k === 2 || k === 3) ? 1 : -1;
      // An offset counts away from the centre in the quadrant's direction, so a
      // span of offsets becomes a span of cells on that side of it.
      const along = (span, anchor, sign, lo, hi) => {
        if (!span) return [Math.max(lo, sign > 0 ? anchor : lo),
                           Math.min(hi, sign > 0 ? hi : anchor)];
        const a = anchor + sign * span[0], b = anchor + sign * span[1];
        return [Math.max(lo, Math.min(a, b)), Math.min(hi, Math.max(a, b))];
      };
      for (const xspan of (xs || [null]))
        for (const yspan of (ys || [null])){
          const [cx0, cx1] = along(xspan, ax, sx, xlo, xhi);
          const [cy0, cy1] = along(yspan, ay, sy, ylo, yhi);
          if (cx0 > cx1 || cy0 > cy1) continue;
          out.push({cx0, cy0, cx1, cy1, sector: i,
                    index: n === undefined ? null : +n});
        }
    }
  });
  return out;
}

// The cells of a region, nearest Sol first, for the handful the list will show.
function cellsInRegion(r, cap = 400){
  const out = [];
  for (let cy = r.cy0; cy <= r.cy1 && out.length < cap; cy++)
    for (let cx = r.cx0; cx <= r.cx1 && out.length < cap; cx++)
      if (sectorId(cx, cy) === r.sector) out.push({cx, cy, index: r.index});
  out.sort((a, b) => (a.cx - 1025) ** 2 + (a.cy - 1591) ** 2
                   - ((b.cx - 1025) ** 2 + (b.cy - 1591) ** 2));
  return out;
}

function cellsFromName(name){
  const out = [];
  for (const r of regionsFromName(name)) out.push(...cellsInRegion(r, 200));
  return out;
}

function cellFromName(name){
  // The offset letters are arithmetic, not an alphabet: a cell far from its
  // sector's anchor overflows the first character past Z, so the pair cannot be
  // matched as [A-Z][a-z].
  const m = /^(.+?)\s+(\S\S)-(\S\S)\s+([A-E])(\d+)$/.exec(name.trim());
  if (!m) return null;
  const [, zone, ax, ay, quad, n] = m;
  const i = D.sectorAnchors.sectors.findIndex(
    s => s.toLowerCase() === zone.toLowerCase());
  if (i < 0 || D.sectorAnchors.x[i] === -1) return null;
  // Arithmetic, not an alphabet: a high digit of 52 is chr(65 + 52), a lowercase
  // u. Case carries value here, so a name cannot be matched case-insensitively.
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
    [read("data/side.webp?v=568f0ad36f", 1), read("data/zones.webp?v=568f0ad36f", 3)]);
  GEN.side = side;
  GEN.zones = zones;
}

// The stars inside one cell. Deterministic, so the cache is only about speed.
// share < 1 stops the walk once that fraction of the cell is built. The walk is
// a sequence, so a star can only be reached through the ones before it: the
// share taken is always the cell's first stars, and every one of them is the
// system the game generates.
function cellStars(cx, cy, share = 1){
  if (!GEN.side || cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return [];
  const cell = cy * GRID + cx;
  const key = share >= 1 ? cell * 64 : cell * 64 + Math.min(63, Math.round(1 / share));
  const hit = GEN.cache.get(key);
  if (hit) return hit;

  const side = GEN.side[cell];
  if (!side) return [];
  const rng = new Rndm(cx * 10000 + cy);                 // GetSectorId
  const r = GEN.zones[cell * 3], g = GEN.zones[cell * 3 + 1], b = GEN.zones[cell * 3 + 2];
  const step = 1 / side;
  const real = catalogueInCell(cx, cy);
  const name = sectorName(cx, cy);

  const want = share >= 1 ? Infinity : Math.max(1, Math.round(side * side * share));
  // GalaxyMap.GetStars drops a star that lands within the clash distance of any
  // star already in the cell, catalogue or generated; a dropped star spends no
  // type draw. Its number (name and seed index) is its place in the walk plus
  // the cell's unnamed catalogue stars.
  const placed = real.map(([rx, ry]) => [rx, ry]);
  const offset = real.filter(r => !r[2]).length;
  let gx = cx + step / 2, gy = cy, out = [];
  for (let i = 0; i < side * side && out.length < want; i++){
    const x = gx + rng.float(0, step / 1.3);
    const y = gy + rng.float(0, step / 1.3);
    let clash = false;
    for (const [rx, ry] of placed)
      if (step * step / 2 > (rx - x) ** 2 + (ry - y) ** 2){ clash = true; break; }
    if (!clash){
      placed.push([x, y]);
      const t = starByZone(rng, r, g, b);
      out.push({
        x: (x - 1025) * CELL_LY, z: (1591 - y) * CELL_LY,
        type: t[4], colour: t[3], fuel: !!t[5], raw: t[0],
        name: `${name.zone} ${name.sector}${i + offset}`,
        // GalaxyMap seeds from the whole-number pixel of the star's own position,
        // which a star in the cell's last column can carry past its right edge.
        seed: ((((Math.floor(x)) & 0xFFF) << 20) + ((Math.floor(y) & 0xFFF) << 8)
               + ((i + offset) & 0xFF)) >>> 0,
      });
    }
    gx += step;
    if (gx > cx + 1){ gx = cx + step / 2; gy += step; }
  }
  // Oldest half, not everything: a view wider than the cache would otherwise
  // wipe it on the frame that filled it and regenerate every cell on the next.
  if (GEN.cache.size > GEN.CAP){
    let n = GEN.cache.size >> 1;
    for (const k of GEN.cache.keys()){ GEN.cache.delete(k); if (--n <= 0) break; }
  }
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
      bucket.push([px, py, s[NAME]]);
    }
  }
  return catalogueCells.get(cy * GRID + cx) || [];
}



// ---- a system's bodies ------------------------------------------------------
// StarSystemGenerator, as the game runs it. Every system that has no hand-built
// entry gets its planets and belts this way, catalogued or not, so this is what
// lets a generated system carry the same detail as a named one.
const SEGMENTS = 500, SEGMENT_LEN = 10;
const SEG_INV_ROOT = new Float64Array(SEGMENTS);
for (let i = 0; i < SEGMENTS; i++)
  SEG_INV_ROOT[i] = 1 / Math.sqrt(SEGMENT_LEN * (i + 1) * 299792000);
// One set of scratch per companion depth; generateBodies recurses at most four
// deep and each level holds its own.
const OCCUPIED = [0, 1, 2, 3].map(() => new Uint8Array(SEGMENTS));

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

// PlanetNew reseeds with the planet's own seed and points at that same pixel,
// then spends three draws plus the type's cosmetic ones before picking its
// materials. Pixel p of the noise is Lehmer state 4p+1, reached by a power.
const LEHMER_M = 2147483647n;
function powmod(b, e){
  let r = 1n;
  for (b %= LEHMER_M; e > 0n; e >>= 1n, b = b * b % LEHMER_M) if (e & 1n) r = r * b % LEHMER_M;
  return r;
}
function planetMaterials(seed, type){
  const entry = D.gen.planetMats[type];
  if (!entry) return [];
  const [looks, n, sets] = entry;
  if (n === 1) return sets[0];
  // Seed 0 (an alpha-0 noise pixel): PlanetNew skips reseeding and draws on from
  // wherever the stream stands, which this does not model.
  if (seed === 0) return [];
  const p = (seed + 3 + looks + 1) % 200000;
  let x = Number(powmod(16807n, BigInt(4 * p + 1)) * BigInt(noiseSeed(seed)) % LEHMER_M);
  const r = x % 256; x = (x * 16807) % 2147483647;
  const g = x % 256; x = (x * 16807) % 2147483647;
  const b = x % 256; x = (x * 16807) % 2147483647;
  const a = x % 256;
  const px = pixelFromBytes(r, g, b, a);
  return sets[Math.floor((px * 0.999999999999998 + 1e-15) / 4294967295 * n)];
}

function systemBodies(seed, starType){
  const rng = new Rndm(seed);
  rng.integer(0, 1);                      // MakePlanetsFromDB bails after two draws
  rng.float(0, Math.PI * 2);
  const lum = genGetRandomStar(rng, starType);
  const out = generateBodies(rng, starType, lum, 0, -1,
                             {stars: [], planets: [], belts: [], groups: []});
  // Where the jump drops the ship, in light seconds from the centre
  // (StarSystemGenerator.warpOutRadius and PlanetManager, as gen.drop_ls): the
  // largest star of the first group x1.3, x1.5 for every group of two or more,
  // 350 more for a neutron star or black hole, and 150 more. A planet pays on
  // arrival for sure when it circles the primary and its orbit plus that is in
  // the scanner's range; a companion's planets never do.
  let px = Math.max(...out.groups[0].map(t => D.gen.starSize[t] || 0)) * 1.3;
  for (const g of out.groups) if (g.length > 1) px *= 1.5;
  if (D.gen.warpExtra.includes(starType)) px += 350;
  const drop = (px + 150) / 20;
  for (const pl of out.planets) pl.reach = pl.group === 0 ? pl.orbit + drop : Infinity;
  // The objects list's names (StarSystemGenerator): a letter per star group, then
  // the group's stars followed by its planets and belts by orbit. Belts are only
  // ever in the first group.
  out.groups.forEach((stars, g) => {
    const ranked = out.planets.filter(p => p.group === g)
      .concat(g ? [] : out.belts).sort((a, b) => a.orbit - b.orbit);
    ranked.forEach((b, i) => { if (b.mats) b.name = "ABCDEFGH"[g] + (stars.length + i); });
  });
  return out;
}

function generateBodies(rng, starType, lum, group, budget, out){
  rng.float(0, Math.PI * 2);
  // Every star in the group pays, and all of them are discovered the moment you
  // arrive, so a system's star value is the sum rather than the primary's alone.
  const stars = genStarPairs(rng, starType, true);
  for (const st of stars){
    rng.integer(-2147483647, 2147483646);
    out.stars.push(st);
  }
  out.groups.push(stars);
  if (rng.integer(0, 100) < 10) return out;

  let count;
  if (budget === -1){ count = rng.integer(1, 15); budget = 15; }
  else count = rng.integer(1, budget);

  // The temperature at a segment is the same expression with only the star's
  // luminosity changing, so the distance half of it is worked out once for the
  // whole program and this is one root per system rather than five hundred.
  const C = (lum * 3.846e26 * 0.7 / (16 * Math.PI * (5.67 / 1e8))) ** 0.25;
  const occupied = OCCUPIED[group];
  occupied.fill(0);
  occupied[0] = occupied[1] = occupied[2] = 1;
  // Temperature falls with distance, so a body type's band is one run of
  // segments. Finding its ends costs two searches; testing every segment
  // against it costs five hundred, for every body of every system in view.
  const tempAt = j => Math.trunc(C * SEG_INV_ROOT[j] + 40);

  let belts = 0;
  for (let n = 0; n < count; n++){
    const body = genBodyType(rng);
    const minWidth = 100 / SEGMENT_LEN + 2;
    let width = Math.trunc(rng.integer(100, 3000) / SEGMENT_LEN), run = 0;
    // Counted, then walked to the one drawn: the list itself was never wanted,
    // and this runs for every body of every system in view.
    // The last segment still hotter than the floor, and the first already
    // cooler than the ceiling.
    let lo = 4, hi = SEGMENTS - 1;
    while (lo < hi){ const m = (lo + hi) >> 1; tempAt(m) >= body[3] ? lo = m + 1 : hi = m; }
    const first = tempAt(lo) < body[3] ? lo : SEGMENTS;
    lo = 4; hi = SEGMENTS - 1;
    while (lo < hi){ const m = (lo + hi + 1) >> 1; tempAt(m) > body[2] ? lo = m : hi = m - 1; }
    const last = tempAt(lo) > body[2] ? lo : 3;
    let fits = 0;
    for (let j = first; j <= last; j++) if (!occupied[j]) fits++;
    if (!fits) continue;
    const pick = rng.integer(0, fits);
    let slot = -1;
    for (let j = first, k = 0; j <= last; j++)
      if (!occupied[j] && k++ === pick){ slot = j; break; }
    const isBelt = body[0] === "Asteroids";
    if (isBelt){
      if (belts > 1 || group > 0) continue;
      while (run < width && pick + run < SEGMENTS && !occupied[pick + run]) run++;
      run -= 8;
      if (run < minWidth) continue;
      belts++;
      while (run > 0){ run--; occupied[pick + run] = 1; }
    }
    occupied[slot] = 1;
    budget--;
    rng.float(0, Math.PI * 2);
    const seed = rng.integer(-2147483647, 2147483646) + 2147483647;
    const orbit = slot * SEGMENT_LEN + 25;
    if (isBelt){
      const triple = genMaterials(rng);
      const pct = orePercents(triple);
      out.belts.push({orbit, ores: triple.map((t, i) => ({name: t[0], pct: pct[i]}))});
    } else {
      out.planets.push({orbit, group, type: body[4], scan: body[5], landable: !!body[6],
                        mats: planetMaterials(seed, body[0])});
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


// globalSettings.distFromSolToDiscover / distFromVoidToDiscover. A system inside
// either radius is handed no scan record at all, so every body in it is already
// explored and scanning pays nothing. The game shows this as "Explored: yes".
const SOL_DISCOVER_LY = 300, VOID_DISCOVER_LY = 150;
const VOID_X = (973 - 1025) * CELL_LY, VOID_Z = (1591 - 1682) * CELL_LY;

// Measured from the whole-number map pixel of the star's own position
// (RoutePoint.secX = floor(marker.x)), as gen.explored: a star's jitter can carry
// it past the edge of the cell that generated it.
function isExplored(x, z){
  const px = Math.floor(x / CELL_LY + 1025), py = Math.floor(1591 - z / CELL_LY);
  return !(Math.hypot(px - 1025, py - 1591) * CELL_LY > SOL_DISCOVER_LY
           && Math.hypot(px - 973, py - 1682) * CELL_LY > VOID_DISCOVER_LY);
}

// Bodies are only produced when something asks for them, and remembered after.
const bodyCache = new Map();
function starBodies(star){
  let b = bodyCache.get(star.seed);
  if (!b){
    b = systemBodies(star.seed, star.raw);
    // A system is worth its planets and the star itself, unless the game counts
    // it explored already, in which case none of it pays.
    b.explored = isExplored(star.x, star.z);
    const cost = D.starCost || {};
    // Split, because the two halves are collected differently: every star is
    // discovered on arrival at any distance, while a planet has to be inside
    // the fitted scanner's range.
    b.starScan = b.explored ? 0 : b.stars.reduce((s, t) => s + (cost[t] || 0), 0);
    b.scan = b.explored ? 0
           : b.starScan + b.planets.reduce((s, p) => s + p.scan, 0);
    b.landable = b.planets.filter(p => p.landable).length;
    // A screenful can be tens of thousands of systems, so the cache has to be
    // bigger than one screen or it thrashes and nothing is ever reused.
    if (bodyCache.size > 120000) bodyCache.clear();
    bodyCache.set(star.seed, b);
  }
  return b;
}

const D = window.__GG__;
const [NAME,X,Z,LY,TY,FUEL,SEC,PL,BE,LA,ST,EN,SCAN,AUTH,ORE,PTY,PUR,FAC,GATE,OP,
       STARV,PB,MAT] = [...Array(23).keys()];
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
// A string passes through: estimated counts too rare to sample arrive as "<N".
const num = n => typeof n === "string" ? n : Number(n).toLocaleString(lang === "cn" ? "zh" : lang);
// Russian needs three plural forms where English needs two; Intl knows which.
const plural = (family, n) => {
  const cat = new Intl.PluralRules(lang === "cn" ? "zh" : lang).select(n);
  return fmt(`${family}_${cat}`, {n: num(n)});
};
const named = (keys, fallback) => keys.map((k, i) => k ? t(k) : fallback[i]);

let TYPES = named(D.typeKeys, D.types);
let ORES = named(D.oreKeys, D.ores);
let PTYPES = named(D.ptypeKeys, D.ptypes);
let MATS = named(D.matKeys, D.matRaw);
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
// A coarse pointer has no hover and no reliable double click, so a tap is spent
// on the tooltip and the route ends are typed instead.
const TOUCH = matchMedia("(pointer:coarse)").matches;

// A phone has too little room for the rail and the map at once, so the page is
// laid out on a wider virtual screen and the browser scales it down. Everything
// renders smaller and about a third more fits.
const SHRINK = 0.75;

function setViewport(content){
  // Chrome can ignore an in-place edit, so the tag is replaced outright.
  document.querySelector("meta[name=viewport]")?.remove();
  const vp = document.createElement("meta");
  vp.name = "viewport"; vp.content = content;
  document.head.append(vp);
  void window.innerWidth;                   // apply the new layout before it is read
}

function fitViewport(){
  // Measured at device width, so the reading is the device's own, whichever way
  // it is held. screen.width is not reliably in CSS pixels on Android.
  setViewport("width=device-width,initial-scale=1");
  if (!TOUCH) return;
  const dev = window.innerWidth;
  // The short edge identifies a phone in either orientation; a tablet is wider.
  if (Math.min(dev, window.innerHeight) > 500) return;
  // No initial-scale: naming one pins the zoom at 1 and the wider layout simply
  // overflows. Left out, the browser scales the layout down to fit the screen.
  setViewport(`width=${Math.round(dev / SHRINK)}`);
}
fitViewport();
matchMedia("(orientation: portrait)").addEventListener("change", fitViewport);
{
  const btn = document.getElementById("menuBtn");
  const setMenu = open => {
    document.body.classList.toggle("menu", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => {
    tip.style.display = "none";
    setMenu(!document.body.classList.contains("menu"));
  });
  addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });
  if (TOUCH){
    document.body.classList.add("touch");
    document.querySelector(".readout div").classList.add("hidden");
    document.getElementById("from").dataset.uiPh = "findPlaceholderTouch";
    document.getElementById("to").dataset.uiPh = "toPlaceholderTouch";
  }
}
let W = 0, H = 0, dpr = 1;
// view: world (ly) -> screen. scale = px per ly.
let cx = 0, cz = 0, scale = 4, scaleSet = false;
// Light years across the window at home zoom. A phone screen is narrow, so it
// starts closer in to keep the same sense of a neighbourhood.
const HOME_LY = TOUCH ? 75 : 150;
// Light years across the window when the whole galaxy is asked for.
const GALAXY_LY = 170000;
// How much of the shorter side the whole galaxy leaves empty when it is framed.
const GALAXY_MARGIN = 0.9;
// Inside this radius the game treats every planet as already scanned and pays
// nothing, so a scan-value filter has to leave that space out.
// The canvas is the map area: it starts where the sidebar ends, so its width is
// the width a reader actually sees, and its centre is the centre they mean.
const mapW = () => W;
const acrossLy = () => W / scale;
const scaleFor = lyAcross => W / lyAcross;
const filters = new Set();
// Hand-placed discoveries stay hidden until asked for: named landmarks, warp
// gates and engineer postings are things the game means you to find.
let spoilers = false;
// Everything the sidebar can narrow by. Empty / null means "don't care".
const F = {sec:new Set(), purp:new Set(), fac:new Set(),
           ore:-1, ptype:-1, mat:-1, arena:null, startype:"", module:-1, fullOnly:true,
           lyMin:null, lyMax:null, valMin:null, oneHop:false, plMin:null,
           pctMin:null, matPctMin:null, laMin:null, stLs:null};

// Which Planet Scanner the reader has fitted. At 1,000 CR and no mass the 1D is
// the first thing anyone buys, so it is what the map assumes unless told
// otherwise; assuming none understates every system and assuming the 1A
// overstates them.
let scanner = 1;
const scanRange = () => D.scanners[scanner][1];

// What a system is worth, in the two numbers that decide whether to go.
//
//   arrival  banked the moment you drop out of warp: every star, at any
//            distance, plus every planet sure to be inside the scanner's range
//            of where the jump drops you (a catalogue row's pairs are already
//            that distance; a generated planet carries it as reach)
//   full     the whole system, once you have flown to everything in it
//   hops     bodies outside the scanner's range worth crossing the system for
//   reach    arrival plus those bodies, which is what the trip actually pays
//
// Computed here and nowhere else. Both tooltips, both filters, the halo and the
// counts read it, so they cannot drift apart.
// Working out what a generated system is worth means making its planets, which
// is the most expensive thing the map does. The answer only changes with the
// fitted scanner, so it is kept per system until that changes.
const valueCache = new Map();
let valueRange = -1;
function systemValue(s){
  if (!Array.isArray(s)){
    if (valueRange !== scanRange()){ valueCache.clear(); valueRange = scanRange(); }
    let v = valueCache.get(s.seed);
    if (!v){
      v = computeValue(s);
      if (valueCache.size > 800000) valueCache.clear();
      valueCache.set(s.seed, v);
    }
    return v;
  }
  return computeValue(s);
}

function computeValue(s){
  const gen = !Array.isArray(s);
  const b = gen ? starBodies(s) : null;
  const full = gen ? b.scan : s[SCAN];
  if (!full) return {arrival: 0, full: 0, hops: 0, reach: 0, oneHop: 0};
  const r = scanRange(), worth = D.worthTheTrip;
  let arrival = gen ? b.starScan : s[STARV], hops = 0, reach = 0, best = 0;
  const each = (orbit, value) => {
    if (orbit <= r) arrival += value;
    else if (value >= worth){ hops++; reach += value; if (value > best) best = value; }
  };
  if (gen) for (const pl of b.planets) each(pl.reach, pl.scan);
  else for (let i = 0; i < s[PB].length; i += 2) each(s[PB][i], s[PB][i + 1]);
  // One hop is the single body worth crossing the system for. Everything past
  // that is a second trip, and a second decision.
  return {arrival, full, hops, reach: arrival + reach, oneHop: arrival + best};
}

// What a station stocks rotates on a clock and the map cannot see the clock, so
// these are the standing rules instead: who is ever dealt the black market, who
// will take it off you, and the two stations that sit outside the rotation.
const TRADE = new Map(Object.entries(D.trade));
const TRADE_BIT = {sellsBlack: 1, buysBlack: 2, oreBuyer: 4, trophyBuyer: 8,
                   noMarket: 16};
const tradeOf = s => TRADE.get(s[NAME]) || 0;

// Which cell-sum digit carries deep ore `oi`, or undefined for a belt ore.
const deepDigit = oi => D.deepOres[D.oreRaw[oi]];
const DEEP_TONS = "3\u20136 t";
// Richest showing of ore `oi` in this system, or 0 if it has none.
function orePct(s, oi){
  const a = s[OP];
  for (let i = 0; i < a.length; i += 2) if (a[i] === oi) return a[i + 1];
  return 0;
}

// Dig chance for material `mi` across this system's planets, [low, high], or null
// when no planet yields it. The filter reads the high end; the label shows both.
const matSpan = (s, mi) => (D.matPct[s[NAME]] || {})[D.matRaw[mi]] || null;
const generatedMatSpan = (st, mi) =>
  matSpans(starBodies(st).planets.map(p => p.mats).filter(m => m.length))[D.matRaw[mi]] || null;
const spanText = ([lo, hi]) => lo === hi ? `${lo}%` : `${lo}–${hi}%`;

// How much of the window the sidebar takes from the map.
let inset = 0;

function resize(){
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  // On a phone the rail is an overlay: off-screen until opened, and covering the
  // map on purpose when it is. Only a rail that sits beside the map takes room
  // away from it.
  const rail = document.getElementById("rail").getBoundingClientRect();
  inset = TOUCH ? 0 : Math.max(0, Math.min(rail.right, window.innerWidth / 2));
  W = window.innerWidth - inset; H = window.innerHeight;
  // A tab that loads in the background reports no size at all, and nothing
  // fires a resize when it is finally shown: every scale would be NaN.
  if (W <= 0 || H <= 0){ requestAnimationFrame(resize); return; }
  cv.style.left = inset + "px";
  cv.style.width = W + "px"; cv.style.height = H + "px";
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!scaleSet){ scale = scaleFor(HOME_LY); scaleSet = true; }
  draw();
}
// Pointer coordinates arrive in window space; the canvas starts at `inset`.
const evX = e => e.clientX - inset;
const sx = wx => (wx - cx) * scale + W / 2;
const sy = wz => (cz - wz) * scale + H / 2;
const wxOf = px => (px - W / 2) / scale + cx;
const wzOf = py => cz - (py - H / 2) / scale;

// The five systems a save's abandoned station can be waiting in. Which one it is
// differs per save, so the map can only show the shortlist.
const WRECKS = new Map(Object.entries(D.wrecks));

function passes(s){
  if (filters.has("fuel")    && !s[FUEL]) return false;
  if (filters.has("wreck")   && !WRECKS.has(s[NAME])) return false;
  for (const k in TRADE_BIT)
    if (filters.has(k) && !(tradeOf(s) & TRADE_BIT[k])) return false;
  if (filters.has("station") && !s[ST])   return false;
  if (filters.has("belt")    && !s[BE])   return false;
  if (filters.has("land")    && !s[LA])   return false;
  if (filters.has("eng")     && !s[EN])   return false;
  if (filters.has("gate")    && !s[GATE]) return false;
  if (filters.has("auth")    && !s[AUTH]) return false;
  if (F.sec.size  && !F.sec.has(s[SEC] || "-"))          return false;
  if (F.ore    >= 0 && !(s[ORE] >> F.ore    & 1))         return false;
  if (F.ptype  >= 0 && !(s[PTY] >> F.ptype  & 1))         return false;
  if (F.mat    >= 0 && !(s[MAT] >> F.mat    & 1))         return false;
  if (F.arena === "all" && !ARENA_SYS.has(s[NAME]))       return false;
  if (typeof F.arena === "number" && s[NAME] !== ARENA[F.arena - 1][1]) return false;
  if (F.startype && D.typeRaw[s[TY]] !== F.startype)      return false;
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
  if (F.valMin != null && worth(s) < F.valMin) return false;
  if (F.plMin   != null && s[PL]   < F.plMin)   return false;
  if (F.ore >= 0 && F.pctMin != null && !deepDigit(F.ore) && orePct(s, F.ore) < F.pctMin) return false;
  if (F.mat >= 0 && F.matPctMin != null && (matSpan(s, F.mat) || [0, 0])[1] < F.matPctMin) return false;
  if (F.laMin   != null && s[LA]   < F.laMin)   return false;
  if (F.stLs != null && !closeStations(s[NAME]).length) return false;
  return true;
}

// Stations within F.stLs light seconds of where a jump drops you, of a picked
// faction when any is picked. Missions and reputation are earned at a station,
// and crossing a system at sublight is the slow part of taking them.
const REP_LS = 500;
function closeStations(name, limit = F.stLs){
  return (D.stations[name] || []).filter(st => st[4] <= limit &&
    (!F.fac.size || [...F.fac].some(i => D.factions[i] === st[2])));
}

function anyFilter(){
  return filters.size || F.sec.size || F.purp.size || F.fac.size ||
         F.ore >= 0 || F.ptype >= 0 || F.mat >= 0 || F.arena != null || F.startype || F.module >= 0 ||
         [F.lyMin,F.lyMax,F.valMin,F.plMin,F.pctMin,F.matPctMin,F.laMin,F.stLs]
           .some(v => v != null);
}

// The grid is the cell lattice, subdivided or doubled by powers of two so every
// line at every zoom sits on a cell boundary the names are counted from.
function gridStep(){
  const target = 120 / scale;                 // aim for ~120px between lines
  return CELL_LY * Math.pow(2, Math.ceil(Math.log2(target / CELL_LY)));
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
    // Just clear of the sidebar, whatever width it happens to be.
    ctx.fillText(String(Math.round(z)), 6, p - 5);
  }
}

// The game colour-codes nothing on its own map, so these are this tool's
// choice. Pirates read as the hazard they are; the rest are told apart rather
// than ranked.
// Highlights answer the question a player did not know to ask, so they are on
// until turned off.
// A system worth this much is drawn gold wherever it appears, and nothing else
// marks value.
const RICH_MIN = 2000000;
const HL = {sectors: true};
// Hovering a legend row answers "which of these is that": its own layer keeps
// full strength and the rest of the map falls back to a ghost of itself.
const DIM = .15;
let solo = null;
const soloA = k => { ctx.globalAlpha = !solo || solo === k ? 1 : DIM; };
function soloRow(s){
  if (!solo) return 1;
  if (solo === "star") return 1;
  if (solo === "station") return s[ST] ? 1 : DIM;
  if (solo === "eng") return s[EN] && spoilers ? 1 : DIM;
  if (solo === "rich") return worth(s) >= RICH_MIN ? 1 : DIM;
  if (solo === "chev") return F.module >= 0 && D.sysModules[s[NAME]] ? 1 : DIM;
  if (solo.startsWith("fac:")){
    const i = D.factions.indexOf(solo.slice(4));
    return s[ST] && i >= 0 && (s[FAC] >> i & 1) ? 1 : DIM;
  }
  return DIM;
}

const FAC_COLOUR = {
  "Pirates": "#ff5a5a", "United Empire": "#c678dd",
  "Trade Federation": "#4ec9a0", "Interstellar Alliance": "#4aa3ff",
  "Independent": "rgba(53,224,245,.85)",
};

function ringColour(s){
  // A pirate station is three systems in the catalogue, so it wins any tie.
  const names = D.factions;
  for (const want of ["Pirates", "United Empire", "Trade Federation",
                      "Interstellar Alliance", "Independent"]){
    const i = names.indexOf(want);
    if (i >= 0 && (s[FAC] >> i & 1)) return FAC_COLOUR[want];
  }
  return "rgba(53,224,245,.85)";
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

// Two names printed over each other are worth less than one, so a label that
// would land on ground already claimed is dropped instead. Claims are kept in a
// coarse grid, which costs nothing however many labels a frame wants to draw.
const LBL_W = 6, LBL_H = 10;
let labelCells = new Set();
// y is the text baseline, so the box runs from the cap height to the descender.
function claimLabel(x, y, w){
  const gy0 = Math.floor((y - 9) / LBL_H) + 4096, gy1 = Math.floor((y + 2) / LBL_H) + 4096;
  const gx0 = Math.floor(x / LBL_W) + 4096, gx1 = Math.floor((x + w) / LBL_W) + 4096;
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++)
      if (labelCells.has(gy * 8192 + gx)) return false;
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++) labelCells.add(gy * 8192 + gx);
  return true;
}

let urlBusy = true, urlTimer = 0;
let visible = [], focused = [], focusStart = 0, focusRAF = 0;
let genVisible = [];              // generated stars currently on screen
// Where the map stops drawing individual systems. Everything about the wide
// views hangs off this one number: the zoom at which generated stars stop being
// drawn and how many cells a frame will cover. Turning it is the whole of that
// decision.
const SYSTEM_LY = 2000;           // the width a full field is drawn to
const FILTER_MAX_LY = 2500;     // a filter makes every system in view, so it stops sooner
const GEN_MAX_LY = 10000;         // wider than this, no generated stars at all
const GEN_SCALE = () => mapW() / SYSTEM_LY;
const GEN_MIN_SCALE = () => mapW() / GEN_MAX_LY;
const FLASH_MS = 900, FLASHES = 1;
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
function filterCount(){
  return filters.size + F.sec.size + F.purp.size + F.fac.size +
    [F.ore, F.ptype, F.mat, F.module].filter(v => v >= 0).length + (F.arena != null ? 1 : 0) +
    (F.startype ? 1 : 0) +
    [F.lyMin, F.lyMax, F.valMin, F.plMin, F.pctMin, F.matPctMin, F.laMin, F.stLs]
      .filter(v => v != null).length;
}

// 1,950,300 CR reads as 2.0m at label size.
const short = v => v >= 1e6 ? (v / 1e6).toFixed(1).replace(/^0/, "") + "m"
                            : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v);
const worthLabel = v => short(F.oneHop ? v.oneHop : v.arrival);
const valueAsked = () => F.valMin != null;
// What a system is worth to the reader: banked for turning up, or that plus the
// one body worth crossing the system for.
const worth = s => { const v = systemValue(s);
                     return F.oneHop ? v.oneHop : v.arrival; };

// Every system worth two million credits or more that the map cannot afford to
// work out for itself, precomputed, so "where is the money" has an answer at the
// zooms where generating 72 million systems to find out is not an option. Each
// arrives in the shape a catalogue row has, so systemValue() reads it without
// knowing the difference, which is also the difference a player never sees.
// A hash that is actually mixed: a plain multiply leaves the low bits of a
// cell's coordinates correlated, and a picture drawn from those bits shows it.
function mix(h){
  h = Math.imul(h ^ h >>> 15, 2246822507);
  h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^ h >>> 16) >>> 0;
}

const DOT_R = 2.0;
// A generated star's dot is full size where the field is close enough to read
// as individual systems, and shrinks with the view past that.
const DOT_FULL_LY = 600;
// A gold mark keeps growing as the view tightens, so it stays the obvious thing
// on screen however few stars are left around it: 1.65px at 10,000 ly across,
// 1.1px at 20,000, and half again as big for every halving until it caps.
const GOLD_R = () => {
  const ly = acrossLy();
  // Past 25,000 the marks are dense enough that the curve is pulled down again,
  // to half size by 50,000.
  return Math.min(6, Math.max(0.5, 1.65 * (10000 / ly) ** 0.585
                                   * Math.min(1, 25000 / ly)));
};
const DOT_SM = () => Math.max(0.35, Math.min(DOT_R, DOT_R * DOT_FULL_LY / acrossLy()));

// What a system's mark looks like, wherever its row came from. The catalogue and
// the generator each hand their own rows to these, so the two cannot drift
// apart, and neither can ask which it is holding.
function dot(px, py, fill, r = DOT_R){
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
}
// Gold is the one mark for value, at one threshold, in every source.
const markFill = (cr, plain) => cr >= RICH_MIN ? "#ffd666" : plain;

// The share of each cell the generated field draws. Below one the field is
// thinned, and the catalogue is held to the same bargain.
const genShare = () => anyFilter() ? 1 : Math.min(1, (SYSTEM_LY / acrossLy()) ** 2 / 4);
const genThin = () => genShare() < 1;

// One routine draws systems, and the two sources differ only in how they
// produce rows: the catalogue is shipped whole and generated space is made on
// demand. A source hands over rows plus the few things only it can answer.
//
//   at(row)      -> [x, z] in light years
//   ok(row)      -> does it pass the filters
//   plain(row)   -> its colour when it is not worth the gold
//   value(row)   -> what it is worth, or null when the source cannot say yet
//   r            -> marker radius, when it is not the usual one
//   kept(row)    -> on screen and passing the filters
//   mark(row, px, py, alpha)  -> anything only this source draws
//   label(row, px, py, value) -> what it prints beside itself
// How rare a faction's stations are, counted rather than assumed: three pirate
// stations against thirty-two independent ones.
const FAC_RANK = (() => {
  const n = D.factions.map(() => 0);
  for (const s of S) if (s[ST]) D.factions.forEach((_f, i) => { if (s[FAC] >> i & 1) n[i]++; });
  const order = n.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]);
  const out = n.slice();
  order.forEach(([, i], place) => { out[i] = place / n.length; });
  return out;
})();
const HITECH = D.purposes.indexOf("HiTech");

// Which names are on screen is settled once and then held until the view has
// changed enough to be worth asking again: a fifth of the current scale. Inside
// that, zooming moves the names it has rather than choosing new ones.
// Always drawn. A mission names a system and the name carries its sector, so the
// grid is how you find the place you were sent to. It is faint enough to sit
// under everything else at any zoom.
const RESETTLE = 0.2;
let drawn = new Set(), settledAt = 0, settledX = 0, settledZ = 0;

// Every name on the map goes through here. Anything that wants to print beside a
// system says so and says how much it matters; which names there is room for is
// settled once, in one place, at the end of the frame. Seven places used to draw
// text and only one of them knew about rank, or hysteresis, or the settle.
//
//   parts  [[text, colour], ...] printed left to right
//   rank   lower wins the ground; see rank()
//   key    what the name is, for holding it across frames
let LABELS = [];
//   mid    centre the text on the point rather than setting it beside a marker
function label(px, py, rank, key, parts, mid){
  LABELS.push({px, py, rank, key, parts, mid});
}

// A layer arriving is new ground for the names to be settled over, and nothing
// about the view has changed to ask for that on its own.
function resettleLabels(){ settledAt = 0; draw(); }

function drawLabels(){
  // Panning brings in stars the settled set never considered, so the view
  // moving a fair way across itself settles again just as zooming does.
  const here = [wxOf(W / 2), wzOf(H / 2)];
  // Asking about value makes the figures the point of the frame, so they are
  // settled fresh each time rather than held steady from the last one.
  const resettle = valueAsked() || !settledAt
                || Math.abs(scale - settledAt) > settledAt * RESETTLE
                || Math.hypot(here[0] - settledX, here[1] - settledZ) > acrossLy() * RESETTLE;
  LABELS.sort((a, b) => a.rank - b.rank);
  const held = new Set();
  ctx.globalAlpha = 1;
  ctx.font = '11px "JetBrains Mono", monospace';
  for (const {px, py, rank, key, parts, mid} of LABELS){
    // Holding the set steady is for the names that are only there because there
    // happened to be room. Sol, the journey and the places a player is looking
    // for appear the moment they exist.
    if (!resettle && rank > 1 && !drawn.has(key)) continue;
    const text = parts.map(p => p[0]).join("");
    if (mid){
      const w = ctx.measureText(text).width;
      if (!claimLabel(px - w / 2 - 4, py + 4, w + 8)) continue;
      held.add(key);
      let mx = px - w / 2;
      for (const [t, colour] of parts){
        ctx.fillStyle = colour;
        ctx.fillText(t, mx, py + 4);
        mx += ctx.measureText(t).width;
      }
      continue;
    }
    // A name claims its own marker along with its text: the ring around a
    // station system is as wide as three characters, so a name printed across
    // one is as unreadable as a name printed across another name. A name that
    // loses still claims its marker, or the winner beside it prints over that.
    if (!claimLabel(px - 8, py + 4, ctx.measureText(text).width + 18)){
      claimLabel(px - 8, py + 4, 17);
      continue;
    }
    held.add(key);
    let x = px + 10;
    for (const [t, colour] of parts){
      ctx.fillStyle = colour;
      ctx.fillText(t, x, py + 4);
      x += ctx.measureText(t).width;
    }
  }
  if (resettle){ drawn = held; settledAt = scale; [settledX, settledZ] = here; }
  LABELS = [];
}

const INK = "rgba(188,219,230,.78)", ORE_INK = "#ffab3d", VALUE_INK = "#fff0c0";

// The journey is named whatever the zoom: its two ends always, and every system
// it passes through whenever there is room. A route you cannot read is not a
// route.
const onRoute = new Set();
function routeNames(){
  onRoute.clear();
  if (routeFrom) onRoute.add(routeFrom.name);
  if (routeTo) onRoute.add(routeTo.name);
  if (routePath) for (const p of routePath) if (p.name) onRoute.add(p.name);
  return onRoute;
}
const routeEnd = n => (routeFrom && routeFrom.name === n)
                   || (routeTo && routeTo.name === n);

// Sol first, then the places a player is looking for, then the rest richest
// first. Among stations: the rarer the faction the better, and one that sells
// at every class before one that caps.
function rank(s){
  if (routeEnd(s[NAME])) return -2;
  if (onRoute.has(s[NAME])) return -1;
  if (s[LY] === 0) return 0;
  if (s[EN]) return 1;
  if (s[ST]){
    let best = 1;
    D.factions.forEach((_f, i) => {
      if (s[FAC] >> i & 1) best = Math.min(best, FAC_RANK[i]);
    });
    return 2 + best - (s[PUR] >> HITECH & 1 ? 0.5 : 0);
  }
  return 4 - Math.min(1, worth(s) / RICH_MIN);
}

function drawSystems(rows, src){
  const pad = 40;
  for (const row of rows){
    const [wx, wz] = src.at(row);
    const px = sx(wx), py = sy(wz);
    if (px < -pad || px > W + pad || py < -pad || py > H + pad) continue;
    const a = src.alpha ? src.alpha(row) : 1;
    ctx.globalAlpha = a;
    if (!src.ok(row)) continue;
    src.kept?.(row);
    const v = src.value(row);
    const cr = v == null ? 0 : (F.oneHop ? v.oneHop : v.arrival);
    dot(px, py, markFill(cr, src.plain(row)),
        (typeof src.r === "function" ? src.r(row, cr) : src.r) || DOT_R);
    src.mark?.(row, px, py, a);
    ctx.globalAlpha = a;
    src.label?.(row, px, py, v);
  }
  ctx.globalAlpha = 1;
}


// The rim of the galaxy: the hull of every cell the density map lights, which
// is the outermost place a system can exist.
// The shape of populated space, and the edge everything else stops at: a sector
// border across empty space is a line about nothing.
function outlinePath(){
  ctx.beginPath();
  for (const [x, z] of D.outline) ctx.lineTo(sx(x), sy(z));
  ctx.closePath();
}

function drawOutline(){
  if (!D.outline) return;
  ctx.save();
  ctx.strokeStyle = "rgba(53,224,245,.18)";
  ctx.lineWidth = 1;
  outlinePath();
  ctx.stroke();
  ctx.restore();
}

// The galaxy's own partition: twelve wedges of thirty degrees from Sol, cut into
// rings ten thousand light years deep. Every generated system is named for the
// sector it sits in, so this is the layer that turns a name a mission gave you
// into somewhere to look.
// Where a sector's name belongs: the middle of the part of it that has stars in
// it, averaged over its own lit cells at build time. The geometric middle of a
// wedge and ring is often empty space, and the game's own centre is authoritative
// for counting cell names from but a handful of those land outside the sector
// entirely. A label follows neither.
const sectorMiddle = i => D.sectorLabel[i];

// The first letter of each pair in a cell name is its base-26 high digit, so it
// steps every 26 cells: 1,137 ly. These are the lines where that letter changes,
// for the sector under the middle of the view.
const LETTER_STEP = 26;
function drawLetterGrid(){
  const at = hoverCell();
  if (!at) return;
  const i = sectorId(at[0], at[1]);
  const axx = D.sectorAnchors.x[i], ayy = D.sectorAnchors.y[i];
  // -1 means the sector never got one. A centre can legitimately be negative:
  // Prime's is cell -348, well outside the grid and its own sector.
  if (axx === -1) return;
  const zone = (i / 8) | 0, ring = i % 8;
  const a0 = zone * Math.PI / 6, a1 = a0 + Math.PI / 6;
  const r0 = ring * 10000 * scale, r1 = r0 + 10000 * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx(0), sy(0), r1, a0, a1);
  ctx.arc(sx(0), sy(0), Math.max(r0, 0), a1, a0, true);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = "rgba(110,231,168,.14)";
  ctx.lineWidth = 1;
  // The pointer's pair prefix names a 26-by-26 block of cells, and the same
  // prefix names one such block in each quadrant: the offset is a magnitude, so
  // four places answer to it at once. Outlining all four is the whole scheme in
  // one picture.
  const nx = Math.floor(Math.abs(axx - at[0]) / LETTER_STEP);
  const ny = Math.floor(Math.abs(ayy - at[1]) / LETTER_STEP);
  const span = LETTER_STEP - 1, wide = LETTER_STEP * CELL_LY * scale;
  // dx = anchor - cell, so a positive offset band lies below the anchor.
  const colX = sg => sg > 0 ? axx - nx * LETTER_STEP - span : axx + nx * LETTER_STEP;
  const rowY = sg => sg > 0 ? ayy - ny * LETTER_STEP - span : ayy + ny * LETTER_STEP;
  const SG = [1, -1];
  const pxOf = c => sx((c - 1025) * CELL_LY), pyOf = c => sy((1591 - c) * CELL_LY);
  ctx.strokeStyle = "rgba(110,231,168,.5)";
  ctx.fillStyle = "rgba(110,231,168,.9)";
  // The mirror of the pointer's own cell in each block: same offset, different
  // quadrant, so the name differs only in its last letter.
  const sgxP = axx - at[0] > 0 ? 1 : -1, sgyP = ayy - at[1] > 0 ? 1 : -1;
  const inX = at[0] - colX(sgxP), inY = at[1] - rowY(sgyP);
  const names = [];
  for (const sgx of SG) for (const sgy of SG){
    ctx.strokeStyle = "rgba(110,231,168,.5)";
    ctx.strokeRect(pxOf(colX(sgx)), pyOf(rowY(sgy)), wide, wide);
    if (sgx === sgxP && sgy === sgyP) continue;
    const cx = colX(sgx) + (sgx === sgxP ? inX : span - inX);
    const cy = rowY(sgy) + (sgy === sgyP ? inY : span - inY);
    names.push([`${D.sectorAnchors.sectors[i]} ${sectorName(cx, cy).sector}`,
                pxOf(cx) + Math.max(CELL_LY * scale, 3) + 6, pyOf(cy) + 13]);
  }
  // Outside the sector clip: a name that runs past the sector edge is still the
  // name of a cell inside it.
  ctx.restore();
  ctx.save();
  ctx.font = '13px "JetBrains Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  for (const [t, px, py] of names) ctx.fillText(t, px, py);
  ctx.restore();
}

function drawSectors(chart){
  const cx0 = sx(0), cy0 = sy(0);
  ctx.save();
  if (D.outline){ outlinePath(); ctx.clip(); }
  ctx.strokeStyle = "rgba(79,195,255,.22)";
  ctx.lineWidth = 1;
  // To the edge of the galaxy, not to the edge of the screen: a wedge is the
  // same wedge however close you are standing to it.
  const far = GALAXY_LY;
  for (let z = 0; z < 12; z++){
    const a = z * Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(cx0, cy0);
    ctx.lineTo(sx(Math.cos(a) * far), sy(Math.sin(a) * far));
    ctx.stroke();
  }
  for (let r = 1; r <= 8; r++){
    const rr = r * 10000 * scale;
    if (rr < 8 || rr > Math.hypot(W, H) * 2) continue;
    ctx.beginPath(); ctx.arc(cx0, cy0, rr, 0, 6.283); ctx.stroke();
  }
  // Every sector's quadrant lines, clipped to the sector they divide. A divider
  // means nothing outside its own wedge and ring, because the cell names it
  // governs are counted from that sector's centre and no other.
  if (!chart){
  // Only the sector the pointer is in. Ninety-six crosses at once is a grid
  // nobody can read, and the quadrant only matters for the sector being asked
  // about.
  const hov = hoverCell();
  const only = hov ? sectorId(hov[0], hov[1]) : -1;
  ctx.font = 'bold 12px "JetBrains Mono", monospace';
  D.sectorAnchors.x.forEach((axx, i) => {
    if (axx === -1 || !D.sectorLive[i] || i !== only) return;
    const ayy = D.sectorAnchors.y[i];
    const zone = (i / 8) | 0, ring = i % 8;
    const a0 = zone * Math.PI / 6, a1 = a0 + Math.PI / 6;
    const r0 = ring * 10000 * scale, r1 = r0 + 10000 * scale;
    const px = sx((axx - 1025) * CELL_LY), py = sy((1591 - ayy) * CELL_LY);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx0, cy0, r1, a0, a1);
    ctx.arc(cx0, cy0, Math.max(r0, 0), a1, a0, true);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = "rgba(255,171,61,.45)";
    ctx.beginPath();
    // Far past the viewport in both directions: the clip decides where these
    // end, so the line reaches its sector's boundary rather than the screen's.
    const FAR = 1e5;
    ctx.moveTo(px, -FAR); ctx.lineTo(px, FAR);
    ctx.moveTo(-FAR, py); ctx.lineTo(FAR, py);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,171,61,.8)";
    ctx.fillText("B", px - 32, py - 16);
    ctx.fillText("C", px - 32, py + 26);
    ctx.fillText("E", px + 20, py - 16);
    ctx.fillText("D", px + 20, py + 26);
    ctx.restore();
  });
  }
  ctx.restore();
  // Through the same queue as every other name, so a sector and a system never
  // print over one another.
  const A = D.sectorAnchors, seen = new Set();
  A.sectors.forEach((name, i) => {
    // Thirty-eight of the ninety-six hold nothing at all.
    if (A.x[i] === -1 || !D.sectorLive[i] || seen.has(name)) return;
    seen.add(name);
    const mid = sectorMiddle(i);
    if (!mid) return;
    const px = sx(mid[0]), py = sy(mid[1]);
    if (px < 0 || px > W || py < 0 || py > H) return;
    label(px, py, 0.5, "sector:" + name, [[name, "rgba(79,195,255,.75)"]], true);
  });
}

// A generated name is three things at three scales: the sector it sits in, the
// cell's offset from that sector's anchor, and the star's index in the cell.
// Zullus Dm-Bb C21 is the 21st star of cell Dm-Bb C in Zullus. So the map draws
// the cell grid where cells are big enough to carry their own half of the name,
// and a system there needs only its index.
const CELL_GRID_LY = 1000;
// Where the pointer is, which is what the reader is asking about. The middle of
// the view is where the map happens to be looking; the pointer is where they are
// looking, and the cell and the letter lines belong to that.
let hoverX = null, hoverY = null;
// A cell is the square from its own corner outwards, so the index is the floor
// of the position, not the nearest one.
const hoverCell = () => hoverX == null ? null
  : [Math.floor(wxOf(hoverX) / CELL_LY + 1025), Math.floor(1591 - wzOf(hoverY) / CELL_LY)];
// The widest band. Above this the map is a chart of the galaxy rather than of
// its stars: where the sectors are, where the game marks a place, where you
// cannot earn anything, and which systems a gate joins. Nothing else.
const CHART_LY = 60000;
const chartOnly = () => acrossLy() >= CHART_LY;
// True only when the cells are actually labelled, because that is the whole
// reason a system may shorten its name to an index.
const cellGridOn = () => HL.sectors && acrossLy() <= CELL_GRID_LY;

const QUAD = (dx, dy) => (dx < 0 && dy > 0) ? "E" : (dx > 0 && dy > 0) ? "B"
                       : (dx < 0 && dy < 0) ? "D" : (dx > 0 && dy < 0) ? "C" : "B";
const QUAD_TINT = {B: "rgba(79,195,255,.05)", C: "rgba(255,171,61,.05)",
                   D: "rgba(110,231,168,.05)", E: "rgba(214,120,255,.05)"};

// No pointer on a touch screen, so the middle of the map area stands in for one:
// pan the map and whatever lands under the cross becomes the destination.
function drawDowseCross(){
  if (!dowsingTouch()) return;
  const mx = W / 2, my = H / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(79,195,255,.65)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx - 14, my); ctx.lineTo(mx - 4, my);
  ctx.moveTo(mx + 4, my); ctx.lineTo(mx + 14, my);
  ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my - 4);
  ctx.moveTo(mx, my + 4); ctx.lineTo(mx, my + 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, 20, 0, 6.283);
  ctx.strokeStyle = "rgba(79,195,255,.25)";
  ctx.stroke();
  ctx.restore();
}

// Where the pointer is, under and left of it: the tooltip opens down and right,
// and a name sits to the right of its own dot, so this is the one corner that
// stays clear.
function drawCursorPlace(){
  if (hoverX == null || TOUCH) return;
  ctx.save();
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(188,219,230,.40)";
  ctx.fillText(`${Math.round(wxOf(hoverX)).toLocaleString()}, `
               + `${Math.round(wzOf(hoverY)).toLocaleString()}`,
               hoverX - 12, hoverY + 16);
  ctx.restore();
}

function drawNaming(){
  const x0 = Math.floor(wxOf(0) / CELL_LY + 1025), x1 = Math.ceil(wxOf(W) / CELL_LY + 1025);
  const y0 = Math.floor(1591 - wzOf(0) / CELL_LY), y1 = Math.ceil(1591 - wzOf(H) / CELL_LY);
  // The cell under the pointer, at any zoom: it is the unit the whole naming
  // scheme counts in, and the reader is asking about where they are pointing.
  {
    const at = hoverCell();
    if (!at) return;
    const [mx, my] = at;
    const px = sx((mx - 1025) * CELL_LY), py = sy((1591 - my) * CELL_LY);
    const wide = Math.max(CELL_LY * scale, 3);
    ctx.save();
    ctx.strokeStyle = "rgba(188,219,230,.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(px, py, wide, wide);
    const wx = wxOf(hoverX), wz = wzOf(hoverY);
    const ly = Math.round(Math.hypot(wx, wz)).toLocaleString();
    ctx.font = '13px "JetBrains Mono", monospace';
    ctx.fillStyle = INK;
    ctx.fillText(`${D.sectorAnchors.sectors[sectorId(mx, my)]} ${sectorName(mx, my).sector}`,
                 px + wide + 6, py + 13);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(188,219,230,.55)";
    ctx.fillText(`${Math.round(wx).toLocaleString()}, ${Math.round(wz).toLocaleString()}`
                 + `  \u00b7  ${ly} ly from Sol`, px + wide + 6, py + 28);
    // The outlined blocks: every name in them shares the pointer's pair prefix.
    // It describes the blocks, so it goes when they do.
    if (!HL.sectors){ ctx.restore(); return; }
    const j = sectorId(mx, my);
    const pair = n => String.fromCharCode((n / 26 | 0) + 65) + String.fromCharCode(n % 26 + 97);
    const band = v => Math.floor(Math.abs(v) / LETTER_STEP) * LETTER_STEP;
    const bx = band(D.sectorAnchors.x[j] - mx), by = band(D.sectorAnchors.y[j] - my);
    ctx.fillStyle = "rgba(110,231,168,.8)";
    ctx.fillText(`${pair(bx)}-${pair(by)} \u2192 ${pair(bx + 25)}-${pair(by + 25)}`
                 + `  in all four quadrants`, px + wide + 6, py + 43);
    ctx.restore();
  }
}

function drawCells(){
  const x0 = Math.floor(wxOf(0) / CELL_LY + 1025), x1 = Math.ceil(wxOf(W) / CELL_LY + 1025);
  // Screen y grows downward and world z grows upward, so the top of the view is
  // the lower cell index.
  const y0 = Math.floor(1591 - wzOf(0) / CELL_LY), y1 = Math.ceil(1591 - wzOf(H) / CELL_LY);
  if ((x1 - x0) * (y1 - y0) > 4000) return;
  ctx.save();
  ctx.strokeStyle = "rgba(79,195,255,.10)";
  ctx.lineWidth = 1;
  for (let cx = x0; cx <= x1; cx++){
    const px = sx((cx - 1025) * CELL_LY);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }
  for (let cy = y0; cy <= y1; cy++){
    const py = sy((1591 - cy) * CELL_LY);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
  }
  ctx.restore();
  // A value filter is asking about systems, and its figures get the ground.
  if (valueAsked()) return;
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++){
      const px = sx((cx - 1025) * CELL_LY), py = sy((1591 - cy) * CELL_LY);
      label(px - 6, py + 14, 0.6, `cell:${cx},${cy}`,
            [[sectorName(cx, cy).sector, "rgba(79,195,255,.5)"]]);
    }
}

// Nothing inside these pays to scan, and the map otherwise gives no hint of
// where they end. Sol's bubble and The Void's, from globalSettings.
function drawExplored(){
  soloA("explored");
  const MIN_R = 13;
  for (const [cx0, cz0, ly] of [[0, 0, 300], [VOID_X, VOID_Z, 150]]){
    // Across the whole galaxy these are two pixels wide. Below a readable size
    // the circle stops being a boundary and becomes a mark saying one is here,
    // so it is drawn solid and brighter rather than as a dash nobody can see.
    const real = ly * scale, small = real < MIN_R;
    ctx.strokeStyle = small ? "rgba(95,127,142,.75)" : "rgba(95,127,142,.30)";
    ctx.lineWidth = small ? 1.5 : 1;
    ctx.setLineDash(small ? [] : [3, 5]);
    ctx.beginPath();
    ctx.arc(sx(cx0), sy(cz0), Math.max(real, MIN_R), 0, 6.283);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// The places the game itself marks on its galaxy map. The near ones are where
// anybody starts; the far ones, and the system holding the Preon star, are
// discoveries, so they wait for spoilers.
const LANDMARK_KNOWN_LY = 5000;
// Filters that put a figure beside every match. Their labels need the ground a
// landmark's name would take.
const figuresShown = () => F.ore >= 0 || F.mat >= 0 || valueAsked()
  || filters.has("wreck") || filters.has("sellsBlack");
function drawPoints(){
  if (figuresShown()) return;
  ctx.globalAlpha = solo ? DIM : 1;
  ctx.fillStyle = "rgba(255,171,61,.85)";
  ctx.font = '600 11px "Oxanium", sans-serif';
  for (const [n, mx, my, desc] of D.points){
    if (!spoilers && Math.hypot(mx, my) > LANDMARK_KNOWN_LY) continue;
    const px = sx(mx), py = sy(my);
    if (px < 0 || px > W || py < 0 || py > H) continue;
    ctx.beginPath(); ctx.arc(px, py, 3, 0, 6.283); ctx.stroke();
    ctx.fillText(desc.toUpperCase(), px + 8, py - 6);
  }
  ctx.globalAlpha = 1;
}

// A gate is a shortcut between two systems, so both ends are worth marking:
// at the widest zooms the line is all there is to say a system matters.
// Each gate's two ends, by name, so either can offer the trip to the other.
const gateOther = new Map();
for (const [a, b] of D.gates || []){ gateOther.set(a, b); gateOther.set(b, a); }

// Both ends of every gate: whichever one you are looking at, the button offers
// the trip the gate exists for.
const GATE_ENDS = [...gateOther.keys()];
// Close enough that a system is a place rather than a dot. The Core-side ends
// sit among hundreds of other systems, so their buttons wait until the view is
// tight enough for that not to be clutter.
const GATE_BUTTON_LY = 15000;
const GATE_NEAR_LY = 175;
// The end of each pair closer to Sol.
const gateNear = new Set();
for (const [a, b] of D.gates || []){
  const A = byName.get(a), B = byName.get(b);
  if (A && B) gateNear.add(A[LY] <= B[LY] ? a : b);
}
// Buttons drawn on the map this frame, in screen coordinates.
let mapButtons = [];

function drawGateButtons(){
  mapButtons = [];
  if (acrossLy() > GATE_BUTTON_LY) return;
  ctx.save();
  ctx.font = '600 16px "JetBrains Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const name of GATE_ENDS){
    const here = byName.get(name), there = byName.get(gateOther.get(name));
    if (!here || !there) continue;
    if (gateNear.has(name) && acrossLy() > GATE_NEAR_LY) continue;
    const px = sx(here[X]), py = sy(here[Z]);
    if (px < -200 || px > W + 200 || py < -100 || py > H + 100) continue;
    const text = fmt("jumpToGate", {sys: there[NAME]});
    const w = ctx.measureText(text).width + 22, h = 26;
    const x = px - w / 2, y = py - 34 - h;
    ctx.fillStyle = "rgba(8,18,34,.92)";
    ctx.strokeStyle = "rgba(255,171,61,.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
    // The line down to the system it belongs to, so the button is clearly its.
    ctx.beginPath();
    ctx.moveTo(px, y + h); ctx.lineTo(px, py - 8);
    ctx.stroke();
    ctx.fillStyle = "#ffab3d";
    ctx.fillText(text, px, y + h / 2 + 1);
    mapButtons.push({x0: x, y0: y, x1: x + w, y1: y + h, to: there});
  }
  ctx.restore();
  ctx.textBaseline = "alphabetic";
}

function drawGates(){
  soloA("gate");
  ctx.strokeStyle = "rgba(255,171,61,.7)"; ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 5]);
  const ends = [];
  for (const [a, b] of D.gates){
    const A = byName.get(a), B = byName.get(b);
    if (!A || !B) continue;
    ctx.beginPath();
    ctx.moveTo(sx(A[X]), sy(A[Z])); ctx.lineTo(sx(B[X]), sy(B[Z]));
    ctx.stroke();
    ends.push(A, B);
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffab3d";
  for (const e of ends){
    ctx.beginPath();
    ctx.arc(sx(e[X]), sy(e[Z]), 3, 0, 6.283);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The nearest systems to Sol, per faction, with a station of that faction
// within reach of the arrival point: where reputation comes cheapest.
let repKey = "";
function renderRepList(){
  const limit = F.stLs ?? REP_LS;
  const key = limit + "|" + lang;
  if (key === repKey) return;
  repKey = key;
  const box = document.getElementById("repList");
  box.innerHTML = "";
  D.factions.forEach((fac, i) => {
    const hits = [];
    for (const s of S){
      const near = (D.stations[s[NAME]] || []).filter(st => st[2] === fac && st[4] <= limit);
      if (near.length) hits.push([s, near.reduce((a, b) => a[4] <= b[4] ? a : b)]);
    }
    hits.sort((a, b) => a[0][LY] - b[0][LY]).splice(5);
    if (!hits.length) return;
    const h = document.createElement("p");
    h.className = "note"; h.textContent = t(D.factionKeys[i]);
    box.append(h);
    for (const [s, st] of hits){
      const b = document.createElement("button");
      b.type = "button"; b.className = "pill rep";
      b.innerHTML = `<b>${s[NAME]}</b> <span class="muted">${num(Math.round(s[LY]))} ly \u00b7 ` +
                    `${st[0]} \u00b7 ${num(st[4])} ls</span>`;
      b.onclick = () => focusOn(s);
      box.append(b);
    }
  });
}

function draw(){
  clampView();
  renderRepList();
  const n = filterCount();
  document.getElementById("fCount").textContent = n ? n : "";
  document.getElementById("ctr").textContent =
    num(Math.round(cx)) + ", " + num(Math.round(cz));
  ctx.fillStyle = "#04060e"; ctx.fillRect(0, 0, W, H);
  labelCells.clear();
  const chart = chartOnly();
  if (!chart) drawGrid();
  drawOutline();
  if (HL.sectors){
    drawSectors(chart);
    if (!chart) drawLetterGrid();
    if (!chart && cellGridOn()) drawCells();
  }
  if (!chart) drawNaming();
  drawCursorPlace();
  drawDowseCross();

  drawGates();

  visible = [];
  routeNames();
  if (chart){
    drawGates();
    drawExplored();
    drawPoints();
    drawRoute();
    drawLabels();
    drawFlashBox();
    drawOverlays();
    mapButtons = [];
    return finish();
  }
  // Wide enough that individual systems are not drawn, only the valuable ones.
  // The catalogue is cheap to draw and the rest of the galaxy is not, which is a
  // fact about this program rather than about the galaxy, so it earns its place
  // the same way everything else does.
  // Wide enough that the generated field is thinned, so the catalogue is held
  // to the same bargain: only the valuable ones, at the same size a generated
  // star gets, because a catalogued system is not a bigger star.
  const wide = genThin();
  drawSystems(S, {
    r: (s, cr) => cr >= RICH_MIN ? GOLD_R() : DOT_SM(),
    at: s => [s[X], s[Z]],
    kept: s => visible.push(s),
    // The journey is drawn at any zoom. Everything else earns its place.
    ok: s => passes(s)
          && (!wide || worth(s) >= RICH_MIN || onRoute.has(s[NAME])),
    alpha: soloRow,
    plain: s => PAL[s[TY]],
    value: systemValue,
    // Only the catalogue has stations, engineers and shops to draw.
    mark(s, px, py, a){
      // One of these five holds the wreck, and which is not knowable from
      // outside the save: a ring around all of them, sized by the odds.
      if (filters.has("wreck") && WRECKS.has(s[NAME])){
        const odds = WRECKS.get(s[NAME]);
        ctx.save();
        ctx.strokeStyle = "#ffab3d";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 6 + odds / 5, 0, 6.283);
        ctx.stroke();
        ctx.restore();
      }
      const flagEng = s[EN] && spoilers;
      if (solo) ctx.globalAlpha = solo === "station" || solo === "eng"
                                || solo.startsWith("fac:") ? a : DIM;
      if (s[ST] || flagEng) hex(px, py, 7, flagEng ? "#ffab3d" : ringColour(s));
      if (solo) ctx.globalAlpha = solo === "chev" ? a : DIM;
      if (F.module >= 0){
        const stock = D.sysModules[s[NAME]];
        if (stock){
          ctx.fillStyle = "#6ee7a8";
          ctx.font = '700 11px "JetBrains Mono", monospace';
          ctx.fillText(stock[0].includes(F.module) ? "\u203a\u203a" : "\u203a",
                       px + 6, py - 5);
        }
      }
    },
    // Names claim their ground before generated space is offered any, so they
    // are collected here and drawn once the loop is done.
    label(s, px, py, v){
      const r = rank(s), key = s[NAME];
      if (F.ore >= 0){
        const shown = deepDigit(F.ore) ? (s[ORE] >> F.ore & 1 ? DEEP_TONS : "") : orePct(s, F.ore) && orePct(s, F.ore) + "%";
        if (shown) label(px, py, r, key, [[shown + "  ", ORE_INK], [s[NAME], INK]]);
      } else if (F.mat >= 0){
        const span = matSpan(s, F.mat);
        if (span) label(px, py, r, key, [[spanText(span) + "  ", ORE_INK], [s[NAME], INK]]);
      // Which of the five it is was decided when the save was made, so the odds
      // are the only thing the map can say, and they are worth saying at any
      // width the chip is on.
      } else if (filters.has("wreck") && WRECKS.has(s[NAME])){
        label(px, py, -1, key,
              [[s[NAME] + "  ", INK], [WRECKS.get(s[NAME]) + "%", ORE_INK]]);
      // Asking where the contraband is asks which half of the turnover it is in.
      } else if (filters.has("sellsBlack") && (tradeOf(s) & 1)){
        label(px, py, r, key,
              [[blackHalf(tradeOf(s)) + "  ", ORE_INK], [s[NAME], INK]]);
      // Stations, engineers and Sol earn a name early; everything else gets one
      // at the zoom where generated stars are named too. Asking about value is
      // asking it of every match.
      } else if (valueAsked()){
        const name = s[AUTH] ? s[NAME] : "";
        label(px, py, r, key,
              [[name, INK], [(name ? "  " : "") + worthLabel(v), VALUE_INK]]);
      } else if (scale > 4 || onRoute.has(s[NAME])
                 || (scale > 2.2 && (s[ST] || s[EN] || s[LY] === 0))){
        label(px, py, r, key, [[s[NAME], INK]]);
      }
    },
  });
  // The percentage leads in amber, the system name follows in the usual ink.
  // Named systems claim their ground before the generated ones are offered any.
  drawExplored();
  drawPoints();

  ctx.globalAlpha = solo && solo !== "star" ? DIM : 1;
  drawGenerated();
  ctx.globalAlpha = solo ? DIM : 1;
  drawRoute();
  drawFlashBox();
  drawOverlays();
  // Last, so every source has had its say about what deserves a name.
  drawLabels();
  drawGateButtons();
  ctx.globalAlpha = 1;

  if (focused.length){
    // One pulse, then it stops drawing itself. The map already labels the
    // systems, so the rings carry no text.
    const t = (performance.now() - focusStart) / FLASH_MS;
    const a = Math.max(0, calm ? 1 - t : Math.abs(Math.sin(t * Math.PI * FLASHES)));
    ctx.save();
    ctx.strokeStyle = "#35e0f5"; ctx.lineWidth = 1.6;
    for (const s of focused){
      const px = sx(s[X]), py = sy(s[Z]);
      if (px < 0 || px > W || py < 0 || py > H) continue;
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(px, py, 14, 0, 6.283); ctx.stroke();
      ctx.globalAlpha = a * .4;
      ctx.beginPath(); ctx.arc(px, py, 22 + (1 - a) * 6, 0, 6.283); ctx.stroke();
    }
    ctx.restore();
  }

  finish();
}

function finish(){
  syncURL();
  document.getElementById("scl").textContent = num(Math.round(acrossLy()));
}

const portrait = () => matchMedia("(orientation: portrait)").matches;

function placeTip(mx, my){
  document.getElementById("help").style.display = "none";
  if (TOUCH){
    // Docked out of the way: a panel that follows the finger on a small screen
    // always lands on something worth seeing. Portrait has room for the full
    // width; landscape keeps it in the corner so the map stays readable.
    tip.style.top = "auto"; tip.style.bottom = "8px";
    tip.style.left = portrait() ? "8px" : "auto";
    tip.style.right = "8px";
    return;
  }
  tip.style.right = ""; tip.style.bottom = "";
  const r = tip.getBoundingClientRect();
  // The tooltip is positioned in the window; its caller works in canvas space.
  const left = (TOUCH ? mx - r.width / 2 : mx + 16) + inset;
  const top  = TOUCH ? my - r.height - 22 : my + 16;
  tip.style.left = Math.max(8, Math.min(left, window.innerWidth - r.width - 10)) + "px";
  tip.style.top  = Math.max(8, Math.min(top, window.innerHeight - r.height - 10)) + "px";
}

function pickGenerated(mx, my){
  let best = null, bd = TOUCH ? 22 * 22 : 12 * 12;
  for (const st of genVisible){
    const [ax, az] = st.at || [st.x, st.z];
    const dx = sx(ax) - mx, dy = sy(az) - my, d = dx*dx + dy*dy;
    if (d < bd){ bd = d; best = st; }
  }
  return best;
}

// What digging on this system's landable planets can turn up, with the chance a
// dig finds each: its commonness over the planet's three, as low to high across
// the planets that carry it.
const matRow = spans => {
  const parts = Object.entries(spans)
    .map(([k, [lo, hi]]) => [MATS[D.matRaw.indexOf(k)], lo === hi ? `${lo}%` : `${lo}–${hi}%`])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, pct]) => `${name} ${pct}`);
  return parts.length
    ? row("materials", parts.map((p, i) => p + (i === parts.length - 1 ? "" : i % 5 === 4 ? ",<br>" : ", ")).join(""))
    : "";
};
// A catalogue planet with a name gets its own line: its distance from the star and
// its three materials, likeliest first.
const namedMatRows = planets => planets.map(([name, orbit, trio], i) => {
  const total = trio.reduce((s, k) => s + D.matRare[k], 0);
  const mats = trio.map(k => [MATS[D.matRaw.indexOf(k)], Math.round(100 * D.matRare[k] / total)])
    .sort((a, b) => b[1] - a[1]).map(([m, p]) => `${m} ${p}%`).join(", ");
  return `<dt>${i ? "" : ui("materials")}</dt><dd>${name} (${num(orbit)} ls): ${mats}</dd>`;
}).join("");
function matSpans(trios){
  const out = {};
  for (const trio of trios){
    const total = trio.reduce((s, k) => s + D.matRare[k], 0);
    for (const k of trio){
      const pct = Math.round(100 * D.matRare[k] / total);
      const e = out[k] || (out[k] = [pct, pct]);
      e[0] = Math.min(e[0], pct); e[1] = Math.max(e[1], pct);
    }
  }
  return out;
}

// A deep ore is rare enough to lead the tooltip rather than sit among the belt ores.
const deepBanner = has => {
  const i = D.oreRaw.findIndex((_k, j) => deepDigit(j) && has(j));
  return i < 0 ? "" : `<div class="deep"><b>${ORES[i]}</b><span>${fmt("deepBanner", {t: DEEP_TONS})}</span></div>`;
};

function showGenTip(st, mx, my){
  const b = starBodies(st);
  const ore = b.belts.flatMap(belt =>
    belt.ores.map(o => `${t("Goods" + o.name) || o.name} ${o.pct}%`));
  tip.innerHTML = flownLine(st.name) + `<h3>${st.name}${coords(st.x, st.z)}</h3>` +
    deepBanner(i => generatedOrePct(st, i)) + `<dl>` +
    row("starType", t(st.raw + "Name") || st.type) +
    row("security", ui("secAnarchy")) +
    (st.fuel ? row("fuel", "\u2713") : "") +
    row("distance", `${num(Math.round(Math.hypot(st.x, st.z)))} ly`) +
    fromHereRow(st.x, st.z) +
    (b.planets.length
      ? row("planets", b.planets.length + (b.landable ? ` (${b.landable})` : "")) : "") +
    (b.belts.length ? row("belts", b.belts.length) : "") +
    ptypeRow(b.planets.filter(p => p.type === PTYPES[F.ptype]).map(p => [p.name, p.orbit, p.group])) +
    matRow(matSpans(b.planets.map(p => p.mats).filter(m => m.length))) +
    valueRows(st) +
    `</dl>` + (ore.length ? `<div class="ore">${ore.map(o => `<span>${o}</span>`).join("")}</div>` : "");
  tip.style.display = "block";
  placeTip(mx, my);
}

// Whichever kind of row it is, the tooltip for it.
function showTipFor(hit, mx, my){
  if (Array.isArray(hit)) showTip(hit, mx, my); else showGenTip(hit, mx, my);
}

function pick(mx, my){
  let best = null, bd = TOUCH ? 24 * 24 : 14 * 14;
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

// A gate end says whether it is repaired, by the ends ticked under the jump
// range, and how to repair one.
const gateRow = name => !gateOther.has(name) ? "" :
  row("gate", `\u2192 ${gateOther.get(name)} \u00b7 ${ui(gateEndRepaired(name) ? "gateRepaired" : "gateBroken")}` +
    `<br><a href="#" class="gateHow">${ui("gateHowTo")}</a>`);

// With a planet type filtered, where each planet of that type orbits: light
// seconds from its own star, which for a companion's planet is not the primary.
function ptypeRow(orbits){
  if (F.ptype < 0 || !orbits.length) return "";
  orbits.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  return `<dt>${PTYPES[F.ptype]}</dt><dd>` + orbits.map(([name, o, g]) =>
    `${name} \u00b7 ${num(o)} ls` + (g ? ` <span class="muted">${ui("ofCompanion")}</span>` : "")).join(", ") + `</dd>`;
}
function catalogueOrbits(s){
  const flat = D.planetOrbits[s[NAME]] || [], out = [];
  for (let i = 0; i < flat.length; i += 4) if (flat[i] === F.ptype) out.push([flat[i + 3], flat[i + 1], flat[i + 2]]);
  return out;
}

// What the system pays, told as the trip it actually is: a figure banked on
// arrival, and what more is out there for how many flights across the system.
function valueRows(s){
  const v = systemValue(s);
  if (!v.full) return row("explored", ui("yes"));
  let out = row("explored", ui("no")) +
            row("onArrival", `${num(v.arrival)} CR` +
              `<span class="muted"> \u00b7 ${D.scanners[scanner][0]}</span>`);
  if (v.hops) out += row("reachValue",
    `${num(v.reach)} CR <span class="muted">\u00b7 ${plural("hops", v.hops)}</span>`);
  return out;
}

// How far this system is from wherever the journey starts. The straight line is
// free to compute for every system on hover; the real route is a search, so what
// is shown is the floor: no chain of jumps can be shorter than this.
function fromHereRow(x, z){
  if (!routeFrom || (routeFrom.x === x && routeFrom.z === z)) return "";
  const ly = Math.hypot(x - routeFrom.x, z - routeFrom.z);
  return row("fromHere", `${num(Math.round(ly))} ly <span class="muted">\u00b7 ` +
    fmt("atLeastJumps", {jumps: plural("jumps", Math.ceil(ly / jumpLy))}) + `</span>`);
}

// The standing trade facts, where a system has any. The rotating stock is the
// game's own map's job; these are the things it never says.
const TRADE_SLOT = [[4, "oreBuyer"], [8, "trophyBuyer"], [16, "noMarket"]];
// Which half of the named stations is holding contraband turns over every 4,000
// units of goods moved, so the map says which half a station is in rather than
// pretending to know the count.
const blackHalf = m => (m & 32) && (m & 64) ? ui("blackAlways")
                     : (m & 32) ? ui("blackEven") : ui("blackOdd");
function tradeRow(s){
  const m = tradeOf(s);
  const said = TRADE_SLOT.filter(([bit]) => m & bit).map(([, slot]) => ui(slot));
  if (m & 1) said.unshift(`${ui("sellsBlack")} (${blackHalf(m)})`);
  return said.length ? row("trading", said.join(", ")) : "";
}

// Which stations are here, by name and by the model the game draws for them.
// With a module filter on, the one that stocks it is marked.
function stationRows(s){
  const list = D.stations[s[NAME]];
  if (!list || !list.length) return "";
  const rows = list.slice(0, 6).map(([nm, model, fac, purp, ls]) => {
    const stock = F.module >= 0 ? D.purposeStock[purp] : null;
    const mark = !stock ? ""
      : stock[0].includes(F.module) ? ` <b class="chev">\u203a\u203a</b>`
      : stock[1].includes(F.module) ? ` <b class="chev">\u203a</b>` : "";
    return `<dd class="stn">${nm}${mark}<span class="muted"> \u00b7 ` +
           `${t(D.stationModel[model]) || model}${fac ? " \u00b7 " + fac : ""} \u00b7 ${num(ls)} ls</span></dd>`;
  });
  return `<dt>${ui("stations")}</dt>` + rows.join("") +
         (list.length > 6 ? `<dd class="muted">+${list.length - 6}</dd>` : "");
}
// The map's own coordinates, which is how the game labels its grid.
const coords = (x, z) =>
  `<span class="coords">${num(Math.round(x))}, ${num(Math.round(z))}</span>`;

// What the journey to this system costs, at the head of its own tooltip: the
// figure the route note carries, where the reader is already looking.
let routeFlown = "";
// The jump range travels with the figures: the same journey at a different
// range is a different number of jumps, and the reader set it minutes ago.
const flownLine = name =>
  routeFlown && routeTo && routeTo.name === name
    ? `<div class="flown">${routeFlown} \u00b7 ${ui("maxJump")}: ${num(jumpLy)} ly</div>`
    : "";

function showTip(s, mx, my){
  const ore = D.oreDetail[s[NAME]];
  const alias = aliasBySystem.get(indexOfName.get(s[NAME])) || {};
  const aliasRows = ["body", "engineer", "landmark"]
    .filter(k => alias[k] && !(SPOILER_ALIAS.has(k) && !spoilers))
    .map(k => `<dt>${ui(ALIAS_SLOT[k])}</dt><dd>${alias[k].slice(0, 6).join(", ")}` +
              `${alias[k].length > 6 ? ` +${alias[k].length - 6}` : ""}</dd>`)
    .join("");
  // A row is only worth its line when it says something. Nothing the system
  // does not have is listed.
  // A card with a link stays where it opened, so the pointer can reach it.
  const live = gateOther.has(s[NAME]);
  if (live && tip.classList.contains("live") && tip.dataset.sys === s[NAME] && tip.style.display === "block") return;
  tip.classList.toggle("live", live);
  tip.dataset.sys = s[NAME];
  tip.innerHTML = flownLine(s[NAME]) +
    `<h3>${s[NAME]}${coords(s[X], s[Z])}</h3>` +
    deepBanner(i => s[ORE] >> i & 1) + `<dl>` +
    row("starType", TYPES[s[TY]]) +
    row("security", ui(SEC_SLOT[s[SEC]] || "secAnarchy")) +
    (s[FUEL] ? row("fuel", "\u2713") : "") +
    row("distance", `${num(s[LY])} ly`) +
    fromHereRow(s[X], s[Z]) +
    (s[PL] ? row("planets", s[PL] + (s[LA] ? ` (${s[LA]})` : "")) : "") +
    (s[BE] ? row("belts", s[BE]) : "") +
    ptypeRow(catalogueOrbits(s)) +
    (D.namedMats[s[NAME]] ? namedMatRows(D.namedMats[s[NAME]]) : matRow(D.matPct[s[NAME]] || {})) +
    stationRows(s) +
    gateRow(s[NAME]) +
    (factionsOf(s) ? row("faction", factionsOf(s)) : "") +
    tradeRow(s) +
    valueRows(s) +
    (aliasRows ? `<dt class="rule"></dt><dd class="rule"></dd>` + aliasRows : "") +
    `</dl>` +
    (ore ? `<div class="ore">${ore.map(o => `<span>${o}</span>`).join("")}</div>` : "");
  tip.style.display = "block";
  placeTip(mx, my);
}

let drag = null;
// How far a pointer may wander before it counts as a drag. A finger resting on
// glass is never as still as a mouse.
const SLOP = TOUCH ? 10 : 3;
// Every pointer currently down, so a second one can turn a drag into a pinch.
const ptrs = new Map();
let pinch = null;

// Zooming out stops where the galaxy does: past this the view is mostly the
// black around it.
const MAX_OUT_LY = 200000;
// The lattice the galaxy is generated on, in light years: panning stops where
// the stars do rather than out in the black.
const WORLD = {x0: -1025 * CELL_LY, x1: (GRID - 1 - 1025) * CELL_LY,
               z0: (1591 - (GRID - 1)) * CELL_LY, z1: 1591 * CELL_LY};
function clampView(){
  cx = Math.min(WORLD.x1, Math.max(WORLD.x0, cx));
  cz = Math.min(WORLD.z1, Math.max(WORLD.z0, cz));
}

const clampScale = v => Math.max(mapW() / MAX_OUT_LY, Math.min(v, 40));

// A destination only means something once there is somewhere to leave from, so
// the box is not there until the origin resolves to a real system.
function syncToBox(){
  const box = document.getElementById("toBox");
  if (box) box.hidden = !routeFrom;
}

// No platform fires a long-press event, so it is a timer that a drag, a second
// finger or an early lift all cancel.
let pressTimer = 0, pressedEnd = false;
function cancelPress(){ clearTimeout(pressTimer); pressTimer = 0; }
function armPress(x, y){
  cancelPress();
  pressTimer = setTimeout(() => {
    pressTimer = 0;
    const target = pick(x, y) || pickGenerated(x, y);
    if (!target) return;
    pressedEnd = true;
    // The hold has been spent; what follows is finger drift, not a pan. Left
    // armed, the next stray pixel would scroll the map and hide the tooltip.
    drag = null;
    // A long press restarts the journey, the way a double click does.
    routeTo = null;
    document.getElementById("to").value = "";
    setEnd("from", target);
    navigator.vibrate?.(15);
  }, 450);
}

function tipAt(mx, my){
  // Wide out the cell naming overlay is what the pointer is for, and a tooltip
  // under it is two answers to one question.
  if (acrossLy() > SYSTEM_LY / 2){ tip.style.display = "none"; return; }
  const s = pick(mx, my);
  if (s){ clearTimeout(tipHide); showTip(s, mx, my); return; }
  // A card with a link waits a moment, for the pointer on its way to it.
  if (!TOUCH && tip.classList.contains("live") && tip.style.display === "block"){
    clearTimeout(tipHide);
    tipHide = setTimeout(() => { if (!tip.matches(":hover")) hideTip(); }, 400);
    return;
  }
  const gen = pickGenerated(mx, my);
  tip.classList.remove("live");
  gen ? showGenTip(gen, mx, my) : (tip.style.display = "none");
}
let tipHide = 0;
function hideTip(){ tip.style.display = "none"; tip.classList.remove("live"); }
tip.addEventListener("pointerenter", () => clearTimeout(tipHide));
tip.addEventListener("pointerleave", () => { if (!TOUCH) hideTip(); });
// Every "how to repair a gate" link opens the wiki beside the map.
function gateHow(e){
  e.preventDefault();
  document.getElementById("gatesDlg").close();
  openWiki("Navigation", "Activating warp gates");
}
addEventListener("click", e => { if (e.target.closest && e.target.closest(".gateHow")) gateHow(e); });

cv.addEventListener("pointerdown", e => {
  // The keyboard is in the way of a map being panned.
  if (TOUCH) document.getElementById("to").blur();
  flyStop();   // the map never fights the hand on it
  ptrs.set(e.pointerId, {x: evX(e), y: e.clientY});
  if (ptrs.size === 2){
    drag = null;
    const [a, b] = [...ptrs.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinch = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale,
             wx: wxOf(mx), wz: wzOf(my)};
    tip.style.display = "none";
  } else if (ptrs.size === 1){
    drag = {x: evX(e), y: e.clientY, cx, cz, moved: false};
    if (TOUCH) armPress(evX(e), e.clientY);
  }
  if (ptrs.size > 1) cancelPress();
  cv.setPointerCapture(e.pointerId);
});
// A route that follows the pointer, while the destination box is focused and
// still empty: whatever is under the cursor becomes the destination. Typing
// anything ends it, because then the box is the one choosing.
let dowseAt = 0, dowseTimer = 0;
// With an origin set and no destination settled, the map plots to whatever the
// pointer is over -- the crosshair at the centre, on a touch screen, since a pan
// is what a hover is there. A destination chosen this way is provisional: it
// keeps the gesture armed until a click or a tap settles on one.
let dowseProvisional = false;
let showNotes = () => {};
const dowsing = () => !!routeFrom && (!routeTo || dowseProvisional);
const dowsingTouch = () => TOUCH && dowsing();

function dowseCross(){
  // Held to the same rate as the pointer version, because a pan fires a move a
  // frame and the search is not free.
  if (performance.now() - dowseAt < 100) return;
  dowseAt = performance.now();
  const mx = W / 2, my = H / 2;
  const hit = pick(mx, my) || pickGenerated(mx, my);
  if (!hit) return;
  const end = endpointOf(hit);
  if (routeTo && routeTo.name === end.name) return;
  routeTo = end;
  dowseProvisional = true;
  recomputeRoute();
  // A pan is this device's hover, so the destination it lands on describes
  // itself the way a hovered one does.
  if (TOUCH && acrossLy() <= SYSTEM_LY / 2) showTipFor(hit, W / 2, H / 2);
}

function dowse(x, y){
  if (TOUCH || !dowsing()) return;
  clearTimeout(dowseTimer);
  const wait = Math.max(0, 100 - (performance.now() - dowseAt));
  dowseTimer = setTimeout(() => {
    const hit = pick(x, y) || pickGenerated(x, y);
    if (!hit) return;
    const end = endpointOf(hit);
    if (routeTo && routeTo.name === end.name) return;
    dowseAt = performance.now();
    routeTo = end;
    dowseProvisional = true;
    recomputeRoute();
  }, wait);
}

cv.addEventListener("pointermove", e => {
  // Before the drag and pinch branches, which return early: the pointer is where
  // it is whether or not it is dragging, and everything that follows it would
  // otherwise stay where the drag began.
  if (!TOUCH){ hoverX = evX(e); hoverY = e.clientY; dowse(evX(e), e.clientY); }
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, {x: evX(e), y: e.clientY});
  if (pinch && ptrs.size >= 2){
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!d) return;
    // The point between the fingers holds still while the scale changes.
    scale = clampScale(pinch.scale * d / pinch.d);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    cx = pinch.wx - (mx - W / 2) / scale;
    cz = pinch.wz + (my - H / 2) / scale;
    draw();
    return;
  }
  if (drag){
    const dx = evX(e) - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > SLOP){ drag.moved = true; cancelPress(); }
    cx = drag.cx - dx / scale; cz = drag.cz + dy / scale;
    tip.style.display = "none";
    draw();
    // The cross is the pointer here, and it has just moved over new ground.
    if (dowsingTouch()) dowseCross();
    return;
  }
  if (TOUCH) return;
  draw();
  document.getElementById("cur").textContent =
    num(Math.round(wxOf(evX(e)))) + ", " + num(Math.round(wzOf(e.clientY)));
  tipAt(evX(e), e.clientY);
});

function endPointer(e){
  cancelPress();
  const many = ptrs.size > 1 || pinch;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  const wasDrag = drag && drag.moved;
  drag = null;
  // A pan is the touch version of hovering: the cross is the pointer, and the
  // pan is over, so this is the moment to plot.
  // A pan has been plotting all along, and the last frame of it is the answer.
  if (wasDrag && dowsingTouch()){ dowseAt = 0; dowseCross(); }
  if (many || ptrs.size || wasDrag || e.type === "pointercancel") return;
  if (e.target !== cv) return;
  if (TOUCH){
    // The lift that ends a long press is not also a tap.
    if (pressedEnd){ pressedEnd = false; return; }
    tipAt(evX(e), e.clientY);
  }
  const btn = mapButtons.find(b => evX(e) >= b.x0 && evX(e) <= b.x1
                                && e.clientY >= b.y0 && e.clientY <= b.y1);
  if (btn){ clearFocus(); focusOn(btn.to, 14, flyPath); return; }
  const hit = pick(evX(e), e.clientY)
            || pickGenerated(evX(e), e.clientY);
  // A tap is a decision: the destination stops being provisional and the
  // gesture stands down.
  if (hit){ dowseProvisional = false; setEnd(routeFrom == null ? "from" : "to", hit); }
}
addEventListener("pointerup", endPointer);
addEventListener("pointercancel", endPointer);
// Double click restarts the journey: new origin, no destination, no route. It
// runs after the single click has already filled an end, and overwrites it.
cv.addEventListener("dblclick", e => {
  e.preventDefault();
  const target = pick(evX(e), e.clientY)
               || pickGenerated(evX(e), e.clientY);
  if (!target) return;
  routeTo = null;
  document.getElementById("to").value = "";
  setEnd("from", target);
});
cv.addEventListener("contextmenu", e => e.preventDefault());
// A tap on the tooltip dismisses it and goes no further.
for (const el of [tip, document.getElementById("help")])
  for (const type of ["pointerdown", "pointerup", "click"])
    el.addEventListener(type, e => {
      e.stopPropagation();
      // Its one link is the exception: it opens the wiki and leaves the card up.
      if (e.target.closest && e.target.closest(".gateHow")){ if (type === "click") gateHow(e); return; }
      if (type === "pointerup") el.style.display = "none";
    });
cv.addEventListener("pointerleave", e => {
  if (!TOUCH && !(e.relatedTarget && tip.contains(e.relatedTarget))) hideTip();
});

cv.addEventListener("wheel", e => {
  flyStop();
  e.preventDefault();
  const wx = wxOf(evX(e)), wz = wzOf(e.clientY);
  scale *= Math.exp(-e.deltaY * .0016);
  scale = clampScale(scale);
  // The pointer has not moved but what is under it has, so the tooltip is about
  // to describe a system that is no longer there.
  if (!TOUCH) requestAnimationFrame(() => tipAt(evX(e), e.clientY));
  cx = wx - (evX(e) - W / 2) / scale;
  cz = wz + (e.clientY - H / 2) / scale;
  tip.style.display = "none";
  draw();
}, {passive: false});

function goto(x, z, sc){ scale = sc; cx = x; cz = z; draw(); }

// Flying the view somewhere, as a critically damped spring rather than a timed
// ease. A spring carries velocity, so a new destination mid-flight curves into
// the old one instead of restarting, which is what typing a name does. Critical
// damping means it never overshoots: the thing you were looking for does not
// leave the screen and come back.
//
// Zoom travels in log space, because scale is multiplicative -- that is what
// keeps the apparent speed of a long flight close to that of a short one.
const FLY_TAU = 0.18;                  // seconds; settles in about half a second
// Zoom and pan must not converge together. Arriving at the target scale before
// arriving at the target place means crossing the galaxy zoomed in, which is the
// streak everyone complains about. So the view retreats quickly and closes in
// slowly: out at less than the travel time, in at several times it.
const FLY_TAU_OUT = FLY_TAU * 0.6;
const FLY_TAU_IN = FLY_TAU * 3;
let flyTo = null, flyV = [0, 0, 0], flyLast = 0, flyRAF = 0;

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// speed divides every time constant: 4 is a flight a quarter as long.
let flySpeed = 1;
function flyView(x, z, sc, speed = 1){
  pathStop();
  sc = clampScale(sc);
  flySpeed = speed;
  // A tooltip describes a system at a position on screen, and the position is
  // about to stop being true.
  tip.style.display = "none";
  document.getElementById("help").style.display = "none";
  if (reducedMotion()){ goto(x, z, sc); return; }
  // The target is the middle of the map area. cx is that minus half the sidebar
  // *at the current scale*, so it cannot be interpolated directly: while the
  // view is still wide that offset is thousands of light years and the flight
  // would swing out to one side before coming back.
  flyTo = [x, z, Math.log(sc)];
  if (!flyRAF){ flyLast = performance.now(); flyRAF = requestAnimationFrame(flyStep); }
}

// The bounds of whatever the search has narrowed to, pulsed once. Same timing as
// a system flash, so the map has one vocabulary for "this is the thing".
let flashBoxes = [], flashWedge = null, flashBoxAt = 0;
// TEMPORARY while the levels are being tuned: the bounds stay up instead of
// pulsing, so what the search reached can be looked at rather than caught.
function flashBounds(boxes, wedges){
  flashBoxes = boxes.length && Array.isArray(boxes[0]) ? boxes : (boxes.length ? [boxes] : []);
  flashWedge = wedges && wedges.length ? wedges : null;
  flashBoxAt = performance.now();
  draw();
}

// The cell a system sits in, as a box in light years.
function cellBoxOf(x, z){
  const cx0 = Math.floor(x / CELL_LY + 1025), cy0 = Math.floor(1591 - z / CELL_LY);
  return boxOf(cx0, cy0, cx0, cy0);
}

// Shapes a link asks the map to draw: `draw={"circle":[x,z,r]}`, in light years,
// or a list of circles. A quest that starts anywhere inside an area is linked
// with that area drawn.
let overlays = {};
function drawOverlays(){
  const circles = overlays.circle || [];
  const list = Array.isArray(circles[0]) ? circles : circles.length ? [circles] : [];
  if (!list.length) return;
  ctx.save();
  ctx.strokeStyle = "#ffb454";
  ctx.fillStyle = "rgba(255,180,84,0.08)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  for (const [x, z, r] of list){
    ctx.beginPath();
    ctx.arc(sx(x), sy(z), Math.max(r * scale, 4), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawFlashBox(){
  if (!flashBoxes.length && !flashWedge) return;
  ctx.save();
  // Nothing is outlined outside populated space: a region's rectangle is drawn
  // from the cells that hold systems, but the rectangle around them can reach
  // past the galaxy's edge.
  if (D.outline){ outlinePath(); ctx.clip(); }
  ctx.strokeStyle = "#35e0f5";
  ctx.lineWidth = 2;
  // A cell is a fraction of a pixel across the galaxy, and a border nobody can
  // see is not an answer. Below a readable size it stops being a boundary and
  // becomes a mark saying the thing you asked for is here.
  // A whole sector is a wedge and a ring, not a rectangle, so it is outlined as
  // the shape it is.
  for (const [zone, ring] of (flashWedge || [])){
    const a0 = zone * Math.PI / 6, a1 = a0 + Math.PI / 6;
    const r0 = ring * 10000 * scale, r1 = r0 + 10000 * scale;
    ctx.beginPath();
    ctx.arc(sx(0), sy(0), r1, a0, a1);
    ctx.arc(sx(0), sy(0), Math.max(r0, 0), a1, a0, true);
    ctx.closePath();
    ctx.stroke();
  }
  // Each axis is floored on its own. A column of cells is a cell wide and two
  // hundred tall: flooring it as a whole throws the height away and draws a
  // square where a column belongs.
  const MIN = 14;
  for (const b of flashBoxes){
    // Clipped to its own sector, because the cells it stands for stop there even
    // though the rectangle around them does not.
    const sec = b.sector;
    if (sec != null){
      ctx.save();
      const zone = (sec / 8) | 0, ring = sec % 8;
      const a0 = zone * Math.PI / 6, a1 = a0 + Math.PI / 6;
      const r0 = ring * 10000 * scale, r1 = r0 + 10000 * scale;
      ctx.beginPath();
      ctx.arc(sx(0), sy(0), r1, a0, a1);
      ctx.arc(sx(0), sy(0), Math.max(r0, 0), a1, a0, true);
      ctx.closePath();
      ctx.clip();
    }
    const w = (b[2] - b[0]) * scale, h = (b[3] - b[1]) * scale;
    const px = sx((b[0] + b[2]) / 2), py = sy((b[1] + b[3]) / 2);
    const dw = Math.max(w, MIN), dh = Math.max(h, MIN);
    ctx.strokeRect(px - dw / 2, py - dh / 2, dw, dh);
    // Ticks only when there is nothing else to see: a mark saying it is here.
    if (w >= MIN || h >= MIN){ if (sec != null) ctx.restore(); continue; }
    ctx.beginPath();
    ctx.moveTo(px - MIN, py); ctx.lineTo(px - MIN / 2 - 3, py);
    ctx.moveTo(px + MIN / 2 + 3, py); ctx.lineTo(px + MIN, py);
    ctx.moveTo(px, py - MIN); ctx.lineTo(px, py - MIN / 2 - 3);
    ctx.moveTo(px, py + MIN / 2 + 3); ctx.lineTo(px, py + MIN);
    ctx.stroke();
    if (sec != null) ctx.restore();
  }
  ctx.restore();
}

// A destination should arrive at about half the shorter side of the map area, so
// it takes roughly a quarter of what you can see: big enough to be the subject,
// small enough to keep its surroundings.
const FILL = 0.5;
// What a sector arrives at, in light years across the map area.
const SECTOR_VIEW_LY = 30000;
// The galaxy, framed by its own outline rather than by a remembered number, so
// it stays centred and inside the view at any window shape.
function showGalaxy(instant){
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of D.outline || []){
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const go = instant ? goto : flyPath;
  if (!isFinite(x0)){ go(0, 0, scaleFor(GALAXY_LY)); return; }
  // Both axes have to fit, so the scale is whichever is tighter.
  const fit = Math.min(W / (x1 - x0), H / (z1 - z0)) * GALAXY_MARGIN;
  go((x0 + x1) / 2, (z0 + z1) / 2, fit);
}

function flyToBounds(x0, z0, x1, z1, fill = FILL, fly = flyView){
  const wide = W;
  const span = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), CELL_LY);
  fly((x0 + x1) / 2, (z0 + z1) / 2, Math.min(wide, H) * fill / span);
}

// What the search has narrowed to, as a rectangle in light years, at whatever
// level it has reached. A name is read one level at a time and the view follows
// the levels, not the individual candidates: while only the sector is known the
// destination is the whole sector, however few of its cells happen to be nearest.
function boxOf(cx0, cy0, cx1, cy1){
  return [(cx0 - 1025) * CELL_LY, (1591 - cy1 - 1) * CELL_LY,
          (cx1 - 1025 + 1) * CELL_LY, (1591 - cy0) * CELL_LY];
}

// The smallest rectangle holding a set of points, padded to a cell so a single
// system still has something to frame.
function boxAround(pts){
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts){
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const pad = CELL_LY / 2;
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

function searchBounds(raw, cells){
  // Nothing of the cell name typed yet: the sectors themselves are the answer,
  // and the sweep measured what each one occupies.
  const m = /^(.+?)(?:\s+(\S)(?:\S?)(?:-.*)?)?$/.exec(raw.trim());
  const named = m && m[2];
  if (!named){
    const z = (m ? m[1] : raw).trim().toLowerCase();
    let b = null;
    D.sectorAnchors.sectors.forEach((name, i) => {
      const box = D.sectorBounds[i];
      if (!box || !D.sectorLive[i] || !name.toLowerCase().startsWith(z)) return;
      b = b ? [Math.min(b[0], box[0]), Math.max(b[1], box[1]),
               Math.min(b[2], box[2]), Math.max(b[3], box[3])] : box.slice();
    });
    return b && boxOf(b[0], b[2], b[1], b[3]);
  }
  if (!cells.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells){
    x0 = Math.min(x0, c.cx); x1 = Math.max(x1, c.cx);
    y0 = Math.min(y0, c.cy); y1 = Math.max(y1, c.cy);
  }
  return boxOf(x0, y0, x1, y1);
}

// Set by the search so it can tell "I already flew there" from "the reader has
// since moved". Cleared whenever the view stops being the one it aimed at.
let flyAimed = "";
function flyStop(){
  pathStop();
  if (flyRAF) cancelAnimationFrame(flyRAF);
  flyRAF = 0; flyTo = null; flyV = [0, 0, 0];
  flyAimed = "";
}

function flyStep(now){
  flyRAF = 0;
  if (!flyTo) return;
  const dt = Math.min(0.05, (now - flyLast) / 1000);
  flyLast = now;
  const at = [cx, cz, Math.log(scale)];
  // Critically damped: one pole at 1/tau, integrated semi-implicitly so it stays
  // stable when a frame is late.
  // The slow close-in only exists so a pan keeps up; a zoom in place (the
  // buttons, the keys) has nothing to wait for.
  const zoomingIn = flyTo[2] > at[2] && (flyTo[0] !== at[0] || flyTo[1] !== at[1]);
  let rest = 0;
  for (let i = 0; i < 3; i++){
    const w = flySpeed / (i < 2 ? FLY_TAU : zoomingIn ? FLY_TAU_IN : FLY_TAU_OUT);
    const d = at[i] - flyTo[i];
    flyV[i] = (flyV[i] - w * w * d * dt) / (1 + 2 * w * dt + w * w * dt * dt);
    at[i] += flyV[i] * dt;
    rest = Math.max(rest, Math.abs(at[i] - flyTo[i]) / (i === 2 ? 0.0005 : 0.5 / scale));
  }
  scale = Math.exp(at[2]);
  cx = at[0]; cz = at[1];
  if (rest <= 1){
    scale = Math.exp(flyTo[2]);
    cx = flyTo[0]; cz = flyTo[1];
    flyStop();
    draw();
    return;
  }
  draw();
  flyRAF = requestAnimationFrame(flyStep);
}

// A planned journey follows van Wijk and Nuij's optimal zoom-and-pan path
// ("Smooth and efficient zooming and panning", 2003): it rises as far as the
// distance needs, crosses zoomed out and descends, at constant perceived speed.
// Progress along it is eased in and out. The spring stays for retargeting.
const PATH_RHO = 1.0;               // how far the path rises; sqrt(2) is canonical
const PATH_MS_PER_S = 360;          // milliseconds per unit of path length
let pathRAF = 0;
function pathStop(){ cancelAnimationFrame(pathRAF); pathRAF = 0; }
function flyPath(x, z, sc){
  sc = clampScale(sc);
  if (reducedMotion()){ goto(x, z, sc); return; }
  flyStop();
  tip.style.display = "none";
  document.getElementById("help").style.display = "none";
  const x0 = cx, z0 = cz, w0 = W / scale, w1 = W / sc, dx = x - x0, dz = z - z0;
  const r2 = PATH_RHO * PATH_RHO, d = Math.hypot(dx, dz);
  let S, at;
  if (d < 1e-6){
    const k = Math.sign(Math.log(w1 / w0));
    S = Math.abs(Math.log(w1 / w0)) / PATH_RHO;
    at = s => [x0, z0, w0 * Math.exp(k * PATH_RHO * s)];
  } else {
    const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d * d) / (2 * w0 * r2 * d);
    const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d * d) / (2 * w1 * r2 * d);
    const q0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const q1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (q1 - q0) / PATH_RHO;
    at = s => {
      const u = w0 / (r2 * d) * (Math.cosh(q0) * Math.tanh(PATH_RHO * s + q0) - Math.sinh(q0));
      return [x0 + u * dx, z0 + u * dz, w0 * Math.cosh(q0) / Math.cosh(PATH_RHO * s + q0)];
    };
  }
  const ms = Math.min(3000, Math.max(350, S * PATH_MS_PER_S)), t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / ms);
    if (t < 1){
      const [px, pz, w] = at((1 - Math.cos(Math.PI * t)) / 2 * S);
      cx = px; cz = pz; scale = W / w;
      draw();
      pathRAF = requestAnimationFrame(step);
    } else { pathRAF = 0; cx = x; cz = z; scale = sc; draw(); }
  };
  pathRAF = requestAnimationFrame(step);
}

// Somewhere off screen is a journey and takes the path; a nudge within view,
// or a retarget mid-path, stays on the spring.
function flyTrip(x, z, sc){
  const far = Math.hypot(x - cx, z - cz) > W / scale || Math.abs(Math.log(sc / scale)) > 2;
  (far && !pathRAF ? flyPath : flyView)(x, z, sc);
}

// Land close enough that the system is unmistakable, then flash the ring out.
function focusOn(s, sc = 14, fly = flyView){
  fly(s[X], s[Z], sc);
  flashMatches([s]);
}

// More than this at once reads as a strobe rather than an answer, and with a
// filter on the dimming already says which systems matched.
const FLASH_MAX = 150;

function flashMatches(list){
  focused = list.slice(0, FLASH_MAX);
  focusStart = performance.now();
  cancelAnimationFrame(focusRAF);
  const step = () => {
    if (!focused.length) return;
    if (performance.now() - focusStart >= FLASH_MS){ focused = []; draw(); return; }
    draw();
    focusRAF = requestAnimationFrame(step);
  };
  focusRAF = requestAnimationFrame(step);
}
// The buttons zoom in flight, quickly. A press mid-flight steps from where the
// flight is heading, so pressing twice is two steps rather than one and a bit.
const zoomStep = f => {
  const base = flyTo ? Math.exp(flyTo[2]) : scale;
  const [x, z] = flyTo ? [flyTo[0], flyTo[1]] : [cx, cz];
  flyView(x, z, base * f, 4);
};
document.getElementById("zin").onclick    = () => zoomStep(1.6);
document.getElementById("zout").onclick   = () => zoomStep(1 / 1.6);
const clearFocus = () => { focused = []; cancelAnimationFrame(focusRAF); };
// Somewhere else on the map is a journey, not a cut: the flight shows how far
// the two places are from each other, which a jump never can.
document.getElementById("zreset").onclick = () => { clearFocus(); flyPath(0, 0, scaleFor(HOME_LY)); };
document.getElementById("toSol").onclick  = () => { clearFocus(); flyPath(0, 0, scaleFor(HOME_LY)); };
// Centre of the deep-space cluster: 21 systems and 35 stations inside about 60 ly.
document.getElementById("toVoid").onclick = () => {
  clearFocus(); flyPath(-2232, -3987, scaleFor(HOME_LY));
};
// The two places worth a button of their own: the black hole that unlocks the
// Warp Drive Booster by being visited, and the galaxy's only Preon star.
document.getElementById("toSagA").onclick  = () => {
  clearFocus(); flyPath(25, 25899, scaleFor(HOME_LY));
};
document.getElementById("toPreon").onclick = () => {
  clearFocus(); flyPath(-4608, -16094, scaleFor(HOME_LY));
};
// `open` is the browser's, and only ever present when a section is open. The
// mirror of it is written out too, so the closed state is visible in the DOM and
// can be styled or found without a negation.
for (const d of document.querySelectorAll("details.grp")){
  const mark = () => d.toggleAttribute("closed", !d.open);
  d.addEventListener("toggle", mark);
  mark();
}

// Every wiki article, grouped the way the wiki's own menu groups them, opened in
// a tab of its own so the map stays where the reader left it.
{
  const sel = document.getElementById("wikiPage");
  const home = document.createElement("option");
  home.value = ""; home.dataset.ui = "wikiHome"; home.textContent = ui("wikiHome");
  sel.append(home);
  for (const [group, pages] of D.wikiPages || []){
    const og = document.createElement("optgroup");
    og.label = group;
    for (const page of pages){
      const o = document.createElement("option");
      o.value = page; o.textContent = page;
      og.append(o);
    }
    sel.append(og);
  }
  document.getElementById("wikiGo").addEventListener("click", () => openWiki(sel.value));
}

// The wiki opens beside the map rather than instead of it. Served locally, the
// map points at the local wiki preview.
const WIKI_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? "http://localhost:8790/" : "https://galaxy-genome.github.io/wiki/";
// The four apps share one site; the product switcher on the brand opens the others.
const LOADOUTS_URL = "https://galaxy-genome.github.io/loadouts/";
const APP_URL = {mods: "https://galaxy-genome.github.io/mods/", loadouts: LOADOUTS_URL,
                 wiki: WIKI_URL};
for (const a of document.querySelectorAll("#appMenu a[data-app]")) a.href = APP_URL[a.dataset.app];
const shipName = sh => sh.n[D.langCodes.indexOf(lang)] || sh.n[0];
const wikiPanel = document.getElementById("wikiPanel");
// Every link to the wiki follows the same rule, so a local map never sends a
// reader to the published copy.
for (const a of document.querySelectorAll('a.wikiLink')) a.href = WIKI_URL;
function wikiUrl(page, section){
  const slug = t => encodeURIComponent(t.replace(/ /g, "_"));
  return WIKI_URL + (page ? "#" + slug(page) + (section ? "#" + slug(section) : "") : "");
}
function openWiki(page, section){
  const frame = document.getElementById("wikiFrame");
  const want = wikiUrl(page, section);
  if (frame.src !== want) frame.src = want;
  wikiPanel.hidden = false;
  document.body.classList.add("wikiOpen");
  document.getElementById("wikiClose").focus();
}
function closeWiki(){
  wikiPanel.hidden = true;
  document.body.classList.remove("wikiOpen");
}
document.getElementById("wikiClose").addEventListener("click", closeWiki);

// Each sidebar section opens the wiki article about its subject; the Map page's own
// section only where no article covers it.
const SECTION_WIKI = {
  route: ["Navigation"], showMe: ["Galaxy Genome Map"],
  exploration: ["Exploration"], mining: ["Mining"], trading: ["Trading"],
  outfitting: ["Modules"], security: ["Galaxy Genome Map", "Security"],
  crafting: ["Module Mods"],
  ratingBattles: ["Combat", "Rating battles"],
  calculators: ["Navigation", "Geeking out: what mass actually costs you"],
  wikiPages: [""]};
for (const sum of document.querySelectorAll("details.grp>summary")){
  const head = sum.querySelector(":scope > span");
  const slot = head.id === "routeHead" ? "route" : head.dataset.ui;
  if (!(slot in SECTION_WIKI)) continue;
  const b = document.createElement("button");
  b.type = "button"; b.className = "secWiki"; b.textContent = "W";
  b.dataset.uiAria = "wikiLink"; b.setAttribute("aria-label", ui("wikiLink"));
  // A second press on the page already showing puts the wiki away.
  b.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const [page, sec] = SECTION_WIKI[slot];
    if (!wikiPanel.hidden && document.getElementById("wikiFrame").src === wikiUrl(page, sec)) closeWiki();
    else openWiki(page, sec);
  });
  sum.append(b);
}
// Escape closes the wiki before it means anything to the route beneath it.
addEventListener("keydown", e => {
  if (e.key === "Escape" && !wikiPanel.hidden){ closeWiki(); e.stopImmediatePropagation(); }
}, true);

// The reverse arrows inside the Jump to chips: the same trip, the other way.
for (const el of document.querySelectorAll(".chip .rev")){
  const go = e => {
    e.stopPropagation();
    const s2 = byName.get(el.dataset.gate);
    if (s2){ clearFocus(); focusOn(s2, 14, flyPath); }
  };
  el.addEventListener("click", go);
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") go(e); });
}

// The far ends of the two warp gates that do not land in the Void.
document.getElementById("toIsar").onclick = () => {
  clearFocus(); flyPath(-9530, 19808, scaleFor(HOME_LY));
};
document.getElementById("toTerm").onclick = () => {
  clearFocus(); flyPath(-24039, -975, scaleFor(HOME_LY));
};
document.getElementById("toAll").onclick  = () => { clearFocus(); showGalaxy(); };

for (const b of document.querySelectorAll(".chip[data-f]")){
  b.onclick = () => {
    const f = b.dataset.f, on = b.getAttribute("aria-pressed") === "true";
    // A station's market is one thing or another: nothing buys contraband and
    // has no market, so pressing one of these releases the rest of its group.
    if (!on && b.dataset.one)
      for (const other of document.querySelectorAll(`.chip[data-one="${b.dataset.one}"]`)){
        if (other === b) continue;
        other.setAttribute("aria-pressed", "false");
        filters.delete(other.dataset.f);
      }
    b.setAttribute("aria-pressed", String(!on));
    on ? filters.delete(f) : filters.add(f);
    draw();
    // Some of these match a single system in the whole catalogue. Turning one on
    // and being left with empty sky reads as a broken filter rather than a rare
    // answer, so go to the nearest one instead.
    if (!on && !visible.length) fitToMatches(true);
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
// Belt ores first, then the two deep ores in a group of their own.
{
  const el = document.getElementById("ore");
  for (const [slot, deep] of [["beltOres", false], ["deepOres", true]]){
    const g = document.createElement("optgroup");
    g.label = ui(slot);
    ORES.forEach((label, i) => {
      if (!!deepDigit(i) !== deep) return;
      const o = document.createElement("option");
      o.value = i; o.textContent = label;
      g.append(o);
    });
    el.append(g);
  }
  el.onchange = () => { F.ore = el.value === "" ? -1 : +el.value; draw(); };
}
fill("mat", MATS);
// The Rating battles ladder: 83 fixed fights, each at one of nine anarchy systems.
// "all" marks every host; a level marks the one system that hosts it.
const ARENA = D.arena || [];
const ARENA_SYS = new Set(ARENA.map(a => a[1]));
{
  const el = document.getElementById("arena");
  for (const [lvl, sys, bots, reward] of ARENA){
    const o = document.createElement("option");
    o.value = String(lvl);
    o.textContent = `${lvl} · ${sys} · ${bots} · ${num(reward)} CR`;
    el.append(o);
  }
  el.onchange = () => {
    F.arena = el.value === "" ? null : el.value === "all" ? "all" : +el.value;
    draw();
    // A level names one system, so go to it rather than leaving the reader to hunt.
    const one = typeof F.arena === "number" && byName.get(ARENA[F.arena - 1][1]);
    if (one) focusOn(one, 14, flyTrip);
    else if (F.arena === "all") fitToMatches();
  };
}


// Planet types, split by whether you can land on one. Surface work needs a
// landing; a scan does not, and the two lists never overlap.
{
  const el = document.getElementById("ptype");
  for (const [slot, want] of [["landableGroup", 1], ["notLandable", 0]]){
    const g = document.createElement("optgroup");
    g.label = ui(slot);
    PTYPES.forEach((label, i) => {
      if (!!D.ptypeLandable[i] !== !!want) return;
      const o = document.createElement("option");
      o.value = i; o.textContent = label;
      g.append(o);
    });
    if (g.children.length) el.append(g);
  }
  el.onchange = () => { F.ptype = el.value === "" ? -1 : +el.value; draw(); };
}

// Which Planet Scanner is fitted decides what a system pays before you move.
{
  const el = document.getElementById("scanner");
  D.scanners.forEach(([label, range], i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = (i ? label : ui("scannerNone")) + `  \u00b7 ${range} ls`;
    el.append(o);
  });
  el.value = String(scanner);
  el.onchange = () => { scanner = +el.value; refreshCounts(); draw(); };
}

// Star class only earns a filter because StarHunter expeditions name one, so the
// list is those classes, rarest first, with how many the expedition asks for.
{
  const el = document.getElementById("startype");
  let impossible = 0;
  const hunted = new Set();
  const gExp = document.createElement("optgroup");
  gExp.label = ui("expedition");
  for (const [label, need, have, raw] of D.hunt){
    hunted.add(raw);
    const o = document.createElement("option");
    o.value = raw;
    // Estimated figures: a number rounded to its accuracy, or "<N" for a type
    // too rare for the sample to meet.
    o.textContent = `${label} — ${typeof have === "number" ? num(have) : have} `
                    + `${ui("hSystems").toLowerCase()}` + (need > 1 ? ` (${need})` : "");
    if (typeof have === "number" && have < need){ o.textContent += "  \u26a0"; impossible++; }
    gExp.append(o);
  }
  el.append(gExp);
  // Every other star type the galaxy can produce, catalogued or generated.
  const gAll = document.createElement("optgroup");
  gAll.label = ui("allStars");
  for (const [raw, shown] of D.starAll){
    if (hunted.has(raw)) continue;
    const o = document.createElement("option");
    o.value = raw; o.textContent = shown;
    gAll.append(o);
  }
  el.append(gAll);
  el.onchange = () => {
    F.startype = el.value;
    draw();
    if (el.value) fitToMatches(true);
  };
  const note = document.getElementById("huntNote");
  note.hidden = !impossible;
  note.innerHTML = impossible
    ? `<b>\u26a0 ` + fmt("huntWarn", {n: impossible, total: D.hunt.length}) + `</b>` : "";
}

// Multi-select pill groups. `bucket` is the Set the group writes into;
// `keyOf` maps a button to whatever passes() looks for.
// A single hover panel serves every control that names a data-help key.
const helpBox = document.getElementById("help");
// A help value is either literal data or {k: slot} pointing at a translated string.
const say = v => {
  if (!v || typeof v !== "object") return v;
  if (v.mods) return v.mods.map((k, i) => t(k) + (v.pct ? ` ${v.pct[i]}%` : "")).join(", ") || "\u2014";   // name lists translate too
  if (v.k) return fmt(v.k, v);      // any other key on the object fills a {slot}
  if (v.g) return t(v.g);                                    // the game's own words
  return v;
};

function showHelp(key, el){
  const h = D.help[key];
  if (!h) return;
  helpBox.innerHTML = `<h4>${say(h.title)}</h4><dl>` +
    h.rows.map(([k, v]) => `<dt>${say(k)}</dt><dd>${say(v)}</dd>`).join("") + "</dl>";
  tip.style.display = "none";
  helpBox.style.display = "block";
  const r = el.getBoundingClientRect(), b = helpBox.getBoundingClientRect();
  if (TOUCH){
    // Pinned clear of the rail rather than beside the control it explains:
    // bottom left in portrait, bottom right in landscape.
    helpBox.style.top = "auto"; helpBox.style.bottom = "8px";
    helpBox.style.left = portrait() ? "8px" : "auto";
    helpBox.style.right = portrait() ? "auto" : "8px";
    return;
  }
  helpBox.style.right = ""; helpBox.style.bottom = "";
  helpBox.style.left = Math.min(r.right + 10, window.innerWidth - b.width - 10) + "px";
  helpBox.style.top = Math.max(8, Math.min(r.top, window.innerHeight - b.height - 10)) + "px";
}
function bindHelp(el, key){
  el.dataset.help = key;
  if (TOUCH){
    // Nothing hovers on a touch screen, so the panel is a toggle and the next
    // tap anywhere else puts it away.
    el.addEventListener("click", e => {
      e.preventDefault();
      const open = helpBox.style.display === "block" && helpBox.dataset.for === key;
      helpBox.style.display = "none";
      if (!open){ showHelp(key, el); helpBox.dataset.for = key; }
    });
    return;
  }
  el.addEventListener("pointerenter", () => showHelp(key, el));
  el.addEventListener("pointerleave", () => { helpBox.style.display = "none"; });
  el.addEventListener("focus", () => showHelp(key, el));
  el.addEventListener("blur", () => { helpBox.style.display = "none"; });
}
for (const el of document.querySelectorAll("[data-help]")) bindHelp(el, el.dataset.help);
// The panel is in the way the moment it is not being read: anywhere else, or
// Escape, puts it away, whether or not the control it explains holds focus.
addEventListener("pointerdown", e => {
  if (!e.target.closest("[data-help]")) helpBox.style.display = "none";
}, true);
addEventListener("keydown", e => {
  if (e.key === "Escape") helpBox.style.display = "none";
});

function pillGroup(hostId, items, bucketName, perRow, keyOf = i => i, helpOf = null){
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
      const bucket = F[bucketName];
      // One at a time: a system has one security level, a station one purpose
      // and one faction, so two of these together can only answer nothing.
      for (const other of box.querySelectorAll(".pill"))
        other.setAttribute("aria-pressed", "false");
      bucket.clear();
      b.setAttribute("aria-pressed", String(!on));
      if (!on) bucket.add(keyOf(i));
      draw();
    };
    if (helpOf) bindHelp(b, helpOf(i));
    row.append(b);
  });
}

const SECS = [["H","secHigh"],["M","secMedium"],["L","secLow"],
              ["A","secAnarchy"],["C","secConflict"]];
pillGroup("secRow", SECS.map(x => ui(x[1])), "sec", 3, i => SECS[i][0],
          i => "sec:" + SECS[i][0]);
pillGroup("purpRow", D.purposeSlots.map(ui), "purp", 2, i => i,
          i => "purp:" + D.purposes[i]);
pillGroup("facRow", D.factionKeys.map(t), "fac", 2, i => i,
          i => "fac:" + D.factions[i]);

// The ring around a station system takes its faction's colour, so the legend is
// built from the same table rather than repeating the names.
{
  const box = document.getElementById("facLegend");
  for (const [i, name] of D.factions.entries()){
    const row = document.createElement("div");
    row.dataset.layer = "fac:" + name;
    row.innerHTML = `<i style="border:1px solid ${FAC_COLOUR[name]};border-radius:0"></i>`
                  + `<span>${t(D.factionKeys[i])}</span>`;
    box.appendChild(row);
  }
}

// Each preset is a whole answer to a question a session actually raises, not a
// component of one. Tapping it clears what was there, then `show` names the
// control it drives, so that section opens and explains itself rather than
// leaving the chip a black box. The two spoiler presets name nothing: filtering
// for engineers or gates is the whole of what anyone does with them, so the chip
// is the control.
const PRESETS = [
  // The one question value asks: where is a scan worth the trip. Sol at 1,000 ly
  // is where a reader can act on the answer.
  {slot: "pHighValue", set: {valMin: 500000}, scanner: "1D", show: "#valMin",
   view: [0, 0, 1000]},
  {slot: "pOutfit",    purp: "HiTech",           show: '#purpRow .pill[aria-pressed="true"]'},
  {slot: "pStation",   on: ["wreck"]},
  {slot: "pBlackMarket", on: ["sellsBlack"],     show: '[data-f="sellsBlack"]'},
  {slot: "pRep",       set: {stLs: REP_LS},    show: "#stLs"},
  {slot: "pArena",     set: {arena: "all"},    show: "#arena"},
  {slot: "pEngineers", on: ["eng"], spoil: true},
  {slot: "pGates",     on: ["gate"], spoil: true},
];

// A chip states what the galaxy answers. Generated space never holds a station,
// an engineer, a gate or the wreck, so the catalogue answers those; a value chip
// is answered by the sweep, which holds every system.
function genCount(pre){
  const cr = pre.set && pre.set.valMin;
  if (cr == null) return 0;
  const sc = pre.scanner || D.scanners[scanner][0];
  return D.genCounts[sc + ":" + cr] || 0;
}

function presetCount(pre){
  const keep = new Set(filters);
  // The sets are restored by their contents, never by replacing them: the pills
  // hold the set they were built with, and a fresh one is a set nothing reads.
  const kf = {...F};
  const sets = {sec: [...F.sec], purp: [...F.purp], fac: [...F.fac]};
  applyPreset(pre, true);
  const n = S.reduce((a, x) => a + (passes(x) ? 1 : 0), 0);
  filters.clear(); for (const k of keep) filters.add(k);
  Object.assign(F, kf);
  for (const [k, had] of Object.entries(sets)){
    F[k].clear();
    for (const v of had) F[k].add(v);
  }
  return n;
}

function applyPreset(pre, quiet){
  clearFilters(quiet);
  for (const f of pre.on || []) filters.add(f);
  Object.assign(F, pre.set || {});
  if (pre.sec) F.sec.add(pre.sec);
  if (pre.purp) F.purp.add(D.purposes.indexOf(pre.purp));
  if (pre.ptype) F.ptype = D.ptypeRaw.indexOf(pre.ptype);
  // A chip that names a figure has to name the scanner it was measured with, or
  // the count on it is about somebody else's ship.
  if (pre.scanner) scanner = D.scanners.findIndex(x => x[0] === pre.scanner);
  if (quiet) return;
  if (pre.scanner){
    document.getElementById("scanner").value = String(scanner);
    refreshCounts();
  }
  // Show the reader what the chip set rather than leaving it a black box.
  for (const [id, v] of Object.entries(pre.set || {}))
    if (document.getElementById(id)) document.getElementById(id).value = v;
  for (const f of pre.on || [])
    document.querySelector(`.chip[data-f="${f}"]`)?.setAttribute("aria-pressed", "true");
  if (pre.sec) syncPills("secRow", SECS.findIndex(x => x[0] === pre.sec));
  if (pre.purp) syncPills("purpRow", D.purposes.indexOf(pre.purp));
  if (pre.ptype) document.getElementById("ptype").value = String(F.ptype);
  if (pre.spoil && !spoilers) document.getElementById("spoilers").click();
}

function syncPills(host, i){
  document.querySelectorAll(`#${host} .pill`)[i]?.setAttribute("aria-pressed", "true");
}

{
  const box = document.getElementById("presetRow");
  // Engineers is offered again in Module Mods, where the work they do is.
  const copies = {pEngineers: "engCopy"};
  const make = pre => {
    const b = document.createElement("button");
    b.className = "chip"; b.type = "button"; b.dataset.preset = pre.slot;
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `<span class="box"></span><span data-ui="${pre.slot}">${ui(pre.slot)}</span>` +
                  `<span class="n"></span>`;
    if (D.help["preset:" + pre.slot]) bindHelp(b, "preset:" + pre.slot);
    b.onclick = () => {
      // Pressed already: the chip is the only filter state there is, so clearing
      // everything is what turning it off means.
      if (b.getAttribute("aria-pressed") === "true"){
        clearFilters(); draw(); return;
      }
      applyPreset(pre);
      for (const twin of document.querySelectorAll(`[data-preset="${pre.slot}"]`))
        twin.setAttribute("aria-pressed", "true");
      draw();
      // A preset that names a place goes there; the rest frame their matches.
      if (pre.view) flyPath(pre.view[0], pre.view[1], scaleFor(pre.view[2]));
      else fitToMatches();
      helpBox.style.display = "none";
      // The section holding what the preset set is the only one worth reading
      // afterwards, so the rest fold away rather than being scrolled past.
      const det = pre.show ? document.querySelector(pre.show)?.closest("details") : null;
      for (const other of document.querySelectorAll(".sections details.grp"))
        if (other !== det && other !== b.closest("details")) other.open = false;
      if (det) det.open = true;
    };
    return b;
  };
  for (const pre of PRESETS){
    box.append(make(pre));
    if (copies[pre.slot]) document.getElementById(copies[pre.slot]).replaceWith(make(pre));
  }
}

{
  const box = document.querySelector(".legend");
  const set = v => { if (solo !== v){ solo = v; draw(); } };
  box.addEventListener("pointerover", e => set(e.target.closest("[data-layer]")?.dataset.layer || null));
  box.addEventListener("pointerleave", () => set(null));
}

// Every count on a chip depends on the scanner, so they are all rebuilt when it
// changes rather than going quietly stale.
function refreshCounts(){
  for (const pre of PRESETS){
    // The sweep's figure already covers the catalogue.
    for (const el of document.querySelectorAll(`[data-preset="${pre.slot}"] .n`))
      el.textContent = num(genCount(pre) || presetCount(pre));
  }
}

// The toggle carries its own count, so it says how much it is worth pressing.
{
  for (const [id, key] of [["hlSectors", "sectors"]]){
    const btn = document.getElementById(id);
    btn.addEventListener("click", () => {
      HL[key] = !HL[key];
      btn.setAttribute("aria-pressed", String(HL[key]));
      draw();
    });
  }
}
refreshCounts();

// The two dropdowns explain the option you land on, under the control.
// Where the percentage box starts for an ore: a quarter into its range.
const matDefault = i => {
  const [lo, hi] = D.matRange[i];
  return Math.round(lo + (hi - lo) / 4);
};
const oreDefault = i => {
  const [lo, hi] = D.oreRange[i];
  return Math.round(lo + (hi - lo) / 4);
};

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
bindSelectHelp("mat", "mat:", D.matRaw);
{
  // Selecting an ore arms the min-% box at the poorest value in the galaxy,
  // so it starts showing everything and only ever narrows.
  const sel = document.getElementById("ore"), box = document.getElementById("pctMin");
  sel.addEventListener("change", () => {
    if (sel.value === ""){
      box.disabled = true; box.value = ""; box.placeholder = ui("pickOre");
      box.removeAttribute("max");
      F.pctMin = null;
    } else if (deepDigit(+sel.value)){
      // A deep ore has no share of a belt to be at least.
      box.disabled = true; box.value = ""; box.placeholder = "—";
      box.removeAttribute("max");
      F.pctMin = null;
    } else {

      // The box spans what this ore can actually be: no belt holds Alexandrite
      // above 21%, so 40% there is a typo rather than a search. It starts a
      // quarter of the way up, because the poorest showing of an ore is not
      // what anyone is looking for.
      const [lo, hi] = D.oreRange[+sel.value];
      box.disabled = false; box.value = oreDefault(+sel.value);
      box.placeholder = `${lo}\u2013${hi}`;
      box.min = lo; box.max = hi;
      F.pctMin = +box.value;
    }
    draw();
  });
}
{
  // A material's box works as the ore's: armed a quarter into what that material
  // can be when one is picked, empty and disabled when none is.
  const sel = document.getElementById("mat"), box = document.getElementById("matPctMin");
  sel.addEventListener("change", () => {
    if (sel.value === ""){
      box.disabled = true; box.value = ""; box.placeholder = ui("pickMaterial");
      box.removeAttribute("max");
      F.matPctMin = null;
    } else {
      const [lo, hi] = D.matRange[+sel.value];
      box.disabled = false; box.value = matDefault(+sel.value);
      box.placeholder = `${lo}–${hi}`;
      box.min = lo; box.max = hi;
      F.matPctMin = +box.value;
    }
    draw();
  });
}
bindSelectHelp("ptype", "pt:", D.ptypeRaw);

// Module availability. A full shop sells every class; the rest stop at class 3.
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
    document.getElementById("chevLegend").hidden = F.module < 0;
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

// Below half a million nothing is worth the jump, so the boxes do not offer it.
const VALUE_FLOOR = 500000;
for (const id of ["valMin","plMin","pctMin","matPctMin","laMin","stLs"]){
  const el = document.getElementById(id);
  el.oninput = e => {
    F[id] = e.target.value === "" ? null : +e.target.value;
    draw();
  };
  if (id === "valMin")
    el.onchange = () => {
      if (el.value !== "" && +el.value < VALUE_FLOOR) el.value = VALUE_FLOOR;
      F[id] = el.value === "" ? null : +el.value;
      draw();
    };
}

// Both value filters are answered by systems that are anywhere but here: inside
// Sol's bubble or The Void's everything is explored and worth nothing. Reaching
// for either box while looking at empty ground pulls the view back to a
// thousand light years, where there is something to see.
const ESCAPE_LY = 1000;
function escapeEmptyView(){
  if (F.valMin == null) return;
  if (acrossLy() >= ESCAPE_LY) return;
  const x0 = 0;
  for (const s of S){
    const px = sx(s[X]), py = sy(s[Z]);
    if (px < x0 || px > W || py < 0 || py > H) continue;
    if (passes(s)) return;
  }
  goto(cx, cz, scaleFor(ESCAPE_LY));
}
{
  const el = document.getElementById("valMin");
  el.addEventListener("focus", escapeEmptyView);
  el.addEventListener("pointerdown", escapeEmptyView);
  const hop = document.getElementById("oneHop");
  hop.onchange = () => { F.oneHop = hop.checked; draw(); refreshCounts(); };
}

function clearFilters(quiet){
  filters.clear();
  F.sec.clear(); F.purp.clear(); F.fac.clear();
  F.ore = F.ptype = F.mat = F.module = -1;
  F.arena = null;
  F.startype = "";
  F.fullOnly = true;
  for (const k of ["lyMin","lyMax","valMin","plMin","pctMin","matPctMin","laMin","stLs"]) F[k] = null;
  F.oneHop = false;
  if (quiet) return;
  for (const k of ["valMin","plMin","pctMin","matPctMin","laMin","stLs"])
    document.getElementById(k).value = "";
  document.getElementById("oneHop").checked = false;
  // The highlight toggles are not filters and keep their state.
  for (const el of document.querySelectorAll('.grp [aria-pressed="true"]'))
    el.setAttribute("aria-pressed", "false");
  for (const el of document.querySelectorAll("#ore,#ptype,#mat,#arena,#startype,#module")) el.value = "";
  const pct = document.getElementById("pctMin");
  pct.disabled = true; pct.value = "";
  document.getElementById("matPctMin").disabled = true;
  document.getElementById("moduleNote").textContent = "";
}

// One section open at a time among the filter sections; the route section keeps
// its own rule.
const FILTER_SECTIONS = [...document.querySelectorAll(".sections details.grp")]
  .filter(d => !d.querySelector("#calcShip, #wikiPage"));
for (const d of document.querySelectorAll(".sections details.grp"))
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    for (const other of document.querySelectorAll(".sections details.grp"))
      if (other !== d) other.open = false;
  });

// Filters answer one section's question at a time. Setting one releases whatever
// another section had set, through that section's own controls, before the new
// choice takes effect. Links arrive whole and are left as they are.
function releaseOtherSections(here){
  for (const d of FILTER_SECTIONS){
    if (d === here) continue;
    for (const b of d.querySelectorAll('button.chip[aria-pressed="true"], button.pill[aria-pressed="true"]'))
      if (b.id !== "fullOnly") b.click();
    for (const s of d.querySelectorAll("select"))
      if (s.value !== "" && [...s.options].some(o => o.value === "")){
        s.value = "";
        s.dispatchEvent(new Event("change", {bubbles: true}));
      }
    for (const n of d.querySelectorAll('input[type="number"]'))
      if (n.value !== "" && !n.disabled){
        n.value = "";
        n.dispatchEvent(new Event("input", {bubbles: true}));
      }
  }
}
for (const d of FILTER_SECTIONS){
  // A choice is kept across the release: clearing a preset clears every box,
  // including the one being set.
  const guard = (el, isSetting) => {
    if (urlBusy || !isSetting || releasing) return;
    releasing = true;
    const kept = el.value;
    try { releaseOtherSections(d); } finally { releasing = false; }
    if ("value" in el && el.value !== kept) el.value = kept;
  };
  d.addEventListener("change", e => {
    if (e.target.tagName === "SELECT") guard(e.target, e.target.value !== "");
  }, true);
  d.addEventListener("input", e => {
    if (e.target.type === "number") guard(e.target, e.target.value !== "");
  }, true);
  d.addEventListener("click", e => {
    const b = e.target.closest("button.chip, button.pill");
    if (b && b.id !== "fullOnly") guard(b, b.getAttribute("aria-pressed") !== "true");
  }, true);
}
let releasing = false;

for (const b of document.querySelectorAll(".resetFilters"))
  b.onclick = () => { clearFilters(); draw(); };

// Both route boxes share one autocomplete. A system matches on its own name or
// on any alias — a body, a station, its catalogue designation. Aliases show
// indented under the system they belong to, and selecting either picks the system.
const SPOILER_ALIAS = new Set(["engineer", "landmark"]);

// The search box finds filters as well as systems: every button and every dropdown
// entry in the filter sections, the route's two buttons and the Jump to places,
// matched on their own words or their field's. Picking one presses it exactly as
// a click would, and opens only the section it sits in.
function filterHits(q){
  const out = [];
  const jumpTo = document.querySelector('.grp h2[data-ui="jumpTo"]').parentElement;
  const els = [
    ...document.querySelectorAll("#clearRoute, #routeSec .resetFilters"),
    ...[...document.querySelectorAll(".sections details.grp")]
      .filter(sec => !sec.querySelector("#calcShip, #wikiPage"))
      .flatMap(sec => [...sec.querySelectorAll("button.chip, button.pill, select")]),
    ...jumpTo.querySelectorAll("button.chip"),
  ];
  for (const el of els){
    if (el.closest("[hidden]") || (el.hasAttribute("data-spoiler") && !spoilers)) continue;
    const sec = el.closest("details.grp");
    const secName = (sec ? sec.querySelector("summary > span") : jumpTo.querySelector("h2")).textContent.trim();
    if (el.tagName === "SELECT"){
      let label = el.previousElementSibling;
      label = label && label.matches("label.f") ? label.textContent.trim() : "";
      for (const o of el.options){
        if (o.value === "") continue;
        const text = o.textContent.trim();
        if (`${label} ${text}`.toLowerCase().includes(q))
          out.push({text: label ? `${label}: ${text}` : text, sec, secName,
                    pick: () => { el.value = o.value;
                                  el.dispatchEvent(new Event("change", {bubbles: true})); }});
      }
    } else {
      const text = [...el.childNodes]
        .filter(n => !(n.classList && (n.classList.contains("n") || n.classList.contains("rev"))))
        .map(n => n.textContent).join("").trim();
      if (text.toLowerCase().includes(q))
        out.push({text, sec, secName, pick: () => el.click()});
    }
  }
  return out;
}
function pickFilter(hit){
  if (hit.sec){
    if (hit.sec.id !== "routeSec")
      for (const d of document.querySelectorAll(".sections details.grp")) d.open = d === hit.sec;
    hit.sec.scrollIntoView({block: "nearest"});
  }
  hit.pick();
}

function bindSearch(id){
  const input = document.getElementById(id);
  // What the box held last time, and what the view was last sent to. Backspacing
  // is not searching, and a target that has not really changed is not a reason
  // to move.
  let lastQuery = "", lastCells = "";
  const list = document.querySelector(`.hits[data-for="${id}"]`);
  input.addEventListener("input", async () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    list.innerHTML = "";
    // An emptied box is an end given up: the origin takes the journey with it,
    // since there is nothing left for a destination to be measured from.
    if (!raw){
      if (id === "find") return;
      if (id === "from") clearRoute();
      else if (routeTo){ routeTo = routePath = routeGates = null; draw(); }
      return;
    }
    if (q.length < 2) return;
    // A system picked here is a system picked in the origin box.
    const end = id === "find" ? "from" : id;
    if (id === "find")
      for (const hit of filterHits(q).slice(0, 12)){
        const li = document.createElement("li");
        li.className = "sub";
        li.innerHTML = `<b></b><em class="sec"></em>`;
        li.querySelector("b").textContent = hit.text;
        li.querySelector("em").textContent = hit.secName;
        li.onclick = () => { closeFind(); pickFilter(hit); };
        list.append(li);
      }
    // A generated name can be resolved from any zoom, so the maps it needs are
    // fetched here rather than waiting for the view to reach them.
    if (cellsFromName(raw).length && !GEN.side) await loadGenerationMaps();

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
    // searching two and a half million of them. What was typed may read more
    // than one way, so every reading that lands in the named sector is offered,
    // exactly like a partial match on a catalogue name.
    // Nearest first: a partial name can name a hundred cells, and the ones worth
    // offering are the ones a ship could reach.
    const plain = t => t.replace(/[^\x20-\x7e]/g, "").toLowerCase();
    // While there is no origin, the search steers the view: each part of a name
    // narrows the galaxy by one level, and the map follows the narrowing. With an
    // origin set the view belongs to the journey, so it is left alone.
    const cells = cellsFromName(raw).sort(
      (c1, c2) => (c1.cx - 1025) ** 2 + (c1.cy - 1591) ** 2
                - ((c2.cx - 1025) ** 2 + (c2.cy - 1591) ** 2));
    // Typing in the origin box is choosing an origin, whether or not one is
    // already set, so the view follows the narrowing either way. Three things
    // have to be true before it moves, and all three exist because of ways it
    // surprised somebody:
    //   the text grew, because backspacing through a name is not a search;
    //   nothing in the catalogue matches, because "So" is Sol before it is Sosi;
    //   the destination actually changed, so typing does not jog the view.
    const grew = raw.length > lastQuery.length;
    lastQuery = raw;

    let shown = 0;
    const matched = [];
    // Everything the dropdown is offering, so the map says where those systems
    // are rather than leaving a list of names to be read.
    const offered = [];
    for (const cell of cells){
      if (shown >= 12) break;
      const stars = (cellStars(cell.cx, cell.cy) || []).filter(
        st => cell.index == null
           || st.name.toLowerCase() === q || plain(st.name) === q);
      for (const star of stars.slice(0, 12 - shown)){
        shown++;
        offered.push(star);
        if (cell.index != null) matched.push(star);
        const li = document.createElement("li");
        li.innerHTML = `${star.name}<span class="ly">${num(Math.round(
          Math.hypot(star.x, star.z)))} ly</span>`;
        li.onclick = () => {
          list.innerHTML = "";
          if (id === "find") closeFind();
          focusOn({[NAME]: star.name, [X]: star.x, [Z]: star.z});
          setEnd(end, star);
        };
        list.append(li);
      }
    }

    for (const si of groups.keys()) offered.push(S[si]);

    // What the search has reached, outlined as the thing it has reached: the
    // sector while only the sector is known, then the band a half-typed pair
    // allows, then the column a whole one fixes, then the four cells the two
    // pairs name, then the one the quadrant letter chooses.
    if (id !== "to" && grew && !groups.size){
      const regions = regionsFromName(raw);
      // Nothing of a cell name typed yet, so the answer is whole sectors, and a
      // sector is a wedge and a ring rather than the rectangle around it.
      const whole = !/\s+\S/.test(raw.trim().replace(/^\S+/, ""));
      const wedges = whole
        ? [...new Set(regions.map(r => r.sector))].map(i => [(i / 8) | 0, i % 8])
        : [];
      // Each box carries the sector it belongs to: a region is worked out from
      // the sector's bounding box, and the sector is a wedge inside it.
      const boxes = whole ? [] : regions.map(r => {
        const b = boxOf(r.cx0, r.cy0, r.cx1, r.cy1);
        b.sector = r.sector;
        return b;
      });
      if (boxes.length || wedges.length){
        const aim = (wedges.length ? "w" + wedges.join("|") : "")
                  + boxes.map(b => b.map(Math.round)).join(";");
        const here = routeFrom && [Math.round(routeFrom.x / CELL_LY + 1025),
                                   Math.round(1591 - routeFrom.z / CELL_LY)];
        const holdsOrigin = here && regions.some(
          r => here[0] >= r.cx0 && here[0] <= r.cx1
            && here[1] >= r.cy0 && here[1] <= r.cy1);
        if (aim !== flyAimed && !holdsOrigin){
          flyAimed = aim;
          // The view moves twice and no more: out to the sector when the sector
          // is known, and in to the cell when one cell is left. Everything
          // between is the same offset in four places at once, so tightening on
          // the box around them is motion that cannot tell you anything.
          const oneCell = !whole && regions.length === 1
                       && regions[0].cx0 === regions[0].cx1
                       && regions[0].cy0 === regions[0].cy1;
          if (whole || oneCell){
            const frame = boxes.length ? boxes
              : regions.map(r => boxOf(r.cx0, r.cy0, r.cx1, r.cy1));
            const b = boxAround(frame.flatMap(k => [[k[0], k[1]], [k[2], k[3]]]));
            // A sector lands at a fixed width rather than a share of the screen:
            // its own extent varies with how far out it sits, and the view
            // should not.
            if (b && whole) flyTrip((b[0] + b[2]) / 2, (b[1] + b[3]) / 2,
                                    scaleFor(SECTOR_VIEW_LY));
            else if (b) flyToBounds(b[0], b[1], b[2], b[3], 0.8, flyTrip);
          }
          flashBounds(boxes, wedges);
        }
      }
    }

    for (const [si, hits] of groups){
      const head = document.createElement("li");
      head.innerHTML = `${S[si][NAME]}<span class="ly">${num(S[si][LY])} ly</span>`;
      head.onclick = () => {
        list.innerHTML = "";
        if (id === "find") closeFind();
        setEnd(end, S[si]); focusOn(S[si], 14, flyTrip);
      };
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
// Enter takes the first thing offered, which is what the list is ordered for.
for (const id of ["from", "to", "find"])
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const first = document.querySelector(`.hits[data-for="${id}"] li`);
    if (!first) return;
    e.preventDefault();
    first.click();
  });

bindSearch("from");
bindSearch("to");
bindSearch("find");

// The search is an icon until it is wanted, as the language picker is a flag.
const findBox = document.getElementById("findBox"), findInput = document.getElementById("find");
function closeFind(){
  findBox.hidden = true;
  findInput.value = "";
  document.querySelector('.hits[data-for="find"]').innerHTML = "";
}
document.getElementById("findBtn").addEventListener("click", () => {
  if (!findBox.hidden) return closeFind();
  findBox.hidden = false;
  findInput.focus();
});
document.getElementById("findGo").addEventListener("click", () =>
  document.querySelector('.hits[data-for="find"] li')?.click());

// Coming back to either box re-describes the system it holds, so you can check
// what you picked without hunting for it on the map.
for (const [id, get] of [["from", () => routeFrom], ["to", () => routeTo]]){
  const box = document.getElementById(id);
  for (const ev of ["focus", "pointerdown"])
    box.addEventListener(ev, () => describeEnd(get()));
}

// The two notes the route boxes carry: how to replace an origin, once there is
// one, and the gesture that plots a destination, while one is still wanted. Both
// name what this device actually does.
{
  const from = document.getElementById("fromNote");
  const dowse = document.getElementById("dowseNote");
  if (TOUCH){ from.dataset.ui = "fromNoteTouch"; dowse.dataset.ui = "dowseTouch"; }
  from.textContent = ui(from.dataset.ui);
  dowse.textContent = ui(dowse.dataset.ui);
  const sec = document.getElementById("routeSec");
  const head = document.getElementById("routeHead");
  showNotes = () => {
    from.hidden = !routeFrom;
    dowse.hidden = !dowsing();
    // The section is open while a journey is still being chosen, and closes
    // itself once both ends are settled: the answer is one line, and the boxes
    // that produced it are in the way of everything below them.
    const settled = !!routeFrom && !!routeTo && !dowseProvisional;
    head.textContent = settled
      ? `${routeFrom.name} \u2192 ${routeTo.name}` + (routeFlown ? ` \u00b7 ${routeFlown}` : "")
      : ui("route");
    head.removeAttribute("data-ui");
    if (settled === sec.open) sec.open = !settled;
  };
}

addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "+" || e.key === "=") document.getElementById("zin").click();
  if (e.key === "-") document.getElementById("zout").click();
  if (e.key === "0") document.getElementById("zreset").click();
});

const counts = {catalogue:0, fuel:0, station:0, belt:0, land:0, eng:0, gate:0,
                auth:0, wreck:0};
for (const k in TRADE_BIT) counts[k] = 0;
counts.catalogue = S.length;
for (const s of S){
  for (const k in TRADE_BIT) if (tradeOf(s) & TRADE_BIT[k]) counts[k]++;
  if (s[FUEL]) counts.fuel++;
  if (s[ST]) counts.station++;
  if (s[BE]) counts.belt++;
  if (s[LA]) counts.land++;
  if (s[EN]) counts.eng++;
  if (s[GATE]) counts.gate++;
  if (s[AUTH]) counts.auth++;
  if (WRECKS.has(s[NAME])) counts.wreck++;
}
for (const [k, v] of Object.entries(counts))
  for (const el of document.querySelectorAll(`[data-n="${k}"]`))
    el.textContent = v.toLocaleString();

addEventListener("resize", resize);
// A background tab measures zero; this is when it stops being one.
addEventListener("visibilitychange", () => { if (!document.hidden) resize(); });


// Generated stars are produced from their cell's seed as the view needs them.
// Below GEN_SCALE a cell is a few pixels wide and drawing 100 stars into it is
// noise, so the catalogue alone is shown. `catalogue`, `fuel` and `auth` have no
// control any more; they stay honoured so a link published while they did still
// means what it said.
let genLoading = false;
function drawGenerated(){
  genVisible = [];
  // Generated systems can never host a mission, a station or an engineer, so
  // that filter simply hides them.
  if (scale < GEN_MIN_SCALE() || filters.has("catalogue")) return;
  if (!GEN.side){
    // The two generation maps are about 1 MB and only matter once you are
    // zoomed in far enough to see individual stars, so they load on demand.
    if (!genLoading){
      genLoading = true;
      loadGenerationMaps().then(resettleLabels).catch(() => {}).finally(() => { genLoading = false; });
    }
    return;
  }
  const pad = 40;
  const x0 = Math.floor((wxOf(-pad) / CELL_LY) + 1025);
  const x1 = Math.ceil((wxOf(W + pad) / CELL_LY) + 1025);
  const y0 = Math.floor(1591 - (wzOf(-pad) / CELL_LY));
  const y1 = Math.ceil(1591 - (wzOf(H + pad) / CELL_LY));
  const deep = needsBodies();
  if ((x1 - x0) * (y1 - y0) > 60000) return;
  // Too wide to draw every star, so each cell contributes a share of its own,
  // scattered across the cell rather than sitting in the corner the walk starts
  // from. The systems are real: the position is the lie, and it lasts only
  // until the view is close enough to draw the cell in full.
  // A filter is answered by making every system in view, which is only
  // affordable while the view is narrow.
  if (anyFilter() && acrossLy() > FILTER_MAX_LY) return;
  const share = genShare();
  const spread = st => {
    if (share >= 1 || st.at) return;
    const h = mix(st.seed);
    const cx0 = Math.floor(st.x / CELL_LY + 1025), cy0 = Math.floor(1591 - st.z / CELL_LY);
    st.at = [((cx0 + (h & 0xFFFF) / 65536) - 1025) * CELL_LY,
             (1591 - (cy0 + ((h >>> 16) & 0xFFFF) / 65536)) * CELL_LY];
  };

  // Answering a planet-level filter costs about 50us per system, which is more
  // than a frame's worth over a wide view. So the work is time-boxed and the
  // rest is picked up on the next frame, filling in rather than blanking out.
  const deadline = deep ? performance.now() + 90 : Infinity;
  let ranOut = false;

  // Cell by cell rather than from a list, because the list is what is being
  // made. The frame gives up when it runs out of time and the next one picks up
  // where this stopped, filling in rather than blanking out.
  function* cells(){
    for (let cy = y0; cy <= y1 && !ranOut; cy++){
      for (let cx = x0; cx <= x1; cx++){
        if (deep && performance.now() > deadline){ ranOut = true; return; }
        // Below one star a cell, the share is spent on which cells get one at
        // all: a cell is a few pixels wide out here, so which of them are
        // empty cannot be seen, and the count on screen stays constant.
        if (share < 1){
          const n = share * (GEN.side[cy * GRID + cx] ** 2);
          if (n < 1 && mix(Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) / 4294967296 > n)
            continue;
        }
        for (const st of cellStars(cx, cy, share)){ spread(st); yield st; }
      }
    }
  }
  drawSystems(cells(), {
    // A system worth the gold is worth a full-size mark at any width.
    r: (st, cr) => cr >= RICH_MIN ? GOLD_R() : DOT_SM(),
    at: st => st.at || [st.x, st.z],
    ok: st => passesGenerated(st, deep),
    kept: st => genVisible.push(st),
    plain: st => st.colour,
    // Bodies are only made when a filter has already asked for them, so the
    // gold appears once the map knows enough to be right about it.
    value: st => deep ? systemValue(st) : null,
  });
  // A generated system says the same things a catalogued one does, in the same
  // order of importance, into the same queue.
  for (const st of genVisible){
    const px = sx(st.x), py = sy(st.z), r = onRoute.has(st.name) ? -1 : 4;
    if (F.ore >= 0){
      const pct = generatedOrePct(st, F.ore);
      if (pct) label(px, py, r, st.name, [[(deepDigit(F.ore) ? DEEP_TONS : pct + "%") + "  ", ORE_INK], [st.name, INK]]);
    } else if (F.mat >= 0 && deep){
      const span = generatedMatSpan(st, F.mat);
      if (span) label(px, py, r, st.name, [[spanText(span) + "  ", ORE_INK], [st.name, INK]]);
    } else if (valueAsked() && deep){
      label(px, py, r, st.name, [[worthLabel(systemValue(st)), VALUE_INK]]);
    } else if (scale > 4 || onRoute.has(st.name)){
      // The cell beneath it already carries the pairs; the quadrant letter and
      // the index are what tell two systems in that cell apart.
      const shown = cellGridOn() ? st.name.replace(/^.*?([A-E]\d+)$/, "$1") : st.name;
      label(px, py, r, st.name, [[shown, INK]]);
    }
  }
  if (ranOut) requestAnimationFrame(draw);
}

// The richest showing of an ore in a generated system, 0 when it has none.
// A deep ore reads 100 where the cell carries it and a belt is there to crack.
function generatedOrePct(st, oreIndex){
  const digit = deepDigit(oreIndex);
  if (digit){
    const cx = (st.seed >>> 20) & 0xFFF, cy = (st.seed >>> 8) & 0xFFF;
    return (cx + cy) % 10 === digit && starBodies(st).belts.length ? 100 : 0;
  }
  const want = D.oreRaw[oreIndex];
  let best = 0;
  for (const belt of starBodies(st).belts)
    for (const o of belt.ores) if (o.name === want && o.pct > best) best = o.pct;
  return best;
}


// Which filters a generated system can be judged on at all. It never has a
// station, an engineer, a gate or a hand-built body, so those simply exclude it.
// A generated system never has a station, so no trade rule can apply to one.
const IMPOSSIBLE = ["catalogue", "station", "eng", "gate", "auth", "wreck",
                    ...Object.keys(TRADE_BIT)];

function needsBodies(){
  return F.ore >= 0 || F.ptype >= 0 || F.mat >= 0 || F.valMin != null ||
         F.plMin != null || F.laMin != null ||
         filters.has("belt") || filters.has("land");
}

function passesGenerated(st, deep){
  for (const f of IMPOSSIBLE) if (filters.has(f)) return false;
  if (F.purp.size || F.fac.size || F.module >= 0 || F.arena != null || F.stLs != null) return false;
  if (filters.has("fuel") && !st.fuel) return false;
  if (F.startype && st.raw !== F.startype) return false;
  if (F.sec.size && !F.sec.has("A")) return false;          // generated space is Anarchy
  const ly = Math.hypot(st.x, st.z);
  if (F.lyMin != null && ly < F.lyMin) return false;
  if (F.lyMax != null && ly > F.lyMax) return false;
  if (!deep) return true;

  // Value is cached per system; the rest has to read the bodies themselves, so
  // the cheap answer is given first and the planets are only made if something
  // still asks about them.
  if (F.valMin != null && worth(st) < F.valMin) return false;
  if (!(filters.has("belt") || filters.has("land") || F.plMin != null
        || F.laMin != null || F.ptype >= 0 || F.mat >= 0 || F.ore >= 0)) return true;

  const b = starBodies(st);
  if (filters.has("belt") && !b.belts.length) return false;
  if (filters.has("land") && !b.landable) return false;
  if (F.plMin != null && b.planets.length < F.plMin) return false;
  if (F.laMin != null && b.landable < F.laMin) return false;
  if (F.ptype >= 0 && !b.planets.some(p => p.type === PTYPES[F.ptype])) return false;
  if (F.mat >= 0 && !b.planets.some(p => p.mats.includes(D.matRaw[F.mat]))) return false;
  if (F.mat >= 0 && F.matPctMin != null && generatedMatSpan(st, F.mat)[1] < F.matPctMin) return false;
  if (F.ore >= 0){
    const best = generatedOrePct(st, F.ore);
    if (!best) return false;
    if (F.pctMin != null && best < F.pctMin) return false;
  }
  return true;
}

// ---- outfitting calculators -------------------------------------------------
// The game never shows how a module's rating turns into a number on your ship.
// These reproduce the three calculations that depend on mass.
{
  const C = D.calc;
  const byClass = list => [...list].sort((a, b) => a.cls - b.cls ||
    "EDCBA".indexOf(a.g) - "EDCBA".indexOf(b.g));
  // Abramowitz and Stegun 7.1.26 with MathE.erf's constants; the shield curve
  // is an error function.
  const erf = x => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.25482952) * t * Math.exp(-x * x);
    return x < 0 ? -y : y;
  };
  const GRADE = {E: 1, D: 2, C: 3, B: 4, A: 5};

  const fill = (id, list) => {
    const sel = document.getElementById(id);
    sel.innerHTML = `<option value="">${ui("calcNone")}</option>`;
    byClass(list).forEach((m, i) => {
      const o = document.createElement("option");
      o.value = String(i); o.textContent = m.n;
      sel.append(o);
    });
    return sel;
  };
  const sels = {warp: fill("calcWarp", C.warp), shield: fill("calcShield", C.shield),
                thruster: fill("calcThruster", C.thrust)};
  const lists = {warp: byClass(C.warp), shield: byClass(C.shield),
                 thruster: byClass(C.thrust)};
  // The stock hull is first: the lightest, and what every ship is sold with.
  const hullBox = document.getElementById("calcHull");
  C.hull.forEach((h, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = shipName(h);
    hullBox.append(o);
  });
  const massBox = document.getElementById("calcMass");
  const loadBox = document.getElementById("calcLoad");
  const out = document.getElementById("calcOut");
  // The hull decides what a shield is worth and how fast the ship goes, so the
  // figures are in the game's own units once one is named.
  const shipBox = document.getElementById("calcShip");
  (D.calc.ships || []).forEach((sh, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = shipName(sh);
    shipBox.append(o);
  });
  // The loadout planner opens on the chosen ship's build, or on its ship list.
  const planFit = document.getElementById("planFit");
  const setPlan = () => {
    const sh = shipBox.value === "" ? null : D.calc.ships[+shipBox.value];
    planFit.href = LOADOUTS_URL + (sh ? "#/build/" + encodeURIComponent(sh.key) : "#/ships");
  };
  shipBox.addEventListener("change", setPlan);
  setPlan();
  // Choosing a ship fills the mass box with the hull's own mass, unless the
  // reader has typed a mass of their own: a figure the ship box put there is
  // the ship box's to replace.
  let massIsOurs = true;
  massBox.addEventListener("input", () => { massIsOurs = massBox.value === ""; });
  shipBox.addEventListener("change", () => {
    const sh = shipBox.value === "" ? null : D.calc.ships[+shipBox.value];
    if (sh && massIsOurs) massBox.value = sh.mass;
  });

  function recalc(){
    const mass = +massBox.value;
    const ship = shipBox.value === "" ? null : D.calc.ships[+shipBox.value];
    // Speed is rated against the hull and what it carries, never against the
    // modules bolted to it; shields are rated against the bare hull alone.
    // ShipInfo.SpeedMax_calc: the hull module scales the hull's mass, within 0.8-2x.
    const hullMass = ship ? Math.min(Math.max(ship.mass * (1 + C.hull[+hullBox.value].mul),
                                              0.8 * ship.mass), 2 * ship.mass) : 0;
    const flying = ship ? hullMass + (+loadBox.value || 0) : 0;
    const rows = [];
    const pick = k => sels[k].value === "" ? null : lists[k][+sels[k].value];
    const warp = pick("warp"), shield = pick("shield"), thr = pick("thruster");
    const need = `<dd class="muted">${ui("calcMass").toLowerCase()}?</dd>`;
    const needShip = `<dd class="muted">${ui("pickShip")}?</dd>`;

    if (warp){
      const reach = Math.pow(1000 * warp.maxFuel / warp.sub, 1 / warp.cc);
      let ly = mass > 0 ? warp.opt / mass * reach : null;
      // ShipInfo.CalcJump throws away anything past 150 and substitutes 30, so
      // a drive too strong for the hull is worse than a smaller one.
      let cliff = null;
      if (ly > 150){
        ly = 30;
        cliff = Math.ceil(warp.opt * reach / 150);
      }
      // The figure is only useful once the map is planning with it, so it
      // offers itself to the Max jump box rather than waiting to be copied.
      rows.push([ui("calcJump"), ly == null ? null
        : `${ly.toFixed(1)} ly <button type="button" class="setJump" `
          + `data-ly="${ly.toFixed(1)}" data-ui="calcSet">${ui("calcSet")}</button>`]);
      rows.push([ui("calcInUse"), `${num(jumpLy)} ly`]);
      if (cliff) rows.push([null, `<span class="cliff">`
        + fmt("calcCliff", {t: num(cliff)}) + `</span>`]);
    }
    if (shield){
      const f = ship
        ? 0.53821 * erf(1.0228 * shield.opt / ship.mass) - 0.0588 * shield.decr + 0.56377
        : null;
      rows.push([ui("calcShieldOut"),
                 f == null ? null : `${Math.round(ship.shields * f)} MW`]);
    }
    if (thr){
      // ShipInfo.SpeedCalc, in the units the game's own ship panel prints.
      const speed = ship
        ? ship.speed * Math.sqrt(thr.opt / flying) * 0.0165
          * (1 + GRADE[thr.g] / 35 - 1 / 35)
        : null;
      rows.push([ui("calcSpeedOut"), speed == null ? null : `${speed.toFixed(1)} ls/s`]);
      if (speed != null){
        rows.push([ui("calcAccelOut"), `${(speed / 4.5).toFixed(1)} ls/s\u00b2`]);
        rows.push([ui("calcTurnOut"),
                   `${(speed / 10 * 180 / Math.PI).toFixed(1)}\u00b0/s\u00b2`]);
      }
    }
    out.innerHTML = rows.map(([k, v]) =>
      k == null ? `<dd class="wide">${v}</dd>`
        : `<dt>${k}</dt>${v != null ? `<dd>${v}</dd>`
            : k === ui("calcJump") ? need : needShip}`).join("");
    for (const b of out.querySelectorAll(".setJump"))
      b.onclick = () => {
        const box = document.getElementById("jump");
        box.value = Math.round(+b.dataset.ly);
        box.dispatchEvent(new Event("input"));
        box.dispatchEvent(new Event("change"));
        recalc();
      };
  }
  for (const el of [massBox, loadBox, shipBox, hullBox, sels.warp, sels.shield, sels.thruster]){
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }
  recalc();
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
  // `src` is kept so the end can be described again later, from the inputs.
  return Array.isArray(source)
    ? {name: source[NAME], x: source[X], z: source[Z], row: source, src: source}
    : {name: source.name, x: source.x, z: source.z, src: source};
}

// Describe whichever system an end names, wherever it currently sits on screen.
function describeEnd(p){
  if (!p || !p.src) return;
  const s = p.src;
  Array.isArray(s) ? showTip(s, sx(s[X]), sy(s[Z]))
                   : showGenTip(s, sx(s.x), sy(s.z));
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

// Every gate starts broken and carries nobody until both its ends are repaired,
// so a gate is an edge only once the player has ticked both. Ends are bits: gate
// i's first end is bit 2i, its second 2i+1.
let gatesMask = +(localStorage.getItem("gg.gates") || 0);
const gateEndRepaired = name => {
  const i = D.gates.findIndex(g => g.includes(name));
  return i >= 0 && !!(gatesMask >> (2 * i + D.gates[i].indexOf(name)) & 1);
};
const gatesWorking = () => D.gates.filter(([a, b]) => gateEndRepaired(a) && gateEndRepaired(b));
const gateLinks = new Map();
function buildGateLinks(){
  gateLinks.clear();
  for (const [a, b] of gatesWorking()){
    if (!gateLinks.has(a)) gateLinks.set(a, []);
    if (!gateLinks.has(b)) gateLinks.set(b, []);
    gateLinks.get(a).push(b);
    gateLinks.get(b).push(a);
  }
}
buildGateLinks();

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
  routePath = null; routeGates = null; routePartial = false; routeFlown = "";
  if (!routeFrom || !routeTo){ note.textContent = ""; showNotes(); draw(); return; }
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
    const gateNote = viaGates ? " \u00b7 " + fmt("viaGate", {n: viaGates}) : "";
    // Finding a system worth flying to and learning how far it is were two
    // separate acts until this line.
    const worth = routeTo.src ? systemValue(routeTo.src) : null;
    const payNote = worth && worth.full
      ? "<br>" + fmt("banksOnArrival",
          {cr: num(worth.arrival), scanner: D.scanners[scanner][0]}) +
        (worth.hops ? " \u00b7 " + fmt("thenHops",
          {cr: num(worth.reach), hops: plural("hops", worth.hops)}) : "")
      : "";
    if (r.partial){
      const stop = r.path[r.path.length - 1];
      routeFlown = fmt("stopsAt", {sys: stop.name, jumps: plural("jumps", jumpsN),
                                   ly: num(Math.round(r.total))});
      const gap = Math.hypot(routeTo.x - stop.x, routeTo.z - stop.z);
      note.innerHTML =
        `<b>${fmt("noRoute", {ly: jumpLy})}</b> ` +
        fmt("stopsAt", {sys: stop.name, jumps: plural("jumps", jumpsN),
                        ly: num(Math.round(r.total))}) +
        `<br><b>${fmt("short", {ly: num(Math.round(gap)), sys: routeTo.name})}</b>`;
    } else {
      routeFlown = fmt("routeOk",
        {jumps: plural("jumps", jumpsN), ly: num(Math.round(r.total))});
      note.innerHTML = routeFlown + gateNote + payNote;
    }
    showNotes();
  } finally {
    routeBusy = false;
    draw();
  }
}

function setEnd(which, source){
  const p = endpointOf(source);
  if (which === "from"){ routeFrom = p; document.getElementById("from").value = p.name; }
  else { routeTo = p; document.getElementById("to").value = p.name; }
  syncToBox();
  showNotes();
  recomputeRoute();
  // However the end was chosen, the system it names is described. Deferred a
  // frame because callers may recentre the view around it first.
  requestAnimationFrame(() => describeEnd(p));
}

function clearRoute(){
  routeFrom = routeTo = routePath = routeGates = null;
  dowseProvisional = false;
  showNotes();
  syncToBox();
  document.getElementById("from").value = "";
  document.getElementById("to").value = "";
  document.getElementById("routeNote").textContent = "";
  draw();
}

// ---- drawing ---------------------------------------------------------------
function drawRoute(){
  // The chosen ends are marked whether or not a route joins them: an origin on
  // its own is still the place the map is answering about.
  for (const [end, colour, dir] of [[routeFrom, "#ff9f2e", 1], [routeTo, "#4fc3ff", 1]]){
    if (!end) continue;
    const px = sx(end.x), py = sy(end.z);
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, 6.283);
    ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.stroke();
    if (!routePath) marker(px, py, colour, dir);
  }
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
    marker(sx(routePath[0].x), sy(routePath[0].z), "#ff9f2e", 1);
    const e = routePath[routePath.length - 1];
    marker(sx(e.x), sy(e.z), "#4fc3ff", 1);
  }
  // The route names its own stops, because most of a journey is generated space
  // and above the systems zoom none of it is drawn.
  for (const p of routePath)
    if (p.name) label(sx(p.x), sy(p.z), -1, p.name, [[p.name, "#ffd08a"]]);
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
// Escape undoes the journey one end at a time: the destination first, because
// changing your mind about where you are going is the common case.
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  focused = [];
  if (routeTo){
    routeTo = routePath = routeGates = null;
    dowseProvisional = false;
    document.getElementById("to").value = "";
    document.getElementById("routeNote").textContent = "";
    routeFlown = "";
    showNotes();
    draw();
    return;
  }
  clearRoute();
});
document.getElementById("clearRoute").onclick = clearRoute;

// The repaired ends, ticked in a dialog under the jump range.
function setGatesMask(m){
  gatesMask = m;
  try { localStorage.setItem("gg.gates", String(m)); } catch (_) {}
  buildGateLinks();
  gatesBtnLabel();
  recomputeRoute();
}
const gatesBtnLabel = () =>
  document.getElementById("gatesBtn").textContent = fmt("gatesBtn", {n: gatesWorking().length});
{
  const dlg = document.getElementById("gatesDlg");
  const list = document.getElementById("gatesList");
  D.gates.forEach(([a, b], i) => {
    const box = document.createElement("fieldset");
    box.innerHTML = `<legend>${a} \u2194 ${b}</legend>` + [a, b].map((end, k) =>
      `<label><input type="checkbox" data-bit="${2 * i + k}"> ${end}</label>`).join("");
    list.append(box);
  });
  list.addEventListener("change", e => {
    const bit = +e.target.dataset.bit;
    setGatesMask(e.target.checked ? gatesMask | 1 << bit : gatesMask & ~(1 << bit));
  });
  document.getElementById("gatesBtn").onclick = () => {
    for (const cb of list.querySelectorAll("input")) cb.checked = !!(gatesMask >> +cb.dataset.bit & 1);
    dlg.showModal();
  };
  document.getElementById("gatesDone").onclick = () => dlg.close();
  gatesBtnLabel();
}

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
  // The picker is a flag until it is wanted: one row of the rail rather than a
  // dropdown nobody touches twice.
  const flag = document.getElementById("langFlag");
  const showFlag = () => { flag.textContent = LANG_FLAG[lang] || "\u{1F310}"; };
  showFlag();
  flag.addEventListener("click", () => {
    if (!sel.hidden){ sel.hidden = true; return; }
    sel.hidden = false;
    sel.focus();
    // Drop the list open in the same press, where the browser allows it: the
    // flag was the click, so a second one to open the picker is a click wasted.
    if (sel.showPicker) { try { sel.showPicker(); } catch (_) {} }
  });
  // Settling is choosing one or looking away; either way the row goes.
  sel.addEventListener("blur", () => { sel.hidden = true; });
  sel.addEventListener("keydown", e => { if (e.key === "Escape") sel.hidden = true; });

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
    // The game's name stays as the developer wrote it in every language, so it
    // can be picked out of the translated title wherever the word order puts it.
    const esc = t => t.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"})[c]);
    document.getElementById("brandTitle").innerHTML = esc(ui("title"))
      .replace("Galaxy Genome", '<span class="game">Galaxy Genome</span>');
    gatesBtnLabel();
  };
  sel.addEventListener("change", () => {
    sel.hidden = true;
    lang = sel.value;
    try { localStorage.setItem("gg.lang", lang); } catch (_) {}
    TYPES = named(D.typeKeys, D.types);
    ORES = named(D.oreKeys, D.ores);
    PTYPES = named(D.ptypeKeys, D.ptypes);
    MATS = named(D.matKeys, D.matRaw);
    MODULES = named(D.moduleKeys, D.modules);
    for (const [id, list] of [["ore", ORES], ["ptype", PTYPES], ["mat", MATS], ["module", MODULES]]){
      const el = document.getElementById(id);
      for (const o of el.options) if (o.value !== "") o.textContent = list[+o.value];
    }
    for (const o of document.getElementById("calcShip").options)
      if (o.value !== "") o.textContent = shipName(D.calc.ships[+o.value]);
    document.querySelectorAll("#secRow .pill").forEach((b, i) => b.textContent = ui(SECS[i][1]));
    document.querySelectorAll("#scanner option").forEach((o, i) => {
      o.textContent = (i ? D.scanners[i][0] : ui("scannerNone"))
                    + `  \u00b7 ${D.scanners[i][1]} ls`;
    });
    refreshCounts();
    document.querySelectorAll("#purpRow .pill").forEach((b, i) => b.textContent = ui(D.purposeSlots[i]));
    document.querySelectorAll("#facRow .pill").forEach((b, i) => b.textContent = t(D.factionKeys[i]));
    applyUI();
    showFlag();
    draw();
  });
  applyUI();
}

resize();   // first paint, once route state exists

// Spoiler toggle: landmarks, gates, engineers and expedition targets.
{
  const box = document.getElementById("spoilers");
  const hideable = [...document.querySelectorAll(
    '[data-f="eng"],[data-spoiler]')];
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
        if (sel2 && sel2.value !== ""){ sel2.value = ""; F.startype = ""; }
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

// Frame both ends of a linked route, so the trip is visible on arrival.
function fitToRoute(){
  if (!routeFrom || !routeTo) return;
  const x0 = Math.min(routeFrom.x, routeTo.x), x1 = Math.max(routeFrom.x, routeTo.x);
  const z0 = Math.min(routeFrom.z, routeTo.z), z1 = Math.max(routeFrom.z, routeTo.z);
  const span = Math.max((x1 - x0) * 1.3, (z1 - z0) * 1.3 * W / H, HOME_LY);
  goto((x0 + x1) / 2, (z0 + z1) / 2, scaleFor(span));
}

// A filtered link opens at the usual zoom on the nearest match, rather than on
// a galaxy-wide view no one can read or on empty sky near Sol.
// A filter answers with a set, so the view has to frame the set. Landing on one
// member tells you nothing about the other hundred and sixty-two.
//
// Sol stays the centre, because every distance on the map is measured from it,
// and the frame is four times the median match: half of them sit between the
// centre and halfway to the edge. Matches are spread bimodally — a Sol
// neighbourhood, then The Void at 4,562 ly, then stragglers — so a percentile
// or a bounding box is either far too tight or far too wide, and this is not.
const FRAME_MIN_LY = 300;

function fitToMatches(fly = false){
  const go = fly ? flyPath : goto;
  // A star type goes to the closest system that has one, wherever it is and
  // whether or not anyone named it.
  const near = F.startype && (D.starNear || {})[F.startype];
  if (near && near.length){
    const [, x, z] = near[0];
    // Close enough that generated systems are drawn, so the star is on screen.
    go(x, z, Math.max(scaleFor(400), GEN_SCALE() * 2));
    return;
  }
  const hit = S.filter(passes);
  if (!hit.length) return;
  const ly = hit.map(s => s[LY]).sort((a, b) => a - b);
  const across = Math.min(Math.max(ly[ly.length >> 1] * 4, FRAME_MIN_LY), GALAXY_LY);
  go(0, 0, scaleFor(across));
  flashMatches(hit);
}

// ---- deep links -------------------------------------------------------------
// A link can arrive pre-filtered or pre-routed, so a wiki page can point at
// "belts holding Painite" rather than at the map's front door. Every parameter
// drives the control a person would have used, which keeps the sidebar honest.
async function applyParams(){
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return;
  const fire = (el, ev = "change") => el.dispatchEvent(new Event(ev, {bubbles: true}));
  // Whatever a link switched on, so the sidebar can show its work afterwards.
  const touched = [];

  const lang0 = p.get("lang");
  if (lang0 && D.langCodes.includes(lang0)){
    const sel = document.getElementById("lang");
    sel.value = lang0; fire(sel);
  }
  if (p.get("spoilers") === "1"){
    const c = document.getElementById("spoilers");
    if (!c.checked){ c.checked = true; fire(c, "change"); }
  }

  // Chips, by the same names the sidebar uses.
  for (const f of (p.get("filters") || "").split(",").filter(Boolean)){
    const name = f.trim();
    const b = document.querySelector(`[data-f="${CSS.escape(name)}"]`);
    if (b){
      if (b.getAttribute("aria-pressed") !== "true"){ b.click(); touched.push(b); }
    // Not every filter has a chip of its own: the ones a preset turns on are
    // still filters, and a link may ask for them directly.
    } else if (name in counts || name === "wreck"){
      filters.add(name);
    }
  }

  // A dropdown is matched on the game's own key first, then on what it shows,
  // so a link works whatever language the reader has selected.
  const choose = (id, raw, want) => {
    const sel = document.getElementById(id);
    if (!sel || !want) return;
    const w = want.trim().toLowerCase();
    const i = (raw || []).findIndex(k => String(k).toLowerCase() === w);
    if (i >= 0) sel.value = String(i);
    else {
      const o = [...sel.options].find(o => o.textContent.trim().toLowerCase() === w);
      if (!o) return;
      sel.value = o.value;
    }
    fire(sel);
    touched.push(sel);
  };
  choose("ore", D.oreRaw, p.get("ore"));
  choose("ptype", D.ptypeRaw, p.get("ptype"));
  choose("mat", D.matRaw, p.get("mat"));
  {
    const v = p.get("arena");
    if (v){
      const el = document.getElementById("arena");
      el.value = v; fire(el); touched.push(el);
    }
  }
  choose("module", D.moduleRaw, p.get("module"));

  // Faction and shop-purpose are rows of toggles rather than dropdowns.
  const pills = (host, names, want) => {
    const btns = document.querySelectorAll(`#${host} .pill`);
    for (const one of (want || "").split(",").filter(Boolean)){
      const i = names.findIndex(n => String(n).toLowerCase() === one.trim().toLowerCase());
      if (i >= 0 && btns[i] && btns[i].getAttribute("aria-pressed") !== "true"){
        btns[i].click(); touched.push(btns[i]);
      }
    }
  };
  pills("facRow", D.factions, p.get("faction"));
  pills("purpRow", D.purposes, p.get("purpose"));
  pills("secRow", SECS.map(x => x[0]), p.get("security"));
  if (p.get("onehop") === "1"){
    const c = document.getElementById("oneHop");
    if (!c.checked){ c.checked = true; fire(c, "change"); }
  }
  // All classes is on by default, so a link only has to carry the other case.
  if (p.get("fullgrade") === "0"){
    const b = document.getElementById("fullOnly");
    if (b.getAttribute("aria-pressed") === "true"){ b.click(); touched.push(b); }
  }
  {   // the star filter is keyed by the game's own name, not a position
    const want = (p.get("startype") || "").trim().toLowerCase();
    const sel = document.getElementById("startype");
    const opt = want && [...sel.options].find(o => o.value.toLowerCase() === want);
    if (opt){ sel.value = opt.value; fire(sel); touched.push(sel); }
  }

  // Distance has no control of its own any more, but a link may still ask for
  // it: the wiki points at "every station inside 100 ly".
  for (const [key, id] of [["lymin", "lyMin"], ["lymax", "lyMax"]]){
    const v = p.get(key);
    if (v != null && v !== "") F[id] = +v;
  }

  for (const [key, id] of [["pct", "pctMin"], ["mpct", "matPctMin"], ["value", "valMin"], ["planets", "plMin"],
                           ["landable", "laMin"], ["stationls", "stLs"]]){
    const v = p.get(key);
    if (v == null) continue;
    const el = document.getElementById(id);
    el.disabled = false; el.value = v; fire(el, "input"); fire(el);
    touched.push(el);
  }

  {
    const want = (p.get("scanner") || "").trim().toLowerCase();
    const i = D.scanners.findIndex(x => x[0].toLowerCase() === want);
    const el = document.getElementById("scanner");
    if (i >= 0){ el.value = String(i); fire(el); touched.push(el); }
  }

  if (p.get("gates")) setGatesMask(+p.get("gates") || 0);
  const jump = p.get("jump") || p.get("warp");
  if (jump){
    const el = document.getElementById("jump");
    el.value = jump; fire(el, "input"); fire(el);
  }

  // A named system may be catalogued or generated; both are ordinary here.
  const resolve = async name => {
    const want = name.trim().toLowerCase();
    for (const [nm, i] of indexOfName)
      if (nm.toLowerCase() === want) return S[i];
    if (typeof cellFromName === "function" && cellFromName(name)){
      if (!GEN.side) await loadGenerationMaps();
      const c = cellFromName(name);
      return (cellStars(c.cx, c.cy) || []).find(
        st => st.name.toLowerCase() === want) || null;
    }
    return null;
  };

  const from = p.get("from"), to = p.get("to"), only = p.get("system");
  if (from){ const s = await resolve(from); if (s) setEnd("from", s); }
  if (to){ const s = await resolve(to); if (s) setEnd("to", s); }
  if (only){ const s = await resolve(only); if (s) focusOn(Array.isArray(s) ? s
    : {[NAME]: s.name, [X]: s.x, [Z]: s.z}); }
  if (from && !to){ const s = await resolve(from); if (s) focusOn(Array.isArray(s) ? s
    : {[NAME]: s.name, [X]: s.x, [Z]: s.z}); }
  if (from && to) fitToRoute();

  // A link that filters but names no place would otherwise open on a patch of
  // sky with nothing in it, so the view widens to where the matches are.
  // `at` is the centre of the uncovered map, which is what the readout shows and
  // what goto takes, so it round-trips through goto rather than through cx.
  try { overlays = JSON.parse(p.get("draw") || "{}") || {}; } catch (e) { overlays = {}; }
  const at = (p.get("at") || "").split(",").map(Number);
  const placed = at.length === 2 && at.every(Number.isFinite);
  const ly = +p.get("ly");
  if (ly > 0) goto(placed ? at[0] : cx, placed ? at[1] : cz,
                   scaleFor(ly));
  else if (placed) goto(at[0], at[1], scale);
  // A link opens where it says it opens; the flight is for a choice made here.
  else if (p.get("view") === "galaxy") showGalaxy(true);
  // An ore, material, planet type or module link is a search near home: framing
  // every match would open on the whole galaxy.
  // Deep ores fall in diagonal stripes across whole cells, which only read as a
  // pattern from further out.
  else if (!from && !only && ["ore", "mat", "ptype", "module"].some(k => p.get(k)))
    goto(0, 0, scaleFor(D.deepOres[p.get("ore")] ? 1100 : 150));
  else if (!from && !only && anyFilter()) fitToMatches();
  draw();
  reveal(touched[0]);
}

// Show the reader which control a link just set: open its section, bring it into
// view, and raise its help panel if it has one.
function reveal(el){
  if (!el) return;
  const det = el.closest("details");
  if (det) det.open = true;
  requestAnimationFrame(() => {
    el.scrollIntoView({block: "center", behavior: "smooth"});
    const holder = el.hasAttribute("data-help") ? el
      : el.closest("label")?.querySelector("[data-help]")
        || el.previousElementSibling?.querySelector?.("[data-help]")
        || el.parentElement?.querySelector("[data-help]");
    if (holder) showHelp(holder.dataset.help, holder);
  });
}

// ---- the address bar follows the sidebar ------------------------------------
// Every control writes itself back into the URL, so the page you are looking at
// is always the page you would send someone. The keys are the ones applyParams
// reads, which makes the round trip exact.
function currentParams(){
  const p = new URLSearchParams();
  const put = (k, v) => { if (v !== "" && v != null) p.set(k, v); };
  const pressed = host => [...document.querySelectorAll(`#${host} .pill`)]
    .map((b, i) => b.getAttribute("aria-pressed") === "true" ? i : -1)
    .filter(i => i >= 0);

  if (filters.size) put("filters", [...filters].join(","));
  if (F.ore >= 0){
    put("ore", D.oreRaw[F.ore]);
    if (F.pctMin != null && F.pctMin !== oreDefault(F.ore)) put("pct", F.pctMin);
  }
  if (F.ptype >= 0) put("ptype", D.ptypeRaw[F.ptype]);
  if (F.arena != null) put("arena", String(F.arena));
  if (F.mat >= 0){
    put("mat", D.matRaw[F.mat]);
    if (F.matPctMin != null && F.matPctMin !== matDefault(F.mat)) put("mpct", F.matPctMin);
  }
  if (F.module >= 0){
    put("module", D.moduleRaw[F.module]);
    if (!F.fullOnly) put("fullgrade", "0");
  }
  put("startype", F.startype);
  const sec = pressed("secRow").map(i => SECS[i][0]);
  if (sec.length) put("security", sec.join(","));
  const fac = pressed("facRow").map(i => D.factions[i]);
  if (fac.length) put("faction", fac.join(","));
  const purp = pressed("purpRow").map(i => D.purposes[i]);
  if (purp.length) put("purpose", purp.join(","));
  for (const [key, id] of [["value", "valMin"], ["planets", "plMin"],
                           ["landable", "laMin"], ["stationls", "stLs"], ["lymin", "lyMin"],
                           ["lymax", "lyMax"]])
    if (F[id] != null) put(key, F[id]);
  if (F.oneHop) put("onehop", "1");
  if (scanner !== 1) put("scanner", D.scanners[scanner][0]);
  if (jumpLy !== 10) put("jump", jumpLy);
  if (gatesMask) put("gates", gatesMask);
  // One end is where you are, which is worth sharing and drives the From-here
  // row. It is only a route once both ends are named, and only then does a line
  // get drawn or a route note appear.
  if (routeFrom) put("from", routeFrom.name);
  if (routeTo) put("to", routeTo.name);
  if (spoilers) put("spoilers", "1");
  if (lang !== "en") put("lang", lang);
  // Where the link points. A picked system is the point of interest; otherwise
  // it is the middle of what you are looking at, in the same words the readout
  // uses. Picking never moves the view — it only changes where a reader lands.
  const [ax, az] = routeFrom ? [routeFrom.x, routeFrom.z]
                             : [cx, cz];
  put("at", `${Math.round(ax)},${Math.round(az)}`);
  put("ly", Math.round(acrossLy()));
  if (Object.keys(overlays).length) put("draw", JSON.stringify(overlays));
  return p;
}

function syncURL(){
  if (urlBusy) return;
  // A flight passes through a hundred views on its way to one worth sharing.
  if (flyRAF) return;
  clearTimeout(urlTimer);
  // Panning calls draw every frame; the address bar only needs the last one.
  urlTimer = setTimeout(() => {
    // URLSearchParams serialises as form data, which escapes the commas in
    // `at`, `filters`, `security` and the rest. A comma is legal in a query
    // value and parses back the same, so the link stays readable.
    const qs = currentParams().toString().replace(/%2C/g, ",");
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }, 400);
}

applyParams()
  .catch(e => { console.error("deep link", e); })
  .finally(() => { urlBusy = false; syncToBox(); syncURL(); });
