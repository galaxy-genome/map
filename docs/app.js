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

function pick(mx, my){
  let best = null, bd = 14 * 14;
  for (const s of visible){
    if (!passes(s)) continue;
    const dx = sx(s[X]) - mx, dy = sy(s[Z]) - my, d = dx * dx + dy * dy;
    if (d < bd){ bd = d; best = s; }
  }
  return best;
}

function showTip(s, mx, my){
  const ore = D.oreDetail[s[NAME]];
  const alias = aliasBySystem.get(indexOfName.get(s[NAME])) || {};
  const aliasRows = ["station", "body", "engineer", "landmark"]
    .filter(k => alias[k] && !(SPOILER_ALIAS.has(k) && !spoilers))
    .map(k => `<dt>${ui(ALIAS_SLOT[k])}</dt><dd>${alias[k].slice(0, 6).join(", ")}` +
              `${alias[k].length > 6 ? ` +${alias[k].length - 6}` : ""}</dd>`)
    .join("");
  tip.innerHTML =
    `<h3>${s[NAME]}</h3><dl>` +
    `<dt>${ui("starType")}</dt><dd>${TYPES[s[TY]]}</dd>` +
    `<dt>${ui("security")}</dt><dd>${s[SEC] ? ui(SEC_SLOT[s[SEC]]) : "—"}</dd>` +
    `<dt>${ui("fuel")}</dt><dd>${s[FUEL] ? "\u2713" : "\u2014"}</dd>` +
    `<dt>${ui("distance")}</dt><dd>${num(s[LY])} ly</dd>` +
    `<dt>${ui("planets")}</dt><dd>${s[PL]}${s[LA] ? ` (${s[LA]})` : ""}</dd>` +
    `<dt>${ui("belts")}</dt><dd>${s[BE] || "—"}</dd>` +
    `<dt>${ui("stations")}</dt><dd>${s[ST] || "—"}</dd>` +
    (s[SCAN] ? `<dt>${ui("fullScan")}</dt><dd>${num(s[SCAN])} CR</dd>` : "") +
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
  s ? showTip(s, e.clientX, e.clientY) : (tip.style.display = "none");
});
// A single click fills whichever end is next; a double click always sets the
// origin, so the single action is held briefly to see if a second arrives.
let clickTimer = 0;
addEventListener("pointerup", e => {
  const wasDrag = drag && drag.moved;
  drag = null;
  if (wasDrag || e.target !== cv) return;
  const s = pick(e.clientX, e.clientY);
  if (!s) return;
  const i = indexOfName.get(s[NAME]);
  if (clickTimer){
    // Double click restarts the journey: new origin, no destination, no route.
    clearTimeout(clickTimer); clickTimer = 0;
    routeTo = null;
    document.getElementById("to").value = "";
    setEnd("from", i);
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = 0;
    setEnd(routeFrom == null ? "from" : "to", i);
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

    for (const [si, hits] of groups){
      const head = document.createElement("li");
      head.innerHTML = `${S[si][NAME]}<span class="ly">${num(S[si][LY])} ly</span>`;
      head.onclick = () => { list.innerHTML = ""; setEnd(id, si); focusOn(S[si]); };
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

const counts = {fuel:0, station:0, belt:0, land:0, eng:0, gate:0, auth:0};
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

// ---- routing ---------------------------------------------------------------
// Nodes are systems; an edge exists when two systems are within one jump.
// Cost is jumps first, distance second, so the route takes the fewest jumps and
// then the shortest path among those.
let jumpLy = +(localStorage.getItem("gg.jump") || 10);
let routeFrom = null, routeTo = null, routePath = null, routePartial = false;
let routeGates = null;
let cellSize = 0, cells = null;

// Warp gates are edges too: one jump, no distance flown. They only work once
// both ends are repaired, which the route note says out loud.
const gateAdj = new Map();
for (const [a, b] of D.gates){
  const ia = indexOfName.get(a), ib = indexOfName.get(b);
  if (ia == null || ib == null) continue;
  if (!gateAdj.has(ia)) gateAdj.set(ia, []);
  if (!gateAdj.has(ib)) gateAdj.set(ib, []);
  gateAdj.get(ia).push(ib);
  gateAdj.get(ib).push(ia);
}

function buildGrid(){
  cellSize = Math.max(jumpLy, 0.5);
  cells = new Map();
  S.forEach((s, i) => {
    const k = ((s[X] / cellSize) | 0) + "," + ((s[Z] / cellSize) | 0);
    let bucket = cells.get(k);
    if (!bucket) cells.set(k, bucket = []);
    bucket.push(i);
  });
}

function neighbours(i){
  const s = S[i], gx = (s[X] / cellSize) | 0, gz = (s[Z] / cellSize) | 0, out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++){
    const bucket = cells.get((gx + dx) + "," + (gz + dz));
    if (!bucket) continue;
    for (const j of bucket){
      if (j === i) continue;
      const d = Math.hypot(S[j][X] - s[X], S[j][Z] - s[Z]);
      if (d <= jumpLy) out.push([j, d]);
    }
  }
  if (spoilers) for (const j of gateAdj.get(i) || []) out.push([j, 0, true]);
  return out;
}

function findRoute(a, b){
  if (!cells) buildGrid();
  const n = S.length;
  const jumps = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const gateLeg = new Uint8Array(n);          // arrived at this node through a gate
  jumps[a] = 0; dist[a] = 0;
  // Layered BFS: every edge costs one jump, so a queue keeps jumps optimal and
  // the distance tie-break only ever improves a node inside its own layer.
  let frontier = [a];
  while (frontier.length){
    const next = [];
    for (const i of frontier){
      for (const [j, d, viaGate] of neighbours(i)){
        const nd = dist[i] + d;
        if (jumps[j] === -1){
          jumps[j] = jumps[i] + 1; dist[j] = nd; prev[j] = i;
          gateLeg[j] = viaGate ? 1 : 0; next.push(j);
        } else if (jumps[j] === jumps[i] + 1 && nd < dist[j]){
          dist[j] = nd; prev[j] = i; gateLeg[j] = viaGate ? 1 : 0;
        }
      }
    }
    frontier = next;
  }
  let target = b, partial = false;
  if (jumps[b] === -1){
    // Nothing reaches the destination at this range: stop at whichever reachable
    // system gets closest to it, so the user can see how far they can get.
    partial = true;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++){
      if (jumps[i] === -1) continue;
      const d = Math.hypot(S[i][X] - S[b][X], S[i][Z] - S[b][Z]);
      if (d < bd){ bd = d; best = i; }
    }
    target = best;
  }
  const path = [], gates = [];
  for (let i = target; i !== -1; i = prev[i]){ path.push(i); gates.push(gateLeg[i]); }
  path.reverse(); gates.reverse();
  return {path, gates, partial, total: dist[target]};
}

function recomputeRoute(){
  const note = document.getElementById("routeNote");
  routePath = null; routePartial = false;
  if (routeFrom == null || routeTo == null){ note.textContent = ""; draw(); return; }
  if (routeFrom === routeTo){ note.textContent = ui("sameSystem"); draw(); return; }
  const r = findRoute(routeFrom, routeTo);
  routePath = r.path; routePartial = r.partial; routeGates = r.gates;
  const jumpsN = r.path.length - 1;
  if (jumpsN === 0){
    // Nothing at all is within range of the origin, so there is no line to draw.
    routePath = null;
    note.innerHTML = "<b>" +
      fmt("nothingInRange", {ly: jumpLy, sys: S[routeFrom][NAME]}) + "</b>";
    draw();
    return;
  }
  const viaGates = r.gates.reduce((a, b) => a + b, 0);
  const gateNote = viaGates ? " &middot; " + fmt("viaGate", {n: viaGates}) : "";
  if (r.partial){
    const stop = S[r.path.at(-1)], dest = S[routeTo];
    const gap = Math.hypot(dest[X] - stop[X], dest[Z] - stop[Z]);
    const flown = Math.hypot(stop[X] - S[routeFrom][X], stop[Z] - S[routeFrom][Z]);
    note.innerHTML =
      `<b>${fmt("noRoute", {ly: jumpLy})}</b> ` +
      fmt("stopsAt", {sys: stop[NAME], jumps: plural("jumps", jumpsN), ly: num(Math.round(r.total))}) +
      `<br><b>` + fmt("short", {ly: num(Math.round(gap)), sys: dest[NAME]}) + `</b>` +
      (flown + gap > 0
        ? ` &middot; ` + fmt("percentOfWay", {pct: Math.round(100 * flown / (flown + gap))})
        : ".");
    draw();
    return;
  }
  note.innerHTML = `${jumpsN} jump${jumpsN === 1 ? "" : "s"} &middot; ` +
      `${Math.round(r.total).toLocaleString()} ly flown${gateNote}.`;
  draw();
}

function setEnd(which, sysIndex){
  if (which === "from"){ routeFrom = sysIndex; document.getElementById("from").value = S[sysIndex][NAME]; }
  else { routeTo = sysIndex; document.getElementById("to").value = S[sysIndex][NAME]; }
  recomputeRoute();
}

function drawRoute(){
  if (!routePath || routePath.length < 2) return;
  ctx.save();
  ctx.lineWidth = 2.2; ctx.lineJoin = "round";
  for (let k = 1; k < routePath.length; k++){
    const a = S[routePath[k - 1]], b = S[routePath[k]];
    const gate = routeGates && routeGates[k];
    ctx.strokeStyle = gate ? "#4fc3ff" : "#ffab3d";
    ctx.setLineDash(gate ? [3, 4] : routePartial ? [7, 5] : []);
    ctx.beginPath();
    ctx.moveTo(sx(a[X]), sy(a[Z])); ctx.lineTo(sx(b[X]), sy(b[Z]));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // waypoint rings
  ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,171,61,.9)";
  for (let k = 1; k < routePath.length - 1; k++){
    const s = S[routePath[k]];
    hex(sx(s[X]), sy(s[Z]), 6, "rgba(255,171,61,.9)");
  }

  const a = S[routePath[0]], b = S[routePath.at(-1)];
  marker(sx(a[X]), sy(a[Z]), "#ff9f2e", -1);      // origin, pointing down
  marker(sx(b[X]), sy(b[Z]), "#4fc3ff", 1);       // destination, pointing up
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

const jumpBox = document.getElementById("jump");
jumpBox.value = jumpLy;
jumpBox.addEventListener("input", () => {
  const v = +jumpBox.value;
  if (!(v > 0)) return;
  jumpLy = v;
  try { localStorage.setItem("gg.jump", String(v)); } catch (_) {}
  cells = null;                       // the grid is sized to the jump range
  recomputeRoute();
});

function clearRoute(){
  routeFrom = routeTo = routePath = routeGates = null;
  document.getElementById("from").value = "";
  document.getElementById("to").value = "";
  document.getElementById("routeNote").textContent = "";
  draw();
}
addEventListener("keydown", e => {
  if (e.key === "Escape"){ clearRoute(); focused = null; }
});
document.getElementById("clearRoute").onclick = () => {
  clearRoute();
};



// Language picker. Switching rewrites the labels and redraws; nothing reloads.
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
    document.querySelectorAll("#secRow .pill").forEach((b, i) => {
      b.textContent = ui(SECS[i][1]);
    });
    document.querySelectorAll("#purpRow .pill").forEach((b, i) => {
      b.textContent = ui(D.purposeSlots[i]);
    });
    document.querySelectorAll("#facRow .pill").forEach((b, i) => {
      b.textContent = t(D.factionKeys[i]);
    });
    applyUI();
    draw();
  });
  applyUI();
}

resize();   // first paint, once route state exists

// Spoiler toggle: landmarks, gates and engineers, plus the filters that name them.
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
        const sel = el.querySelector("select");
        if (sel && sel.value !== ""){ sel.value = ""; F.startype = -1; }
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
