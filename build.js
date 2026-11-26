#!/usr/bin/env node
/*
 * Construye docs/index.html con los datos incrustados (window.BAKED).
 *
 * La lógica de datos y de cálculo es la del artifact de claude.ai: las SQL (SQLS) y compute()
 * se leen de fleet-template.html y se ejecutan aquí, sin reescribirlas.
 *
 * Variables de entorno (secrets del repo):
 *   DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID
 *   SHEET_CSV_URL (opcional): si no existe, la lista de companies se lee de config/companies.json
 *
 * Códigos de salida: 0 = publicado/listo · 78 = el dato de ayer aún no está en Databricks · otro = error.
 * Uso:  node build.js            (consulta Databricks)
 *       node build.js --offline  (solo meses ya congelados en data/closed, sin red)
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = __dirname;
const OFFLINE = process.argv.includes("--offline");
const OWNER = "vtc plus";
const SENTINELS = [47653, 109555, 400536]; // IDs que siempre deben estar en el Sheet
const MIN_IDS = 20;
const NOT_READY = 78;

// ---------- lógica de la plantilla (misma que el artifact) ----------
function loadLogic() {
  const html = fs.readFileSync(path.join(ROOT, "fleet-template.html"), "utf8");
  const script = html.split("<script>").pop().split("</script>")[0];
  const el = () => new Proxy(function () {}, { get: (t, p) => (p === "style" || p === "classList" ? el() : p === "dataset" ? {} : el()), set: () => true, apply: () => el() });
  const sb = {
    console, Intl, Date, JSON, Math, Promise, setTimeout, TextDecoder, atob, Uint8Array,
    document: { getElementById: () => el(), querySelectorAll: () => [], documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    Chart: function () { return { destroy() {} }; },
    localStorage: { getItem() { return null; }, setItem() {} },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(script + "\n;globalThis.__x={compute,monthInfo,weeksOf,SQLS,START_YM,FREEZE_DAY,iso,addD,U,parseD,madridToday};", sb);
  return sb.__x;
}

// ---------- Sheet de companies ----------
function csvRows(text) {
  const rows = []; let row = [], c = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(c); c = ""; rows.push(row); row = []; }
    else c += ch;
  }
  if (c.length || row.length) { row.push(c); rows.push(row); }
  return rows;
}
async function getCompanies() {
  const url = process.env.SHEET_CSV_URL;
  if (!url) return fromConfig(); // sin secret SHEET_CSV_URL: lista en config/companies.json
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("No se pudo leer el Sheet: HTTP " + r.status);
  const rows = csvRows(await r.text());
  // columnas: D (3) = Fleet Owner, E (4) = Company ID, F (5) = nombre
  const ids = [], names = {};
  rows.forEach(c => {
    if (c.length < 5 || String(c[3]).trim().toLowerCase() !== OWNER) return;
    const id = String(c[4]).trim();
    if (!/^\d+$/.test(id)) return;
    const n = +id;
    if (!ids.includes(n)) { ids.push(n); names[n] = String(c[5] || "").replace(/^(OLD\s+\+?)?Madrid\s*Fleet\s*/i, "").trim(); }
  });
  return check(ids, names, "El Sheet");
}
function check(ids, names, origin) {
  ids.sort((a, b) => a - b);
  const missing = SENTINELS.filter(s => !ids.includes(s));
  if (ids.length < MIN_IDS || missing.length) throw new Error(`${origin} parece incorrecto: ${ids.length} companies de VTC Plus, faltan IDs de control: ${missing.join(",") || "ninguno"}`);
  return { ids, names };
}
function fromConfig() {
  const f = path.join(ROOT, "config", "companies.json");
  if (!fs.existsSync(f)) throw new Error("Falta el secret SHEET_CSV_URL y no existe config/companies.json");
  const list = JSON.parse(fs.readFileSync(f, "utf8")).companies || [];
  const ids = [], names = {};
  list.forEach(c => { const n = +c.id; if (n && !ids.includes(n)) { ids.push(n); names[n] = String(c.name || ""); } });
  console.log("Companies desde config/companies.json:", ids.length);
  return check(ids, names, "config/companies.json");
}

// ---------- Databricks (API de SQL statements) ----------
function dbx() {
  const host = (process.env.DATABRICKS_HOST || "").replace(/\/$/, "");
  const token = process.env.DATABRICKS_TOKEN, wh = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!host || !token || !wh) throw new Error("Faltan DATABRICKS_HOST, DATABRICKS_TOKEN o DATABRICKS_WAREHOUSE_ID");
  const base = host.startsWith("http") ? host : "https://" + host;
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return async function sql(statement) {
    let r = await fetch(base + "/api/2.0/sql/statements", { method: "POST", headers: H, body: JSON.stringify({ warehouse_id: wh, statement, wait_timeout: "30s", on_wait_timeout: "CONTINUE", format: "JSON_ARRAY", disposition: "INLINE" }) });
    let j = await r.json();
    if (!r.ok) throw new Error("Databricks: " + JSON.stringify(j).slice(0, 300));
    const t0 = Date.now();
    while (j.status && (j.status.state === "PENDING" || j.status.state === "RUNNING")) {
      if (Date.now() - t0 > 240000) throw new Error("Timeout de la consulta en Databricks");
      await sleep(3000);
      r = await fetch(base + "/api/2.0/sql/statements/" + j.statement_id, { headers: H });
      j = await r.json();
    }
    if (!j.status || j.status.state !== "SUCCEEDED") throw new Error("Consulta fallida: " + JSON.stringify(j.status && j.status.error || j.status).slice(0, 300));
    const cols = (j.manifest.schema.columns || []).map(c => c.name);
    let data = (j.result && j.result.data_array) || [];
    let next = j.result && j.result.next_chunk_internal_link;
    while (next) {
      const rr = await fetch(base + next, { headers: H });
      const jj = await rr.json();
      data = data.concat(jj.data_array || []);
      next = jj.next_chunk_internal_link;
    }
    return data.map(row => { const o = {}; cols.forEach((c, i) => { o[c] = row[i]; }); return o; });
  };
}

// ---------- principal ----------
(async () => {
  const L = loadLogic();
  const { iso, addD, U, parseD } = L;
  const today = L.madridToday();
  const todayD = parseD(today), yestIso = iso(addD(todayD, -1));
  const months = [];
  { let [y, m] = L.START_YM.split("-").map(Number); const cur = today.slice(0, 7);
    while (y + "-" + String(m).padStart(2, "0") <= cur) { months.push(y + "-" + String(m).padStart(2, "0")); m++; if (m > 12) { m = 1; y++; } } }

  // publicación anterior: para no cambiar la hora de actualización si los datos no han cambiado
  let prev = {};
  try {
    const old = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");
    const m = old.match(/window\.BAKED=(\{.*?\});window\.BAKED_DATE=/s);
    if (m) prev = JSON.parse(m[1]).months || {};
  } catch (e) { /* primera ejecución */ }

  const live = OFFLINE ? null : await getCompanies();
  const sql = OFFLINE ? null : dbx();
  const baked = {};

  for (const ym of months) {
    const mi = L.monthInfo(ym);
    const fz = path.join(ROOT, "data", "closed", ym + ".json");
    if (mi.closed && fs.existsSync(fz)) { // mes ya congelado: no se vuelve a consultar
      const f = JSON.parse(fs.readFileSync(fz, "utf8"));
      baked[ym] = { ids: f.ids, names: f.names || {}, c: f.c, frozenAt: f.frozenAt, asOf: f.frozenAt, dataEnd: iso(mi.me) };
      console.log(ym, "congelado (data/closed)");
      continue;
    }
    if (OFFLINE || mi.dataEnd < mi.ms) continue;

    const ids = live.ids.join(","), s = iso(mi.first), e = iso(mi.dataEnd), S = L.SQLS;
    console.log(ym, "consultando Databricks", s, "→", e);
    const [ops0, hrs, rad, brand, inc, nm] = await Promise.all([
      sql(S.ops(ids, s, e)), sql(S.hrs(ids, s, e)), sql(S.rad(ids, s, e)), sql(S.brand(ids, s, e)), sql(S.inc(ids, s, e)),
      sql(S.names(ids)).catch(() => []),
    ]);

    // el dato de ayer debe estar cargado (horas online > 0) antes de publicar
    if (iso(mi.dataEnd) === yestIso && yestIso >= iso(mi.ms)) {
      const ohY = hrs.filter(r => r.d === yestIso).reduce((t, r) => t + (+r.oh || 0), 0);
      if (!(ohY > 0)) { console.log("El dato de ayer (" + yestIso + ") aún no está disponible."); process.exit(NOT_READY); }
    }

    const names = { ...live.names };
    nm.forEach(r => { names[r.id] = String(r.name || "").replace(/^(OLD\s+\+?)?Madrid\s*Fleet\s*/i, "").trim() || names[r.id]; });
    const d = { mi, snap: { ids: live.ids, names, frozen: false }, ops: ops0.concat(hrs, inc), rad, brand, names, loaded: new Date() };
    const c = JSON.parse(JSON.stringify(L.compute(d)));

    let asOf = new Date().toISOString();
    const p = prev[ym];
    if (p && JSON.stringify(p.c) === JSON.stringify(c) && JSON.stringify(p.ids) === JSON.stringify(live.ids) && p.dataEnd === iso(mi.dataEnd)) asOf = p.asOf;
    baked[ym] = { ids: live.ids, names, c, asOf, dataEnd: iso(mi.dataEnd) };

    // congelado: el día FREEZE_DAY del mes siguiente, una sola vez
    const [y, m] = ym.split("-").map(Number);
    if (mi.closed && todayD >= U(y, m, L.FREEZE_DAY)) {
      const frozenAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(fz), { recursive: true });
      fs.writeFileSync(fz, JSON.stringify({ ym, ids: live.ids, names, c, frozenAt }));
      baked[ym].frozenAt = frozenAt; baked[ym].asOf = frozenAt;
      console.log(ym, "congelado ahora →", path.relative(ROOT, fz));
    }
  }

  const tpl = fs.readFileSync(path.join(ROOT, "fleet-template.html"), "utf8");
  if (!tpl.includes("<!--BAKED_HERE-->")) throw new Error("La plantilla no tiene <!--BAKED_HERE-->");
  const payload = JSON.stringify({ months: baked }).replace(/</g, "\\u003c");
  const out = tpl.replace("<!--BAKED_HERE-->", `<script>window.BAKED=${payload};window.BAKED_DATE="${yestIso}";</script>`);
  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "index.html"), out);
  console.log("docs/index.html escrito:", Object.keys(baked).join(", ") || "(sin meses)", "· datos al", yestIso);
})().catch(err => { console.error("ERROR:", err.message); process.exit(1); });
