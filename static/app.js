"use strict";
/* HRM Database Viewer front end. Talks to the local server in app.py. */

const APP = document.getElementById("app");
let STATUS = null;
let RENDER_SEQ = 0;
let TABLES_CACHE = null;

// ------------------------------------------------------------------ utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNum = (v) => typeof v === "number" && isFinite(v);
const GD = () => (STATUS && STATUS.meta && STATUS.meta.game_date) || Date.now() / 1000;

async function api(path) {
  const r = await fetch("/api/" + path);
  let j;
  try { j = await r.json(); } catch (e) { throw new Error("The viewer sent back something unexpected."); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fDate(ts) {
  if (!isNum(ts)) return ts == null || ts === "" ? "—" : esc(ts);
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fDateTime(ts) {
  if (!isNum(ts)) return fDate(ts);
  const d = new Date(ts * 1000);
  return `${fDate(ts)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
// number formatters are made once and reused (toLocaleString builds a new one on every call, which is slow on big tables)
const NUMFMT = [];
const numFmt = (dp) => NUMFMT[dp] || (NUMFMT[dp] = new Intl.NumberFormat("en-NZ", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
function fNum(v, dp = 0) {
  if (!isNum(v)) return v == null || v === "" ? "—" : esc(v);
  return numFmt(dp).format(v);
}
function fMoney(v) {
  if (!isNum(v)) return "—";
  return (v < 0 ? "-$" : "$") + numFmt(0).format(Math.round(Math.abs(v)));
}
function fMoneyShort(v) {
  if (!isNum(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-$" : "$";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return s + (a / 1e3).toFixed(0) + "K";
  return s + numFmt(0).format(Math.round(a));
}
function fTime(sec) {
  if (!isNum(sec) || sec <= 0) return "—";
  // Match the game's display: it keeps times at single precision and cuts (not rounds) to 3 decimals.
  sec = Math.floor(Math.fround(sec) * 1000) / 1000;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}
const fDist = (m) => (isNum(m) && m > 0 ? `${numFmt(0).format(Math.round(m))} m` : "—");
function age(birth, died) {
  if (!isNum(birth)) return null;
  const end = isNum(died) ? died : GD();
  return Math.floor((end - birth) / (365.2425 * 86400));
}
// age of a foal: "3yo", or "died aged 12"
function ageCell(birth, died) {
  const a = age(birth, died);
  if (a === null) return "—";
  return isNum(died) ? `<span class="muted" title="Died ${fDate(died)}">died at ${a}</span>` : `${a}yo`;
}
function ord(n) {
  if (!isNum(n)) return "—";
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function pos(rank, runners) {
  if (!isNum(rank)) return "—";
  const cls = rank <= 3 ? ` p${rank}` : "";
  return `<span class="posw" title="Finished ${ord(rank)}${isNum(runners) && runners > 0 ? ` of ${runners} runners` : ""}"><span class="pos${cls || " px"}">${rank}</span>${isNum(runners) && runners > 0 ? `<span class="of">of ${runners}</span>` : ""}</span>`;
}
function grade(t) {
  if (!t) return "";
  if (["G1", "G2", "G3"].includes(t)) return `<span class="badge ${t}" title="Group ${t[1]} race">${t}</span>`;
  if (t === "listed") return `<span class="badge listed" title="Listed race (black-type, below Group 3)">Listed</span>`;
  return `<span class="badge">${esc(String(t).replace("_2yo", " 2yo").replace("_", " "))}</span>`;
}
const realId = (id) => id !== null && id !== undefined && id !== 0 && id !== -1 && id !== "";
const link = (type) => (id, name, fallback = "—") =>
  realId(id) ? `<a href="#/${type}/${id}">${esc(name || `#${id}`)}</a>` : name ? esc(name) : fallback;
const L = { horse: link("horse"), person: link("person"), stable: link("stable"), course: link("course"), race: link("race") };
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------------ menu bar, sidebar, icons
const ICON_PATHS = {
  home: '<path d="M2.5 7.5 8 3l5.5 4.5V13a1 1 0 0 1-1 1h-3v-4h-3v4h-3a1 1 0 0 1-1-1z"/>',
  horse: '<path d="M4.6 13.2 4 9.5a4 4 0 0 1 8 0l-.6 3.7" stroke-width="1.9"/>',
  flag: '<path d="M3.5 14V2.5"/><path d="M3.5 3h8l-1.6 2.5L11.5 8h-8"/>',
  barn: '<path d="M2.5 7 8 3l5.5 4v7h-11z"/><path d="M6 14v-4h4v4"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14a5 5 0 0 1 10 0"/>',
  pin: '<path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z"/><circle cx="8" cy="6.5" r="1.6"/>',
  tree: '<circle cx="4" cy="8" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="12" cy="12" r="1.6"/><path d="M5.5 8H8V4h2.4M8 8v4h2.4"/>',
  table: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M2.5 10h11M6.5 6.5V13"/>',
  grid: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M6.5 3v10M10 3v10"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2V11M8 5v.2"/>',
  cog: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  trophy: '<path d="M5 2.5h6v3a3 3 0 0 1-6 0zM5 3.5H3a2 2 0 0 0 2 2.5M11 3.5h2a2 2 0 0 1-2 2.5M8 8.5V11M5.5 13.5h5"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  list: '<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.5M2.5 8h.5M2.5 11.5h.5"/>',
  upload: '<path d="M8 10.5V3M5 6l3-3 3 3M3 10.5v2.5h10v-2.5"/>',
  star: '<path d="m8 2.5 1.7 3.6 3.8.4-2.9 2.6.8 3.8L8 11l-3.4 1.9.8-3.8-2.9-2.6 3.8-.4z"/>',
};
const icon = (k) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ""}</svg>`;
// Navigation: the top menu holds the main sections (what you're looking at); the side menu shows "You" shortcuts
// and the pages inside the current section, grouped by what you want to do (results, coming up, breeding…).
const SECTIONS = [
  { k: "home", label: "Home", ic: "home", href: "#/", routes: [""] },
  { k: "racing", label: "Racing", ic: "flag", href: "#/meetings", routes: ["meetings", "meeting", "races", "race", "courses", "course"] },
  { k: "horses", label: "Horses", ic: "horse", href: "#/horses", routes: ["horses", "horse", "horse-table", "pedigrees", "pedigree"] },
  { k: "stables", label: "Stables", ic: "barn", href: "#/stables", routes: ["stables", "stable", "stable-table"] },
  { k: "people", label: "People", ic: "user", href: "#/people", routes: ["people", "person"] },
  { k: "awards", label: "Awards", ic: "trophy", href: "#/awards", routes: ["awards"] },
  { k: "settings", label: "Settings", ic: "cog", href: "#/settings", routes: ["settings", "databases", "tables", "versions"], right: true },
];
const SIDE = {
  home: null,   // filled in below: every other area's pages
  racing: [["Results", [["#/meetings", "list", "Meetings"], ["#/races", "flag", "All races"], ["#/races?type=G1", "trophy", "Group 1 results"]]],
    ["Coming up", [["#/meetings?when=upcoming", "clock", "Upcoming meetings"], ["#/races?when=upcoming", "flag", "Upcoming races"], ["#/races?when=upcoming&type=G1", "star", "Upcoming Group 1s"]]],
    ["Places", [["#/courses", "pin", "Racecourses"]]]],
  horses: [["Horses", [["#/horses", "horse", "All horses"], ["#/horse-table", "table", "Horse table"]]],
    ["Breeding", [["#/pedigrees", "tree", "Top sires"], ["#/pedigrees?kind=dams", "tree", "Top dams"], ["#/pedigrees?kind=damsires", "tree", "Broodmare sires"]]]],
  stables: [["Stables", [["#/stables", "barn", "All stables"], ["#/stable-table", "grid", "Stable table"]]]],
  people: [["People", [["#/people", "user", "All people"], ["#/people?role=Jockey&sort=jockey_wins", "trophy", "Top jockeys"], ["#/people?role=Jockey", "user", "Jockeys"],
    ["#/people?role=Trainer", "user", "Trainers"], ["#/people?role=Head%20trainer", "user", "Head trainers"], ["#/people?role=Manager", "user", "Managers"]]]],
  awards: [["Awards", [["#/awards", "trophy", "Awards by year"], ["#/awards?view=winners", "star", "Most awards"], ["#/awards?group=hof", "star", "Hall of Fame"]]],
    ["By award", [["#/awards?group=year", "trophy", "Horse of the Year"], ["#/awards?group=age", "horse", "Age divisions"], ["#/awards?group=distance", "flag", "Distance champions"],
      ["#/awards?group=breeding", "tree", "Breeding"], ["#/awards?group=people", "user", "People"], ["#/awards?group=stables", "barn", "Stables"], ["#/awards?group=special", "star", "Special awards"]]]],
  settings: [["Settings", [["#/settings", "cog", "General"], ["#/databases", "db", "Databases"], ["#/tables", "table", "All tables"], ["#/versions", "info", "Versions & changes"]]]],
};
// on Home the side menu lists every area, each under its own heading
SIDE.home = [["Home", [["#/", "home", "Overview"]]]].concat(
  ["racing", "horses", "stables", "people", "awards", "settings"].map((k) => [SECTIONS.find((x) => x.k === k).label, SIDE[k].flatMap((g) => g[1])]));
function sectionOf(key) { return (SECTIONS.find((x) => x.routes.includes(key)) || SECTIONS[0]).k; }
function renderNav() {
  const item = (x) => `<a href="${x.href}" data-k="${x.k}">${icon(x.ic)}<span>${x.label}</span></a>`;
  const chev = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  $("#nav").innerHTML = `<button class="sb-toggle" id="sb-toggle" title="Hide or show the side menu" aria-label="Hide or show the side menu">☰</button>` +
    `<button class="sb-toggle nav-hist" id="nav-back" data-tip="Back (Alt + ←)" aria-label="Back">${chev("M10 3 5 8l5 5")}</button>` +
    `<button class="sb-toggle nav-hist" id="nav-fwd" data-tip="Forward (Alt + →)" aria-label="Forward">${chev("M6 3l5 5-5 5")}</button>` +
    SECTIONS.filter((x) => !x.right).map(item).join("") + `<span class="grow"></span>` + SECTIONS.filter((x) => x.right).map(item).join("");
}
renderNav();
// back / forward: each page visit is numbered in the browser history, so the buttons know when there's somewhere to go
const HIST = { i: 0, max: 0 };
function histSync() {
  const st = history.state;
  let max = 0;
  try { max = +sessionStorage.getItem("hrm.histMax") || 0; } catch (e) { /* this page only */ }
  if (st && Number.isInteger(st.hi)) { HIST.i = st.hi; HIST.max = Math.max(max, st.hi); }
  else {   // a page visited for the first time: it goes after the current one, and anything "forward" of it is gone
    HIST.i = HIST.i + (HIST.seen ? 1 : 0); HIST.max = HIST.i;
    history.replaceState({ ...(st || {}), hi: HIST.i }, "");
  }
  HIST.seen = true;
  try { sessionStorage.setItem("hrm.histMax", String(HIST.max)); } catch (e) { /* this page only */ }
  const b = $("#nav-back"), f = $("#nav-fwd");
  if (b) b.disabled = HIST.i <= 0;
  if (f) f.disabled = HIST.i >= HIST.max;
}
histSync();
window.addEventListener("hashchange", histSync);
window.addEventListener("popstate", histSync);
document.addEventListener("click", (e) => {
  if (e.target.closest("#nav-back")) history.back();
  else if (e.target.closest("#nav-fwd")) history.forward();
});
// (Alt + ← / → and the mouse's back / forward buttons are handled by the window itself, as in a web browser)
// side menu: full, or a narrow strip of icons
function sideMenuMode() { try { return localStorage.getItem("hrm.sideMenu") || "full"; } catch (e) { return "full"; } }
function setSideMenu(mode) {
  try { localStorage.setItem("hrm.sideMenu", mode); } catch (e) { /* this session only */ }
  document.body.classList.toggle("sb-mini", mode === "mini");
  document.body.classList.toggle("sb-hidden", mode === "hidden");
  const t = $("#sb-toggle"); if (t) t.title = mode === "full" ? "Shrink the side menu" : mode === "mini" ? "Hide the side menu" : "Show the side menu";
}
// on narrow windows the side menu slides in over the page instead of taking room from it
const NARROW = 1150;
const isNarrow = () => window.innerWidth <= NARROW;
function sideDrawer(open) { document.body.classList.toggle("sb-open", open); }
document.addEventListener("click", (e) => {
  if (e.target.closest("#sb-toggle")) {
    if (isNarrow()) sideDrawer(!document.body.classList.contains("sb-open"));
    else setSideMenu({ full: "mini", mini: "hidden", hidden: "full" }[sideMenuMode()] || "full");
    return;
  }
  if (e.target.closest("#sb-collapse")) { if (isNarrow()) sideDrawer(false); else setSideMenu(sideMenuMode() === "full" ? "mini" : "full"); return; }
  if (e.target.closest("#sb-backdrop")) { sideDrawer(false); return; }
  if (isNarrow() && e.target.closest("#sidebar a[href], #sidebar a[onclick]")) sideDrawer(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") sideDrawer(false); });
window.addEventListener("resize", () => { if (!isNarrow()) sideDrawer(false); });
window.addEventListener("hashchange", () => sideDrawer(false));
document.body.insertAdjacentHTML("beforeend", '<div id="sb-backdrop" class="sb-backdrop"></div>');
setSideMenu(sideMenuMode());
// ------------------------------------------------------------------ your stables (owned or shared in)
function myStableId() {
  const ms = (STATUS && STATUS.my_stables) || [], m = (STATUS && STATUS.meta) || {};
  let v = null;
  try { v = localStorage.getItem("hrm.myStable:" + ((STATUS.db || {}).id || "")); } catch (e) { /* none */ }
  if (v && ms.some((x) => String(x.id) === v)) return v;
  return m.player_stable_id ? String(m.player_stable_id) : ms[0] ? String(ms[0].id) : null;
}
function setMyStable(id) {
  try { localStorage.setItem("hrm.myStable:" + ((STATUS.db || {}).id || ""), String(id)); } catch (e) { /* not remembered */ }
}
// switcher shown on the stable pages of your own stables: ◀ dropdown ▶ plus a summary of all of them
function myStableBar(id, sub = "") {
  const ms = (STATUS && STATUS.my_stables) || [];
  const i = ms.findIndex((x) => String(x.id) === String(id));
  if (i < 0 || ms.length < 2) return "";
  setMyStable(id);
  const prev = ms[(i - 1 + ms.length) % ms.length], next = ms[(i + 1) % ms.length];
  const href = (x) => `#/stable/${x.id}${sub}`;
  const label = (x) => `${x.name} — ${x.role}${x.role === "Shareholder" && x.share_pct != null ? " " + fNum(x.share_pct, 1) + "%" : ""}${x.closed ? " (closed)" : ""}`;
  return `<div class="mystables"><span class="lbl">Your stables <b>${i + 1} of ${ms.length}</b></span>
    <a class="btn" href="${href(prev)}" title="${esc(prev.name)}">◀</a>
    <select data-mystable="${sub}">${ms.map((x) => `<option value="${x.id}" ${x === ms[i] ? "selected" : ""}>${esc(label(x))}</option>`).join("")}</select>
    <a class="btn" href="${href(next)}" title="${esc(next.name)}">▶</a>
    <span class="grow"></span><a class="small" href="#" data-mystable-all>See all ${ms.length}</a></div>
    <div class="mystables-all" hidden>${table([
      { h: "Stable", f: (x) => `${L.stable(x.id, x.name)}${x.closed ? ' <span class="badge dead">Closed</span>' : ""}` },
      { h: "You are", f: (x) => esc(x.role) + (x.via && x.via.length ? ` <span class="muted small">via ${x.via.map((v) => esc(v.name)).join(", ")}</span>` : "") },
      { h: "Your shares", cls: "num", f: (x) => (x.shares ? `${fNum(x.shares)}${x.share_pct != null ? ` (${fNum(x.share_pct, 1)}%)` : ""}` : "—") },
      { h: "Horses", cls: "num", f: (x) => fNum(x.horses) },
      { h: "Starts", cls: "num", f: (x) => fNum(x.starts) }, { h: "Wins", cls: "num", f: (x) => fNum(x.wins) },
      { h: "Prize money", cls: "num", f: (x) => fMoneyShort(x.prize) }, { h: "Net worth", cls: "num", f: (x) => fMoneyShort(x.net_worth) },
    ], ms)}</div>`;
}
document.addEventListener("change", (e) => {
  const s = e.target.closest("select[data-mystable]");
  if (s) { setMyStable(s.value); location.hash = `#/stable/${s.value}${s.dataset.mystable}`; }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-mystable-all]");
  if (!a) return;
  e.preventDefault();
  const box = a.closest(".mystables").nextElementSibling;
  box.hidden = !box.hidden;
  a.textContent = box.hidden ? `See all ${((STATUS && STATUS.my_stables) || []).length}` : "Hide list";
});

let SIDE_SECTION = null;
function renderSidebar() {
  const m = (STATUS && STATUS.meta) || {};
  const sec = sectionOf(parseHash().parts[0] || "");
  SIDE_SECTION = sec;
  const link = (href, ic, label) => `<a href="${href}" data-href="${href}" data-tip="${esc(label)}">${icon(ic)}<span>${label}</span></a>`;
  let h = `<button class="sb-collapse" id="sb-collapse" title="Shrink or expand the side menu">«</button>`;
  // You: always here, whatever section you're in
  const ms = (STATUS && STATUS.my_stables) || [];
  const cur = myStableId();
  let you = "";
  if (m.player_id) you += link(`#/person/${m.player_id}`, "user", "Your profile");
  if (cur) {
    you += link(`#/stable/${cur}`, "barn", ms.length > 1 ? "Your stables" : "Your stable");
    if (ms.length > 1) you += `<div class="sb-pick"><select id="sb-stable" title="${esc((ms.find((x) => String(x.id) === String(cur)) || {}).name || "")} — choose which of your stables to open">${ms.map((x) =>
      `<option value="${x.id}" ${String(x.id) === String(cur) ? "selected" : ""}>${esc(x.name)}${x.role === "Shareholder" ? ` · ${x.share_pct != null ? fNum(x.share_pct, 1) + "%" : "shares"}` : ""}${x.closed ? " (closed)" : ""}</option>`).join("")}</select></div>`;
    you += link(`#/horse-table?stable=${cur}`, "horse", "Your horses") + link(`#/stable/${cur}/races`, "flag", "Your stable's races");
  }
  if (you) h += '<div class="sb-sec">You</div>' + you;
  const label = (SECTIONS.find((x) => x.k === sec) || {}).label || "";
  for (const [title, links] of SIDE[sec] || []) {
    h += `<div class="sb-sec">${esc(title === label || title === "Settings" ? title : title)}</div>` + links.map(([href, ic, lab]) => link(href, ic, lab)).join("");
  }
  if (sec === "settings") h += `<a onclick="openLoad()" data-tip="Load new database">${icon("upload")}<span>Load new database</span></a>`;
  $("#sidebar").innerHTML = h;
  const sel = $("#sb-stable");
  if (sel) sel.addEventListener("change", () => { setMyStable(sel.value); location.hash = `#/stable/${sel.value}`; });
  markSidebar();
}
function markSidebar() {
  const cur = location.hash || "#/";
  const links = $$("#sidebar a[data-href]");
  links.forEach((a) => a.classList.remove("on"));
  let best = links.find((a) => a.dataset.href === cur), bestScore = 0;
  if (!best) {
    const [p, qs] = cur.split("?"), q = new URLSearchParams(qs || "");
    for (const a of links) {
      const [ap, aqs] = a.dataset.href.split("?");
      if (ap !== p) continue;
      const aq = [...new URLSearchParams(aqs || "")];
      if (!aq.every(([k, v]) => q.get(k) === v)) continue;
      const score = aq.length + 1;
      if (score > bestScore) { best = a; bestScore = score; }
    }
  }
  if (best) best.classList.add("on");
}

// ------------------------------------------------------------------ routing
function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [p, qs] = h.split("?");
  return { parts: p.split("/").filter(Boolean).map(decodeURIComponent), q: Object.fromEntries(new URLSearchParams(qs || "")) };
}
function hashFor(parts, q = {}) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v != null)).toString();
  return "#/" + parts.map(encodeURIComponent).join("/") + (qs ? "?" + qs : "");
}
function go(parts, q) { location.hash = hashFor(parts, q); }

const PAGES = {
  "": homePage, horses: horsesPage, horse: (r) => horsePage(r.parts[1]), races: racesPage, race: Object.assign((r) => racePage(r.parts[1]), { after: () => {
    $$("[data-openall]", APP).forEach((b) => b.addEventListener("click", () => {
      const open = b.textContent.startsWith("Open");
      $$(".rtoggle", APP).forEach((t) => { if (t.classList.contains("open") !== open) t.click(); });
      b.textContent = open ? "Close all form" : "Open all form";
    }));
  } }),
  stables: stablesPage, stable: (r) => (r.parts[2] === "races" ? stableRacesPage(r) : r.parts[2] === "financials" ? stableFinancePage(r) : r.parts[2] === "horse-money" ? stableHorseMoneyPage(r) : stablePage(r.parts[1])), people: peoplePage, person: (r) => personPage(r.parts[1]),
  courses: coursesPage, course: Object.assign((r) => coursePage(r.parts[1]), { after: (r) => coursePage.after && coursePage.after(r) }), tables: tablesPage,
  pedigrees: pedigreesPage, pedigree: Object.assign((r) => pedigreePage(r.parts[1], r.q), { after: (r) => pedigreePage.after && pedigreePage.after(r) }), "horse-table": horseTablePage, "stable-table": stableTablePage,
  versions: versionsPage, meetings: meetingsPage, awards: (r) => awardsPage(r.q || {}), settings: Object.assign(() => settingsPage(), { after: () => settingsPage.after() }), databases: Object.assign(() => databasesPage(), { after: () => databasesPage.after() }),
  meeting: Object.assign((r) => meetingPage(r.parts[1]), { after: (r) => meetingPage.after && meetingPage.after(r) }),
};

async function render() {
  const seq = ++RENDER_SEQ;
  const route = parseHash();
  const key = route.parts[0] || "";
  const sec = sectionOf(key);
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.k === sec));
  if (sec !== SIDE_SECTION) renderSidebar(); else markSidebar();
  closeSearch();
  if ((!STATUS || !STATUS.loaded) && !["databases", "versions", "settings"].includes(key)) return welcome();
  const fn = PAGES[key];
  if (!fn) { APP.innerHTML = `<div class="err-box">Page not found. <a href="#/">Go home</a></div>`; return; }
  if (!APP.dataset.keep) APP.innerHTML = `<div class="loading">Loading…</div>`;
  delete APP.dataset.keep;
  try {
    await loadHorsePics();
    const html = await fn(route);
    if (seq !== RENDER_SEQ) return;
    if (typeof html === "string") {
      const tabKey = { courses: "racing", horses: "horses", "horse-table": "horses", pedigrees: "horses", stables: "stables", "stable-table": "stables" }[key];
      APP.innerHTML = (tabKey && !route.parts[1] ? sectionTabs(tabKey, key) : "") + html;
    }
    if (fn.after) fn.after(route);
    afterRender(route);
  } catch (e) {
    if (seq !== RENDER_SEQ) return;
    APP.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ shared rendering
function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return `<div class="empty">${opts.empty || "Nothing to show."}</div>`;
  const head = cols.map((c) => {
    const cls = [c.cls || "", c.sort ? "sortable" : "", c.sort && opts.sort === c.sort ? "sorted" : ""].join(" ");
    const arrow = c.sort && opts.sort === c.sort ? (opts.dir === "asc" ? " ▲" : " ▼") : "";
    const asc = c.sort && opts.ascCols && opts.ascCols.includes(c.sort) ? ' data-asc="1"' : "";
    return `<th class="${cls}" ${c.sort ? `data-sort="${c.sort}"` : ""}${asc}>${c.h}${arrow}</th>`;
  }).join("");
  const body = rows.map((r) => `<tr class="${opts.rowClass ? opts.rowClass(r) : ""}">${cols.map((c) => `<td class="${c.cls || ""}">${c.f(r)}</td>`).join("")}</tr>`).join("");
  return opts.wide ? `<div class="wide-wrap"><table class="data wide"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="tbl-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000, 2500, 5000];
function prefPageSize() { try { const v = parseInt(localStorage.getItem("hrm.pageSize"), 10); return PAGE_SIZES.includes(v) ? v : null; } catch (e) { return null; } }
// adds the preferred rows per page to a list request when the page hasn't chosen one
function withSize(q) { const p = prefPageSize(); return q.size || !p ? q : { ...q, size: String(p) }; }
function pager(d) {
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  const from = d.total ? (d.page - 1) * d.page_size + 1 : 0, to = Math.min(d.total, d.page * d.page_size);
  const sizeSel = `<label class="small muted" title="How many rows to show on each page (up to 5,000)">Rows per page <select data-q="size" data-size-pref>${PAGE_SIZES.map((n) =>
    `<option value="${n}" ${n === d.page_size ? "selected" : ""}>${fNum(n)}</option>`).join("")}${PAGE_SIZES.includes(d.page_size) ? "" : `<option selected value="${d.page_size}">${fNum(d.page_size)}</option>`}</select></label>`;
  return `<div class="pager"><span>${fNum(from)}–${fNum(to)} of ${fNum(d.total)}</span>${sizeSel}<span class="grow"></span>
    <button class="btn" data-page="1" ${d.page <= 1 ? "disabled" : ""}>First</button>
    <button class="btn" data-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${fNum(d.page)} of ${fNum(pages)}</span>
    <button class="btn" data-page="${d.page + 1}" ${d.page >= pages ? "disabled" : ""}>Next</button>
    <button class="btn" data-page="${pages}" ${d.page >= pages ? "disabled" : ""}>Last</button></div>`;
}
function panel(title, body, note = "", cls = "") {
  return `<section class="panel ${cls}"><div class="panel-head"><h2>${title}</h2>${note ? `<span class="note">${note}</span>` : ""}</div>${body}</section>`;
}
function tiles(list) {
  return `<div class="tiles">${list.filter(Boolean).map(([label, value, hint]) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`).join("")}</div>`;
}
function kv(pairs) {
  return `<div class="kv">${pairs.filter((p) => p && p[1] !== undefined).map(([k, v]) => `<div class="k">${k}</div><div class="v">${v === null || v === "" ? "—" : v}</div>`).join("")}</div>`;
}
function bars(items, max = 100) {
  return `<div class="bars">${items.map((it) => {
    const w = (v) => (isNum(v) ? Math.max(0, Math.min(100, (100 * v) / max)) : 0);
    return `<div class="bar-row" title="${esc(String(it.label).replace(/<[^>]+>/g, ""))}: ${fNum(it.cur, 1)}${isNum(it.peak) ? ` · best ${fNum(it.peak, 1)}` : ""}"><div class="lbl">${it.label}</div><div class="bar">
      ${isNum(it.max) ? `<div class="max" style="width:${w(it.max)}%"></div>` : ""}
      ${isNum(it.peak) ? `<div class="peak" style="width:${w(it.peak)}%"></div>` : ""}
      <div class="cur" style="width:${w(it.cur)}%"></div></div>
      <div class="val"><b>${fNum(it.cur, 1)}</b>${isNum(it.max) ? ` <span title="${it.maxLabel || "Potential"}">/ ${fNum(it.max, 1)}</span>` : ""}</div></div>`;
  }).join("")}</div>`;
}
function chips(traits) {
  if (!traits || !traits.length) return `<div class="empty">No traits.</div>`;
  return `<div class="chips">${traits.map((t) => `<span class="chip ${t.positive > 0 ? "pos-1" : t.positive < 0 ? "neg" : ""}" title="${esc(t.description)}">${esc(t.name)}</span>`).join("")}</div>`;
}
function events(list, shown = 0) {
  if (!list || !list.length) return `<div class="empty">No news.</div>`;
  const inner = `<div class="events">${list.map((e, i) => `<div class="ev ${shown && i >= shown ? "more-row" : ""}"><div class="d">${fDate(e.date)}</div><div>${esc(e.text || e.type)}</div></div>`).join("")}</div>`;
  return shown ? expandable(inner, list.length, shown) : inner;
}

// guess which page an id column points to
function colLink(col) {
  if (/(^|_)horse_id$|^horse_horse_id$|_mare_id$|_stallion_id$/.test(col)) return "horse";
  if (/person_id$|jockey_id$|(^|_)(manager|head_trainer|trainer|caretaker)_id$|^stable_owner_id$|_spouse_id$|_partner_id$/.test(col)) return "person";
  if (/stable_id$/.test(col)) return "stable";
  if (/racecourse_id$/.test(col)) return "course";
  if (/(^|_)race_id$/.test(col)) return "race";
  return null;
}
const isDateCol = (col) => /date|timestamp|_until$|_since$|_at$|race_time$/.test(col);
function fieldValue(col, v, datesOn = true) {
  if (v === null || v === undefined) return `<span class="muted">null</span>`;
  const t = colLink(col);
  if (t && realId(v) && isNum(v)) return `<a href="#/${t}/${v}">${v}</a>`;
  if (datesOn && isDateCol(col) && isNum(v) && Math.abs(v) >= 1e7) return `<span title="${v}">${fDateTime(v)}</span>`;
  if (isNum(v) && !Number.isInteger(v)) return fNum(v, 3);
  return esc(v);
}
function allFields(obj) {
  return `<details class="panel"><summary>All ${Object.keys(obj).length} fields</summary><div class="allfields">${Object.entries(obj)
    .map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${fieldValue(k, v)}</span></div>`).join("")}</div></details>`;
}

// SVG line chart: series = [{name, color, points:[[t, v, tip?], ...], dots, dash}]
const PALETTE = ["#1f5240", "#b5872c", "#3e6e9e", "#a8714a", "#7a4f9a", "#c0504d"];
const yearOf = (ts) => new Date(ts * 1000).getUTCFullYear();
const yearStart = (y) => Date.UTC(y, 0, 1) / 1000;
// Logarithmic y-axis (opt-in with { scale: "symlog" }). A plain log scale can't show zero or negative values, and stable
// money goes to $0 in quiet months and below zero with loans, so this is a symmetric log: f(v) = sign(v)·log10(1 + |v|/c).
// It's linear within ±c of zero (c = opts.logC, $1,000 for money) and logarithmic beyond, so 0 sits on the axis, negatives
// mirror the positives, and one huge month doesn't flatten the rest. Only the drawing uses f: data and tooltips stay as-is.
const symlog = (v, c = 1) => Math.sign(v) * Math.log10(1 + Math.abs(v) / c);
// gridlines for a symlog axis: 0 (when the data spans it) and ±powers of ten from c upwards, at most 7 lines;
// when thinning, the largest power on each side is always kept
function symlogTicks(lo, hi, c = 1) {
  if (!isNum(lo) || !isNum(hi)) return [];
  const first = Math.max(0, Math.ceil(Math.log10(c)));
  const powers = (lim) => { const a = []; for (let k = first; 10 ** k <= lim * 1.0001; k++) a.push(10 ** k); return a; };
  const pos = hi > 0 ? powers(hi) : [], neg = lo < 0 ? powers(-lo) : [];
  const zero = lo <= 0 && hi >= 0 ? 1 : 0;
  let step = 1;
  while (Math.ceil(pos.length / step) + Math.ceil(neg.length / step) + zero > 7) step++;
  const thin = (a) => a.filter((_, i) => (a.length - 1 - i) % step === 0);
  const out = [...thin(neg).map((v) => -v).reverse(), ...(zero ? [0] : []), ...thin(pos)];
  // values too small for a power of ten (all within ±c): label the actual low and high ends instead
  return out.length >= 2 ? out : [...new Set([lo, ...(zero ? [0] : []), hi])].sort((a, b) => a - b);
}
// round-number gridlines (steps of 1, 2, 2.5 or 5 × a power of ten) covering lo..hi
function niceTicks(lo, hi, want = 5) {
  if (!isNum(lo) || !isNum(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / Math.max(1, want - 1), mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}
// Charts: hover for exact values, click legend entries to hide/show a line, pick a time range.
const CHARTS = {};
let CHART_SEQ = 0;
function lineChart(series, opts = {}) {
  const id = "ch" + ++CHART_SEQ;
  CHARTS[id] = { series, opts: Object.assign({ yFmt: (v) => fNum(v), height: 220, invert: false, yInt: false, yMin: null, yMax: null, width: 680 }, opts), hidden: new Set(), range: chartDefaultRange() };
  const ok = series.some((s) => s.points.filter((p) => isNum(p[1])).length) && series.flatMap((s) => s.points.filter((p) => isNum(p[1]))).length >= 2;
  if (!ok) { delete CHARTS[id]; return `<div class="empty">Not enough history to chart.</div>`; }
  return `<div class="chartbox" id="${id}">${chartInner(id)}</div>`;
}
function chartDefaultRange() { try { return localStorage.getItem("hrm.chartRange") || "all"; } catch (e) { return "all"; } }
const RANGES = [["all", "All", 0], ["10y", "10 years", 3652], ["5y", "5 years", 1826], ["3y", "3 years", 1096], ["2y", "2 years", 730], ["1y", "1 year", 365],
  ["9m", "9 months", 274], ["6m", "6 months", 183], ["3m", "3 months", 91], ["1m", "1 month", 30]];
function chartInner(id) {
  const C = CHARTS[id], o = C.opts;
  const allPts = C.series.flatMap((s) => s.points.filter((p) => isNum(p[1])));
  const tMax = Math.max(...allPts.map((p) => p[0])), tMin = Math.min(...allPts.map((p) => p[0]));
  let rg = RANGES.find((r) => r[0] === C.range) || RANGES[0];
  if (rg[2] && rg[2] * 86400 >= tMax - tMin) rg = RANGES[0];
  const from = rg[2] ? tMax - rg[2] * 86400 : -Infinity;
  const series = C.series.map((s, i) => ({ ...s, i, color: s.color || PALETTE[i % PALETTE.length], pts: s.points.filter((p) => isNum(p[1]) && p[0] >= from).sort((a, b) => a[0] - b[0]) }))
    .filter((s) => !C.hidden.has(s.i) && s.pts.length);
  const all = series.flatMap((s) => s.pts);
  const W = o.width, H = o.height, l = 64, r = 12, t = 10, b = 30;
  const ranges = o.ranges !== false && (tMax - tMin) / 86400 > 31 ? `<div class="ch-ranges">${RANGES.filter((x) => !x[2] || x[2] * 86400 < tMax - tMin).map((x) =>
    `<button class="${x[0] === rg[0] ? "on" : ""}" data-chrange="${x[0]}" title="Show ${x[2] ? "the last " + x[1] : "everything"}">${x[2] ? x[0].toUpperCase() : "All"}</button>`).join("")}</div>` : "";
  // the chart's tool row: linear/log switch (not for positions), time range, enlarge, picture and data downloads
  const canLog = !o.invert && !o.yInt;
  const scaleSw = canLog ? `<div class="ch-sw" role="group" aria-label="Scale"><button class="${o.scale === "symlog" ? "" : "on"}" data-chscale="linear" data-tip="Linear scale: equal steps for equal amounts">Linear</button><button class="${o.scale === "symlog" ? "on" : ""}" data-chscale="symlog" data-tip="Logarithmic scale: each gridline is 10 times the one below, so a few very big values don't squash the rest. Zero and negative values still show; hover for exact amounts.">Log</button></div>` : "";
  const tools = `<div class="ch-tools">${o.big ? "" : `<button data-chexp data-tip="Open this chart large">⤢</button>`}<button data-chpng data-tip="Download this chart as a picture (PNG)">PNG</button><button data-chcsv data-tip="Download the numbers behind this chart (CSV)">CSV</button></div>`;
  const rangeBtns = `<div class="ch-bar">${scaleSw}<span class="grow"></span>${ranges}${tools}</div>`;
  // legend: click to hide/show a line, double-click to show only that line; each entry shows the latest value in view
  const fmtOf = (s) => s.fmt || o.tipFmt || o.yFmt;
  const latestOf = (i) => { const sv = series.find((x) => x.i === i); return sv && sv.pts.length ? sv.pts[sv.pts.length - 1] : null; };
  const legend = C.series.length > 1 ? `<div class="legend ch-legend">${C.series.map((s, i) => { const lp = latestOf(i);
    return `<span class="lg ${C.hidden.has(i) ? "off" : ""}" data-lg="${i}" title="Click to ${C.hidden.has(i) ? "show" : "hide"} this line · double-click to show only this line">
      <i style="background:${s.color || PALETTE[i % PALETTE.length]}"></i>${esc(s.name)}${lp && !C.hidden.has(i) ? ` <b class="lg-v">${fmtOf(s)(lp[1])}</b>` : ""}</span>`; }).join("")}</div>`
    : (() => { const sv = series[0]; if (!sv || sv.pts.length < 2) return "";
      const vals = sv.pts.map((p) => p[1]), hi = sv.pts.reduce((a, p) => (p[1] > a[1] ? p : a)), lo = sv.pts.reduce((a, p) => (p[1] < a[1] ? p : a)), f = fmtOf(sv);
      const first = vals[0], last = vals[vals.length - 1], ch = first ? ((last - first) / Math.abs(first)) * 100 : null;
      return `<div class="ch-stats"><span>Latest <b>${f(last)}</b></span><span>High <b>${f(hi[1])}</b> <span class="muted">${fDate(hi[0])}</span></span><span>Low <b>${f(lo[1])}</b> <span class="muted">${fDate(lo[0])}</span></span>${
        isNum(ch) && !o.invert ? `<span>Change in view <b class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${fNum(ch, 0)}%</b></span>` : ""}</div>`; })();
  // same size as the chart, so the legend doesn't jump while lines are switched off and on
  if (all.length < 1) return rangeBtns + `<div class="empty ch-empty" style="aspect-ratio:${W}/${H}">Nothing to show — all lines are hidden. Click a name below to show it.</div>` + legend;
  let x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  if (x0 === x1) { x0 -= 86400 * 15; x1 += 86400 * 15; }
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  if (o.yMin === null && o.yMax === null) {
    const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    if (all.every((p) => p[1] >= 0) && y0 < 0) y0 = 0;
  }
  if (o.yMin !== null) y0 = o.yMin;
  if (o.yMax !== null) y1 = Math.max(o.yMax, y0 + 1);
  const X = (v) => l + ((v - x0) / (x1 - x0)) * (W - l - r);
  const LOG = o.scale === "symlog", lc = o.logC || (o.yFmt === fMoneyShort ? 1000 : 1);
  // on a log axis the y range is worked out on the transformed values, with the same 8% headroom
  const f = LOG ? (v) => symlog(v, lc) : (v) => v;
  let f0 = f(y0), f1 = f(y1);
  if (LOG) {
    const lo = Math.min(...all.map((p) => p[1])), hi = Math.max(...all.map((p) => p[1]));
    f0 = symlog(lo, lc); f1 = symlog(hi, lc);
    if (f0 === f1) { f0 -= 1; f1 += 1; }
    const pad = (f1 - f0) * 0.08; f0 -= pad; f1 += pad;
    if (lo >= 0 && f0 < 0) f0 = 0;
  }
  const Y = o.invert ? (v) => t + ((f(v) - f0) / (f1 - f0)) * (H - t - b) : (v) => t + (1 - (f(v) - f0) / (f1 - f0)) * (H - t - b);
  C.geo = { x0, x1, l, r, W, H, t, b, X, Y, series };
  let g = "";
  let yt = niceTicks(y0, y1, 6);
  if (o.yInt) { const step = Math.max(1, Math.ceil((y1 - y0) / 5)); yt = []; for (let v = Math.ceil(y0); v <= y1; v += step) yt.push(v); if (!yt.includes(1) && y0 <= 1) yt.unshift(1); }
  if (LOG) {
    // drop a gridline that would sit within 13px of one already kept (0 and the biggest values are kept first) so labels never overlap
    const lo_ = Math.min(...all.map((p) => p[1])), hi_ = Math.max(...all.map((p) => p[1]));
    let cand = symlogTicks(lo_, hi_, lc).filter((v) => v >= lo_ - Math.abs(lo_) * 0.1 && v <= hi_ * 1.1 || v === 0);
    // a narrow range has few powers of ten in it: use round numbers between instead
    if (cand.filter((v) => v !== 0).length < 3) cand = niceTicks(lo_, hi_, 5);
    const order = cand.slice().sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : Math.abs(b) - Math.abs(a)));
    const kept = [];
    for (const v of order) if (kept.every((k) => Math.abs(Y(k) - Y(v)) >= 13)) kept.push(v);
    yt = kept.sort((a, b) => a - b);
  }
  for (const v of yt) g += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${LOG && v === 0 ? "#b9bfca" : "#ece9e2"}"/><text x="${l - 6}" y="${Y(v) + 4}" text-anchor="end">${o.yFmt(v)}</text>`;
  const ya = yearOf(x0), yb = yearOf(x1), span = (x1 - x0) / 86400;
  const ticks = [];
  if (yb - ya >= 1) {
    const every = Math.max(1, Math.ceil((yb - ya + 1) / 10));
    for (let y = ya + 1; y <= yb; y++) if ((y - ya - 1) % every === 0) ticks.push([yearStart(y), String(y), true]);
    if (span < 1100) for (let y = ya; y <= yb; y++) for (const m of [3, 6, 9]) { const ts = Date.UTC(y, m, 1) / 1000; if (ts > x0 && ts < x1) ticks.push([ts, MONTHS[m], false]); }
  } else {
    for (let m = 0; m < 12; m++) { const ts = Date.UTC(ya, m, 1) / 1000; if (ts >= x0 && ts <= x1) ticks.push([ts, `${MONTHS[m]}`, false]); }
  }
  for (const [ts, lab, major] of ticks) {
    const x = X(ts);
    g += `<line x1="${x}" x2="${x}" y1="${t}" y2="${H - b}" stroke="${major ? "#cfd5df" : "#f1efe9"}" ${major ? "" : 'stroke-dasharray="2 3"'}/>`;
    g += `<text x="${x}" y="${H - b + 13}" text-anchor="middle" ${major ? 'font-weight="700"' : 'fill-opacity="0.6"'}>${lab}</text>`;
  }
  g += `<text x="${l}" y="${H - 3}" text-anchor="start" fill-opacity="0.7">${fDate(x0)}</text><text x="${W - r}" y="${H - 3}" text-anchor="end" fill-opacity="0.7">${fDate(x1)}</text>`;
  if (yb === ya) g += `<text x="${(l + W - r) / 2}" y="${H - 3}" text-anchor="middle" font-weight="700">${ya}</text>`;
  const lines = series.map((s) => {
    const line = `<polyline fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.5 : 2}" ${s.dash ? 'stroke-dasharray="4 3"' : ""} points="${s.pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}"/>`;
    const dots = s.dots ? s.pts.map((p) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${p[3] ? 4.5 : 3}" fill="${p[3] || s.color}" stroke="#fff" stroke-width="1"/>`).join("") : "";
    return line + dots;
  }).join("");
  // charts that are on a log scale say so on the picture itself too
  const logTag = LOG ? `<text class="ch-logmark" x="${W - r - 4}" y="${t + 11}" text-anchor="end">log scale</text>` : "";
  return rangeBtns + `<svg class="chart${LOG ? " is-log" : ""}" viewBox="0 0 ${W} ${H}" role="img">${g}${logTag}${lines}<g class="ch-hover"></g>
    <rect class="ch-hit" x="${l}" y="${t}" width="${W - l - r}" height="${H - t - b}" fill="transparent"/></svg>` + legend;
}
function chartNearest(id, clientX, svg) {
  const C = CHARTS[id], G = C && C.geo;
  if (!G) return null;
  const rect = svg.getBoundingClientRect();
  const xs = ((clientX - rect.left) * G.W) / rect.width;
  const tx = G.x0 + ((xs - G.l) / (G.W - G.l - G.r)) * (G.x1 - G.x0);
  let best = null;
  for (const s of G.series) {
    let lo = 0, hi = s.pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s.pts[m][0] < tx) lo = m; else hi = m; }
    const p = Math.abs(s.pts[lo][0] - tx) <= Math.abs(s.pts[hi][0] - tx) ? s.pts[lo] : s.pts[hi];
    if (!best || Math.abs(p[0] - tx) < Math.abs(best[0] - tx)) best = p;
  }
  if (!best) return null;
  // every visible line's value at (or nearest to) that date
  const at = best[0];
  const rows = G.series.map((s) => {
    let q = null;
    for (const p of s.pts) if (!q || Math.abs(p[0] - at) < Math.abs(q[0] - at)) q = p;
    return { s, p: q, exact: q && Math.abs(q[0] - at) < 86400 * 2 };
  }).filter((x) => x.p);
  return { at, rows, best };
}
const CHART_TIP = document.createElement("div");
CHART_TIP.className = "ch-tip"; CHART_TIP.hidden = true; document.body.appendChild(CHART_TIP);
document.addEventListener("mousemove", (e) => {
  const svg = e.target.closest && e.target.closest(".chartbox svg");
  if (!svg) { if (!CHART_TIP.hidden) { CHART_TIP.hidden = true; $$(".chartbox .ch-hover").forEach((h) => (h.innerHTML = "")); } return; }
  const id = svg.closest(".chartbox").id, C = CHARTS[id], G = C && C.geo;
  const n = chartNearest(id, e.clientX, svg);
  if (!n) return;
  const tipFmt = C.opts.tipFmt || C.opts.yFmt;
  const hx = G.X(n.at);
  svg.querySelector(".ch-hover").innerHTML = `<line x1="${hx}" x2="${hx}" y1="${G.t}" y2="${G.H - G.b}" stroke="#18202f" stroke-opacity=".35" stroke-dasharray="3 3"/>` +
    n.rows.filter((r) => r.exact).map((r) => `<circle cx="${G.X(r.p[0])}" cy="${G.Y(r.p[1])}" r="5" fill="${r.p[3] || r.s.color}" stroke="#fff" stroke-width="2"/>`).join("");
  CHART_TIP.innerHTML = `<div class="d">${fDate(n.at)}</div>` + n.rows.filter((r) => r.exact).map((r) =>
    `<div class="r"><i style="background:${r.p[3] || r.s.color}"></i><span>${esc(r.s.name)}</span><b>${(r.s.fmt || tipFmt)(r.p[1])}</b></div>${r.p[2] ? `<div class="x">${esc(r.p[2])}</div>` : ""}`).join("") +
    (n.best[4] ? `<div class="h">Click to open the race</div>` : "");
  CHART_TIP.hidden = false;
  const w = CHART_TIP.offsetWidth, h = CHART_TIP.offsetHeight;
  let x = e.clientX + 16, y = e.clientY + 14;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
  CHART_TIP.style.left = x + "px"; CHART_TIP.style.top = y + "px";
  svg.style.cursor = n.best[4] ? "pointer" : "crosshair";
});
document.addEventListener("click", (e) => {
  const lg = e.target.closest(".chartbox [data-lg]"), rg = e.target.closest(".chartbox [data-chrange]");
  const box = e.target.closest(".chartbox");
  if (!box || !CHARTS[box.id]) return;
  const C = CHARTS[box.id];
  if (lg) {
    const i = +lg.dataset.lg, now = Date.now();
    // a second click on the same entry straight away (a double-click): undo the first click and show only that line,
    // or everything again if it was already the only one (the legend is redrawn between clicks, so the browser's own dblclick never comes)
    if (LAST_LG && LAST_LG.id === box.id && LAST_LG.i === i && now - LAST_LG.t < 450) {
      if (C.hidden.has(i)) C.hidden.delete(i); else C.hidden.add(i);
      const only = C.series.every((_, j) => j === i || C.hidden.has(j));
      C.hidden = new Set(only ? [] : C.series.map((_, j) => j).filter((j) => j !== i));
      LAST_LG = null;
    } else {
      LAST_LG = { id: box.id, i, t: now };
      if (C.hidden.has(i)) C.hidden.delete(i); else C.hidden.add(i);
    }
    box.innerHTML = chartInner(box.id);
    return;
  }
  if (rg) { C.range = rg.dataset.chrange; box.innerHTML = chartInner(box.id); return; }
  const sc = e.target.closest("[data-chscale]");
  if (sc) { C.opts.scale = sc.dataset.chscale; box.innerHTML = chartInner(box.id); return; }
  if (e.target.closest("[data-chexp]")) { chartBig(box); return; }
  if (e.target.closest("[data-chpng]")) { chartPng(box); return; }
  if (e.target.closest("[data-chcsv]")) { chartCsv(box); return; }
  const svg = e.target.closest("svg");
  if (svg) { const n = chartNearest(box.id, e.clientX, svg); if (n && n.best[4]) { CHART_TIP.hidden = true; location.hash = n.best[4]; } }
});

// double-click on a legend entry (handled in the click handler above): show only that line, again to show them all
let LAST_LG = null;
function chartTitle(box) {
  const p = box.closest(".panel"), h = p && p.querySelector(".panel-head h2"), h1 = document.querySelector("#app h1");
  return ([h1 && h1.innerText, h && h.innerText].filter(Boolean).join(" - ") || "chart").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
}
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// the chart large, in a pop-up, with the same lines, range and scale
function chartBig(box) {
  const C = CHARTS[box.id], id = "ch" + ++CHART_SEQ;
  CHARTS[id] = { series: C.series, opts: { ...C.opts, width: 1200, height: 480, big: true }, hidden: new Set(C.hidden), range: C.range };
  const ov = document.createElement("div");
  ov.className = "overlay ch-overlay";
  ov.innerHTML = `<div class="modal ch-modal"><div class="ch-mhead"><h2>${esc(chartTitle(box))}</h2><button class="btn" data-chclose>Close</button></div><div class="chartbox" id="${id}">${chartInner(id)}</div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); delete CHARTS[id]; document.removeEventListener("keydown", esc_); };
  const esc_ = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esc_);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-chclose]")) close(); });
}
// a picture of the chart: the SVG with its colours and fonts written in, drawn at twice the size
function chartPng(box) {
  const svg = box.querySelector("svg.chart");
  if (!svg) return;
  const vb = svg.viewBox.baseVal, scale = 2, cs = getComputedStyle(svg.querySelector("text") || svg);
  const dark = document.documentElement.classList.contains("dark");
  const copy = svg.cloneNode(true);
  copy.querySelector(".ch-hover") && (copy.querySelector(".ch-hover").innerHTML = "");
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", vb.width); copy.setAttribute("height", vb.height);
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `text{font:${cs.fontSize} ${cs.fontFamily};fill:${cs.fill}}`;
  copy.insertBefore(style, copy.firstChild);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", dark ? "#151b26" : "#ffffff");
  copy.insertBefore(bg, style.nextSibling);
  // the legend underneath, as text, so the picture explains itself
  const C = CHARTS[box.id], names = C.series.map((s, i) => ({ n: s.name, c: s.color || PALETTE[i % PALETTE.length], off: C.hidden.has(i) })).filter((x) => !x.off);
  const H = vb.height + (names.length > 1 ? 22 : 0);
  copy.setAttribute("height", H); copy.setAttribute("viewBox", `0 0 ${vb.width} ${H}`);
  if (names.length > 1) {
    let x = 64;
    for (const nm of names) {
      copy.insertAdjacentHTML("beforeend", `<rect x="${x}" y="${vb.height + 8}" width="10" height="10" rx="2" fill="${nm.c}"/><text x="${x + 14}" y="${vb.height + 17}">${esc(nm.n)}</text>`);
      x += 30 + nm.n.length * 7;
    }
  }
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement("canvas");
    cv.width = vb.width * scale; cv.height = H * scale;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    cv.toBlob((b) => b && saveBlob(b, chartTitle(box) + ".png"), "image/png");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
}
// the numbers behind the chart: one row per date, one column per line (all lines, whatever's hidden or in range)
function chartCsv(box) {
  const C = CHARTS[box.id], dates = new Map();
  C.series.forEach((s, i) => s.points.forEach((p) => { if (isNum(p[1])) { if (!dates.has(p[0])) dates.set(p[0], {}); dates.get(p[0])[i] = p[1]; } }));
  const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [["Date", ...C.series.map((s) => s.name)].map(q).join(",")];
  [...dates.keys()].sort((a, b) => a - b).forEach((ts) => lines.push([day(ts), ...C.series.map((_, i) => (dates.get(ts)[i] ?? ""))].join(",")));
  saveBlob(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), chartTitle(box) + ".csv");
}

// ------------------------------------------------------------------ pop-ups: styled tooltips for anything with a title, and hover cards for links
const TIP = document.createElement("div");
TIP.className = "tip"; TIP.hidden = true; document.body.appendChild(TIP);
const CARD = document.createElement("div");
CARD.className = "hcard"; CARD.hidden = true; document.body.appendChild(CARD);
const CARD_CACHE = new Map();
let TIP_TIMER = null, CARD_TIMER = null, CARD_FOR = null, TIP_FOR = null;
let HOVER_CARDS = true;
try { HOVER_CARDS = localStorage.getItem("hrm.hoverCards") !== "0"; } catch (e) { /* default on */ }
function placePop(el, x, y) {
  const w = el.offsetWidth, h = el.offsetHeight;
  let px = x + 14, py = y + 16;
  if (px + w > window.innerWidth - 8) px = Math.max(8, x - w - 10);
  if (py + h > window.innerHeight - 8) py = Math.max(8, y - h - 12);
  el.style.left = px + "px"; el.style.top = py + "px";
}
const CARD_KINDS = /^#\/(horse|person|stable|race|course)\/(-?\d+)$/;
function cardHtml(kind, d) {
  if (kind === "horse" && d && horseBanner(d.id)) return bannerHtml(horseBanner(d.id), (horsePicRec(d.id) || {}).banner_view || {}) + cardHtml0(kind, d);
  return cardHtml0(kind, d);
}
function cardHtml0(kind, d) {
  if (!d) return "";
  const line = (t) => (t ? `<div class="l">${t}</div>` : "");
  if (kind === "horse") {
    const a = age(d.birth, d.died);
    return `<div class="t">${esc(d.name)}${isNum(d.died) ? ' <span class="badge dead">Dead</span>' : ""}${d.g1 ? ` <span class="badge G1">${d.g1}× G1</span>` : ""}</div>
      ${line(`${a !== null ? a + "yo " : ""}${esc(d.color || "")} ${esc((d.gender || "").toLowerCase())}${d.stable ? " · " + esc(d.stable) : ""}`)}
      ${line(d.sire || d.dam ? `By <b>${esc(d.sire || "?")}</b> out of <b>${esc(d.dam || "?")}</b>` : "")}
      <div class="g"><span>Record</span><b>${d.starts ? `${d.starts}: ${d.wins}-${d.seconds}-${d.thirds}` : "Unraced"}</b><span>Earnings</span><b>${fMoneyShort(d.earnings)}</b>
      <span>Rating</span><b>${fNum(d.rating)} <span class="muted">peak ${fNum(d.peak)}</span></b><span>Form</span><b class="mono">${esc(d.form || "—")}</b>
      ${d.last_run ? `<span>Last run</span><b>${fDate(d.last_run)}</b>` : ""}</div>`;
  }
  if (kind === "person") {
    const js = d.person_jockey_starts, tw = d.person_trainer_starts, ht = d.person_head_trainer_starts;
    return `<div class="t">${esc(d.name)}</div>${line(isNum(d.person_birth_date) ? `Age ${age(d.person_birth_date, d.person_deceased_date)}` : "")}
      <div class="g">${js ? `<span>As jockey</span><b>${fNum(js)} rides · ${fNum(d.person_jockey_wins)} wins (${pct(d.person_jockey_wins, js)})</b>` : ""}
      ${d.person_jockey_winnings ? `<span>Jockey prize</span><b>${fMoneyShort(d.person_jockey_winnings)}</b>` : ""}
      ${tw ? `<span>As trainer</span><b>${fNum(tw)} starts · ${fNum(d.person_trainer_wins)} wins (${pct(d.person_trainer_wins, tw)})</b>` : ""}
      ${ht ? `<span>Head trainer</span><b>${fNum(ht)} starts · ${fNum(d.person_head_trainer_wins)} wins</b>` : ""}
      ${d.owns ? `<span>Owns</span><b>${esc(d.owns)}</b>` : ""}${isNum(d.person_fame_calculated) ? `<span>Fame</span><b>${fNum(d.person_fame_calculated, 1)}</b>` : ""}</div>`;
  }
  if (kind === "stable") {
    return `<div class="t">${esc(d.name)}${d.closed ? ' <span class="badge dead">Closed</span>' : ""}</div>${line(d.owner ? "Owner " + esc(d.owner) : "")}
      <div class="g"><span>Horses</span><b>${fNum(d.horses)}</b><span>Record</span><b>${fNum(d.starts)} starts · ${fNum(d.wins)} wins (${pct(d.wins, d.starts)})</b>
      <span>Prize money</span><b>${fMoneyShort(d.prize)}</b><span>Group wins</span><b>${fNum(d.group_wins)}${d.g1 ? ` <span class="muted">(${d.g1} G1)</span>` : ""}</b>
      <span>Net worth</span><b>${fMoneyShort(d.net_worth)}</b><span>Prestige</span><b>${fNum(d.prestige, 1)}</b></div>`;
  }
  if (kind === "race") {
    return `<div class="t">${esc(d.name || "Race")} ${grade(d.race_type)}</div>${line(`${fDateTime(d.date)} · ${esc(d.course || "")}`)}
      ${line(`${fDist(d.distance)} ${esc(d.track || "")}${d.weather ? " · " + esc(d.weather) : ""} · ${fMoney(d.purse)}`)}
      ${(d.top3 || []).length ? `<div class="g">${d.top3.map((x) => `<span>${ord(x.rank)}</span><b>${esc(x.horse || "")} <span class="muted">${fTime(x.time)}</span></b>`).join("")}</div>`
        : line(d.entries ? `${d.entries} entries · not run yet` : "Not run yet")}`;
  }
  if (kind === "course") {
    return `<div class="t">${esc(d.name)}</div>${line(`${esc(d.city || "")}${d.country ? ", " + esc(d.country) : ""}`)}
      <div class="g"><span>Main track</span><b>${esc(d.surface || "—")} · ${fDist(d.track_length)}</b><span>Direction</span><b>${esc(d.direction || "—")}</b>
      <span>Capacity</span><b>${fNum(d.capacity)}</b></div>`;
  }
  return "";
}
function hideCard() { clearTimeout(CARD_TIMER); CARD.hidden = true; CARD_FOR = null; }
document.addEventListener("mouseover", (e) => {
  // styled tooltip for title attributes
  const tEl = e.target.closest && e.target.closest("[title], [data-tip]");
  if (tEl && !tEl.closest(".hcard")) {
    if (tEl.hasAttribute("title")) { const t = tEl.getAttribute("title"); if (t) tEl.dataset.tip = t; tEl.removeAttribute("title"); }
    // moving between the parts of one element (like the gear letters) mustn't restart or move its tooltip
    if (tEl === TIP_FOR) return;
    TIP_FOR = tEl;
    clearTimeout(TIP_TIMER);
    if (tEl.dataset.tip) {
      const x = e.clientX, y = e.clientY;
      TIP_TIMER = setTimeout(() => { TIP.textContent = tEl.dataset.tip; TIP.hidden = false; placePop(TIP, x, y); }, 280);
    }
  }
  // hover cards for links to horses, people, stables, races and racecourses
  const a = e.target.closest && e.target.closest("a[href^='#/']");
  if (!HOVER_CARDS || !a || a.closest(".hcard, nav, .sidebar, .crumb, .subtabs")) return;
  const m = (a.getAttribute("href") || "").match(CARD_KINDS);
  if (!m || CARD_FOR === a) return;
  hideCard();
  CARD_FOR = a;
  const key = m[1] + "/" + m[2], x = e.clientX, y = e.clientY;
  CARD_TIMER = setTimeout(async () => {
    try {
      let d = CARD_CACHE.get(key);
      if (d === undefined) { d = await api("card/" + key); CARD_CACHE.set(key, d); }
      if (CARD_FOR !== a || !d) return;
      CARD.innerHTML = cardHtml(m[1], d) + `<div class="hint">Click to open · <a href="#" data-cards-off>turn off hover cards</a></div>`;
      CARD.hidden = false; placePop(CARD, x, y);
    } catch (err) { /* no card */ }
  }, 500);
});
document.addEventListener("mouseout", (e) => {
  const tEl = e.target.closest && e.target.closest("[data-tip]");
  if (tEl && !tEl.contains(e.relatedTarget)) { clearTimeout(TIP_TIMER); TIP.hidden = true; if (TIP_FOR === tEl) TIP_FOR = null; }
  const a = e.target.closest && e.target.closest("a[href^='#/']");
  if (a && a === CARD_FOR && !(e.relatedTarget && (a.contains(e.relatedTarget) || CARD.contains(e.relatedTarget)))) {
    clearTimeout(CARD_TIMER);
    setTimeout(() => { if (!CARD.matches(":hover") && CARD_FOR === a) hideCard(); }, 200);
  }
});
CARD.addEventListener("mouseleave", hideCard);
CARD.addEventListener("click", (e) => {
  if (e.target.closest("[data-cards-off]")) {
    e.preventDefault(); HOVER_CARDS = false;
    try { localStorage.setItem("hrm.hoverCards", "0"); } catch (er) { /* session only */ }
    hideCard(); if (location.hash === "#/settings") render();
  }
});
window.addEventListener("scroll", () => { TIP.hidden = true; TIP_FOR = null; hideCard(); }, true);
window.addEventListener("hashchange", () => { TIP.hidden = true; hideCard(); CHART_TIP.hidden = true; });
document.addEventListener("mousedown", () => { TIP.hidden = true; TIP_FOR = null; clearTimeout(TIP_TIMER); });

// ------------------------------------------------------------------ horse photos: a gallery per horse; the main one shows at the top of its page and small in lists
const ICON_PHOTO = `<svg class="ic-ph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="6.5" r="1.3" fill="currentColor"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
let HORSE_PICS = null, HORSE_PICS_DB = null;
async function loadHorsePics(force) {
  const db = (STATUS && STATUS.db && STATUS.db.id) || "";
  if (!force && HORSE_PICS && HORSE_PICS_DB === db) return;
  try { HORSE_PICS = await (await fetch("/api/horse_pics")).json(); } catch (e) { HORSE_PICS = {}; }
  HORSE_PICS_DB = db;
}
// {main, banner} per horse (older versions stored just the profile photo's address)
const horsePicRec = (id) => { const v = HORSE_PICS && HORSE_PICS[String(id)]; return !v ? null : typeof v === "string" ? { main: v, banner: null } : v; };
const horsePic = (id) => (horsePicRec(id) || {}).main || null;
// the hover card shows a banner only when one has been chosen in the gallery (no fallback to the profile photo)
const horseBanner = (id) => (horsePicRec(id) || {}).banner || null;
// the banner as it appears on the hover card, framed the way it was set up in the gallery
const BANNER_H = { short: 90, medium: 120, tall: 160 };
function bannerHtml(url, v = {}, cls = "hc-ban") {
  const fit = v.fit === "contain" ? "contain" : "cover", x = isNum(v.x) ? v.x : 50, y = isNum(v.y) ? v.y : 50, z = isNum(v.zoom) ? v.zoom : 1;
  return `<div class="${cls}" style="height:${BANNER_H[v.height] || 120}px;background:${fit === "contain" ? esc(v.bg || "#1b2130") : "var(--panel)"}">` +
    `<img src="${url}" alt="" draggable="false" style="object-fit:${fit};object-position:${x}% ${y}%;transform:scale(${z});transform-origin:${x}% ${y}%;${v.crisp ? "image-rendering:pixelated;" : ""}"></div>`;
}
const horseThumb = (id) => (horsePic(id) ? `<img class="h-thumb" src="${horsePic(id)}" alt="" loading="lazy">` : "");
async function galleryOpen(hid, name) {
  $("#gal-ov") && $("#gal-ov").remove();
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "gal-ov";
  ov.innerHTML = `<div class="modal gal-modal"><div class="ch-mhead"><h2>${esc(name || "Gallery")} · photos</h2><button class="btn" data-gal-close>Close</button></div><div class="gal-body"><div class="loading">Loading…</div></div></div>`;
  document.body.appendChild(ov);
  ov.dataset.hid = hid;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { if ($(".gal-view", ov)) $(".gal-view", ov).remove(); else close(); } };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-gal-close]")) close(); });
  await galleryDraw(ov);
}
async function galleryDraw(ov, g) {
  const hid = ov.dataset.hid;
  if (!g) g = await (await fetch(`/api/horse_images/${hid}`)).json();
  const body = $(".gal-body", ov);
  body.innerHTML = `<label class="gal-drop"><input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden>
      <b>${ICON_PHOTO} Add photos</b><span class="muted small">Click to choose, or drop pictures here · JPG, PNG, GIF or WebP, up to 25 MB each</span></label>
    <div class="gal-msg"></div>
    ${g.images.length ? `<div class="gal-head"><b>${fNum(g.images.length)} photo${g.images.length === 1 ? "" : "s"}</b><span class="grow"></span>
        <button class="gal-nav" data-gal-scroll="-1" aria-label="Scroll left">‹</button><button class="gal-nav" data-gal-scroll="1" aria-label="Scroll right">›</button></div>
      <div class="gal-strip">${g.images.slice().reverse().map((im) => `<figure class="${im.main ? "is-main" : ""} ${im.banner ? "is-banner" : ""}">
        <div class="gal-tags">${im.main ? '<span class="badge good">Profile</span>' : ""}${im.banner ? '<span class="badge gal-b">Banner</span>' : ""}</div>
        <img src="${im.url}" alt="" data-gal-view="${im.url}" loading="lazy">
        <figcaption>
          ${im.main ? "" : `<button class="btn sm" data-gal-main="${im.file}" data-tip="Show this next to the horse's name, and small in lists">★ Profile</button>`}
          ${im.banner ? `<button class="btn sm" data-gal-banner="" data-tip="Stop using this as the banner (the hover card then has no picture)">✕ Banner</button>`
            : `<button class="btn sm" data-gal-banner="${im.file}" data-tip="Show this wide across the top of the horse's hover card">▭ Banner</button>`}
</figcaption>
        <button class="gal-del" data-gal-del="${im.file}" data-tip="Delete this photo (click twice)" aria-label="Delete this photo">✕</button></figure>`).join("")}</div>
      ${g.banner ? bannerEditor(g) : ""}
      <p class="muted small"><b>Profile</b> shows next to the horse's name on its page and small in the horse lists. <b>Banner</b> shows across the top of its hover card (without one, the hover card has no picture). Add as many photos as you like; they're kept with this database, on this computer.</p>`
    : '<div class="empty">No photos yet.</div>'}`;
  // the row of photos slides sideways; the arrows show when there are more than fit
  const strip = $(".gal-strip", body);
  if (strip) {
    const navs = $$(".gal-nav", body);
    const sync = () => { const over = strip.scrollWidth > strip.clientWidth + 2;
      navs.forEach((n) => { n.hidden = !over; }); if (over) { navs[0].disabled = strip.scrollLeft <= 2; navs[1].disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2; } };
    strip.addEventListener("scroll", sync);
    strip.addEventListener("wheel", (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && strip.scrollWidth > strip.clientWidth) { e.preventDefault(); strip.scrollLeft += e.deltaY; } }, { passive: false });
    requestAnimationFrame(sync);
    $$("img", strip).forEach((im) => im.addEventListener("load", sync));
  }
  const input = $("input[type=file]", body), drop = $(".gal-drop", body);
  const upload = async (files) => {
    const msg = $(".gal-msg", body);
    let last = null, n = 0;
    for (const f of files) {
      msg.innerHTML = `<div class="muted">Adding ${esc(f.name)}…</div>`;
      try {
        const r = await fetch(`/api/horse_images/${hid}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Couldn't add that picture.");
        last = j; n++;
      } catch (e) {
        if (n) await galleryChanged(ov, last);
        $(".gal-msg", ov).innerHTML = `<div class="err">${esc(f.name)}: ${esc(e.message)}</div>`;
        return;
      }
    }
    await galleryChanged(ov, last);
    if (n) $(".gal-msg", ov).innerHTML = `<div class="ok-msg">Added ${n} photo${n === 1 ? "" : "s"}.</div>`;
  };
  input.onchange = () => upload([...input.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files].filter((f) => /^image\//.test(f.type))); };
}
// how the banner looks on the hover card: drag the preview to choose the part that shows, zoom, fill or whole picture, height, sharp pixels
function bannerEditor(g) {
  const v = { fit: "cover", x: 50, y: 50, zoom: 1, height: "medium", crisp: false, bg: "#1b2130", ...(g.banner_view || {}) };
  const im = g.images.find((i) => i.file === g.banner);
  const seg2 = (k, opts) => `<div class="seg">${opts.map(([val, t]) => `<button data-bv="${k}" data-v="${val}" class="${String(v[k]) === String(val) ? "on" : ""}">${t}</button>`).join("")}</div>`;
  return `<div class="bv" data-bv-state='${esc(JSON.stringify(v))}'>
    <div class="bv-h"><b>Banner view</b> <span class="muted small">how the banner looks on the hover card · drag the picture to choose which part shows</span></div>
    <div class="bv-body">
      <div class="bv-prev" data-bv-url="${im.url}">${bannerHtml(im.url, v, "hc-ban bv-ban")}<div class="bv-card-l"></div><div class="bv-card-s"></div></div>
      <div class="bv-ctl">
        <div class="bv-row"><span>Show</span>${seg2("fit", [["cover", "Fill the banner"], ["contain", "Whole picture"]])}</div>
        <div class="bv-row"><span>Zoom</span><input type="range" min="1" max="4" step="0.05" value="${v.zoom}" data-bv-zoom><b class="bv-zv">${Math.round(v.zoom * 100)}%</b></div>
        <div class="bv-row"><span>Height</span>${seg2("height", [["short", "Short"], ["medium", "Medium"], ["tall", "Tall"]])}</div>
        <div class="bv-row"><span>Pixel art</span>${seg2("crisp", [["false", "Smooth"], ["true", "Sharp pixels"]])}</div>
        <div class="bv-row bv-bg" ${v.fit === "contain" ? "" : "hidden"}><span>Background</span><input type="color" value="${v.bg}" data-bv-bg></div>
        <div class="bv-row"><span></span><button class="btn sm" data-bv-reset>Reset view</button><span class="bv-saved muted small"></span></div>
      </div>
    </div></div>`;
}
function bvState(box) { try { return JSON.parse(box.dataset.bvState); } catch (e) { return {}; } }
function bvApply(box, v, save = true) {
  box.dataset.bvState = JSON.stringify(v);
  const prev = $(".bv-prev", box);
  prev.querySelector(".bv-ban").outerHTML = bannerHtml(prev.dataset.bvUrl, v, "hc-ban bv-ban");
  $$("[data-bv]", box).forEach((b) => b.classList.toggle("on", String(v[b.dataset.bv]) === b.dataset.v));
  $(".bv-zv", box).textContent = Math.round(v.zoom * 100) + "%";
  $(".bv-bg", box).hidden = v.fit !== "contain";
  if (save) bvSave(box, v);
}
let BV_TIMER = null;
function bvSave(box, v) {
  clearTimeout(BV_TIMER);
  $(".bv-saved", box).textContent = "";
  BV_TIMER = setTimeout(async () => {
    const ov = box.closest("#gal-ov");
    const r = await fetch(`/api/horse_images/${ov.dataset.hid}/bannerview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: v }) });
    if (!r.ok) { $(".bv-saved", box).textContent = "Couldn't save"; return; }
    $(".bv-saved", box).textContent = "✓ Saved";
    await loadHorsePics(true);
    CARD_CACHE.clear();
  }, 350);
}
document.addEventListener("click", (e) => {
  const box = e.target.closest(".bv");
  if (!box) return;
  const b = e.target.closest("[data-bv]"), reset = e.target.closest("[data-bv-reset]");
  if (b) { const v = bvState(box); v[b.dataset.bv] = b.dataset.bv === "crisp" ? b.dataset.v === "true" : b.dataset.v; bvApply(box, v); }
  if (reset) bvApply(box, { fit: "cover", x: 50, y: 50, zoom: 1, height: "medium", crisp: false, bg: "#1b2130" });
});
document.addEventListener("input", (e) => {
  const box = e.target.closest(".bv");
  if (!box) return;
  const v = bvState(box);
  if (e.target.matches("[data-bv-zoom]")) v.zoom = +e.target.value;
  else if (e.target.matches("[data-bv-bg]")) v.bg = e.target.value;
  else return;
  bvApply(box, v);
});
// drag the preview to move the picture (the part you drag towards comes into view)
document.addEventListener("pointerdown", (e) => {
  const prev = e.target.closest(".bv-prev");
  if (!prev) return;
  e.preventDefault();
  const box = prev.closest(".bv"), start = bvState(box), w = prev.clientWidth, h = prev.querySelector(".bv-ban").clientHeight;
  const sx = e.clientX, sy = e.clientY;
  prev.classList.add("dragging");
  const move = (ev) => {
    const z = start.zoom || 1;
    const v = { ...start, x: Math.max(0, Math.min(100, start.x - ((ev.clientX - sx) / w) * 100 / z)), y: Math.max(0, Math.min(100, start.y - ((ev.clientY - sy) / h) * 100 / z)) };
    bvApply(box, v, false);
  };
  const up = () => { prev.classList.remove("dragging"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); const v = bvState(box); v.x = Math.round(v.x * 10) / 10; v.y = Math.round(v.y * 10) / 10; bvApply(box, v); };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
});

// after any change: redraw the gallery, refresh the list of main photos, and redraw the page behind
async function galleryChanged(ov, g) {
  await galleryDraw(ov, g || undefined);
  await loadHorsePics(true);
  CARD_CACHE.clear();
  APP.dataset.keep = "1";
  const y = window.scrollY;
  await render();
  window.scrollTo(0, y);
}
document.addEventListener("click", async (e) => {
  const open = e.target.closest("[data-gallery]");
  if (open) { e.preventDefault(); return galleryOpen(open.dataset.gallery, open.dataset.gname || ($("#app h1") || {}).innerText); }
  const ov = e.target.closest("#gal-ov");
  if (!ov) return;
  const main = e.target.closest("[data-gal-main]"), del = e.target.closest("[data-gal-del]"), view = e.target.closest("[data-gal-view]");
  const ban = e.target.closest("[data-gal-banner]"), nav = e.target.closest("[data-gal-scroll]");
  if (nav) { const st = $(".gal-strip", ov); st.scrollBy({ left: +nav.dataset.galScroll * st.clientWidth * 0.85, behavior: "smooth" }); return; }
  const post = async (act, file) => {
    const r = await fetch(`/api/horse_images/${ov.dataset.hid}/${act}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
    const j = await r.json();
    if (!r.ok) { $(".gal-msg", ov).innerHTML = `<div class="err">${esc(j.error || "That didn't work.")}</div>`; return; }
    await galleryChanged(ov, j);
  };
  if (main) return post("main", main.dataset.galMain);
  if (ban) return post("banner", ban.dataset.galBanner);
  if (del) { if (del.dataset.sure) return post("delete", del.dataset.galDel); del.dataset.sure = "1"; del.classList.add("sure"); del.textContent = "Delete?"; return; }
  if (view) {
    const v = document.createElement("div");
    v.className = "gal-view"; v.innerHTML = `<img src="${view.dataset.galView}" alt=""><div class="muted small">Click or press Esc to go back</div>`;
    v.onclick = () => v.remove();
    $(".gal-modal", ov).appendChild(v);
  }
});

// ------------------------------------------------------------------ updates from GitHub: a banner when a newer version is out, and the Settings row
let GH = null;
async function githubCheck(force) {
  try { GH = await (await fetch("/api/github" + (force ? "?force=1" : ""), { cache: "no-store" })).json(); } catch (e) { GH = null; }
  githubBanner();
  return GH;
}
function githubBanner() {
  const box = $("#gh-banner");
  if (!box) return;
  let seen = "";
  try { seen = localStorage.getItem("hrm.ghLater") || ""; } catch (e) { /* show it */ }
  box.innerHTML = GH && GH.newer && seen !== GH.latest ? `<div class="banner gh-ban"><span>⬆ <b>HRM Viewer ${esc(GH.latest)}</b> is available (you have ${esc(GH.current)}).</span>
    <span><button class="btn primary" data-gh-install>Install now</button> <button class="btn" data-gh-notes>What's new</button> <button class="btn" data-gh-later>Later</button></span></div>` : "";
}
async function drawGithubBox() {
  const box = $("#gh-box");
  if (!box) return;
  const g = GH || (await githubCheck(false)) || {};
  const repoForm = (val) => `<span class="gh-form"><input type="text" class="gh-repo" placeholder="owner/name" value="${esc(val || "")}" aria-label="GitHub repository">
    <button class="btn sm" data-gh-save>Save</button></span>`;
  if (!g.configured) { box.innerHTML = `<div class="muted small" style="margin-bottom:4px">Not connected to a GitHub repository yet.</div>${repoForm("")}`; return; }
  box.innerHTML = `<div class="gh-status">${g.error ? `<span class="err-inline">${esc(g.error)}</span>`
      : g.newer ? `<b>Version ${esc(g.latest)} is available.</b> <button class="btn primary sm" data-gh-install>Install now</button> <button class="btn sm" data-gh-notes>What's new</button>`
      : `✓ You have the latest version${g.latest ? ` (${esc(g.latest)})` : ""}.`}</div>
    <div class="gh-links small"><button class="btn sm" data-gh-check>Check now</button> <a href="${esc(g.page)}" target="_blank" rel="noopener">Download page on GitHub</a>
      · <span class="muted">${esc(g.repo)}</span> <a href="#" data-gh-edit>change</a></div>`;
}
async function githubInstall(btn) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal"><h2>Installing ${esc((GH && GH.latest) || "the update")}</h2><div class="gh-work"><div class="progress"><div style="width:100%"></div></div>
    <div class="muted">Downloading from GitHub…</div></div></div>`;
  document.body.appendChild(ov);
  const say = (m, err) => { $(".gh-work", ov).innerHTML = err ? `<div class="err">${esc(m)}</div><div style="text-align:right;margin-top:12px"><button class="btn" data-gh-close>Close</button></div>` : `<div class="progress"><div style="width:100%"></div></div><div class="muted">${esc(m)}</div>`; };
  ov.addEventListener("click", (e) => { if (e.target.closest("[data-gh-close]")) ov.remove(); });
  try {
    const r = await fetch("/api/github/install", { method: "POST" });
    const j = await r.json();
    if (!r.ok) return say(j.error || "The update couldn't be installed.", true);
    if (j.restarting) { say("Installed. Restarting the viewer…"); waitForVersion(j.version, (m) => say(m)); }
    else say("Installed. Close the viewer's window and start it again to finish.");
  } catch (e) { say("The update couldn't be installed: " + e.message, true); }
}
function githubNotes() {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal"><h2>What's new in ${esc(GH.latest)}</h2><div class="gh-notes">${esc(GH.notes || "No notes.")}</div>
    <div style="text-align:right;margin-top:14px"><a class="btn" href="${esc(GH.release_page || GH.page)}" target="_blank" rel="noopener">Open on GitHub</a> <button class="btn primary" data-gh-install>Install now</button> <button class="btn" data-gh-close>Close</button></div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-gh-close], [data-gh-install]")) ov.remove(); });
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-gh-install]")) { e.preventDefault(); return githubInstall(); }
  if (e.target.closest("[data-gh-notes]")) { e.preventDefault(); return githubNotes(); }
  if (e.target.closest("[data-gh-later]")) { try { localStorage.setItem("hrm.ghLater", GH.latest); } catch (er) { /* session */ } $("#gh-banner").innerHTML = ""; return; }
  if (e.target.closest("[data-gh-check]")) { $("#gh-box").innerHTML = '<span class="muted small">Checking…</span>'; await githubCheck(true); return drawGithubBox(); }
  if (e.target.closest("[data-gh-edit]")) { e.preventDefault(); const g = GH || {}; $("#gh-box").innerHTML = `<span class="gh-form"><input type="text" class="gh-repo" placeholder="owner/name" value="${esc(g.repo || "")}"><button class="btn sm" data-gh-save>Save</button></span>`; return; }
  if (e.target.closest("[data-gh-save]")) {
    const repo = $(".gh-repo").value.trim();
    const r = await fetch("/api/github/repo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
    const j = await r.json();
    if (!r.ok) { $("#gh-box").insertAdjacentHTML("beforeend", `<div class="err-inline">${esc(j.error)}</div>`); return; }
    GH = j; githubBanner(); drawGithubBox();
  }
});
// check when the viewer opens, then every 6 hours while it's open
setTimeout(() => githubCheck(false), 4000);
setInterval(() => githubCheck(false), 6 * 3600 * 1000);

// the Quick Guide (PDF) in a large pop-up inside the viewer
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-guide]")) return;
  e.preventDefault();
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal guide-modal"><div class="ch-mhead"><h2>Quick Guide</h2><span style="display:inline-flex;gap:8px">
      <a class="btn" href="/quick-guide.pdf" download="HRM Viewer - Quick Guide.pdf">Download PDF</a><button class="btn" data-guide-close>Close</button></span></div>
    <iframe class="guide-frame" src="/quick-guide.pdf#view=FitH" title="Quick Guide"></iframe></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (ev) => { if (ev.target === ov || ev.target.closest("[data-guide-close]")) close(); });
});

// ------------------------------------------------------------------ sort any table by clicking its heading
// (list pages with server-side sorting keep their own [data-sort] headings)
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function sortKey(txt) {
  const t = txt.replace(/\s+/g, " ").trim();
  if (!t || /^[—–-]$/.test(t) || t === "unraced" || t === "Unknown") return { k: null };
  let m = t.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})(?: (\d{1,2}):(\d{2}))?/);
  if (m && m[2] in MON) return { k: Date.UTC(+m[3], MON[m[2]], +m[1], +(m[4] || 0), +(m[5] || 0)), num: true };
  m = t.match(/^(\d+):(\d{2}(?:\.\d+)?)$/);
  if (m) return { k: +m[1] * 60 + +m[2], num: true };
  m = t.replace(/,/g, "").match(/^([+\-−]?)\$?(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (m) {
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[3] || "").toUpperCase()] || 1;
    return { k: (m[1] === "-" || m[1] === "−" ? -1 : 1) * parseFloat(m[2]) * mult, num: true };
  }
  m = t.match(/(\d+(?:\.\d+)?)/);   // "died at 12", "W 80%"...
  return { k: t.toLowerCase(), n2: m ? parseFloat(m[1]) : null };
}
document.addEventListener("click", (e) => {
  const th = e.target.closest("table.data > thead th");
  if (!th || th.hasAttribute("data-sort") || e.target.closest("a, button, input, select")) return;
  const table = th.closest("table");
  if (table.classList.contains("nosort") || !th.textContent.trim()) return;
  const col = [...th.parentNode.children].indexOf(th), tbody = table.tBodies[0];
  if (!tbody) return;
  // keep fold-out rows (form panels, record history) with the row above them
  const groups = [];
  for (const tr of [...tbody.rows]) {
    const first = tr.cells[0];
    if (groups.length && (tr.cells.length === 1 && first && first.colSpan > 1)) groups[groups.length - 1].push(tr);
    else groups.push([tr]);
  }
  const cellKey = (td) => (!td ? sortKey("") : td.dataset.sv !== undefined ? (td.dataset.sv === "" ? { k: null } : { k: +td.dataset.sv, num: true }) : sortKey(td.innerText));
  const keyed = groups.map((g, i) => ({ g, i, key: cellKey(g[0].cells[col]) }));
  const nonEmpty = keyed.filter((x) => x.key.k !== null), numeric = nonEmpty.length && nonEmpty.filter((x) => x.key.num).length >= nonEmpty.length * 0.6;
  const prev = th.dataset.cdir;
  const dir = prev ? (prev === "asc" ? "desc" : "asc") : numeric ? "desc" : "asc";
  [...th.parentNode.children].forEach((x) => { delete x.dataset.cdir; const a = x.querySelector(".sarr"); if (a) a.remove(); });
  th.dataset.cdir = dir;
  th.insertAdjacentHTML("beforeend", `<span class="sarr"> ${dir === "asc" ? "▲" : "▼"}</span>`);
  const val = (x) => (numeric ? (x.key.num ? x.key.k : x.key.n2 !== null && x.key.n2 !== undefined ? x.key.n2 : null) : x.key.k === null ? null : String(x.key.k));
  keyed.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === null && vb === null) return a.i - b.i;
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = numeric ? va - vb : va.localeCompare(vb, undefined, { numeric: true });
    return (dir === "asc" ? c : -c) || a.i - b.i;
  });
  keyed.forEach((x) => x.g.forEach((tr) => tbody.appendChild(tr)));
  // "show latest" lists: the first few rows stay visible after sorting
  const box = table.closest(".expand");
  if (box) { const shown = [...tbody.rows].filter((r) => !r.classList.contains("more-row")).length; [...tbody.rows].forEach((r, i) => r.classList.toggle("more-row", i >= shown)); }
  const moreRuns = [...tbody.rows].filter((r) => r.classList.contains("more-run"));
  if (moreRuns.length && table.closest(".rpanel") && table.closest(".rpanel").querySelector("[data-morerun]")) {
    [...tbody.rows].forEach((r, i) => { r.classList.toggle("more-run", i >= 6); r.hidden = i >= 6; });
  }
});

// a table or list that shows the latest few and expands to show the rest
function expandable(inner, total, shown) {
  if (total <= shown) return inner;
  return `<div class="expand collapsed">${inner}<div class="rp-more"><button class="btn" data-expand data-total="${total}">Show all ${fNum(total)}</button></div></div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-expand]");
  if (!b) return;
  const box = b.closest(".expand"), open = box.classList.toggle("collapsed") === false;
  b.textContent = open ? "Show latest only" : `Show all ${fNum(+b.dataset.total)}`;
});

// ------------------------------------------------------------------ list pages (shared)
async function listPage(cfg, route) {
  const q = route.q;
  const data = await api(cfg.endpoint + "?" + new URLSearchParams(withSize(q)));
  const sort = q.sort || cfg.defaultSort, dir = q.dir || (cfg.ascDefault && cfg.ascDefault.includes(sort) ? "asc" : "desc");
  const expUrl = cfg.exportName ? `/api/export/${cfg.exportName}` : ["horses", "races", "stables", "people", "courses", "meetings"].includes(cfg.endpoint) ? `/api/export/list/${cfg.endpoint}` : null;
  const exp = expUrl ? `<a class="btn btn-csv" href="${expUrl}?${new URLSearchParams(q)}" download data-tip="Download every matching row (all pages, with your filters and sort) as a spreadsheet (CSV) file">${ICON_DL}Export CSV</a>` : "";
  return `<div class="page-head"><div><h1>${cfg.title}</h1><div class="sub">${fNum(data.total)} ${cfg.noun}</div></div>${exp}</div>
    <section class="panel"><div class="filters">${cfg.filters(q, data)}</div>${cfg.intro ? `<div class="note-line">${cfg.intro}</div>` : ""}
    ${table(cfg.cols, data.rows, { sort, dir, rowClass: cfg.rowClass, wide: cfg.wide, ascCols: cfg.ascDefault, empty: "No matches. Try a different search or filter." })}
    ${pager(data)}</section>`;
}
function searchBox(q, placeholder) {
  return `<input type="search" data-q="q" value="${esc(q.q || "")}" placeholder="${placeholder}">`;
}
function select(name, q, options, label) {
  return `<select data-q="${name}" title="${label || ""}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(q[name] || "") === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
}
function seg(name, q, options, def) {
  const cur = q[name] || def;
  return `<div class="seg">${options.map(([v, t]) => `<button data-seg="${name}" data-v="${v}" class="${cur === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
}
let LAST_FOCUS = null;
function afterRender(route) {
  const update = (changes) => {
    const q = { ...route.q, ...changes };
    if (!("page" in changes)) delete q.page;
    APP.dataset.keep = "1";
    go(route.parts, q);
  };
  $$("[data-q]", APP).forEach((el) => {
    if (el.type === "search") {
      el.addEventListener("input", debounce(() => { LAST_FOCUS = el.dataset.q; update({ [el.dataset.q]: el.value.trim() }); }, 350));
    } else el.addEventListener("change", () => {
      if (el.hasAttribute("data-size-pref")) { try { localStorage.setItem("hrm.pageSize", el.value); } catch (e) { /* this page only */ } }
      update({ [el.dataset.q]: el.value });
    });
  });
  $$("[data-seg]", APP).forEach((b) => b.addEventListener("click", () => update({ [b.dataset.seg]: b.dataset.v })));
  $$("th[data-sort]", APP).forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort, cur = route.q.sort;
    const curDir = route.q.dir || (th.dataset.asc ? "asc" : "desc");
    const dir = cur === k ? (curDir === "asc" ? "desc" : "asc") : (th.dataset.asc ? "asc" : "desc");
    update({ sort: k, dir });
  }));
  $$("[data-page]", APP).forEach((b) => b.addEventListener("click", () => { update({ page: b.dataset.page }); window.scrollTo(0, 0); }));
  if (LAST_FOCUS) {
    const el = $(`[data-q="${LAST_FOCUS}"]`, APP);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) { /* ignore */ } }
    LAST_FOCUS = null;
  }
}

const removedNote = (d) => (d && d.removed ? `<div class="warn-line">The game has since removed this record. It's kept from an earlier load (last seen in the save dated ${fDate(d.removed.last_seen)}).</div>` : "");
const removedBadge = (d) => (d && d.removed ? ' <span class="badge">Removed from game</span>' : "");
// ------------------------------------------------------------------ home
function welcome() {
  APP.innerHTML = `<div class="welcome"><h1>Welcome to the HRM Viewer</h1>
    <p>${STATUS && STATUS.db && STATUS.db_count > 1 ? `The database <b>${esc(STATUS.db.name)}</b> is empty.` : "No database is stored yet."} Load your Horse Racing Manager <code>database.db</code> to browse every horse, race, stable and person in your save.</p>
    <p><button class="btn primary" onclick="openLoad()">Load database</button>${STATUS && STATUS.db_count > 1 ? ` <a class="btn" href="#/databases">Open another database</a>` : ""}</p></div>`;
}

async function homePage() {
  const d = await api("home");
  const m = STATUS.meta || {};
  const me = d.me, st = STATUS.player_stable;
  let html = updateBanner() + `<div class="page-head"><div><div class="crumb">Game date ${fDate(m.game_date)}</div>
    <h1>${me ? esc(me.name) : "Your save"}</h1>
    <div class="sub">${me ? `${L.person(me.id, "Your profile")}` : ""}${st ? ` · ${L.stable(st.id, st.name)}` : ""}</div></div></div>`;
  if (me) {
    html += tiles([
      ["Rides", fNum(me.jockey_starts)],
      ["Wins", fNum(me.jockey_wins), `Strike rate ${pct(me.jockey_wins, me.jockey_starts)}`],
      ["Jockey prize money", fMoneyShort(me.jockey_winnings)],
      ["Reputation", fNum(me.reputation, 1)],
      d.my_horses ? ["Horses in your stable", fNum(d.my_horses.length)] : null,
    ]);
  }
  const rideCols = [
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name, "Unnamed race")} ${grade(r.race_type)}` },
    { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
    { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Pos", f: (r) => pos(r.rank, r.runners) },
    { h: "Prize", cls: "num", f: (r) => fMoney(r.prize) },
  ];
  if (me) {
    html += `<div class="grid cols-2">` + panel("Your recent rides", table(rideCols, d.my_rides, { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No rides yet." }), `<a href="#/person/${me.id}">All rides</a>`);
    html += panel("Your upcoming rides", table([
      { h: "Date", cls: "nowrap", f: (r) => fDateTime(r.race_time) },
      { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
      { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
      { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    ], d.my_upcoming, { empty: "No upcoming rides booked." })) + `</div><div style="height:16px"></div>`;
  }
  html += `<div class="grid cols-2">`;
  if (d.my_horses && st) {
    html += panel(`${esc(st.name)} horses`, table([
      { h: "Horse", f: (r) => L.horse(r.id, r.name) },
      { h: "Age", cls: "num", f: (r) => fNum(age(r.birth)) },
      { h: "Sex", f: (r) => esc(r.gender) },
      { h: "Rating", cls: "num", f: (r) => fNum(r.rating) },
      { h: "Form", f: (r) => esc(r.form || "") },
      { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
    ], d.my_horses, { empty: "No horses." }), "", "span-2");
  }
  html += panel("Latest Group 1 & 2 results", table([
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.race_time) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
    { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Winner", f: (r) => L.horse(r.winner_id, r.winner_name) },
  ], d.recent_big), `<a href="#/races?type=G1">All G1s</a>`);
  html += panel("Upcoming Group 1s", table([
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.race_time) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
    { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Purse", cls: "num", f: (r) => fMoneyShort(r.purse) },
    { h: "Entries", cls: "num", f: (r) => fNum(r.entries) },
  ], d.upcoming_big), `<a href="#/races?when=upcoming&type=G1">More</a>`);
  html += panel("Top earners still alive", table([
    { h: "Horse", f: (r) => L.horse(r.id, r.name) },
    { h: "Age", cls: "num", f: (r) => fNum(age(r.birth)) },
    { h: "Sex", f: (r) => esc(r.gender) },
    { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable_name) },
    { h: "Earnings", cls: "num", f: (r) => fMoneyShort(r.earnings) },
  ], d.top_horses), `<a href="#/horses">All horses</a>`, "span-2");
  html += `</div>`;
  // leader boards for the whole save
  const ld = d.leaders || {};
  const num = (list) => list.map((r, i) => ({ ...r, _i: i + 1 }));
  const nCol = { h: "#", cls: "num muted", f: (r) => r._i };
  const hName = { h: "Horse", f: (r) => `${L.horse(r.id, r.name)}${isNum(r.died) ? ' <span class="badge dead">Dead</span>' : ""}` };
  const hStable = { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) };
  const board = (title, cols, list, link) => panel(title, table([nCol].concat(cols), num(list || []), { empty: "Nothing yet." }), link || "");
  html += `<div class="panel-head" style="margin-top:20px"><h2>Leaders across the whole save</h2><span class="note">Every horse, person and stable in this database</span></div>`;
  html += `<div class="grid cols-2 leaders">`;
  html += board("Highest rated horses", [hName, { h: "Age", cls: "num", f: (r) => fNum(age(r.birth, r.died)) }, hStable,
    { h: "Rating", cls: "num", f: (r) => `<b>${fNum(r.rating)}</b>` }, { h: "Peak", cls: "num", f: (r) => fNum(r.peak) }], ld.rated, `<a href="#/horse-table?sort=rating">Horse table</a>`);
  html += board("Most wins (horses)", [hName, hStable, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) }], ld.wins, `<a href="#/horse-table?sort=wins&status=all">More</a>`);
  html += board("Most jockey wins", [{ h: "Jockey", f: (r) => L.person(r.id, r.name) }, { h: "Rides", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.jockeys, `<a href="#/people?role=Jockey&sort=jockey_wins">Top jockeys</a>`);
  html += board("Most trainer wins", [{ h: "Trainer", f: (r) => L.person(r.id, r.name) }, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.trainers);
  html += board("Top earners of all time", [hName, hStable, { h: "Record", cls: "num", f: (r) => `${fNum(r.starts)}: ${fNum(r.wins)} wins` },
    { h: "Earnings", cls: "num", f: (r) => `<b>${fMoneyShort(r.earnings)}</b>` }], ld.earners, `<a href="#/horse-table?sort=earnings&status=all">More</a>`);
  html += board("Most Group 1 wins", [hName, hStable, { h: "G1 wins", cls: "num", f: (r) => `<b>${fNum(r.g1)}</b>` },
    { h: "Earnings", cls: "num", f: (r) => fMoneyShort(r.earnings) }], ld.g1, `<a href="#/horse-table?sort=g1&status=all">More</a>`);
  html += board("Most successful stables", [{ h: "Stable", f: (r) => L.stable(r.id, r.name) }, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "G1", cls: "num", f: (r) => fNum(r.g1) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.stables, `<a href="#/stable-table">Stable table</a>`);
  html += board("Leading sires (progeny earnings)", [{ h: "Sire", f: (r) => `${L.horse(r.id, r.name)} <a class="small" href="#/pedigree/${r.id}">tree</a>` },
    { h: "Foals", cls: "num", f: (r) => fNum(r.foals) }, { h: "Winners", cls: "num", f: (r) => fNum(r.winners) },
    { h: "Progeny earnings", cls: "num", f: (r) => `<b>${fMoneyShort(r.earnings)}</b>` }], ld.sires, `<a href="#/pedigrees">Top sires</a>`);
  html += `</div>`;
  const counts = m.counts || {};
  const totalRows = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  const rem = m.removed || {};
  const remText = [["horses", "horse", "horses"], ["persons", "person", "people"], ["stables", "stable", "stables"], ["racecourses", "racecourse", "racecourses"]]
    .filter(([k]) => rem[k]).map(([k, one, many]) => `${fNum(rem[k])} ${rem[k] === 1 ? one : many}`).join(", ");
  const hist = (m.history || []).slice().reverse();
  const modeLabel = { fresh: "Fresh start", merge_new: "Updated (newer save)", merge_old: "Added missing records (older save)" };
  html += `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2>Stored database</h2></div><div class="grid cols-2"><div>${kv([
    ["Save", esc(m.player_name || "—")],
    ["Last loaded from", esc(m.source_path || m.source || "—")],
    ["Last loaded on", m.loaded_at ? new Date(m.loaded_at * 1000).toLocaleString("en-NZ") : "—"],
    ["Size", isNum(m.file_size) ? (m.file_size / 1048576).toFixed(0) + " MB" : "—"],
    ["Contents", `${fNum(Object.keys(counts).length)} tables, ${fNum(totalRows)} rows · <a href="#/tables">browse all tables</a>`],
    remText ? ["Kept after the game removed them", remText] : null,
  ])}</div><div>${hist.length ? table([
    { h: "Loaded on", cls: "nowrap", f: (r) => new Date(r.loaded_at * 1000).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
    { h: "Game date of file", cls: "nowrap", f: (r) => fDate(r.file_game_date) },
    { h: "How", f: (r) => esc(modeLabel[r.mode] || r.mode) },
    { h: "Older records kept", cls: "num", f: (r) => (r.mode === "fresh" ? "—" : fNum(r.kept)) },
  ], hist.slice(0, 10)) : '<div class="empty">Load history starts with your next load.</div>'}</div></div></section>`;
  return html;
}

// ------------------------------------------------------------------ horses
const horseRow = (r) => (r.died ? "" : "");
async function horsesPage(route) {
  return listPage({
    title: "Horses", noun: "horses", endpoint: "horses", defaultSort: "earnings", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search by name") +
      seg("status", q, [["alive", "Alive"], ["dead", "Deceased"], ["all", "All"]], "alive") +
      select("gender", q, [["", "Any sex"], ["Colt", "Colts"], ["Filly", "Fillies"], ["Stallion", "Stallions"], ["Mare", "Mares"], ["Gelding", "Geldings"]]),
    cols: [
      { h: "Name", sort: "name", f: (r) => `${horseThumb(r.id)}${L.horse(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}` },
      { h: "Sex", f: (r) => esc(r.gender) },
      { h: "Age", cls: "num", sort: "birth", f: (r) => fNum(age(r.birth, r.died)) },
      { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable_name) },
      { h: "Rating", cls: "num", sort: "rating", f: (r) => fNum(r.rating) },
      { h: "G1 wins", cls: "num", sort: "g1", f: (r) => fNum(r.g1) },
      { h: "Form", f: (r) => esc(r.form || "") },
      { h: "Value", cls: "num", sort: "value", f: (r) => fMoneyShort(r.value) },
      { h: "Earnings", cls: "num", sort: "earnings", f: (r) => fMoney(r.earnings) },
    ],
    rowClass: horseRow,
  }, route);
}

async function horsePage(id) {
  const d = await api("horse/" + id);
  const h = d.horse;
  const res = d.results || [];
  const wins = res.filter((r) => r.rank === 1).length, seconds = res.filter((r) => r.rank === 2).length, thirds = res.filter((r) => r.rank === 3).length;
  const a = age(h.horse_birth_date, h.horse_deceased_date);
  const dead = isNum(h.horse_deceased_date);
  const pic = horsePic(h.horse_horse_id);
  // the main photo is the horse's profile picture, next to its name
  let html = `<div class="page-head"><div class="hp-head">${pic ? `<img class="hp-avatar" src="${pic}" alt="${esc(h.horse_name)}" data-gallery="${h.horse_horse_id}" data-gname="${esc(h.horse_name)}" data-tip="Open the gallery">` : ""}<div><div class="crumb"><a href="#/horses">Horses</a></div>
    <h1>${esc(h.horse_name)} ${dead ? '<span class="badge dead">Deceased</span>' : ""}${removedBadge(d)}</h1>
    <div class="sub">${a !== null ? a + "yo " : ""}${esc(h.horse_color || "")} ${esc((h.horse_gender || "").toLowerCase())} · ${esc(h.horse_breed || "")}
    · Foaled ${fDate(h.horse_birth_date)}${dead ? ` · Died ${fDate(h.horse_deceased_date)} ${esc(h.horse_death_cause || "")}` : ""}
    ${d.stable ? ` · ${L.stable(d.stable.id, d.stable.name)}` : ""}</div>${removedNote(d)}</div></div>
    <div style="display:flex;gap:8px"><button class="btn" data-gallery="${h.horse_horse_id}" data-gname="${esc(h.horse_name)}">${ICON_PHOTO}${pic ? "Gallery" : "Add photos"}</button></div></div>`;
  html += tiles([
    ["Rating", fNum(h.horse_international_rating), `Peak ${fNum(h.horse_peak_rating)}`],
    ["Career earnings", fMoneyShort(h.horse_career_earnings)],
    ["Record", `${res.length}: ${wins}-${seconds}-${thirds}`, `Strike rate ${pct(wins, res.length)}`],
    ["Group wins", `${fNum(h.horse_g1_wins)} · ${fNum(h.horse_g2_wins)} · ${fNum(h.horse_g3_wins)}`, `G1 · G2 · G3 · Listed ${fNum(h.horse_listed_wins)}`],
    ["Value", fMoneyShort(h.horse_value_calculated)],
    ["Form", esc(h.horse_form || "—"), `Condition ${fNum(h.horse_condition)}%`],
  ]);

  const ped = (x, role, cls = "") => `<div class="p ${cls}"><div class="r">${role}</div>${x ? L.horse(x.id, x.name) : '<span class="muted">Unknown</span>'}</div>`;
  const gp = d.grandparents || {};
  const pedigree = `<div class="ped">${ped(d.sire, "Sire", "parent")}${ped(gp.sire && gp.sire.sire, "Sire's sire")}${ped(gp.sire && gp.sire.dam, "Sire's dam")}
    ${ped(d.dam, "Dam", "parent")}${ped(gp.dam && gp.dam.sire, "Dam's sire")}${ped(gp.dam && gp.dam.dam, "Dam's dam")}</div>`;
  const ppl = d.people || {};
  const pp = (k) => (ppl[k] ? L.person(ppl[k].id, ppl[k].name) : "—");
  const connections = kv([
    ["Stable", d.stable ? L.stable(d.stable.id, d.stable.name) : "—"],
    ["Manager", pp("horse_manager_id")], ["Head trainer", pp("horse_head_trainer_id")], ["Trainer", pp("horse_trainer_id")],
    ["Preferred jockey", pp("horse_prefered_jockey_id")], ["Caretaker", pp("horse_caretaker_id")],
    ["Running instruction", esc(h.horse_running_style_instruction || "—")],
  ]);
  // abilities: current level and best so far, plus whether the horse has hit its ceiling (the ceiling itself isn't shown)
  const near = (x, y) => isNum(x) && isNum(y) && x >= y - 0.05;
  const abilRows = ["speed", "stamina", "acceleration", "strength"].map((k) => {
    const cur = h["horse_" + k], peak = h["horse_peak_" + k], max = h["horse_max_" + k];
    let st;
    if (near(cur, max)) st = ["Peak reached", "ok", "Has reached its full potential for this ability"];
    else if (near(peak, max)) st = ["Past peak", "warn", `Reached its full potential (best ${fNum(peak, 1)}) and has dropped back since`];
    else if (isNum(peak) && isNum(cur) && cur < peak - 0.05) st = ["Below its best", "warn", `Best so far ${fNum(peak, 1)} — not yet at full potential`];
    else st = ["Still improving", "dev", "Has not yet reached its full potential"];
    return { label: k[0].toUpperCase() + k.slice(1), cur, peak, st };
  });
  const reached = abilRows.filter((x) => x.st[1] === "ok" || x.st[0] === "Past peak").length;
  const abil = `<div class="bars abil">${abilRows.map((x) => `<div class="bar-row"><div class="lbl">${x.label}</div><div class="bar">
      ${isNum(x.peak) ? `<div class="peak" style="width:${Math.max(0, Math.min(100, x.peak))}%"></div>` : ""}<div class="cur" style="width:${Math.max(0, Math.min(100, x.cur || 0))}%"></div></div>
      <div class="val"><b>${fNum(x.cur, 1)}</b> <span class="pk ${x.st[1]}" title="${esc(x.st[2])}">${x.st[0]}</span></div></div>`).join("")}</div>
    <div class="legend"><span><i style="background:var(--blue)"></i>Current</span><span><i style="background:#9fbdf0"></i>Best so far</span>
    <span><b>${reached} of 4</b> abilities have reached their peak</span></div>`;
  const mind = bars([["Intelligence", "intelligence"], ["Temperament", "temperament"], ["Sociability", "sociability"], ["Experience", "experience"], ["Health risk", "health_risk"]]
    .map(([l, k]) => ({ label: l, cur: h["horse_" + k] })));
  const dk = [["Sprint", "s"], ["Mile", "m"], ["Intermediate", "i"], ["Long", "l"], ["Extended", "e"]];
  const dmax = Math.max(1, ...dk.map(([, k]) => h["horse_distance_" + k] || 0));
  const dist = bars(dk.map(([l, k]) => ({ label: l + (String(h.horse_distance_preference || "").toLowerCase() === k ? " ★" : ""), cur: h["horse_distance_" + k] })), dmax);
  const smax = Math.max(1, ...["front", "press", "mid", "back"].map((k) => h["horse_style_" + k] || 0));
  const style = bars([["Front", "front"], ["Press", "press"], ["Mid-pack", "mid"], ["Back", "back"]].map(([l, k]) => ({ label: l, cur: h["horse_style_" + k] })), smax);
  const physical = kv([
    ["Breed", esc(h.horse_breed)], ["Colour", esc(h.horse_color)], ["Height", fNum(h.horse_height, 1) + " cm"], ["Weight", fNum(h.horse_weight, 0) + " kg"],
    ["Weather preference", esc(h.horse_weather_preference || "—")], ["Longevity", fNum(h.horse_longetivity, 2)], ["Maturity rate", fNum(h.horse_maturity_rate, 2)],
    ["Breeding ability", fNum(h.horse_breeding_ability, 1)], ["Grade", fNum(h.horse_grade)],
    ["Stud fee", h.horse_stud_fee ? fMoney(h.horse_stud_fee) : "—"], ["Pregnant", h.horse_is_pregnant ? "Yes" : "No"],
  ]);

  html += `<div class="grid cols-3">${panel("Connections", connections)}${panel("Pedigree", pedigree, `<a href="#/pedigree/${h.horse_horse_id}">Full pedigree</a>`)}${panel("Physical", physical)}</div>`;
  const ent = (d.entries || []).slice().sort((x, y) => (x.race_time || 0) - (y.race_time || 0));
  if (ent.length) {
    html += `<div style="margin-top:16px">${panel("Upcoming races", table([
      { h: "Date", cls: "nowrap", f: (r) => fDateTime(r.race_time) },
      { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
      { h: "Course", f: (r) => L.course(r.course_id, r.course) },
      { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
      { h: "Jockey", f: (r) => L.person(r.jockey_id, r.jockey) },
      { h: "Purse", cls: "num", f: (r) => fMoney(r.purse) },
    ], ent))}</div>`;
  }
  // form guide (the same details as the race-page runner panel)
  const next = ent[0];
  let fg = "";
  try {
    const f = await api(`runner?horse=${h.horse_horse_id}` + (next ? `&race=${next.race_id}` : ""));
    if (f) fg = panel("Form guide", `<div class="rpanel hp">${renderRunnerPanel(f, { noRuns: true, noPeople: true, condLabel: "next start's conditions", byDistance: res })}</div>`,
      next ? `For next start: ${L.race(next.race_id, next.race_name)} · ${fDate(next.race_time)}` : "Career summary");
  } catch (err) { fg = panel("Form guide", `<div class="err-box">${esc(err.message)}</div>`); }
  if (fg) html += `<div style="margin-top:16px">${fg}</div>`;

  html += `<div style="margin-top:16px">${panel("Race record", table([
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name, '<span class="muted">Historic race</span>')} ${grade(r.race_type)}` },
    { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    { h: "Pos", f: (r) => pos(r.rank, r.runners) },
    { h: "Jockey", f: (r) => L.person(r.jockey_id, r.jockey) },
    { h: "Trainer", f: (r) => L.person(r.trainer_id, r.trainer) },
    { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) },
    { h: "Gear", f: (r) => gearAbbr(r.gear) },
    { h: "Time", cls: "num", f: (r) => fTime(r.time) },
    { h: "Odds", cls: "num", f: (r) => (isNum(r.odds) ? fNum(r.odds, 1) : "—") },
    { h: "Rating", cls: "num", f: (r) => fNum(r.rating) },
    { h: "Prize", cls: "num", f: (r) => fMoney(r.prize) },
  ], res, { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No races yet." }), `${res.length} starts`, "tall")}</div>`;

  // track records set by this horse: still standing, and broken since
  const trs = d.track_records || [], held = trs.filter((r) => r.current), former = trs.filter((r) => !r.current);
  const trWhere = (r) => `${L.course(r.course_id, r.course)} <span class="muted small">${esc(r.track || "")}</span>`;
  const trCols = [
    { h: "Racecourse", f: trWhere },
    { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    { h: "Time", cls: "num", f: (r) => `<b>${fTime(r.time)}</b>` },
    { h: "Improved by", cls: "num", f: (r) => (isNum(r.prev_best) ? `${(r.prev_best - r.time).toFixed(2)}s` : '<span class="muted">first</span>') },
    { h: "Set", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
    { h: "Jockey", f: (r) => L.person(r.jockey_id, r.jockey) },
  ];
  const trHeld = held.length ? table(trCols.concat([{ h: "Standing for", cls: "num", f: (r) => `${fNum(Math.max(0, Math.floor((GD() - r.date) / 86400)))} days` }]), held)
    : '<div class="empty">This horse doesn\'t hold any course records right now.</div>';
  const trFormer = former.length ? table(trCols.concat([
    { h: "Broken by", f: (r) => (r.broken_by ? `${r.broken_by.horse_id === h.horse_horse_id ? "<b>itself</b>" : L.horse(r.broken_by.horse_id, r.broken_by.horse)} <span class="muted small">${fTime(r.broken_by.time)} · ${L.race(r.broken_by.race_id, fDate(r.broken_by.date))}</span>` : "—") },
    { h: "Held for", cls: "num", f: (r) => (r.broken_by ? `${fNum(Math.floor((r.broken_by.date - r.date) / 86400))} days` : "—") },
    { h: "Record now", f: (r) => (r.record_now ? `${fTime(r.record_now.time)} <span class="muted small">${L.horse(r.record_now.horse_id, r.record_now.horse)}</span>` : "—") },
  ]), former) : '<div class="empty">No earlier course records.</div>';
  const srs = d.section_records || [];
  const srBlock = srs.length ? `<div class="rp-h">Sectional records held <span class="muted small">· fastest ever for that section at that course and distance</span></div>` + table([
    { h: "Racecourse", f: trWhere }, { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    { h: "Section", f: (r) => { const [a, b] = secBounds(r.distance)[r.sec - 1]; return `${SEC_NAMES[r.sec - 1]} <span class="muted small">${fNum(a)}–${fNum(b)} m</span>`; } },
    { h: "Time", cls: "num", f: (r) => `<b>${r.time.toFixed(2)}</b>` },
    { h: "Speed", cls: "num", f: (r) => { const [a, b] = secBounds(r.distance)[r.sec - 1]; return `${(((b - a) / r.time) * 3.6).toFixed(1)} km/h`; } },
    { h: "Set", cls: "nowrap", f: (r) => L.race(r.race_id, fDate(r.date)) }, { h: "Runs timed", cls: "num", f: (r) => fNum(r.runs) },
  ], srs) : "";
  html += `<div style="margin-top:16px">${panel(`Track records`, `<div class="rp-h" style="margin-top:0">Held now <span class="muted small">· ${held.length} course record${held.length === 1 ? "" : "s"} still standing</span></div>${trHeld}
    <div class="rp-h">Held in the past <span class="muted small">· ${former.length} record${former.length === 1 ? "" : "s"} since broken</span></div>${trFormer}${srBlock}`,
    `${trs.length} course record${trs.length === 1 ? "" : "s"} set in all${srs.length ? ` · ${srs.length} sectional record${srs.length === 1 ? "" : "s"}` : ""}`)}</div>`;

  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Abilities", abil)}${panel("Mind & health", mind)}
    ${panel("Distance preference", dist, "★ = preferred")}${panel("Running style", style)}</div>`;

  // charts
  const st = d.stats || [];
  const runs = res.filter((r) => isNum(r.rank) && isNum(r.date)).slice().sort((x, y) => x.date - y.date);
  const GOLD = "#d4a017", SILVER = "#8f9aa8", BRONZE = "#b87333";
  const placeCol = (k) => (k === 1 ? GOLD : k === 2 ? SILVER : k === 3 ? BRONZE : null);
  const maxField = Math.max(3, ...runs.map((r) => Math.max(r.rank, r.runners || 0)));
  const finChart = lineChart([
    { name: "Finishing position", color: "#1d63d6", dots: true,
      points: runs.map((r) => [r.date, r.rank, `${r.race_name || "Historic race"} · ${r.course || ""} · ${fDist(r.distance)}${r.runners ? ` · ${ord(r.rank)} of ${r.runners}` : ""}`, placeCol(r.rank), r.race_id ? `#/race/${r.race_id}` : null]) },
    { name: "Field size", color: "#b8c2d3", dash: true, fmt: (v) => `${v} runners`, points: runs.filter((r) => r.runners).map((r) => [r.date, r.runners]) },
  ], { invert: true, yInt: true, yMin: 1, yMax: maxField, yFmt: (v) => ord(Math.round(v)), tipFmt: (v) => ord(Math.round(v)), height: 260, width: 1400 });
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Stats over time", lineChart(["speed", "stamina", "acceleration", "strength", "intelligence"].map((k) => ({ name: k[0].toUpperCase() + k.slice(1), points: st.map((s) => [s.date, s[k]]) })), { tipFmt: (v) => fNum(v, 1) }), "Hover for values · click a name to hide its line")}
    ${panel("Value over time", lineChart([{ name: "Value", points: (d.valuation || []).map((v) => [v.date, v.value]) }], { yFmt: fMoneyShort, tipFmt: fMoney }), "Hover for values")}</div>`;
  html += `<div style="margin-top:16px">${panel("Finishing positions", finChart + (runs.length ? `<div class="legend"><span><i style="background:${GOLD}"></i>Won</span><span><i style="background:${SILVER}"></i>2nd</span><span><i style="background:${BRONZE}"></i>3rd</span><span>1st is at the top · hover for the race, click a dot to open it · click a legend entry to hide a line</span></div>` : ""),
    runs.length ? `${runs.length} starts` : "")}</div>`;

  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Traits", chips(d.traits))}
    ${panel("Health history", table([
      { h: "From", cls: "nowrap", f: (r) => fDate(r.start) }, { h: "To", cls: "nowrap", f: (r) => fDate(r.end) },
      { h: "Condition", f: (r) => esc(r.name) }, { h: "Type", f: (r) => esc(r.type) }, { h: "Severity", cls: "num", f: (r) => fNum(r.severity) },
    ], d.health, { empty: "No illnesses or injuries." }))}</div>`;

  const AWARD_NAMES = { g1_race: "G1 win", g2_race: "G2 win", g3_race: "G3 win", listed_race: "Listed win" };
  const AWARD_GRADE = { g1_race: "G1", g2_race: "G2", g3_race: "G3", listed_race: "listed" };
  const aw = d.awards || [], SHOW = 5;
  const nRace = (c) => aw.filter((x) => x.category === c).length;
  const awSummary = ["g1_race", "g2_race", "g3_race", "listed_race"].map((c) => [c, nRace(c)]).filter(([, n]) => n).map(([c, n]) => `${n}× ${AWARD_NAMES[c].replace(" win", "")}`).join(" · ");
  const awTable = table([
    { h: "Year", f: (r) => esc(r.year ?? "") },
    { h: "Award", f: (r) => AWARD_GRADE[r.category] ? `${grade(AWARD_GRADE[r.category])} <span class="small muted">win</span>` : esc((r.category || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())) + (isNum(r.rank) ? ` <span class="small muted">(${ord(r.rank)})</span>` : "") },
    { h: "For", f: (r) => (r.race_id ? L.race(r.race_id, r.description || "race") : esc(r.description || "")) },
    { h: "Value", cls: "num", f: (r) => (r.value ? fMoney(r.value) : "—") },
  ], aw, { empty: "No awards.", rowClass: (r) => (aw.indexOf(r) >= SHOW ? "more-row" : "") });
  const ev = d.events || [];
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Awards", expandable(awTable, aw.length, SHOW), aw.length ? (awSummary ? awSummary + " · " : "") + `${aw.length} in all` : "")}
    ${panel("News", events(ev, SHOW), ev.length > SHOW ? `latest ${SHOW} of ${ev.length}` : "")}</div>`;

  html += `<div style="margin-top:16px">${panel("Offspring", table([
    { h: "Name", f: (r) => `${L.horse(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}` },
    { h: "Sex", f: (r) => esc(r.gender) }, { h: "Foaled", cls: "nowrap", f: (r) => fDate(r.birth) }, { h: "Age", cls: "num nowrap", f: (r) => ageCell(r.birth, r.died) },
    { h: h.horse_sex === "Female" ? "Sire" : "Dam", f: (r) => L.horse(r.mate_id, r.mate_name) },
    { h: "G1 wins", cls: "num", f: (r) => fNum(r.g1) }, { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
  ], d.offspring, { empty: "No offspring." }), (d.offspring_total > d.offspring.length ? `Top ${d.offspring.length} of ${fNum(d.offspring_total)} by earnings` : `${fNum(d.offspring_total)} foals`) +
    (d.offspring_total ? ` · <a href="#/horse-table?${h.horse_sex === "Female" ? "dam" : "sire"}=${h.horse_horse_id}&status=all">Open in Horse table</a>` : ""), "tall")}</div>`;
  html += `<div style="margin-top:16px">${allFields(h)}</div>`;
  return html;
}

// ------------------------------------------------------------------ runner lines + form panels (race and meeting pages)
const rec = (a) => (a && a.length === 4 ? `${a[0]}: ${a[1]}-${a[2]}-${a[3]}` : "—");
function upText(n) { return n === 1 ? "1st up" : n === 2 ? "2nd up" : n === 3 ? "3rd up" : `${ord(n)} run this preparation`; }
function runnerTable(race, rows, kind) {
  const myId = (STATUS.player || {}).id;
  if (!rows || !rows.length) return `<div class="empty">${kind === "entries" ? "No entries yet." : "No results."}</div>`;
  const wt = kind === "results" && isNum(rows[0].time) ? rows[0].time : null;
  const head = kind === "results"
    ? `<th>Pos</th><th>Horse</th><th>Form</th><th class="num">Career</th><th class="num">Win / Place</th><th class="num">Rtg</th><th class="num">Time</th><th class="num">Margin</th><th class="num">SP</th><th class="num">Prize</th><th></th>`
    : `<th class="num">Bar.</th><th>Horse</th><th>Form</th><th class="num">Career</th><th class="num">Win / Place</th><th>Last start</th><th class="num">Rating</th><th></th>`;
  const cols = kind === "results" ? 11 : 8;
  const body = rows.map((x, i) => {
    const c = x.career || [0, 0, 0, 0];
    const wp = c[0] ? `${Math.round((100 * c[1]) / c[0])}% / ${Math.round((100 * (c[1] + c[2] + c[3])) / c[0])}%` : "—";
    const sub = `${isNum(x.birth) ? fNum(age(x.birth, race.race_time)) + "yo " : ""}${esc(x.color || "")} ${esc(x.gender || "")}` +
      ` · <span class="lbl">J:</span> ${L.person(x.jockey_id, x.jockey, "No jockey yet")}` + (x.trainer ? ` · <span class="lbl">T:</span> ${L.person(x.trainer_id, x.trainer)}` : "") +
      (x.stable ? ` · ${L.stable(x.stable_id, x.stable)}` : "");
    const horse = `<div class="rname">${L.horse(x.horse_id, x.horse)} <span class="bar">(${isNum(x.gate) ? x.gate : "–"})</span></div><div class="rsub">${sub}</div>`;
    const form = `<span class="form">${esc(x.form || "") || '<span class="muted">first start</span>'}</span>`;
    const arrow = `<button class="rtoggle" data-i="${i}" title="Show form">▸</button>`;
    const cls = kind === "results" ? (x.rank === 1 ? "win" : x.jockey_id === myId ? "me" : "") : x.jockey_id === myId ? "me" : "";
    const cells = kind === "results"
      ? `<td>${pos(x.rank)}</td><td class="rhorse">${horse}</td><td>${form}</td><td class="num">${rec(x.career)}</td><td class="num">${wp}</td>
         <td class="num">${fNum(x.rating)}</td><td class="num">${fTime(x.time)}</td><td class="num">${wt && isNum(x.time) && x.rank > 1 ? "+" + (x.time - wt).toFixed(2) + "s" : ""}</td>
         <td class="num">${isNum(x.odds) ? `<span class="box">${fNum(x.odds, 1)}</span>` : "—"}</td><td class="num">${fMoney(x.prize)}</td><td>${arrow}</td>`
      : `<td class="num"><span class="gate">${isNum(x.gate) ? x.gate : "–"}</span></td><td class="rhorse">${horse}</td><td>${form}</td><td class="num">${rec(x.career)}</td><td class="num">${wp}</td>
         <td>${x.last ? `${ord(x.last.rank)}${x.last.runners ? ` of ${x.last.runners}` : ""} <span class="muted small">${isNum(x.last.days) ? x.last.days + " days ago" : ""}</span>` : '<span class="muted">—</span>'}</td>
         <td class="num"><span class="box">${fNum(x.rating)}</span></td><td>${arrow}</td>`;
    return `<tr class="rline ${cls}">${cells}</tr><tr class="rdetail" hidden><td colspan="${cols}"><div class="rpanel" data-race="${race.race_id}" data-horse="${x.horse_id}"></div></td></tr>`;
  }).join("");
  return `<div class="tbl-wrap"><table class="data runners"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function ring(w, p) {
  const R = 30, C = 2 * Math.PI * R, pw = Math.max(0, Math.min(1, w)), pp = Math.max(0, Math.min(1, p));
  return `<svg viewBox="0 0 80 80" width="96" height="96"><circle cx="40" cy="40" r="${R}" fill="none" stroke="#e6e9ef" stroke-width="8"/>
    <circle cx="40" cy="40" r="${R}" fill="none" stroke="#9db8ec" stroke-width="8" stroke-dasharray="${pp * C} ${C}" transform="rotate(-90 40 40)"/>
    <circle cx="40" cy="40" r="${R}" fill="none" stroke="#1f9d55" stroke-width="8" stroke-dasharray="${pw * C} ${C}" transform="rotate(-90 40 40)"/>
    <text x="40" y="34" text-anchor="middle" font-size="8.5" fill="#1f9d55" font-weight="700">Win</text>
    <text x="40" y="44" text-anchor="middle" font-size="9" fill="#18202f" font-weight="700">${(100 * pw).toFixed(1)}%</text>
    <text x="40" y="54" text-anchor="middle" font-size="8.5" fill="#3d6fd0" font-weight="700">Place ${(100 * pp).toFixed(0)}%</text></svg>`;
}
const GEAR_NAMES = { B: "Blinkers", E: "Earplugs", T: "Tongue tie" };
const gearName = (g) => (g ? g.split("").map((x) => GEAR_NAMES[x] || `gear code ${x}`).join(", ") : "");
// short gear letters, full names when you hover
function gearAbbr(g) {
  if (!g) return '<span class="muted">—</span>';
  return `<span class="gear" title="${esc(gearName(g))}">${g.split("").map((x) => `<i>${esc(x)}</i>`).join("")}</span>`;
}
const WEATHER_PREF = { A: "Any weather", D: "Dry", W: "Wet" };
function compactStyles(list) {
  const out = [];
  for (const x of list) { const last = out[out.length - 1]; if (last && last[0] === x) last[1]++; else out.push([x, 1]); }
  return out.map(([x, n]) => (n > 1 ? `${x} ×${n}` : x)).join(", ");
}
function renderRunnerPanel(d, opts = {}) {
  const h = d.horse, sf = d.short, race = d.race, car = sf.career || [0, 0, 0, 0];
  const gen = !race.race_id;  // horse page with no upcoming race: career summary, nothing highlighted
  const wPct = car[0] ? car[1] / car[0] : 0, pPct = car[0] ? (car[1] + car[2] + car[3]) / car[0] : 0;
  const cell = (label, value, hl) => `<div class="rc ${hl ? "hl" : ""}"><div class="l">${label}</div><div class="v">${value}</div></div>`;
  const pc = (o) => (o && o.n ? `${o.n}: W ${Math.round((100 * o.w) / o.n)}% P ${Math.round((100 * o.p) / o.n)}%` : "—");
  const styleName = { F: "Leader", P: "On pace", M: "Midfield", B: "Back" };
  const gearNow = (d.gear || {}).now, gearLast = (d.gear || {}).last;
  const gearTxt = gearNow ? gearAbbr(gearNow) + (gearLast !== undefined && gearLast !== null && gearLast !== gearNow ? ` <span class="muted small">(was ${gearLast ? gearAbbr(gearLast) : "none"})</span>` : "")
    : (gearLast ? `<span class="muted">last start:</span> ${gearAbbr(gearLast)}` : "None");
  const top = `<div class="rp-top"><div class="rp-grid">
      ${cell("Overall", rec(sf.career))}${cell("Rating", fNum(h.rating))}${cell("Prize money", fMoney(d.prize_before))}
      ${cell("Type", `${esc(h.color || "")} / ${esc(h.gender || "")}`)}${cell("Age", d.age !== null ? d.age + "yo" : "—")}${cell("Sire", L.horse(h.sire_id, h.sire))}
      ${cell("Dam", L.horse(h.dam_id, h.dam))}${cell("Dam's sire", L.horse(h.damsire_id, h.damsire))}${opts.noPeople ? "" : cell("Trainer", L.person(h.trainer_id, h.trainer))}
      ${cell("Stable", L.stable(h.stable_id, h.stable))}${opts.noPeople ? "" : cell("Jockey last 50", d.jockey ? rec(d.jockey.last50) : "—")}
      ${cell("Expected settling", `${esc(d.settle || "—")}${(d.recent_styles || []).length ? ` <span class="muted small">recent: ${compactStyles(d.recent_styles.map((x) => styleName[x] || x))}</span>` : ""}`)}
      ${cell("Gear", gearTxt)}${cell("Days since last start", isNum(sf.days_since) ? `${sf.days_since} · ${gen ? "next run " : ""}${upText(sf.first_up_now)}` : gen ? "Unraced" : "First start")}
      ${cell("Preferences", `${esc({ S: "Sprint", M: "Mile", I: "Intermediate", L: "Long", E: "Extended" }[h.dist_pref] || h.dist_pref || "—")} · ${esc(WEATHER_PREF[h.weather_pref] || h.weather_pref || "Any weather")}`)}
    </div><div class="rp-ring">${ring(wPct, pPct)}</div></div>`;
  const W = race.weather, S = race.surface, D = race.direction, up = gen ? 0 : sf.first_up_now;
  const cond = `${esc(race.course || "")}, ${fDist(race.distance)}${W ? ", " + esc(W) : ""}${S ? ", " + esc(S) : ""}${D === "CW" ? ", clockwise" : D === "CCW" ? ", anti-clockwise" : ""}`;
  const short = `<div class="rp-h">Short form <span class="muted small">· ${gen ? "whole career, by conditions" : `highlighted = ${opts.condLabel || "today's conditions"} (${cond})`}</span></div>
    <div class="rp-short">
      ${gen ? "" : cell("Track", rec(sf.track), true) + cell("Distance", rec(sf.distance), true) + cell("Trk/Dst", rec(sf.track_distance), true)}${cell("Season", rec(sf.season))}
      ${cell("1st Up", rec(sf.up["1"]), up === 1)}${cell("2nd Up", rec(sf.up["2"]), up === 2)}${cell("3rd Up", rec(sf.up["3"]), up === 3)}${cell("4th Up+", rec(sf.up["4"]), up >= 4)}
      ${["Sunny", "Cloudy", "Rainy", "Stormy", "Foggy", "Snowy"].map((w) => cell(w, rec(sf.weather[w]), w === W)).join("")}
      ${["Turf", "Dirt", "Synthetic"].map((x) => cell(x, rec(sf.surface[x]), x === S)).join("")}
      ${cell("Clockwise", rec(sf.direction.CW), D === "CW")}${cell("Anti-clockwise", rec(sf.direction.CCW), D === "CCW")}${opts.noPeople ? "" : cell("Jockey / horse", rec(sf.jockey_horse), !gen)}
    </div>`;
  const people = `<div class="rp-h">Jockey and trainer</div><div class="rp-short">
      ${cell("Jockey", d.jockey ? L.person(d.jockey.id, d.jockey.name) : "—")}${cell("Jockey last 50", d.jockey ? rec(d.jockey.last50) : "—")}
      ${gen ? "" : cell("Jockey at this track", d.jockey ? pc(d.jockey.track) : "—") + cell("Jockey at this distance", d.jockey ? pc(d.jockey.distance) : "—")}
      ${cell("Trainer", d.trainer ? L.person(d.trainer.id, d.trainer.name) : "—")}${cell("Trainer last 100", d.trainer ? pc(d.trainer.last100) : "—")}
      ${gen ? "" : cell("Trainer at this track", d.trainer ? pc(d.trainer.track) : "—")}${cell("Trainer with this jockey", d.trainer ? pc(d.trainer.jockey) : "—")}
    </div>`;
  const runs = d.runs || [];
  const speed = (r) => (isNum(r.time) && r.time > 0 && r.distance ? ((r.distance / r.time) * 3.6).toFixed(1) + " km/h" : "—");
  const lastRows = runs.map((r, i) => `<tr class="${i >= 6 ? "more-run" : ""} ${r.rank === 1 ? "win" : ""}" ${i >= 6 ? "hidden" : ""}>
      <td class="nowrap"><b>${ord(r.rank)}</b>${r.runners ? ` <span class="muted">of ${r.runners}</span>` : ""}</td>
      <td class="nowrap">${r.race_id ? L.race(r.race_id, fDate(r.date)) : fDate(r.date)}</td>
      <td>${r.meeting_id ? `<a href="#/meeting/${r.meeting_id}">${esc(r.course || "")}</a>` : esc(r.course || "Historic")}</td>
      <td class="num">${fDist(r.distance)}</td>
      <td>${grade(r.race_type)}</td><td class="num">${fNum(r.gate)}</td>
      <td>${L.person(r.jockey_id, r.jockey)}</td>
      <td>${esc(r.weather || "—")}</td>
      <td class="num">${fTime(r.time)}</td><td class="num">${speed(r)}</td>
      <td class="num">${isNum(r.winner_time) && isNum(r.time) && r.rank > 1 ? "+" + (r.time - r.winner_time).toFixed(2) + "s" : "—"}</td>
      <td class="num">${isNum(r.odds) ? "$" + fNum(r.odds, 2) : "—"}</td><td class="num">${isNum(r.days) ? r.days : "—"}</td>
      <td class="num">${fMoneyShort(r.purse)}</td><td class="num">${fMoney(r.prize_won)}</td>
      <td class="small">${(r.top3 || []).map((t) => `${t.rank}. ${t.id === h.id ? `<b>${esc(t.name)}</b>` : L.horse(t.id, t.name)}`).join("&nbsp; ")}</td></tr>`).join("");
  const last = `<div class="rp-h">Last starts <span class="muted small">· ${isNum(sf.days_since) ? sf.days_since + " days since last start" : "no starts yet"}</span></div>
    ${runs.length ? `<div class="tbl-wrap"><table class="data rp-runs"><thead><tr><th>Place</th><th>Date</th><th>Track</th><th class="num">Distance</th><th>Class</th><th class="num">Barrier</th>
      <th>Jockey</th><th>Cond.</th><th class="num">Race time</th><th class="num">Avg speed</th><th class="num">Margin</th><th class="num">SP</th><th class="num">Days</th>
      <th class="num">Prize</th><th class="num">Prize won</th><th>Result</th></tr></thead><tbody>${lastRows}</tbody></table></div>
      ${runs.length > 6 ? `<div class="rp-more"><button class="btn" data-morerun>Show all ${runs.length}${d.runs_total > runs.length ? ` of ${d.runs_total}` : ""} starts</button></div>` : ""}` : '<div class="empty">No previous starts.</div>'}`;
  let byDist = "";
  if (opts.byDistance) {
    const groups = {};
    for (const r of opts.byDistance) {
      if (!isNum(r.distance) || !isNum(r.rank)) continue;
      const k = Math.round(r.distance / 100) * 100;
      const g = (groups[k] = groups[k] || [0, 0, 0, 0]);
      g[0]++; if (r.rank <= 3) g[r.rank]++;
    }
    const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const nextK = isNum(race.distance) ? Math.round(race.distance / 100) * 100 : null;
    const pcts = (g) => `<div class="rc-sub">W ${Math.round((100 * g[1]) / g[0])}% · P ${Math.round((100 * (g[1] + g[2] + g[3])) / g[0])}%</div>`;
    byDist = `<div class="rp-h">By distance <span class="muted small">· starts: wins-seconds-thirds at each distance (to the nearest 100 m)${nextK ? " · highlighted = next start's distance" : ""}</span></div>
      <div class="rp-short">${keys.length ? keys.map((k) => cell(fDist(k), rec(groups[k]) + pcts(groups[k]), k === nextK)).join("") : '<div class="empty">No starts yet.</div>'}</div>`;
  }
  if (opts.noRuns) return top + short + byDist + (opts.noPeople ? "" : people);
  return top + short + people + last + `<div class="rp-actions"><a class="btn" href="#/horse/${h.id}">Horse page &amp; full form</a><a class="btn" href="#/pedigree/${h.id}">Family tree</a></div>`;
}
let RUNNER_BOUND = false;
function bindRunnerToggles(root) {
  if (RUNNER_BOUND) return;
  RUNNER_BOUND = true;
  root.addEventListener("click", async (e) => {
    const more = e.target.closest("[data-morerun]");
    if (more) { const panel = more.closest(".rpanel"); $$("tr.more-run", panel).forEach((tr) => (tr.hidden = false)); more.parentNode.remove(); return; }
    const tg = e.target.closest(".rtoggle");
    if (!tg) return;
    const line = tg.closest("tr"), detail = line.nextElementSibling, panel = detail.querySelector(".rpanel");
    detail.hidden = !detail.hidden;
    tg.classList.toggle("open", !detail.hidden);
    tg.textContent = detail.hidden ? "▸" : "▾";
    if (!detail.hidden && !panel.dataset.loaded) {
      panel.dataset.loaded = "1";
      panel.innerHTML = '<div class="muted" style="padding:8px">Loading form…</div>';
      try { panel.innerHTML = renderRunnerPanel(await api(`runner?race=${panel.dataset.race}&horse=${panel.dataset.horse}`)); }
      catch (err) { panel.innerHTML = `<div class="err-box">${esc(err.message)}</div>`; panel.dataset.loaded = ""; }
    }
  });
}

// ------------------------------------------------------------------ races
// the same row of tabs at the top of every list page in a section
const SECTION_TABS = {
  racing: [["meetings", "#/meetings", "Meetings"], ["races", "#/races", "Races"], ["courses", "#/courses", "Racecourses"]],
  horses: [["horses", "#/horses", "All horses"], ["horse-table", "#/horse-table", "Horse table"], ["pedigrees", "#/pedigrees", "Pedigrees"]],
  stables: [["stables", "#/stables", "All stables"], ["stable-table", "#/stable-table", "Stable table"]],
};
function sectionTabs(sec, active) {
  return `<div class="subtabs">${(SECTION_TABS[sec] || []).map(([k, h, t]) => `<a href="${h}" class="${k === active ? "on" : ""}">${t}</a>`).join("")}</div>`;
}
function raceSubTabs(active) { return sectionTabs("racing", active); }
async function racesPage(route) {
  return raceSubTabs("races") + await listPage({
    title: "Races", noun: "races", endpoint: "races", defaultSort: "date", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search by race name") +
      seg("when", q, [["past", "Results"], ["upcoming", "Upcoming"], ["all", "All"]], "past") +
      select("type", q, [["", "Any type"], ["G1", "Group 1"], ["G2", "Group 2"], ["G3", "Group 3"], ["listed", "Listed"], ["stakes", "Stakes"], ["open", "Open"], ["allowance", "Allowance"], ["juvenile", "Juvenile"], ["maiden", "Maiden"], ["maiden_2yo", "Maiden 2yo"]]) +
      (q.course ? `<span class="chip">Course #${esc(q.course)} <a href="${hashFor(["races"], { ...q, course: "" })}">✕</a></span>` : ""),
    cols: [
      { h: "Date", sort: "date", cls: "nowrap", f: (r) => fDateTime(r.race_time) },
      { h: "Race", sort: "name", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
      { h: "Course", f: (r) => L.course(r.course_id, r.course) },
      { h: "Distance", sort: "distance", cls: "num", f: (r) => fDist(r.distance) },
      { h: "Purse", sort: "purse", cls: "num", f: (r) => fMoney(r.purse) },
      { h: "Winner", f: (r) => L.horse(r.winner_id, r.winner_name, '<span class="muted">—</span>') },
    ],
  }, route);
}

// Track condition. The save has no going rating, so it is worked out from the race-day weather and rain
// (NZ / Australian 1-10 scale on turf; dirt uses Fast / Good / Muddy / Sloppy; synthetic tracks drain).
function trackCondition(day, surface) {
  const w = day && day.raceday_weather_condition;
  if (!w) return null;
  const rain = day.raceday_rain_intensity || 0, hum = day.raceday_humidity || 0;
  if (surface === "Synthetic") return { word: "Synthetic", n: null };
  let n;
  if (w === "Sunny") n = hum < 35 ? 2 : 3;
  else if (w === "Cloudy" || w === "Foggy") n = 4;
  else if (w === "Rainy") n = rain < 25 ? 5 : rain < 50 ? 6 : rain < 75 ? 7 : 8;
  else if (w === "Snowy") n = rain < 50 ? 7 : 9;
  else if (w === "Stormy") n = rain < 40 ? 7 : rain < 70 ? 9 : 10;
  else n = 4;
  if (surface === "Dirt") return { word: n <= 4 ? "Fast" : n <= 6 ? "Good" : n <= 8 ? "Muddy" : "Sloppy", n: null };
  return { word: n <= 2 ? "Firm" : n <= 4 ? "Good" : n <= 7 ? "Soft" : "Heavy", n };
}
function conditionTile(day, surface) {
  const tc = trackCondition(day, surface);
  if (!tc) return ["Track condition", "—"];
  const rain = day.raceday_rain_intensity;
  const cls = { Firm: "tc-firm", Good: "tc-good", Fast: "tc-good", Soft: "tc-soft", Muddy: "tc-soft", Heavy: "tc-heavy", Sloppy: "tc-heavy", Synthetic: "tc-syn" }[tc.word] || "";
  return ["Track condition", `<span class="tc ${cls}">${tc.word}${tc.n ? " " + tc.n : ""}</span>`,
    `${surface ? esc(surface) + " · " : ""}from ${esc(day.raceday_weather_condition)}${rain ? `, rain ${fNum(rain, 0)}%` : ""}`];
}

// Sectionals: the save records each runner at 25%, 50%, 75% and 90% of the trip and at the finish
const SEC_NAMES = ["1st quarter", "2nd quarter", "3rd quarter", "75–90%", "Final 10%"];
function secBounds(dist) {
  const pts = [0, 0.25, 0.5, 0.75, 0.9, 1].map((p) => Math.round(p * dist));
  return [1, 2, 3, 4, 5].map((k) => [pts[k - 1], pts[k]]);
}
function sectionalsPanel(list, dist) {
  return panel("Sectionals", fastestSections(list, dist) + sectionalsTable(list, dist), SEC_NOTE);
}
const SEC_NOTE = `Time for each section in seconds · under it: position and distance behind the leader at the end of that section, and average speed · Top speed = the runner's fastest section speed · <span class="sec-best">purple</span> = fastest in the race · click a heading to sort`;
const secSplit = (x, k) => (k === 1 ? x.t1 : isNum(x["t" + k]) && isNum(x["t" + (k - 1)]) ? x["t" + k] - x["t" + (k - 1)] : null);
// one line per section: who ran it fastest
function fastestSections(list, dist) {
  const D = list[0].d5 || dist, b = secBounds(D);
  const cells = [1, 2, 3, 4, 5].map((k) => {
    let best = null;
    for (const x of list) { const v = secSplit(x, k); if (isNum(v) && v > 0 && (!best || v < best.v)) best = { v, x }; }
    if (!best) return "";
    const m = b[k - 1][1] - b[k - 1][0];
    return `<div class="fs"><div class="l">${SEC_NAMES[k - 1]} <span class="muted">${fNum(b[k - 1][0])}–${fNum(b[k - 1][1])} m</span></div>
      <div class="v"><span class="sec-best">${best.v.toFixed(2)}</span> ${L.horse(best.x.horse_id, best.x.horse)}</div>
      <div class="s">${((m / best.v) * 3.6).toFixed(1)} km/h · finished ${ord(best.x.rank)}</div></div>`;
  });
  let late = null;
  for (const x of list) { if (isNum(x.t5) && isNum(x.t2) && (!late || x.t5 - x.t2 < late.v)) late = { v: x.t5 - x.t2, x }; }
  let tops = null;
  for (const x of list) { const t = topSpeed(x, D); if (t && (!tops || t.kmh > tops.t.kmh)) tops = { t, x }; }
  if (tops) cells.push(`<div class="fs"><div class="l">Top speed <span class="muted">${SEC_NAMES[tops.t.k - 1]}</span></div>
      <div class="v"><span class="sec-best">${tops.t.kmh.toFixed(1)} km/h</span> ${L.horse(tops.x.horse_id, tops.x.horse)}</div><div class="s">fastest section speed in the race · finished ${ord(tops.x.rank)}</div></div>`);
  if (late) cells.push(`<div class="fs"><div class="l">Last 50% <span class="muted">${fNum(Math.round(D / 2))}–${fNum(D)} m</span></div>
      <div class="v"><b>${late.v.toFixed(2)}</b> ${L.horse(late.x.horse_id, late.x.horse)}</div><div class="s">${((D / 2 / late.v) * 3.6).toFixed(1)} km/h · finished ${ord(late.x.rank)}</div></div>`);
  return `<div class="rp-h" style="margin-top:0">Fastest sections</div><div class="fastest">${cells.join("")}</div>`;
}
// Top speed: the fastest average speed the runner held over any one section of the race
// (the save records each runner at 25%, 50%, 75%, 90% and the finish, so this is the best sectional speed).
function topSpeed(x, D) {
  const b = secBounds(D);
  let best = null;
  for (let k = 1; k <= 5; k++) {
    const v = secSplit(x, k);
    if (!isNum(v) || v <= 0) continue;
    const kmh = ((b[k - 1][1] - b[k - 1][0]) / v) * 3.6;
    if (!best || kmh > best.kmh) best = { kmh, k };
  }
  return best;
}
function sectionalsTable(list, dist) {
  const D = list[0].d5 || dist, b = secBounds(D);
  const split = secSplit;
  const best = [1, 2, 3, 4, 5].map((k) => Math.min(...list.map((x) => split(x, k)).filter((v) => isNum(v) && v > 0)));
  const kmh = (m, sec) => (sec > 0 ? ((m / sec) * 3.6).toFixed(1) : "—");
  const lead = (x, k) => (x["r" + k] === 1 ? "led" : isNum(x["m" + k]) ? `+${fNum(x["m" + k], 1)} m` : "");
  const topBest = Math.max(...list.map((x) => (topSpeed(x, D) || { kmh: -1 }).kmh));
  const cols = [
    { h: "Fin", f: (x) => pos(x.rank) },
    { h: "Horse", f: (x) => `${L.horse(x.horse_id, x.horse)}${isNum(x.gate) ? ` <span class="muted small">(${x.gate})</span>` : ""}` },
  ].concat([1, 2, 3, 4, 5].map((k) => ({
    h: `${SEC_NAMES[k - 1]}<div class="sec-m">${fNum(b[k - 1][0])}–${fNum(b[k - 1][1])} m</div>`, cls: "num sec",
    f: (x) => {
      const v = split(x, k);
      if (!isNum(v)) return "—";
      return `<span class="${Math.abs(v - best[k - 1]) < 1e-6 ? "sec-best" : ""}">${v.toFixed(2)}</span>
        <div class="sec-sub">${ord(x["r" + k])}${lead(x, k) ? " · " + lead(x, k) : ""} · ${kmh(b[k - 1][1] - b[k - 1][0], v)} km/h</div>`;
    },
  }))).concat([
    { h: "Finish time", cls: "num", f: (x) => `<b>${fTime(x.t5)}</b>` },
    { h: `<span title="Fastest average speed this runner held over any one section of the race">Top speed</span><div class="sec-m">and where</div>`, cls: "num",
      f: (x) => { const t = topSpeed(x, D); return t ? `<span class="${Math.abs(t.kmh - topBest) < 1e-6 ? "sec-best" : ""}">${t.kmh.toFixed(1)} km/h</span><div class="sec-sub">${SEC_NAMES[t.k - 1]}</div>` : "—"; } },
    { h: "Last 50% <div class=\"sec-m\">late speed</div>", cls: "num", f: (x) => (isNum(x.t5) && isNum(x.t2) ? `${(x.t5 - x.t2).toFixed(2)}<div class="sec-sub">${kmh(D / 2, x.t5 - x.t2)} km/h</div>` : "—") },
    { h: `<span title="The game's own speed reading as the horse crossed the line">Speed at finish</span>`, cls: "num", f: (x) => (isNum(x.v5) ? `${(x.v5 * 3.6).toFixed(1)} km/h` : "—") },
  ]);
  return `<div class="rp-h">All runners</div>` + table(cols, list, { wide: true });
}
function sectionRecordsPanel(d, c) {
  const recs = d.section_records || [];
  if (!recs.length) return panel("Sectional records", '<div class="empty">No sectional times recorded here yet.</div>');
  const groups = [], byKey = {};
  recs.forEach((r) => {
    const k = r.track + "|" + r.distance;
    if (!byKey[k]) { byKey[k] = { track: r.track, distance: r.distance, secs: {}, runs: 0 }; groups.push(byKey[k]); }
    byKey[k].secs[r.sec] = r; byKey[k].runs = Math.max(byKey[k].runs, r.runs || 0);
  });
  groups.sort((a, b) => a.distance - b.distance || String(a.track).localeCompare(String(b.track)));
  const surface = (t) => { const v = c[TRACK_SURFACE_COL[t]]; return v ? ` <span class="muted small">${esc(v)}</span>` : ""; };
  const cell = (g, k) => {
    const r = g.secs[k];
    if (!r) return '<span class="muted">—</span>';
    const [a, b] = secBounds(g.distance)[k - 1];
    return `<b>${r.time.toFixed(2)}</b> <span class="muted small">${((b - a) / r.time * 3.6).toFixed(1)} km/h</span>
      <div class="sec-sub">${L.horse(r.horse_id, r.horse)} · ${L.race(r.race_id, fDate(r.date))}</div>`;
  };
  return panel("Sectional records", table([
    { h: "Distance", cls: "nowrap", f: (g) => `<b>${fDist(g.distance)}</b>` },
    { h: "Track", cls: "nowrap", f: (g) => `${esc(g.track || "—")}${surface(g.track)}` },
  ].concat([1, 2, 3, 4, 5].map((k) => ({ h: SEC_NAMES[k - 1], cls: "sec", f: (g) => cell(g, k) }))).concat([
    { h: "Runs timed", cls: "num", f: (g) => fNum(g.runs) },
  ]), groups, { wide: true }), "Fastest time ever run for each section at each distance, and the horse that ran it · sections are 0–25%, 25–50%, 50–75%, 75–90% and the final 10% of the trip");
}

async function racePage(id) {
  const d = await api("race/" + id);
  const r = d.race, day = d.day || {};
  const res = d.results || [];
  const winTime = res.length && isNum(res[0].time) ? res[0].time : null;
  let html = `<div class="page-head"><div><div class="crumb"><a href="#/races">Races</a></div>
    <h1>${esc(r.races_race_name || "Race")} ${grade(r.races_type_of_race)}</h1>
    <div class="sub">${fDateTime(r.races_race_date_time)} · ${d.course ? L.course(d.course.id, d.course.name) : "—"}${d.course && d.course.country ? ", " + esc(d.course.country) : ""}
    · Race ${fNum(r.races_race_number)} · ${fDist(r.races_distance)} ${esc(r.races_track || "")}</div></div></div>`;
  html += tiles([
    ["Purse", fMoney(r.races_prize_money_total)],
    ["Runners", fNum(res.length || (d.entries || []).length)],
    ["Weather", esc(day.raceday_weather_condition || "—"), isNum(day.raceday_temperature) ? `${fNum(day.raceday_temperature, 1)}°C · wind ${fNum(day.raceday_wind_speed, 0)} km/h` : ""],
    ["Winning time", fTime(winTime)],
    ["Crowd", day.raceday_capacity ? fNum((day.raceday_vip_sold || 0) + (day.raceday_normal_sold || 0) + (day.raceday_standing_sold || 0)) : "—", day.raceday_capacity ? `Capacity ${fNum(day.raceday_capacity)}` : ""],
    conditionTile(day, d.surface),
  ]);
  const rinfo = { race_id: r.races_race_id, race_time: r.races_race_date_time };
  const openAll = `<button class="btn" data-openall>Open all form</button>`;
  html += res.length ? panel("Result", runnerTable(rinfo, res, "results"), `Click ▸ for a runner's form · ${openAll}`)
    : panel("Field", runnerTable(rinfo, d.entries || [], "entries"), `Form is up to the day before the race · click ▸ for a runner's form · ${openAll}`);
  if ((d.sectionals || []).length) html += `<div style="margin-top:16px">${sectionalsPanel(d.sectionals, r.races_distance)}</div>`;
  const prizes = [1, 2, 3, 4, 5].map((i) => [ord(i), fMoney(r["races_prize_money_" + i])]);
  html += `<div class="grid cols-3" style="margin-top:16px">
    ${panel("Conditions", kv([
      ["Type", grade(r.races_type_of_race) || "—"], ["Sex", esc(r.races_gender_restriction || "Open")], ["Breed", esc(r.races_breed_restriction || "Open")],
      ["Min rating", fNum(r.races_min_rating)], ["Maiden only", r.races_maiden_only ? "Yes" : "No"], ["Max runners", fNum(r.races_max_participants)],
      ["Entry fee", fMoney(r.races_entrance_fee)], ["Track", esc(r.races_track || "—")],
    ]))}
    ${panel("Prize money", kv(prizes.concat(r.races_prize_money_bonus_winner ? [["Winner bonus", fMoney(r.races_prize_money_bonus_winner)]] : [])))}
    ${panel("Race card", table([
      { h: "#", f: (x) => fNum(x.number) },
      { h: "Time", cls: "nowrap", f: (x) => { const t = new Date(x.time * 1000); return isNum(x.time) ? `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}` : "—"; } },
      { h: "Race", f: (x) => (String(x.id) === String(id) ? `<b>${esc(x.name)}</b>` : L.race(x.id, x.name)) + " " + grade(x.race_type) },
    ], d.card))}</div>`;
  const hist = d.history || [];
  const pastW = hist.filter((x) => x.winner_id);
  const upcoming = hist.filter((x) => !x.winner_id && isNum(x.date) && x.date > GD()).sort((a, b) => a.date - b.date);
  if (pastW.length) {
    html += `<div style="margin-top:16px">${panel("Past winners", table([
      { h: "Date", cls: "nowrap", f: (x) => L.race(x.race_id, fDate(x.date)) },
      { h: "Winner", f: (x) => L.horse(x.winner_id, x.winner) },
      { h: "Jockey", f: (x) => L.person(x.jockey_id, x.jockey) },
      { h: "Stable", f: (x) => L.stable(x.stable_id, x.stable) },
      { h: "Distance", cls: "num", f: (x) => fDist(x.distance) },
      { h: "Type", f: (x) => grade(x.race_type) },
      { h: "Time", cls: "num", f: (x) => fTime(x.time) },
      { h: "Prize", cls: "num", f: (x) => fMoney(x.prize) },
    ], pastW, { rowClass: (x) => (x.jockey_id === (STATUS.player || {}).id ? "me" : "") }), `${pastW.length} other running${pastW.length === 1 ? "" : "s"} of this race`)}</div>`;
  }
  if (upcoming.length) {
    html += `<div style="margin-top:16px">${panel("Coming up", `<div class="chips">${upcoming.map((x) => `<span class="chip">${L.race(x.race_id, fDate(x.date))}</span>`).join("")}</div>`, "Future runnings already scheduled")}</div>`;
  }
  html += `<div style="margin-top:16px">${allFields(r)}</div>`;
  return html;
}

// ------------------------------------------------------------------ meetings
async function meetingsPage(route) {
  return raceSubTabs("meetings") + await listPage({
    title: "Meetings", noun: "meetings", endpoint: "meetings", defaultSort: "date", ascDefault: ["course", "name"],
    filters: (q, data) => searchBox(q, "Search meeting or course") +
      seg("when", q, [["past", "Results"], ["upcoming", "Upcoming"], ["all", "All"]], "past") +
      select("country", q, [["", "Any country"]].concat((data.countries || []).map((c) => [c, c]))) +
      select("group", q, [["", "All meetings"], ["1", "With a Group race"]]) +
      (q.course ? `<span class="chip">Course #${esc(q.course)} <a href="${hashFor(["meetings"], { ...q, course: "" })}">✕</a></span>` : ""),
    cols: [
      { h: "Date", sort: "date", cls: "nowrap", f: (r) => fDate(r.date) },
      { h: "Meeting", sort: "name", f: (r) => `<a href="#/meeting/${r.id}"><b>${esc(r.name || "Race meeting")}</b></a>` },
      { h: "Racecourse", sort: "course", f: (r) => `${L.course(r.course_id, r.course)} <span class="muted small">${esc(r.country || "")}</span>` },
      { h: "Races", sort: "races", cls: "num", f: (r) => fNum(r.races) },
      { h: "Top race", f: (r) => (r.top_race_id ? `${grade(r.top_grade)} ${L.race(r.top_race_id, r.top_race_name)}` : '<span class="muted">—</span>') },
      { h: "Prize money", sort: "purse", cls: "num", f: (r) => fMoneyShort(r.purse) },
      { h: "Weather", f: (r) => `${esc(r.weather || "")}${isNum(r.temp) ? ` <span class="muted small">${fNum(r.temp, 0)}°</span>` : ""}` },
      { h: "Crowd", cls: "num", f: (r) => (r.crowd ? fNum(r.crowd) : "—") },
    ],
  }, route);
}

async function meetingPage(id) {
  const d = await api("meeting/" + id);
  const day = d.day, c = d.course || {};
  const races = d.races || [];
  const purse = races.reduce((a, r) => a + (r.purse || 0), 0);
  const crowd = (day.raceday_vip_sold || 0) + (day.raceday_normal_sold || 0) + (day.raceday_standing_sold || 0);
  const hm = (t) => { const x = new Date(t * 1000); return isNum(t) ? `${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}` : "—"; };
  const nav = `<div style="display:flex;gap:8px">${d.prev_meeting ? `<a class="btn" href="#/meeting/${d.prev_meeting.id}" title="Previous meeting at this course">‹ ${fDate(d.prev_meeting.date)}</a>` : ""}
    ${d.next_meeting ? `<a class="btn" href="#/meeting/${d.next_meeting.id}" title="Next meeting at this course">${fDate(d.next_meeting.date)} ›</a>` : ""}</div>`;
  let html = raceSubTabs("meetings") + `<div class="page-head"><div><div class="crumb"><a href="#/meetings">Meetings</a></div>
    <h1>${esc(day.raceday_raceseries_name || "Race meeting")}</h1>
    <div class="sub">${fDate(day.raceday_date)} · ${L.course(c.id, c.name)}${c.country ? ", " + esc(c.country) : ""}</div></div>${nav}</div>`;
  html += tiles([
    ["Races", fNum(races.length)], ["Prize money", fMoneyShort(purse)],
    ["Weather", esc(day.raceday_weather_condition || "—"), isNum(day.raceday_temperature) ? `${fNum(day.raceday_temperature, 1)}°C · wind ${fNum(day.raceday_wind_speed, 0)} km/h` : ""],
    ["Crowd", day.raceday_capacity ? fNum(crowd) : "—", day.raceday_capacity ? `Capacity ${fNum(day.raceday_capacity)}` : ""],
    conditionTile(day, c.surface),
  ]);
  html += panel("Races at this meeting", table([
    { h: "Race", f: (r) => `<b>R${fNum(r.number)}</b>` },
    { h: "Time", cls: "nowrap", f: (r) => hm(r.race_time) },
    { h: "Name", f: (r) => `<a href="#" data-goto="race-${r.race_id}">${esc(r.race_name)}</a> ${grade(r.race_type)}` },
    { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    { h: "Prize money", cls: "num", f: (r) => fMoney(r.purse) },
    { h: "Runners", cls: "num", f: (r) => fNum((r.results.length || (r.entries || []).length)) },
    { h: "Winner", f: (r) => { const w = r.results.find((x) => x.rank === 1); return w ? `${L.horse(w.horse_id, w.horse)} <span class="muted small">${esc(w.jockey || "")}</span>` : '<span class="muted">Not run yet</span>'; } },
  ], races), "Click a race name to jump to it");
  for (const r of races) {
    const res = r.results || [];
    let body = runnerTable({ race_id: r.race_id, race_time: r.race_time }, res.length ? res : r.entries || [], res.length ? "results" : "entries");
    if ((r.sectionals || []).length) body += `<details class="secbox" open><summary>Sectionals <span class="muted small">· fastest sections and every runner's splits</span></summary>
      ${fastestSections(r.sectionals, r.distance)}${sectionalsTable(r.sectionals, r.distance)}<div class="help" style="margin-top:6px">${SEC_NOTE}</div></details>`;
    html += `<div style="margin-top:16px" id="race-${r.race_id}">` + panel(`R${fNum(r.number)} · ${hm(r.race_time)} · ${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}`,
      body, `${fDist(r.distance)} ${esc(r.track || "")} · ${fMoney(r.purse)} · <a href="#/race/${r.race_id}">Race page</a>`) + `</div>`;
  }
  return html;
}
meetingPage.after = () => {
  $$("[data-goto]", APP).forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const el = document.getElementById(a.dataset.goto);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 110, behavior: "smooth" });
  }));
};

async function stableRacesPage(route) {
  const id = route.parts[1], q = route.q;
  const d = await api(`stable_races/${id}?` + new URLSearchParams(withSize(q)));
  const rec = d.record || {};
  const sort = q.sort || "date", dir = q.dir || "desc";
  let html = myStableBar(d.stable.id, "/races") + `<div class="page-head"><div><div class="crumb"><a href="#/stables">Stables</a> · ${L.stable(d.stable.id, d.stable.name)}</div>
    <h1>Every race · ${esc(d.stable.name)}</h1><div class="sub">${fNum(d.total)} ${Object.keys(q).some((k) => ["q", "type", "result", "year"].includes(k) && q[k]) ? "matching " : ""}runs</div></div>
    <div style="display:flex;gap:8px"><a class="btn" href="#/stable/${id}">Stable page</a>
    <a class="btn btn-csv" href="/api/export/stable_races?${new URLSearchParams({ ...q, stable: id })}" download data-tip="Download every matching race as a spreadsheet (CSV) file">${ICON_DL}Export CSV</a></div></div>`;
  html += tiles([
    ["Starts", fNum(rec.starts || 0)], ["Wins", fNum(rec.wins || 0), `Strike rate ${pct(rec.wins, rec.starts)}`],
    ["2nds · 3rds", `${fNum(rec.seconds || 0)} · ${fNum(rec.thirds || 0)}`],
    ["G1 · G2 · G3 · Listed", `${fNum(rec.g1 || 0)} · ${fNum(rec.g2 || 0)} · ${fNum(rec.g3 || 0)} · ${fNum(rec.listed || 0)}`],
    ["Total stakes won", fMoneyShort(rec.prize || 0)],
  ]);
  const filters = searchBox(q, "Search horse or race") + seg("result", q, [["", "All runs"], ["wins", "Wins"], ["placed", "Placed (1st–3rd)"]], "") +
    select("type", q, [["", "Any race type"], ["G1", "Group 1"], ["G2", "Group 2"], ["G3", "Group 3"], ["listed", "Listed"], ["stakes", "Stakes"], ["open", "Open"], ["allowance", "Allowance"], ["juvenile", "Juvenile"], ["maiden", "Maiden"], ["maiden_2yo", "Maiden 2yo"]]) +
    select("year", q, [["", "Every year"]].concat((d.years || []).map((y) => [String(y), String(y)])));
  html += `<section class="panel"><div class="filters">${filters}</div>${table([
    { h: "Date", sort: "date", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", sort: "race", f: (r) => `${L.race(r.race_id, r.race_name, '<span class="muted">Historic race</span>')} ${grade(r.race_type)}` },
    { h: "Meeting", f: (r) => (r.meeting_id ? `<a href="#/meeting/${r.meeting_id}">${esc(r.course || "Meeting")}</a>` : L.course(r.course_id, r.course)) },
    { h: "Distance", sort: "distance", cls: "num", f: (r) => fDist(r.distance) },
    { h: "Horse", sort: "horse", f: (r) => L.horse(r.horse_id, r.horse) },
    { h: "Jockey", sort: "jockey", f: (r) => L.person(r.jockey_id, r.jockey) },
    { h: "Pos", sort: "rank", f: (r) => pos(r.rank, r.runners) },
    { h: "Time", cls: "num", f: (r) => fTime(r.time) },
    { h: "Odds", cls: "num", f: (r) => (isNum(r.odds) ? `<span class="box">${fNum(r.odds, 1)}</span>` : "—") },
    { h: "Prize", sort: "prize", cls: "num", f: (r) => fMoney(r.prize) },
  ], d.rows, { sort, dir, ascCols: ["horse", "race", "jockey", "rank"], rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No runs match." })}${pager(d)}</section>`;
  return html;
}

// ------------------------------------------------------------------ stables
async function stablesPage(route) {
  return listPage({
    title: "Stables", noun: "stables", endpoint: "stables", defaultSort: "prestige", ascDefault: ["name"], wide: true,
    filters: (q) => searchBox(q, "Search by name") + seg("status", q, [["active", "Active"], ["all", "Include closed"]], "active"),
    cols: [
      { h: "Stable", sort: "name", f: (r) => `${L.stable(r.id, r.name)}${r.liquidated ? ' <span class="badge dead">Closed</span>' : ""}${r.id === (STATUS.player_stable || {}).id ? ' <span class="badge good">Yours</span>' : ""}` },
      { h: "Owner", f: (r) => L.person(r.owner_id, r.owner) },
      { h: "Horses", sort: "horses", cls: "num", f: (r) => fNum(r.horses) },
      { h: "Starts", sort: "starts", cls: "num grp-start", f: (r) => fNum(r.starts) },
      { h: "Wins", sort: "wins", cls: "num", f: (r) => fNum(r.wins) },
      { h: "2nds", sort: "seconds", cls: "num", f: (r) => fNum(r.seconds) },
      { h: "3rds", sort: "thirds", cls: "num", f: (r) => fNum(r.thirds) },
      { h: "Win %", sort: "winpct", cls: "num", f: (r) => pct(r.wins, r.starts) },
      { h: "G1", sort: "g1", cls: "num grp-start", f: (r) => fNum(r.g1) },
      { h: "G2", sort: "g2", cls: "num", f: (r) => fNum(r.g2) },
      { h: "G3", sort: "g3", cls: "num", f: (r) => fNum(r.g3) },
      { h: "Listed", sort: "listed", cls: "num", f: (r) => fNum(r.listed) },
      { h: "Stakes won", sort: "prize", cls: "num grp-start", f: (r) => fMoney(r.prize) },
      { h: "Level", cls: "num grp-start", f: (r) => fNum(r.level) },
      { h: "Prestige", sort: "prestige", cls: "num", f: (r) => fNum(r.prestige, 1) },
      { h: "Founded", sort: "founded", cls: "nowrap", f: (r) => fDate(r.founded) },
    ],
  }, route);
}

// the heading and tabs shared by a stable's Overview and Financials tabs
function stableHead(d, on) {
  const s = d.stable, id = s.stable_stable_id;
  return myStableBar(id, on === "overview" ? "" : "/" + on) + `<div class="page-head"><div><div class="crumb"><a href="#/stables">Stables</a></div>
    <h1>${esc(s.stable_name)} ${s.stable_liquidated ? '<span class="badge dead">Closed</span>' : ""}${removedBadge(d)}</h1>
    <div class="sub">Owner ${d.owner ? L.person(d.owner.id, d.owner.name) : "—"}${d.city ? ` · ${esc(d.city.city)}, ${esc(d.city.country)}` : ""} · Founded ${fDate(s.stable_founded_date)}</div>${removedNote(d)}</div>
    <div style="display:flex;gap:8px"><a class="btn primary" href="#/stable/${id}/races">Every race</a><a class="btn" href="#/horses?stable=${id}&status=all">All horses ever</a></div></div>
    <div class="subtabs"><a href="#/stable/${id}" class="${on === "overview" ? "on" : ""}">Overview</a><a href="#/stable/${id}/financials" class="${on === "financials" ? "on" : ""}">Financials</a><a href="#/stable/${id}/horse-money" class="${on === "horse-money" ? "on" : ""}">Horse finances</a></div>`;
}
// the stable's money charts (moved here from the Overview tab in 10.2): same data, now on a log scale
const STABLE_LOG = { scale: "symlog", logC: 1000, yFmt: fMoneyShort, tipFmt: fMoney };

async function stablePage(id) {
  const d = await api("stable/" + id);
  const s = d.stable, lf = d.latest_finance || {};
  let html = stableHead(d, "overview");
  html += tiles([
    ["Cash", fMoneyShort(lf.snapshot_cash)], ["Net worth", fMoneyShort(lf.snapshot_net_worth)],
    ["Horses", fNum(d.horses.length), `Capacity ${fNum(s.stable_horse_capacity)}`], ["Staff", fNum(d.staff.length)],
    ["Prestige", fNum(s.stable_prestige, 1)], ["Share price", isNum(lf.snapshot_share_price) ? "$" + fNum(lf.snapshot_share_price, 2) : "—"],
  ]);
  const rec = d.record || {};
  html += `<h3 style="margin:4px 0 8px">All-time race record</h3>` + tiles([
    ["Starts", fNum(rec.starts || 0)],
    ["Wins", fNum(rec.wins || 0), `Strike rate ${pct(rec.wins, rec.starts)}`],
    ["2nds", fNum(rec.seconds || 0)],
    ["3rds", fNum(rec.thirds || 0)],
    ["Group & Listed wins", `${fNum(rec.g1 || 0)} · ${fNum(rec.g2 || 0)} · ${fNum(rec.g3 || 0)} · ${fNum(rec.listed || 0)}`, "G1 · G2 · G3 · Listed"],
    ["Total stakes won", fMoneyShort(rec.prize || 0), rec.prize ? fMoney(rec.prize) : ""],
  ]);
  html += `<div style="margin-top:16px">${panel("Horses", table([
    { h: "Horse", f: (r) => L.horse(r.id, r.name) }, { h: "Age", cls: "num", f: (r) => fNum(age(r.birth)) }, { h: "Sex", f: (r) => esc(r.gender) },
    { h: "Rating", cls: "num", f: (r) => fNum(r.rating) }, { h: "Form", f: (r) => esc(r.form || "") }, { h: "G1", cls: "num", f: (r) => fNum(r.g1) },
    { h: "Condition", cls: "num", f: (r) => fNum(r.condition) + "%" }, { h: "Value", cls: "num", f: (r) => fMoneyShort(r.value) },
    { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
  ], d.horses, { empty: "No horses." }))}</div>`;
  const breakdown = Object.entries(lf).filter(([k, v]) => /^snapshot_(income|expense)_/.test(k) && !/_total$/.test(k) && isNum(v) && v !== 0)
    .map(([k, v]) => [esc(k.replace("snapshot_", "").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())), fMoney(v)]);
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Staff", table([
    { h: "Role", f: (r) => esc(r.role) }, { h: "Name", f: (r) => L.person(r.id, r.name) }, { h: "Since", cls: "nowrap", f: (r) => fDate(r.start) },
    { h: "Salary", cls: "num", f: (r) => fMoney(r.salary) },
  ], d.staff, { empty: "No staff." }))}
    ${panel("Latest month", breakdown.length ? kv(breakdown) : '<div class="empty">No figures.</div>', lf.snapshot_date ? fDate(lf.snapshot_date) : "")}
    ${panel("Top shareholders", table([
      { h: "Investor", f: (r) => L.person(r.id, r.name) }, { h: "Shares", cls: "num", f: (r) => fNum(r.shares) },
      { h: "Stake", cls: "num", f: (r) => (s.stable_total_shares ? ((100 * r.shares) / s.stable_total_shares).toFixed(1) + "%" : "—") },
    ], d.investors, { empty: "No shareholders." }))}
    ${d.courses && d.courses.length ? panel("Racecourses owned", d.courses.map((c) => L.course(c.id, c.name)).join("<br>")) : ""}</div>`;
  html += `<div style="margin-top:16px">
    ${panel("Recent results", table([
      { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) }, { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
      { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name, '<span class="muted">Historic</span>')} ${grade(r.race_type)}` },
      { h: "Jockey", f: (r) => L.person(r.jockey_id, r.jockey) }, { h: "Pos", f: (r) => pos(r.rank) }, { h: "Prize", cls: "num", f: (r) => fMoney(r.prize) },
    ], d.recent_results, { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No results." }), `Last 100 · <a href="#/stable/${s.stable_stable_id}/races">every race</a>`, "tall")}</div>`;
  html += `<div style="margin-top:16px">${allFields(s)}</div>`;
  return html;
}

// ------------------------------------------------------------------ stable financials tab
// category names are the game's own (snapshot_income_* / snapshot_expense_* columns, transaction_category); a few read better reworded
const FIN_LABELS = { "": "Uncategorised", medical_vet: "Medical & vet", horse_trade: "Horse trade", racecourse_ops: "Racecourse operations", breeder_fees: "Breeder fees", breeding_fees: "Breeding fees" };
const finLabel = (k) => FIN_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, " ");
// change on the year before; for expenses a rise is the bad direction, so the colours swap (costUp)
function finChange(cur, prev, costUp = false) {
  if (!isNum(cur) || !isNum(prev) || prev === 0) return '<span class="muted">—</span>';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `<span class="${(p >= 0) !== costUp ? "up" : "down"}">${p >= 0 ? "+" : ""}${fNum(p, 0)}%</span>`;
}
// short amount with the exact one on hover; ▲▼ change badge (for costs, up is the bad direction)
const finAmt = (v, cls = "") => `<span class="amt ${cls}" data-tip="${fMoney(v)}">${fMoneyShort(v)}</span>`;
function finPill(cur, prev, costUp, label) {
  if (!isNum(cur) || !isNum(prev) || prev === 0) return "";
  const pc = ((cur - prev) / Math.abs(prev)) * 100, good = (pc >= 0) !== costUp;
  return `<span class="chg ${good ? "good" : "bad"}" data-tip="${pc >= 0 ? "Up" : "Down"} ${fNum(Math.abs(pc), 0)}% on ${esc(label)} (${fMoney(prev)})">${pc >= 0 ? "▲" : "▼"} ${fNum(Math.abs(pc), 0)}%</span>`;
}
// what a year is compared with: the year before, or for a year still in progress the same months of the year before
function finPrev(years, y) {
  const i = years.indexOf(y), p = years[i - 1];
  if (y.prev_same) {
    const m = y.prev_same.months;
    return { ...y.prev_same, label: `${MONTHS[m[0] - 1]}–${MONTHS[m[m.length - 1] - 1]} ${y.prev_same.year}` };
  }
  if (!p || p.year !== y.year - 1 || y.months < 12) return null;
  return { ...p, label: String(p.year) };
}
// a tiny trend line for one category across the years
function finSpark(vals, color) {
  const n = vals.length;
  if (n < 2) return "";
  const W = 74, H = 22, lo = Math.min(0, ...vals), hi = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [2 + (i * (W - 4)) / (n - 1), H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${pts[n - 1][0].toFixed(1)}" cy="${pts[n - 1][1].toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
}
// Income / Expenses by category: categories down the side (biggest this year first), years across, shaded by size within each row,
// then the trend, the change on the year before and the share of this year's total. "% of year" swaps amounts for shares.
function finYearTable(years, cats, key, totalKey, costUp = false) {
  if (!years.length) return '<div class="empty">No yearly figures.</div>';
  const last = years[years.length - 1], pv = finPrev(years, last);
  const used = cats.filter((c) => years.some((y) => (y[key][c] || 0) !== 0))
    .sort((a, b) => (last[key][b] || 0) - (last[key][a] || 0) || years.reduce((t, y) => t + (y[key][b] || 0) - (y[key][a] || 0), 0));
  if (!used.length) return '<div class="empty">Nothing recorded in any category.</div>';
  const tint = costUp ? "198,40,40" : "30,122,69", color = costUp ? "#c0504d" : "#1f5240";
  const cell = (v, total, rowMax) => {
    const pct = total ? (100 * v) / total : 0;
    const bg = v > 0 && rowMax > 0 ? `background:rgba(${tint},${(0.05 + 0.2 * (v / rowMax)).toFixed(3)})` : "";
    return `<td class="num fc" style="${bg}" data-sv="${v}" data-csv="${v}">${v === 0 ? '<span class="muted">—</span>' :
      `<span class="v-amt" data-tip="${fMoney(v)}">${fMoneyShort(v)}</span><span class="v-pct" data-tip="${fMoney(v)} of ${fMoney(total)}">${fNum(pct, pct < 10 ? 1 : 0)}%</span>`}</td>`;
  };
  const head = `<tr><th>Category</th>${years.map((y) => `<th class="num">${y.year}${y.months < 12 ? ` <span class="fy-part" data-tip="${y.months} of 12 months recorded">${y.months} mo</span>` : ""}</th>`).join("")}
    <th class="fc-trend">Trend</th><th class="num" data-tip="${last.year}${pv ? " vs " + esc(pv.label) : ""}">Change</th><th class="fc-share">Share of ${last.year}</th></tr>`;
  const body = used.map((c) => {
    const vals = years.map((y) => y[key][c] || 0), rowMax = Math.max(...vals);
    const cur = last[key][c] || 0, share = last[totalKey] ? (100 * cur) / last[totalKey] : 0;
    return `<tr><td class="fc-name">${esc(finLabel(c))}</td>${years.map((y) => cell(y[key][c] || 0, y[totalKey], rowMax)).join("")}
      <td class="fc-trend" data-csv="">${finSpark(vals, color)}</td>
      <td class="num" data-sv="${pv && pv[key][c] ? (cur - pv[key][c]) / Math.abs(pv[key][c]) : ""}" data-csv="${pv && pv[key][c] ? fNum((100 * (cur - pv[key][c])) / Math.abs(pv[key][c]), 0) + "%" : ""}">${pv ? finPill(cur, pv[key][c], costUp, pv.label) || '<span class="muted">—</span>' : '<span class="muted">—</span>'}</td>
      <td class="fc-share" data-sv="${share}" data-csv="${fNum(share, 1)}%"><span class="sbar"><i style="width:${Math.max(0, Math.min(100, share)).toFixed(1)}%;background:${color}"></i></span><span class="sval">${cur ? fNum(share, share < 10 ? 1 : 0) + "%" : "—"}</span></td></tr>`;
  }).join("");
  const totals = years.map((y) => y[totalKey]);
  const foot = `<tr class="fin-total"><td>Total</td>${years.map((y, i) => `<td class="num"><span class="amt" data-tip="${fMoney(y[totalKey])}">${fMoneyShort(y[totalKey])}</span>${
    i ? finPill(y[totalKey], (finPrev(years, y) || {})[totalKey], costUp, (finPrev(years, y) || {}).label || "") : ""}</td>`).join("")}
    <td class="fc-trend">${finSpark(totals, color)}</td><td class="num">${pv ? finPill(last[totalKey], pv[totalKey], costUp, pv.label) || "" : ""}</td><td class="fc-share"><span class="sval">100%</span></td></tr>`;
  return `<div class="fc-tools"><div class="seg fc-mode"><button class="on" data-fcmode="amt">Amounts</button><button data-fcmode="pct" data-tip="Each category as a share of that year's total">% of year</button></div>
    <span class="muted small">Darker = a bigger year for that category · click a heading to sort · hover for exact amounts</span></div>
    <div class="tbl-wrap"><table class="data fc-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fcmode]");
  if (!b) return;
  const box = b.closest(".panel");
  box.querySelectorAll("[data-fcmode]").forEach((x) => x.classList.toggle("on", x === b));
  box.querySelector(".fc-table").classList.toggle("pct-mode", b.dataset.fcmode === "pct");
});

async function stableFinancePage(route) {
  const id = route.parts[1], q = route.q;
  const [d, fin] = await Promise.all([api("stable/" + id), api(`stable_finance/${id}?` + new URLSearchParams(q.year ? { year: q.year } : {}))]);
  let html = stableHead(d, "financials");
  const lf = d.latest_finance || {}, monthly = d.finance || [];
  const years = (fin.years || []).map((y) => ({ ...y, net: (y.income_total || 0) - (y.expense_total || 0) }));
  const last = years[years.length - 1], prev = years[years.length - 2];
  if (!years.length && !monthly.length) return html + `<div class="empty">No financial records for this stable.</div>`;
  if (last) html += tiles([
    [`Income ${last.year}`, fMoneyShort(last.income_total), prev ? `${finChange(last.income_total, prev.income_total)} on ${prev.year}` : ""],
    [`Expenses ${last.year}`, fMoneyShort(last.expense_total), prev ? `${finChange(last.expense_total, prev.expense_total, true)} on ${prev.year}` : ""],
    [`Net ${last.year}`, `<span class="${last.net >= 0 ? "up" : "down"}">${fMoneyShort(last.net)}</span>`, last.months < 12 ? `${last.months} months so far` : "Full year"],
    ["Cash", fMoneyShort(lf.snapshot_cash), lf.snapshot_date ? "at " + fDate(lf.snapshot_date) : ""],
    ["Net worth", fMoneyShort(lf.snapshot_net_worth)],
  ]);
  // the two charts that used to be on the Overview tab, with the same data
  html += `<div class="grid cols-2">${panel("Net worth & cash", lineChart([
    { name: "Net worth", points: monthly.map((f) => [f.date, f.net_worth]) }, { name: "Cash", points: monthly.map((f) => [f.date, f.cash]) }], STABLE_LOG))}
    ${panel("Income vs expenses", lineChart([
      { name: "Income", color: "#1f5240", points: monthly.map((f) => [f.date, f.income]) }, { name: "Expenses", color: "#c0504d", points: monthly.map((f) => [f.date, f.expenses]) }], STABLE_LOG), lf.snapshot_date ? "Monthly · latest " + fDate(lf.snapshot_date) : "Monthly")}</div>`;
  const amt = finAmt, pill = finPill;
  const yrRows = years.slice().reverse().map((y) => {
    const pv0 = finPrev(years, y), pv = pv0 && { income: pv0.income_total, expenses: pv0.expense_total, label: pv0.label };
    const margin = y.income_total ? (100 * y.net) / y.income_total : null;
    return `<tr class="${y === last ? "fy-latest" : ""}">
      <td class="fy-year">${y.year}${y.months < 12 ? ` <span class="fy-part" data-tip="Only ${y.months} of 12 months recorded so far${pv ? ` · changes compare with ${esc(pv.label)}` : ""}">${y.months} mo</span>` : ""}</td>
      <td class="num">${amt(y.income_total)}${pv ? pill(y.income_total, pv.income, false, pv.label) : ""}</td>
      <td class="num">${amt(y.expense_total)}${pv ? pill(y.expense_total, pv.expenses, true, pv.label) : ""}</td>
      <td class="num">${amt(y.net, y.net >= 0 ? "pos" : "neg")}${isNum(margin) ? `<span class="fy-margin" data-tip="Net as a share of income">${fNum(margin, 0)}% margin</span>` : ""}</td></tr>`;
  }).join("");
  const yearTable = years.length ? `<div class="tbl-wrap"><table class="data fy"><thead><tr><th>Year</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th></tr></thead>
    <tbody>${yrRows}</tbody></table></div>` : '<div class="empty">No yearly figures.</div>';
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Year by year", yearTable, "▲▼ vs the year before · hover for exact amounts")}
    ${years.length >= 2 ? panel("Income vs expenses by year", lineChart([
      { name: "Income", color: "#1f5240", dots: true, points: years.map((y) => [yearStart(y.year) + 182 * 86400, y.income_total, `${y.year}${y.months < 12 ? ` (${y.months} months)` : ""}`]) },
      { name: "Expenses", color: "#c0504d", dots: true, points: years.map((y) => [yearStart(y.year) + 182 * 86400, y.expense_total]) },
      { name: "Net", color: "#3e6e9e", dash: true, points: years.map((y) => [yearStart(y.year) + 182 * 86400, y.net]) }], { ...STABLE_LOG, ranges: false }), "Each dot is a whole year") : ""}</div>`;
  html += `<div style="margin-top:16px">${panel("Income by category", finYearTable(years, fin.income_cats || [], "income", "income_total"))}</div>
    <div style="margin-top:16px">${panel("Expenses by category", finYearTable(years, fin.expense_cats || [], "expenses", "expense_total", true), "The game's own expense categories · the detail below breaks them down")}</div>`;
  // detail: the transaction log, one year at a time: category → type → each payment
  const det = fin.detail, dys = fin.detail_years || [];
  const pick = dys.length > 1 ? seg("year", { year: String(det ? det.year : "") }, dys.slice().reverse().map((y) => [String(y), String(y)]), String(dys[dys.length - 1])) : "";
  let body;
  if (!det || !det.categories.length) body = (pick ? `<div class="fd-tools">${pick}</div>` : "") + `<div class="empty">${dys.length ? "No payments recorded that year." : "The game hasn't kept individual payments for this stable (older years are only kept as yearly totals)."}</div>`;
  else {
    const payee = (x) => (x.to_type === "person" && x.to_name ? L.person(x.to_id, x.to_name) : x.to_type === "stable" && x.to_name ? L.stable(x.to_id, x.to_name) : esc(finLabel(x.to_type || "—")));
    const bar = (pct, cls) => `<span class="sbar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`;
    const top = det.categories[0];
    // long lists start tidy: only the biggest category is opened out
    const fold = det.categories.reduce((a, c) => a + c.types.length, 0) > 12;
    let rowsHtml = "";
    det.categories.forEach((c, ci) => {
      const cp = det.total ? (100 * c.total) / det.total : 0;
      const shut = fold && ci > 0;
      rowsHtml += `<tr class="fin-cat" data-fcat="${ci}"><td><button class="fin-cg" data-fcat-tg="${ci}" title="Hide or show the types in this category">${shut ? "▸" : "▾"}</button> <b>${esc(finLabel(c.cat))}</b>
        <span class="muted small">${fNum(c.types.length)} type${c.types.length === 1 ? "" : "s"}</span></td>
        <td class="num">${fNum(c.n)}</td><td class="num"><b>${finAmt(c.total)}</b></td><td class="num">${c.n ? finAmt(c.total / c.n) : "—"}</td>
        <td class="fd-share">${bar(cp, "cat")}<span class="sval">${fNum(cp, cp < 10 ? 1 : 0)}%</span></td></tr>`;
      c.types.forEach((t, ti) => {
        const key = `${ci}-${ti}`, tp = c.total ? (100 * t.total) / c.total : 0;
        const search = [t.type, finLabel(c.cat), ...t.items.map((x) => `${x.note || ""} ${x.to_name || ""}`)].join(" ").toLowerCase();
        rowsHtml += `<tr class="fin-type" data-fcat-of="${ci}" data-fsearch="${esc(search)}" ${shut ? "hidden" : ""}><td><button class="fin-tg" data-fin="${key}" title="Show each payment">▸</button> ${esc(t.type || "Other")}</td>
          <td class="num">${fNum(t.n)}</td><td class="num">${finAmt(t.total)}</td><td class="num">${t.n ? finAmt(t.total / t.n) : "—"}</td>
          <td class="fd-share">${bar(tp, "type")}<span class="sval muted">${fNum(tp, 0)}% of ${esc(finLabel(c.cat).toLowerCase())}</span></td></tr>
          <tr class="fin-items" data-fin-row="${key}" hidden><td colspan="5"><table class="data fd-pay nosort"><thead><tr><th>Date</th><th>Paid to</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>
          ${t.items.map((x) => `<tr data-fsearch="${esc(`${x.note || ""} ${x.to_name || ""} ${t.type} ${finLabel(c.cat)}`.toLowerCase())}"><td class="nowrap">${fDate(x.date)}</td><td>${payee(x)}</td><td>${esc(x.note || "")}</td><td class="num">${fMoney(x.amount)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No payments.</td></tr>'}
          </tbody></table>${t.n > t.items.length ? `<div class="muted small">Newest ${fNum(t.items.length)} of ${fNum(t.n)} payments.</div>` : ""}</td></tr>`;
      });
    });
    const nPay = det.categories.reduce((a, c) => a + c.n, 0);
    body = `<div class="fd-summary">
        <div><span class="lbl">Paid out in ${det.year}</span><b>${finAmt(det.total)}</b></div>
        <div><span class="lbl">Payments</span><b>${fNum(nPay)}</b></div>
        <div><span class="lbl">Biggest category</span><b>${esc(finLabel(top.cat))}</b> <span class="muted">${det.total ? fNum((100 * top.total) / det.total, 0) + "%" : ""}</span></div>
      </div>
      <div class="fd-tools">${pick}<input type="search" class="fd-filter" placeholder="Filter by type, note or who was paid…" aria-label="Filter payments">
        <span class="grow"></span><button class="btn sm" data-fd-all="open" data-tip="Show every type in every category">Open all</button><button class="btn sm" data-fd-all="close" data-tip="Fold everything back to the categories">Close all</button></div>
      <div class="fd-none empty" hidden>Nothing matches that filter.</div>
      <div class="tbl-wrap"><table class="data fin-detail nosort"><thead><tr><th>Category / type</th><th class="num">Payments</th><th class="num">Total</th><th class="num">Average</th><th class="fd-share">Share</th></tr></thead>
      <tbody>${rowsHtml}</tbody><tfoot><tr><td>Total paid out</td><td class="num">${fNum(nPay)}</td><td class="num">${finAmt(det.total)}</td><td class="num">${nPay ? finAmt(det.total / nPay) : "—"}</td><td></td></tr></tfoot></table></div>`;
  }
  html += `<div style="margin-top:16px">${panel(`Expense detail${det ? " · " + det.year : ""}`, body,
    "From the game's payment log, so it can differ a little from the monthly totals above · ▸ shows each payment")}</div>`;
  return html;
}
// expense detail: open/close a type's payments, collapse a category, open/close everything, and filter
function fdToggle(b, open) {
  const row = document.querySelector(`[data-fin-row="${b.dataset.fin}"]`);
  if (!row) return;
  row.hidden = !open;
  b.textContent = open ? "▾" : "▸";
  b.title = open ? "Hide the payments" : "Show each payment";
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".fin-tg");
  if (b) { const row = document.querySelector(`[data-fin-row="${b.dataset.fin}"]`); if (row) fdToggle(b, row.hidden); return; }
  const cg = e.target.closest("[data-fcat-tg]");
  if (cg) {
    const ci = cg.dataset.fcatTg, open = cg.textContent === "▸";
    cg.textContent = open ? "▾" : "▸";
    document.querySelectorAll(`tr[data-fcat-of="${ci}"]`).forEach((tr) => {
      tr.hidden = !open;
      const tb = tr.querySelector(".fin-tg");
      if (!open && tb) fdToggle(tb, false);
    });
    return;
  }
  const all = e.target.closest("[data-fd-all]");
  if (all) {
    const open = all.dataset.fdAll === "open";
    document.querySelectorAll(".fin-detail [data-fcat-tg]").forEach((x) => (x.textContent = open ? "▾" : "▸"));
    document.querySelectorAll(".fin-detail tr.fin-type").forEach((tr) => {
      tr.hidden = !open || !!tr.dataset.fhide;
      const tb = tr.querySelector(".fin-tg");
      if (tb && !open) fdToggle(tb, false);
    });
  }
});
document.addEventListener("input", (e) => {
  const f = e.target.closest(".fd-filter");
  if (!f) return;
  const q = f.value.trim().toLowerCase(), panel = f.closest(".panel");
  let any = false;
  panel.querySelectorAll("tr.fin-cat").forEach((cat) => {
    const ci = cat.dataset.fcat;
    let shown = 0;
    panel.querySelectorAll(`tr.fin-type[data-fcat-of="${ci}"]`).forEach((tr) => {
      const hit = !q || tr.dataset.fsearch.includes(q);
      tr.hidden = !hit;
      tr.dataset.fhide = hit ? "" : "1";
      const tb = tr.querySelector(".fin-tg"), items = panel.querySelector(`[data-fin-row="${tb.dataset.fin}"]`);
      // show only the matching payments, and open the type when the match is inside its payments
      let inPay = 0;
      items.querySelectorAll("tbody tr[data-fsearch]").forEach((p) => { const h = !q || p.dataset.fsearch.includes(q); p.hidden = !h; inPay += h ? 1 : 0; });
      fdToggle(tb, !!q && hit && inPay > 0 && !(tr.firstElementChild.textContent.toLowerCase().includes(q)));
      if (hit) shown++;
    });
    cat.hidden = !shown;
    if (shown) { any = true; cat.querySelector("[data-fcat-tg]").textContent = "▾"; }
  });
  panel.querySelector(".fd-none").hidden = any;
});

// ------------------------------------------------------------------ stable horse finances tab
const HM_STATUS = { current: ["In the stable", "good"], sold: ["Sold", ""], died: ["Died", "dead"], left: ["Left", ""] };
function hmBreakdown(book, total, color) {
  const rows = Object.entries(book).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="muted small">Nothing recorded.</div>';
  return `<table class="hm-mini">${rows.map(([k, v]) => { const pc = total ? (100 * v) / total : 0;
    return `<tr><td>${esc(k)}</td><td class="num">${finAmt(v)}</td><td class="hm-bar"><span class="sbar"><i style="width:${Math.max(0, Math.min(100, pc)).toFixed(1)}%;background:${color}"></i></span></td><td class="num muted">${fNum(pc, pc < 10 ? 1 : 0)}%</td></tr>`; }).join("")}</table>`;
}
async function stableHorseMoneyPage(route) {
  const id = route.parts[1];
  const [d, hm] = await Promise.all([api("stable/" + id), api("stable_horse_money/" + id)]);
  let html = stableHead(d, "horse-money");
  const hs = hm.horses || [];
  if (!hs.length) return html + `<div class="empty">This stable hasn't had any horses the save can show money for.</div>`;
  const cur = hs.filter((h) => h.status === "current");
  const sum = (list, k) => list.reduce((a, h) => a + (h[k] || 0), 0);
  const inc = sum(hs, "income"), exp = sum(hs, "expenses"), best = hs.slice().sort((a, b) => b.net - a.net)[0], worst = hs.slice().sort((a, b) => a.net - b.net)[0];
  html += tiles([
    ["Horses", fNum(hs.length), `${fNum(cur.length)} in the stable now · ${fNum(hs.length - cur.length)} in the past`],
    ["Earned by its horses", finAmt(inc), `Current horses ${fMoneyShort(sum(cur, "income"))}`],
    ["Spent on its horses", finAmt(exp), `Current horses ${fMoneyShort(sum(cur, "expenses"))}`],
    ["Net", `<span class="${inc - exp >= 0 ? "up" : "down"}">${fMoneyShort(inc - exp)}</span>`, exp ? `${fNum(((inc - exp) / exp) * 100, 0)}% return on costs` : ""],
    ["Most profitable", best ? L.horse(best.id, best.name) : "—", best ? `Net ${fMoneyShort(best.net)}` : ""],
    ["Costliest", worst && worst.net < 0 ? L.horse(worst.id, worst.name) : "—", worst && worst.net < 0 ? `Net ${fMoneyShort(worst.net)}` : "No horse lost money"],
  ]);
  // what the money is made of, for all horses together
  html += `<div class="grid cols-2">${panel("Income from horses", hmBreakdown(hm.totals.inc, inc, "#1f5240"), "All horses, now and past")}
    ${panel("Spending on horses", hmBreakdown(hm.totals.exp, exp, "#c0504d"), "All horses, now and past")}</div>`;
  // month and year only: start dates are sometimes only known to the year (the game's yearly cost records)
  const my = (ts) => { const d = new Date(ts * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const span = (h) => `${h.from ? my(h.from) : "—"} – ${h.status === "current" ? "now" : h.to ? my(h.to) : "—"}`;
  const status = (h) => { const [t, c] = HM_STATUS[h.status] || [h.status, ""];
    return `<span class="badge ${c}">${t}</span>${h.now_stable ? ` <span class="muted small">now ${L.stable(h.now_stable_id, h.now_stable)}</span>` : ""}${h.bred ? ' <span class="muted small" data-tip="Born at this stable">bred here</span>' : ""}`; };
  const rowsHtml = hs.map((h, i) => {
    const roi = h.expenses ? (100 * h.net) / h.expenses : null;
    const search = `${h.name} ${(HM_STATUS[h.status] || [""])[0]} ${h.now_stable || ""}`.toLowerCase();
    return `<tr class="hm-row" data-hm-status="${h.status === "current" ? "current" : "past"}" data-hm-search="${esc(search)}">
      <td><button class="fin-tg" data-hm="${i}" title="Show this horse's money in detail">▸</button> ${L.horse(h.id, h.name)}</td>
      <td>${status(h)}</td><td class="nowrap small" data-sv="${h.from || ""}">${span(h)}</td>
      <td class="num">${fNum(h.starts)}</td><td class="num">${fNum(h.wins)}</td>
      <td class="num" data-sv="${h.income}" data-csv="${h.income}">${h.income ? finAmt(h.income) : '<span class="muted">—</span>'}</td>
      <td class="num" data-sv="${h.expenses}" data-csv="${h.expenses}">${h.expenses ? finAmt(h.expenses) : '<span class="muted">—</span>'}</td>
      <td class="num" data-sv="${h.net}" data-csv="${h.net}">${finAmt(h.net, h.net >= 0 ? "pos" : "neg")}</td>
      <td class="num" data-sv="${roi === null ? "" : roi}" data-csv="${roi === null ? "" : fNum(roi, 0) + "%"}">${roi === null ? '<span class="muted">—</span>' : `<span class="${roi >= 0 ? "up" : "down"}">${roi >= 0 ? "+" : ""}${fNum(roi, 0)}%</span>`}</td></tr>
      <tr class="hm-more" data-hm-row="${i}" hidden><td colspan="9"><div class="hm-detail">
        <div><h4>Income</h4>${hmBreakdown(h.inc, h.income, "#1f5240")}</div>
        <div><h4>Expenses</h4>${hmBreakdown(h.exp, h.expenses, "#c0504d")}</div>
        <div><h4>Year by year</h4>${h.years.length ? `<table class="hm-mini"><tr><th></th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr>${h.years.slice().reverse().map((y) =>
          `<tr><td><b>${y.year}</b></td><td class="num">${finAmt(y.inc)}</td><td class="num">${finAmt(y.exp)}</td><td class="num">${finAmt(y.inc - y.exp, y.inc - y.exp >= 0 ? "pos" : "neg")}</td></tr>`).join("")}</table>` : '<div class="muted small">No dated figures.</div>'}</div>
      </div></td></tr>`;
  }).join("");
  html += `<div style="margin-top:16px">${panel("Every horse", `<div class="fd-tools">
      <div class="seg"><button class="on" data-hm-show="all">All ${fNum(hs.length)}</button><button data-hm-show="current">In the stable ${fNum(cur.length)}</button><button data-hm-show="past">Past ${fNum(hs.length - cur.length)}</button></div>
      <input type="search" class="hm-filter fd-filter" placeholder="Find a horse…" aria-label="Find a horse"><span class="grow"></span>
      <span class="muted small">▸ for each horse's breakdown · click a heading to sort</span></div>
    <div class="fd-none empty" hidden>No horses match.</div>
    <div class="tbl-wrap"><table class="data hm-table"><thead><tr><th>Horse</th><th>Status</th><th>With the stable</th><th class="num">Starts</th><th class="num">Wins</th>
      <th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num" data-tip="Net as a share of what was spent on the horse">Return</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr><td colspan="5">All horses shown</td><td class="num hm-t-inc">${finAmt(inc)}</td><td class="num hm-t-exp">${finAmt(exp)}</td><td class="num hm-t-net">${finAmt(inc - exp, inc - exp >= 0 ? "pos" : "neg")}</td><td></td></tr></tfoot></table></div>`,
    "Only money while the horse was with this stable")}</div>`;
  html += `<p class="muted small hm-note">Where the figures come from: prize money from race results; sales and purchases from auctions; stud and breeding fees from the breeding records;
    feed, care, training and staff costs from the game's per-horse cost records (yearly up to 2017, monthly after); travel from the travel log (plus an older lifetime total for horses still here);
    and payments whose note names the horse (sponsorships, win shares, vet treatment, jockey fees). Stable-wide costs that aren't tied to one horse — facilities, wages, subscriptions — aren't included.</p>`;
  return html;
}
function hmApply(panel) {
  const show = (panel.querySelector("[data-hm-show].on") || {}).dataset?.hmShow || "all", q = (panel.querySelector(".hm-filter").value || "").trim().toLowerCase();
  let n = 0, inc = 0, exp = 0;
  panel.querySelectorAll("tr.hm-row").forEach((tr) => {
    const ok = (show === "all" || tr.dataset.hmStatus === show) && (!q || tr.dataset.hmSearch.includes(q));
    tr.hidden = !ok;
    const more = tr.nextElementSibling;
    if (!ok && more) { more.hidden = true; const b = tr.querySelector(".fin-tg"); if (b) b.textContent = "▸"; }
    if (ok) { n++; inc += +tr.cells[5].dataset.sv || 0; exp += +tr.cells[6].dataset.sv || 0; }
  });
  panel.querySelector(".fd-none").hidden = n > 0;
  panel.querySelector(".hm-t-inc").innerHTML = finAmt(inc);
  panel.querySelector(".hm-t-exp").innerHTML = finAmt(exp);
  panel.querySelector(".hm-t-net").innerHTML = finAmt(inc - exp, inc - exp >= 0 ? "pos" : "neg");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hm]");
  if (b) { const row = document.querySelector(`[data-hm-row="${b.dataset.hm}"]`); if (row) { row.hidden = !row.hidden; b.textContent = row.hidden ? "▸" : "▾"; } return; }
  const s = e.target.closest("[data-hm-show]");
  if (s) { const p = s.closest(".panel"); p.querySelectorAll("[data-hm-show]").forEach((x) => x.classList.toggle("on", x === s)); hmApply(p); }
});
document.addEventListener("input", (e) => { const f = e.target.closest(".hm-filter"); if (f) hmApply(f.closest(".panel")); });

// ------------------------------------------------------------------ people
async function peoplePage(route) {
  return listPage({
    title: "People", noun: "people", endpoint: "people", defaultSort: "fame", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search by name") +
      select("role", q, [["", "Any role"], ["Jockey", "Jockeys"], ["Trainer", "Trainers"], ["Head trainer", "Head trainers"], ["Manager", "Managers"], ["Assistant manager", "Assistant managers"], ["Scout", "Scouts"], ["Stablehand", "Stablehands"]]) +
      seg("status", q, [["alive", "Alive"], ["all", "Include deceased"]], "alive"),
    cols: [
      { h: "Name", sort: "name", f: (r) => `${L.person(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}${r.id === (STATUS.player || {}).id ? ' <span class="badge good">You</span>' : ""}` },
      { h: "Role", f: (r) => esc(r.role || "—") },
      { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable_name) },
      { h: "Age", cls: "num", sort: "birth", f: (r) => fNum(age(r.birth, r.died)) },
      { h: "Rides", cls: "num", f: (r) => fNum(r.jockey_starts) },
      { h: "Wins", cls: "num", sort: "jockey_wins", f: (r) => fNum(r.jockey_wins) },
      { h: "Jockey prize money", cls: "num", sort: "jockey_winnings", f: (r) => fMoneyShort(r.jockey_winnings) },
      { h: "Reputation", cls: "num", sort: "reputation", f: (r) => fNum(r.reputation, 1) },
      { h: "Fame", cls: "num", sort: "fame", f: (r) => fNum(r.fame, 0) },
    ],
  }, route);
}

async function personPage(id) {
  const d = await api("person/" + id);
  const p = d.person, rs = d.ride_summary || {};
  const dead = isNum(p.person_deceased_date);
  const current = (d.jobs || []).filter((j) => !j.end);
  let html = `<div class="page-head"><div><div class="crumb"><a href="#/people">People</a></div>
    <h1>${esc(p.person_full_name)} ${dead ? '<span class="badge dead">Deceased</span>' : ""}${removedBadge(d)}${p.person_is_player === "true" ? ' <span class="badge good">You</span>' : ""}</h1>
    <div class="sub">${fNum(age(p.person_birth_date, p.person_deceased_date))} years old · ${esc(p.person_sex || "")}${d.city ? ` · ${esc(d.city.city)}, ${esc(d.city.country)}` : ""}
    ${current.length ? " · " + current.map((j) => `${esc(j.role)} at ${L.stable(j.stable_id, j.stable)}`).join(", ") : ""}
    ${d.owns && d.owns.length ? " · Owns " + d.owns.map((s) => L.stable(s.id, s.name)).join(", ") : ""}</div>${removedNote(d)}</div></div>`;
  html += tiles([
    ["Rides", fNum(rs.rides)], ["Wins", fNum(rs.wins), `Strike rate ${pct(rs.wins, rs.rides)}`], ["Placed (top 3)", fNum(rs.places), pct(rs.places, rs.rides)],
    ["Prize money as jockey", fMoneyShort(rs.prize)], ["Reputation", fNum(p.person_reputation, 1)], ["Fame", fNum(p.person_fame_calculated, 0)],
  ]);
  const skill = (l, k) => ({ label: l, cur: p["person_" + k + "_skill"], max: p["person_max_" + k + "_skill"] });
  const skills = bars([skill("Jockey", "jockey"), skill("Trainer", "trainer"), skill("Head trainer", "head_trainer"), skill("Manager", "manager"),
    skill("Asst. manager", "assistant_manager"), skill("Scout", "scout"), skill("Stablehand", "stablehand")]) +
    `<div class="legend"><span><i style="background:var(--green-2)"></i>Current</span><span><i style="background:#e2dccb"></i>Potential</span></div>`;
  const persona = bars([["Intelligence", "intelligence"], ["Temperament", "temperament"], ["Sociability", "sociability"], ["Negotiation", "negotiation"],
    ["Leadership", "leadership"], ["Karma", "karma"]].map(([l, k]) => ({ label: l, cur: p["person_" + k] })));
  const rel = d.relations || {};
  const family = kv([
    ["Spouse", rel.person_spouse_id ? L.person(rel.person_spouse_id.id, rel.person_spouse_id.name) : "—"],
    ["Partner", rel.person_partner_id ? L.person(rel.person_partner_id.id, rel.person_partner_id.name) : "—"],
    ["Parents", (d.parents || []).length ? d.parents.map((x) => L.person(x.id, x.name)).join(", ") : "—"],
    ["Children", (d.children || []).length ? d.children.map((x) => L.person(x.id, x.name)).join(", ") : "—"],
  ]);
  html += `<div class="grid cols-3">${panel("Skills", skills)}${panel("Personality", persona)}${panel("Family", family)}</div>`;
  html += `<div style="margin-top:16px">${panel("Rides", table([
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name, '<span class="muted">Historic race</span>')} ${grade(r.race_type)}` },
    { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) }, { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Distance", cls: "num", f: (r) => fDist(r.distance) }, { h: "Pos", f: (r) => pos(r.rank, r.runners) }, { h: "Prize", cls: "num", f: (r) => fMoney(r.prize) },
  ], d.rides, { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No rides." }), rs.rides > (d.rides || []).length ? `Latest ${d.rides.length} of ${fNum(rs.rides)}` : `${fNum(rs.rides)} rides`, "tall")}</div>`;
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Jobs", table([
    { h: "Role", f: (r) => esc(r.role) }, { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) },
    { h: "From", cls: "nowrap", f: (r) => fDate(r.start) }, { h: "To", cls: "nowrap", f: (r) => (r.end ? fDate(r.end) : "Now") }, { h: "Salary", cls: "num", f: (r) => fMoney(r.salary) },
  ], d.jobs, { empty: "No jobs on record." }))}
    ${panel("Traits", chips(d.traits))}
    ${panel("Awards", table([{ h: "Year", f: (r) => esc(r.year) }, { h: "Award", f: (r) => esc((r.category || "").replace(/_/g, " ")) }, { h: "For", f: (r) => esc(r.description || "") }], d.awards, { empty: "No awards." }))}
    ${panel("News", events(d.events))}</div>`;
  html += `<div style="margin-top:16px">${allFields(p)}</div>`;
  return html;
}

// ------------------------------------------------------------------ racecourses
async function coursesPage(route) {
  const data = await api("courses?" + new URLSearchParams(withSize(route.q)));
  const q = route.q;
  return `<div class="page-head"><div><h1>Racecourses</h1><div class="sub">${fNum(data.total)} racecourses</div></div></div>
    <section class="panel"><div class="filters">${searchBox(q, "Search name or town")}${select("country", q, [["", "Any country"]].concat(data.countries.map((c) => [c, c])))}</div>
    ${table([
      { h: "Racecourse", f: (r) => L.course(r.id, r.name) }, { h: "Town", f: (r) => esc(r.city || "") }, { h: "Country", f: (r) => esc(r.country || "") },
      { h: "Surface", f: (r) => esc(r.surface || "—") }, { h: "Direction", f: (r) => esc(r.direction || "—") },
      { h: "Capacity", cls: "num", f: (r) => fNum(r.capacity) }, { h: "Owner", f: (r) => L.stable(r.owner_id, r.owner) },
    ], data.rows, { empty: "No matches." })}${pager(data)}</section>`;
}

async function coursePage(id) {
  const d = await api("course/" + id);
  const c = d.course;
  const tracks = ["outer_oval", "center_oval", "inner_oval"].filter((t) => c[`racecourse_${t}_track_surface`])
    .map((t) => [esc(t.replace("_", " ").replace(/^./, (x) => x.toUpperCase())), `${esc(c[`racecourse_${t}_track_surface`])} · ${fDist(c[`racecourse_${t}_track_distance`])}`]);
  if (c.racecourse_straight_track_material) tracks.push(["Straight", `${esc(c.racecourse_straight_track_material)} · ${fDist(c.racecourse_straight_track_distance)}`]);
  let html = `<div class="page-head"><div><div class="crumb"><a href="#/courses">Racecourses</a></div>
    <h1>${esc(c.racecourse_name)}</h1><div class="sub">${esc(c.racecourse_location_city || "")}, ${esc(c.racecourse_location_country || "")}
    ${c.racecourse_nickname ? " · “" + esc(c.racecourse_nickname) + "”" : ""}</div>${removedNote(d)}</div>
    <a class="btn" href="#/races?course=${c.racecourse_racecourse_id}&when=all">All races here</a></div>`;
  html += tiles([
    ["Capacity", fNum(c.racecourse_max_attendance)], ["Direction", esc(c.racecourse_direction || "—")],
    ["Track condition", fNum(c.racecourse_condition_of_track, 0) + "%"], ["Facilities", fNum(c.racecourse_condition_of_facilities, 0) + "%"],
    ["Awareness", fNum(c.racecourse_awareness, 0)], ["Built", fDate(c.racecourse_build_date)],
  ]);
  const dayCols = [
    { h: "Date", cls: "nowrap", f: (r) => L.race(r.first_race_id, fDate(r.date)) }, { h: "Meeting", f: (r) => esc(r.name || "") },
    { h: "Races", cls: "num", f: (r) => fNum(r.races) },
    { h: "Top race", f: (r) => (r.top_race_id ? `${grade(r.top_grade)} ${L.race(r.top_race_id, r.top_race_name)}` : '<span class="muted">—</span>') },
    { h: "Weather", f: (r) => esc(r.weather || "") },
  ];
  html += trackRecordsPanel(d, c);
  html += `<div style="margin-top:16px">${sectionRecordsPanel(d, c)}</div>`;
  html += `<div class="grid cols-3" style="margin-top:16px">${panel("Tracks", tracks.length ? kv(tracks) : '<div class="empty">No track details.</div>')}
    ${panel("People", kv([["Owner", d.owner ? L.stable(d.owner.id, d.owner.name) : "—"], ["Manager", d.manager ? L.person(d.manager.id, d.manager.name) : "—"]]))}
    ${panel("Tickets", kv([["VIP", fMoney(c.racecourse_vip_ticket_price)], ["Normal", fMoney(c.racecourse_normal_ticket_price)], ["Standing", fMoney(c.racecourse_standing_ticket_price)]]))}</div>
    <div class="grid cols-2" style="margin-top:16px">
    ${panel("Recent meetings", table(dayCols, d.recent_days.slice(0, 20), { empty: "None yet." }), `<a href="#/races?course=${c.racecourse_racecourse_id}">All results here</a>`)}
    ${panel("Upcoming meetings", table(dayCols, d.upcoming_days.slice(0, 20), { empty: "None scheduled." }))}
    ${panel("Feature races", table([
      { h: "Race", f: (r) => `${L.race(r.race_id, r.name)} ${grade(r.race_type)}` }, { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    ], d.big_races, { empty: "No group or listed races." }), "", "span-2")}</div>`;
  html += `<div style="margin-top:16px">${allFields(c)}</div>`;
  return html;
}

const TRACK_SURFACE_COL = { "Outer Oval": "racecourse_outer_oval_track_surface", "Center Oval": "racecourse_center_oval_track_surface",
  "Inner Oval": "racecourse_inner_oval_track_surface", "Straight Track": "racecourse_straight_track_material" };
function trackRecordsPanel(d, c) {
  const recs = d.track_records || [];
  const groups = [], byKey = {};
  recs.forEach((r) => {
    const k = r.track + "|" + r.distance;
    if (!byKey[k]) { byKey[k] = { track: r.track, distance: r.distance, list: [] }; groups.push(byKey[k]); }
    byKey[k].list.push(r);
  });
  groups.sort((a, b) => a.distance - b.distance || String(a.track).localeCompare(String(b.track)));
  if (!groups.length) return panel("Track records", '<div class="empty">No races with recorded times here yet.</div>');
  const surface = (t) => { const v = c[TRACK_SURFACE_COL[t]]; return v ? ` <span class="muted small">${esc(v)}</span>` : ""; };
  const raceCell = (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}`;
  const body = groups.map((g, i) => {
    const cur = g.list[0];
    const hist = g.list.map((r, j) => `<tr class="${j === 0 ? "win" : ""}">
      <td class="nowrap">${fDate(r.date)}</td><td class="num"><b>${fTime(r.time)}</b></td>
      <td class="num">${isNum(r.prev_best) ? "−" + (r.prev_best - r.time).toFixed(2) + "s" : '<span class="muted">First winning time</span>'}</td>
      <td>${L.horse(r.horse_id, r.horse)}</td><td>${L.person(r.jockey_id, r.jockey)}</td><td>${L.stable(r.stable_id, r.stable)}</td><td>${raceCell(r)}</td>
      <td class="muted small">${j === 0 ? "Current record" : `Stood until ${fDate(g.list[j - 1].date)}`}</td></tr>`).join("");
    return `<tr>
      <td class="nowrap"><button class="linklike" data-rec="${i}" title="Show earlier record holders"><span class="arrow">▸</span> ${fDist(g.distance)}</button></td>
      <td class="nowrap">${esc(g.track || "—")}${surface(g.track)}</td>
      <td class="num"><b>${fTime(cur.time)}</b></td>
      <td>${L.horse(cur.horse_id, cur.horse)}</td>
      <td class="nowrap">${fDate(cur.date)}</td>
      <td>${L.person(cur.jockey_id, cur.jockey)}</td>
      <td>${raceCell(cur)}</td>
      <td class="num">${g.list.length > 1 ? `${g.list.length - 1}×` : '<span class="muted">—</span>'}</td></tr>
      <tr class="rec-hist" data-hist="${i}" hidden><td colspan="8"><div class="rec-box">
        <div class="small muted" style="margin-bottom:6px">Every time the ${fDist(g.distance)} record on the ${esc(g.track || "track")} was lowered, newest first</div>
        <table class="data"><thead><tr><th>Date</th><th class="num">Time</th><th class="num">Improved by</th><th>Horse</th><th>Jockey</th><th>Stable</th><th>Race</th><th></th></tr></thead>
        <tbody>${hist}</tbody></table></div></td></tr>`;
  }).join("");
  return panel("Track records", `<div class="tbl-wrap"><table class="data rec-table"><thead><tr><th>Distance</th><th>Track</th><th class="num">Record</th><th>Horse</th>
    <th>Set on</th><th>Jockey</th><th>Race</th><th class="num" title="How many times the record has been lowered">Broken</th></tr></thead><tbody>${body}</tbody></table></div>`,
    `Fastest winning time at each distance · click a distance for earlier holders · <a href="#" data-rec-all>expand all</a>`);
}
coursePage.after = () => {
  const toggle = (i, open) => {
    const row = $(`tr[data-hist="${i}"]`), btn = $(`[data-rec="${i}"]`);
    if (!row || !btn) return;
    row.hidden = open === undefined ? !row.hidden : !open;
    btn.querySelector(".arrow").textContent = row.hidden ? "▸" : "▾";
  };
  $$("[data-rec]", APP).forEach((b) => b.addEventListener("click", () => toggle(b.dataset.rec)));
  const all = $("[data-rec-all]", APP);
  if (all) all.addEventListener("click", (e) => {
    e.preventDefault();
    const open = all.textContent === "expand all";
    $$("[data-rec]", APP).forEach((b) => toggle(b.dataset.rec, open));
    all.textContent = open ? "collapse all" : "expand all";
  });
};

// ------------------------------------------------------------------ raw tables
function filterToApi(text) {
  const t = text.trim();
  if (!t) return "";
  if (/^null$/i.test(t)) return "null:";
  if (/^!null$/i.test(t)) return "notnull:";
  let m;
  if ((m = t.match(/^(>=|<=|!=|=|>|<)\s*(.*)$/))) return { ">=": "ge", "<=": "le", "!=": "ne", "=": "eq", ">": "gt", "<": "lt" }[m[1]] + ":" + m[2];
  return "has:" + t;
}
let DATES_ON = true;
async function tablesPage(route) {
  if (!TABLES_CACHE) TABLES_CACHE = (await api("tables")).tables;
  const name = route.parts[1] || "";
  const q = route.q;
  const list = `<section class="panel list"><input type="search" id="tfilter" placeholder="Filter ${TABLES_CACHE.length} tables">
    ${TABLES_CACHE.map((t) => `<a href="${hashFor(["tables", t.name])}" class="${t.name === name ? "on" : ""} ${t.rows === 0 ? "zero" : ""}" data-name="${esc(t.name)}"><span>${esc(t.name)}</span><span class="n">${fNum(t.rows)}</span></a>`).join("")}</section>`;
  if (!name) {
    return settingsTabs("tables") + `<div class="page-head"><div><h1>All tables</h1><div class="sub">Every table in the database, exactly as stored. Pick one on the left.</div></div></div>
      <div class="raw">${list}<section class="panel"><p>Tips</p><ul class="help">
      <li>Click a column name to sort; click again to reverse.</li>
      <li>Type in the box under a column and press Enter to filter: plain text finds rows that contain it; <code>=5</code>, <code>&gt;100</code>, <code>&lt;=2018</code>, <code>!=0</code> compare; <code>null</code> / <code>!null</code> find empty or filled cells.</li>
      <li>IDs that point to a horse, person, stable, race or racecourse are links. Click any row to see all of its fields.</li></ul></section></div>`;
  }
  const params = { page: q.page || 1, size: q.size || prefPageSize() || 100, sort: q.sort || "", dir: q.dir || "", q: q.q || "" };
  Object.entries(q).forEach(([k, v]) => { if (k.startsWith("f.") && v) params[k] = filterToApi(v); });
  const d = await api("table/" + encodeURIComponent(name) + "?" + new URLSearchParams(params));
  const head = d.columns.map((c) => `<th data-col="${esc(c)}" title="${esc(c)}">${esc(c)}${q.sort === c ? (q.dir === "desc" ? " ▼" : " ▲") : ""}</th>`).join("");
  const flt = d.columns.map((c) => `<th><input data-f="${esc(c)}" value="${esc(q["f." + c] || "")}" placeholder="filter"></th>`).join("");
  const body = d.rows.map((r, i) => `<tr data-i="${i}">${r.map((v, j) => `<td class="${v === null ? "null" : ""}">${fieldValue(d.columns[j], v, DATES_ON)}</td>`).join("")}</tr>`).join("");
  const anyFilter = Object.keys(q).some((k) => k.startsWith("f.") && q[k]) || q.q;
  APP._rawData = d;
  const rawExp = `<a class="btn btn-csv" href="/api/export/raw/${encodeURIComponent(name)}?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([k]) => !["page", "size"].includes(k))))}" download data-tip="Download every matching row of this table (all pages, with your filters and sort) as a spreadsheet (CSV) file">${ICON_DL}Export CSV</a>`;
  return settingsTabs("tables") + `<div class="page-head"><div><div class="crumb"><a href="#/tables">All tables</a></div><h1>${esc(name)}</h1>
    <div class="sub">${fNum(d.total)} rows${anyFilter ? " match" : ""} · ${d.columns.length} columns</div></div>
    <div class="filters" style="margin:0"><input type="search" data-q="q" value="${esc(q.q || "")}" placeholder="Search text in this table">
    <label class="small"><input type="checkbox" id="dates" ${DATES_ON ? "checked" : ""}> Show dates</label> ${rawExp}
    ${select("size", q, [["100", "100 per page"], ["250", "250 per page"], ["500", "500 per page"]])}
    ${anyFilter ? `<a class="btn" href="${hashFor(["tables", name])}">Clear filters</a>` : ""}</div></div>
    <div class="raw">${list}<section class="panel" style="padding:10px">
    ${d.rows.length || anyFilter ? `<div class="grid-scroll"><table class="raw-grid"><thead><tr>${head}</tr><tr class="flt">${flt}</tr></thead><tbody>${body}</tbody></table></div>` : '<div class="empty">This table is empty.</div>'}
    ${!d.rows.length && anyFilter ? '<div class="empty">No rows match.</div>' : ""}
    ${pager(d)}</section></div>`;
}
tablesPage.after = (route) => {
  const name = route.parts[1];
  const tf = $("#tfilter");
  if (tf) {
    tf.addEventListener("input", () => {
      const v = tf.value.toLowerCase();
      $$(".raw .list a").forEach((a) => (a.style.display = a.dataset.name.toLowerCase().includes(v) ? "" : "none"));
    });
    const on = $(".raw .list a.on"), box = $(".raw .list");
    if (on && box) box.scrollTop = on.offsetTop - box.clientHeight / 2;
  }
  if (!name) return;
  const upd = (changes) => {
    const q = { ...route.q, ...changes };
    if (!("page" in changes)) delete q.page;
    APP.dataset.keep = "1";
    go(route.parts, q);
  };
  $$("table.raw-grid thead th[data-col]").forEach((th) => th.addEventListener("click", () => {
    const c = th.dataset.col;
    upd({ sort: c, dir: route.q.sort === c && route.q.dir !== "desc" ? "desc" : "asc" });
  }));
  $$("table.raw-grid input[data-f]").forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") upd({ ["f." + inp.dataset.f]: inp.value.trim() });
  }));
  const dates = $("#dates");
  if (dates) dates.addEventListener("change", () => { DATES_ON = dates.checked; render(); });
  $$("table.raw-grid tbody tr").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const d = APP._rawData, row = d.rows[+tr.dataset.i];
    openDrawer(`<h2>${esc(name)} row</h2>${`<div class="allfields" style="grid-template-columns:1fr">${d.columns.map((c, j) =>
      `<div><span class="k">${esc(c)}</span><span class="v">${fieldValue(c, row[j])}${isDateCol(c) && isNum(row[j]) && Math.abs(row[j]) >= 1e7 ? ` <span class="muted small">(${row[j]})</span>` : ""}</span></div>`).join("")}</div>`}`);
  }));
};

function openDrawer(html) {
  closeDrawer();
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "drawer-ov"; ov.style.background = "rgba(18,30,25,.25)";
  ov.innerHTML = `<aside class="drawer"><button class="btn close">Close</button>${html}</aside>`;
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest(".close") || e.target.closest("a")) closeDrawer(); });
  document.body.appendChild(ov);
}
function closeDrawer() { const o = $("#drawer-ov"); if (o) o.remove(); }

// ------------------------------------------------------------------ v2: Pedigrees tab
const yr = (ts) => (isNum(ts) ? new Date(ts * 1000).getUTCFullYear() : "—");
const KIND_LABEL = { sires: "Sires", dams: "Dams", damsires: "Broodmare sires" };
const KIND_INTRO = {
  sires: "Stallions ranked by how their foals have performed. A runner is a foal that has raced; a winner has won at least once; a stakes winner has won a Group or Listed race.",
  dams: "Mares ranked by how their foals have performed. A runner is a foal that has raced; a winner has won at least once; a stakes winner has won a Group or Listed race.",
  damsires: "A broodmare sire is the sire of a horse's dam. These figures cover the foals of each stallion's daughters, so they show how his line carries on through his fillies.",
};
async function pedigreesPage(route) {
  const q = route.q, kind = q.kind || "sires";
  const offspring = kind === "damsires" ? "Grand-foals" : "Foals";
  const tablesLink = (r) => kind === "damsires" ? "" : ` <a class="small" href="#/horse-table?${kind === "dams" ? "dam" : "sire"}=${r.id}&status=all" title="All foals in the Horse table">foals ↗</a>`;
  const years = [["", "Any year"]];
  const gy = new Date(GD() * 1000).getUTCFullYear();
  for (let y = gy; y >= gy - 40; y--) years.push([String(y), String(y)]);
  return listPage({
    title: "Pedigrees", noun: KIND_LABEL[kind].toLowerCase(), endpoint: "pedigrees", defaultSort: "earnings", ascDefault: ["name"],
    exportName: "pedigrees", wide: true, intro: KIND_INTRO[kind],
    filters: (q) => seg("kind", q, [["sires", "Sires"], ["dams", "Dams"], ["damsires", "Broodmare sires"]], "sires") +
      searchBox(q, "Search by name") + seg("status", q, [["all", "All"], ["alive", "Alive only"]], "all") +
      `<label class="lbl">${offspring} foaled from ${select("from", q, years)} to ${select("to", q, years)}</label>` +
      select("osex", q, [["", "Colts & fillies"], ["Male", "Colts only"], ["Female", "Fillies only"]]) +
      select("minrunners", q, [["", "Any number of runners"], ["1", "1+ runners"], ["5", "5+ runners"], ["10", "10+ runners"], ["25", "25+ runners"], ["50", "50+ runners"], ["100", "100+ runners"]]),
    cols: [
      { h: KIND_LABEL[kind].replace(/s$/, ""), sort: "name", f: (r) => `${L.horse(r.id, r.name)} <a class="small" href="#/pedigree/${r.id}" title="Family tree">tree</a>${tablesLink(r)}` },
      { h: "Born", sort: "birth", cls: "num", f: (r) => yr(r.birth) },
      { h: "Sire", f: (r) => L.horse(r.sire_id, r.sire) },
      { h: "Dam", f: (r) => L.horse(r.dam_id, r.dam) },
      { h: offspring, sort: "foals", cls: "num grp-start", f: (r) => fNum(r.foals) },
      { h: "Runners", sort: "runners", cls: "num", f: (r) => fNum(r.runners) },
      { h: "Winners", sort: "winners", cls: "num", f: (r) => fNum(r.winners) },
      { h: "Winners / runners", sort: "winner_pct", cls: "num", f: (r) => pct(r.winners, r.runners) },
      { h: "Stakes winners", sort: "stakes_winners", cls: "num", f: (r) => fNum(r.stakes_winners) },
      { h: "G1 winners", sort: "g1_winners", cls: "num", f: (r) => fNum(r.g1_winners) },
      { h: "Total wins", sort: "wins", cls: "num", f: (r) => fNum(r.wins) },
      { h: "Progeny earnings", sort: "earnings", cls: "num grp-start", f: (r) => fMoney(r.earnings) },
      { h: "Per runner", sort: "per_runner", cls: "num", f: (r) => (r.runners ? fMoney(r.earnings / r.runners) : "—") },
      { h: "Best " + (kind === "damsires" ? "grand-foal" : "foal"), f: (r) => (r.best ? `${L.horse(r.best.id, r.best.name)} <span class="muted small">${fMoneyShort(r.best.earnings)}</span>` : "—") },
      { h: "Own earnings", sort: "own_earnings", cls: "num grp-start", f: (r) => fMoneyShort(r.own_earnings) },
      { h: "Stud fee", sort: "stud_fee", cls: "num", f: (r) => (r.stud_fee ? fMoney(r.stud_fee) : "—") },
      { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) },
    ],
  }, route);
}

const REP_COLORS = ["#b5872c", "#3e6e9e", "#7a4f9a", "#c0504d", "#2f8f6a", "#a8714a"];
const PED_GENS = [4, 8, 12, 16];
let PED = null;
function pedGens(q) {
  let g = parseInt(q.gens, 10);
  return PED_GENS.includes(g) ? g : 4;   // opens at 4 generations unless more are picked
}
function gensText(gens) {
  return Object.entries(gens).sort((a, b) => a[0] - b[0]).map(([g, c]) => (c > 1 ? `${g}×${c}` : g)).join(", ");
}
async function pedigreePage(id, q) {
  const depth = pedGens(q || {});
  const d = await api(`pedigree/${id}?gens=${depth}`);
  const keepSel = PED && PED.horse && d.horse && PED.horse.id === d.horse.id && PED.sel ? PED.sel : null;
  PED = d;
  if (keepSel) PED.sel = keepSel;
  const me = d.horse, t = d.tree, deep = d.deep;
  const repColor = {};
  d.repeats.forEach((r, i) => (repColor[r.id] = REP_COLORS[i % REP_COLORS.length]));
  const node = (path) => {
    const h = t[path];
    const gen = path.length, row = parseInt(path.replace(/s/g, "0").replace(/d/g, "1"), 2) * (16 >> gen);
    const style = `grid-column:${gen};grid-row:${row + 1} / span ${16 >> gen};`;
    const sexCls = path.endsWith("s") ? "m" : "f";
    if (!h) return `<div class="node g${gen} unk ${sexCls}" style="${style}">Unknown</div>`;
    const rep = repColor[h.id];
    const bits = [yr(h.birth), h.starts ? `${h.wins}/${h.starts} wins` : "unraced", h.earnings ? fMoneyShort(h.earnings) : ""].filter(Boolean);
    return `<div class="node g${gen} ${sexCls} ${rep ? "rep" : ""}" style="${style}${rep ? `--rep:${rep};` : ""}" title="${esc(h.name)}">
      <a class="go" href="#/horse/${h.id}" title="Open horse page">↗</a>
      <div class="nm"><a href="#/pedigree/${h.id}">${esc(h.name)}</a> ${h.g1 ? `<span class="badge G1">${h.g1}× G1</span>` : h.stakes_wins ? '<span class="badge listed">SW</span>' : ""}</div>
      ${gen <= 3 ? `<div class="meta">${bits.join(" · ")}</div>` : `<div class="meta">${bits.slice(0, 2).join(" · ")}</div>`}</div>`;
  };
  const sumKV = (x) => (x && x.foals ? kv([["Foals", fNum(x.foals)], ["Runners", fNum(x.runners)], ["Winners", `${fNum(x.winners)} (${pct(x.winners, x.runners)} of runners)`],
    ["Stakes winners", fNum(x.stakes_winners)], ["Progeny earnings", fMoney(x.earnings)]]) : '<div class="empty">No foals recorded.</div>');
  const sibCols = (otherLabel) => [
    { h: "Horse", f: (r) => `${L.horse(r.id, r.name)} <a class="small" href="#/pedigree/${r.id}">tree</a>` },
    { h: "Sex", f: (r) => esc(r.gender) }, { h: "Born", cls: "num", f: (r) => yr(r.birth) }, { h: "Age", cls: "num nowrap", f: (r) => ageCell(r.birth, r.died) },
    otherLabel ? { h: otherLabel, f: (r) => L.horse(r.other_id, r.other) } : null,
    { h: "Record", cls: "num", f: (r) => (r.starts ? `${r.wins}/${r.starts}` : "unraced") },
    { h: "Stakes wins", cls: "num", f: (r) => fNum(r.stakes_wins) }, { h: "G1", cls: "num", f: (r) => fNum(r.g1) },
    { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
  ].filter(Boolean);
  const ps = d.progeny_summary;
  const genBtns = `<div class="seg" title="How many generations to go back">${PED_GENS.map((g) =>
    `<button data-gens="${g}" class="${g === depth ? "on" : ""}">${g} generations</button>`).join("")}</div>`;
  let html = `<div class="page-head"><div><div class="crumb"><a href="#/pedigrees">Pedigrees</a></div>
    <h1>${esc(me.name)} <span class="muted" style="font-weight:400;font-size:calc(var(--tf) + 5px)">family tree</span></h1>
    <div class="sub">${esc(me.sex === "Female" ? "Filly / mare" : "Colt / stallion")} · born ${yr(me.birth)} · ${esc(me.color || "")}
    · ${me.starts ? `${me.wins} wins from ${me.starts} starts` : "unraced"} · ${fMoney(me.earnings)}</div></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${genBtns}<a class="btn" href="#/horse/${me.id}">Horse page</a></div></div>`;
  const coiTile = ["Inbreeding (COI)", `<span id="coi-val">…</span>`, `over ${depth} generations`];
  if (!deep) {
    const paths = [];
    for (let g = 1; g <= 4; g++) for (let i = 0; i < 1 << g; i++) paths.push(i.toString(2).padStart(g, "0").replace(/0/g, "s").replace(/1/g, "d"));
    const GEN_NAMES = ["Parents", "Grandparents", "Great-grandparents", "3× great-grandparents"];
    const tree = `<div class="anc-tools"><span class="small muted">Show or hide:</span>${GEN_NAMES.map((n, i) => `<button class="btn on-btn" data-tg4="${i + 1}">▾ ${n}</button>`).join("")}
        <span class="grow"></span><button class="btn" data-tg4all="1">Expand all</button><button class="btn" data-tg4all="0">Hide all</button></div>
      <div class="tree" id="tree4">${paths.map(node).join("")}</div>
      <div class="legend"><span><i style="background:#2f6fc4"></i>Sire line</span><span><i style="background:#d0457a"></i>Dam line</span>
      <span>Click a name to move the tree to that horse · ↗ opens its horse page</span></div>`;
    const reps = d.repeats.length ? `<div class="rep-list">${d.repeats.map((r) => `<span class="chip" style="--rep:${repColor[r.id]};border-width:2px">${L.horse(r.id, r.name)} <b>${r.gens.join("×")}</b></span>`).join("")}</div>
      <p class="help">These ancestors appear more than once. The numbers are the generations they appear in (1 = parents, 2 = grandparents…), so 3×4 means a great-grandparent on one side and a great-great-grandparent on the other.</p>`
      : `<p class="help">No ancestor appears twice in four generations (no close inbreeding).</p>`;
    html += tiles([coiTile]).replace('class="tiles"', 'class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(150px,220px))"');
    html += panel("Four generations", tree + reps);
  } else {
    const gl = deep.generations, last = gl[gl.length - 1] || { gen: 0, known: 0, possible: 1 };
    const atDepth = gl.find((g) => g.gen === depth);
    html += tiles([
      coiTile,
      ["Different ancestors", fNum(deep.ancestor_total), `in ${depth} generations`],
      ["Appear more than once", fNum(deep.repeated_total), "ancestors repeated in the pedigree"],
      ["Deepest generation known", fNum(last.gen), last.gen < depth ? "the save has no older records" : ""],
      ["Generation " + depth + " complete", atDepth ? pct(atDepth.known, atDepth.possible) : "0%", atDepth ? `${fNum(atDepth.known)} of ${fNum(atDepth.possible)} places known` : "no ancestors that far back"],
    ]);
    html += panel(`Family tree · ${depth} generations`, `<div class="anc-list" id="anc-list"></div>`,
      `D = dam, S = sire, read from ${esc(me.name)} outwards (DS = dam's sire) · † = deceased · click a name to move the tree to that horse`);
    const blood = (a) => `<span class="blood" style="width:${Math.max(2, Math.min(80, a.blood * 160))}px"></span>${(100 * a.blood).toFixed(a.blood >= 0.1 ? 1 : 2)}%`;
    const ancCols = [
      { h: "Show", cls: "nowrap", f: (a) => `<label class="pick" title="Highlight where this horse appears in the family tree"><input type="checkbox" class="anc-pick" data-id="${a.id}"><i class="sw"></i></label>` },
      { h: "Ancestor", f: (a) => `${L.horse(a.id, a.name)} <a class="small" href="#/pedigree/${a.id}">tree</a>` },
      { h: "Born", cls: "num", f: (a) => yr(a.birth) },
      { h: "Appears", cls: "num", f: (a) => `${fNum(a.times)}×` },
      { h: "In generations", f: (a) => `<span class="small">${esc(gensText(a.gens))}</span>` },
      { h: "Share of pedigree", f: blood },
      { h: "Record", cls: "num", f: (a) => (a.starts ? `${a.wins}/${a.starts}` : "unraced") },
      { h: "G1", cls: "num", f: (a) => fNum(a.g1) },
      { h: "Earnings", cls: "num", f: (a) => fMoneyShort(a.earnings) },
    ];
    const repeated = deep.ancestors.filter((a) => a.times > 1).sort((a, b) => b.blood - a.blood).slice(0, 150);
    const byShare = deep.ancestors.slice().sort((a, b) => b.blood - a.blood).slice(0, 150);
    html += `<div style="margin-top:16px">` + panel("Most influential ancestors",
      `<div class="filters"><div class="seg"><button data-anc="rep" class="on">Repeated ancestors</button><button data-anc="all">All ancestors</button></div>
       <span class="help">Share of pedigree adds up each appearance: a parent is 50%, a grandparent 25%, and so on. Tick <b>Show</b> to highlight a horse everywhere it appears in the family tree above.</span>
       <button class="btn" id="anc-clear" hidden>Clear highlights</button></div>
       <div id="anc-rep">${table(ancCols, repeated, { empty: "No ancestor appears more than once." })}</div>
       <div id="anc-all" hidden>${table(ancCols, byShare)}</div>`, "Top 150", "tall") + `</div>`;
    const lineList = (lst) => lst.length ? `<div class="lineage">${lst.map((x, i) => `<div class="li"><span class="gn">Gen ${i + 1}</span>
      <span>${L.horse(x.id, x.name)} <span class="muted small">${yr(x.birth)}</span></span>
      <span class="muted small">${x.starts ? `${x.wins}/${x.starts}` : "unraced"}${x.g1 ? ` · ${x.g1}× G1` : ""}</span></div>`).join("")}</div>` : '<div class="empty">Unknown.</div>';
    html += `<div class="grid cols-3" style="margin-top:16px">
      ${panel("Generation by generation", table([
        { h: "Generation", f: (g) => `${g.gen}` },
        { h: "Places known", cls: "num", f: (g) => `${fNum(g.known)} / ${fNum(g.possible)}` },
        { h: "Complete", cls: "num", f: (g) => pct(g.known, g.possible) },
        { h: "Different horses", cls: "num", f: (g) => fNum(g.distinct) },
      ], gl), "Fewer different horses than places means repeats")}
      ${panel("Sire line", lineList(deep.sire_line), "Sire, his sire, and so on")}
      ${panel("Dam line", lineList(deep.dam_line), "Dam, her dam, and so on")}</div>`;
  }
  html += `<div class="grid cols-3" style="margin-top:16px">
    ${panel("Sire's foals", sumKV(d.sire_summary), t.s ? L.horse(t.s.id, t.s.name) : "")}
    ${panel("Dam's foals", sumKV(d.dam_summary), t.d ? L.horse(t.d.id, t.d.name) : "")}
    ${panel(`${esc(me.name)}'s own foals`, sumKV(ps), ps && ps.foals ? `<a href="#/horse-table?${d.progeny_col}=${me.id}&status=all">See them all</a>` : "")}</div>`;
  html += `<div style="margin-top:16px">${panel("Full brothers and sisters", table(sibCols(null), d.full_siblings, { empty: "None — no other foal has the same sire and dam." }), "Same sire and dam")}</div>`;
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Half siblings through the dam", table(sibCols("Sire"), d.half_dam, { empty: "None." }), t.d ? `Out of ${L.horse(t.d.id, t.d.name)}` : "", "tall")}
    ${panel("Half siblings through the sire", table(sibCols("Dam"), d.half_sire, { empty: "None." }),
      d.half_sire_total ? `Top ${d.half_sire.length} of ${fNum(d.half_sire_total)} · <a href="#/horse-table?sire=${me.sire_id}&status=all">all</a>` : "", "tall")}</div>`;
  return html;
}

// 8-16 generations: one row per generation listing every ancestor by position (D/S path)
const ANC_AUTO_GEN = 9;   // larger generations are built when you open them
let ANC_COLOURS = true;
try { ANC_COLOURS = localStorage.getItem("hrm.ancColours") !== "0"; } catch (e) { /* default on */ }
function ancestorGenerations() {
  const deep = PED.deep, nodes = deep.nodes, gens = [];
  let level = [[PED.horse.id, ""]];
  for (let g = 1; g <= deep.depth; g++) {
    const next = [];
    for (const [cid, path] of level) {
      const c = nodes[String(cid)];
      if (!c) continue;
      for (const [pid, l] of [[c.dam_id, "D"], [c.sire_id, "S"]]) if (pid && nodes[String(pid)]) next.push([pid, path + l]);
    }
    if (!next.length) break;
    gens.push(next);
    level = next;
  }
  return gens;
}
const PICK_COLOURS = ["#ffd54a", "#7fe0c4", "#ffa3c4", "#a9c8ff", "#ffbe7a", "#cdb4ff", "#b6e36b", "#ff8f8f"];
function pickColour(id) { return PED && PED.sel ? PED.sel.get(String(id)) : null; }
function ancItem(id, path) {
  const n = PED.deep.nodes[String(id)], t = PED.deep.times[String(id)], pc = pickColour(id);
  const tip = `${n.name} · born ${yr(n.birth)}${isNum(n.died) ? " · died " + yr(n.died) : ""} · ${n.starts ? `${n.wins}/${n.starts} wins` : "unraced"}${n.earnings ? " · " + fMoneyShort(n.earnings) : ""}${n.g1 ? ` · ${n.g1}× G1` : ""}${t > 1 ? ` · appears ${t} times` : ""}`;
  return `<span class="ai ${path.endsWith("D") ? "f" : "m"}${pc ? " hl" : ""}" data-id="${id}" ${pc ? `style="--hl:${pc}"` : ""} title="${esc(tip)}"><b>${path}:</b> ${isNum(n.died) && !/^†/.test(n.name) ? "† " : ""}<a href="#/pedigree/${id}">${esc(n.name)}</a> ${yr(n.birth)}</span>`;
}
function genRowBody(g) {
  const list = PED.ancGens[g - 1];
  return PED.open.has(g) ? list.map(([id, p]) => ancItem(id, p)).join('<span class="sep">·</span> ')
    : `<span class="muted">${fNum(list.length)} ancestors hidden · </span><button class="linklike" data-gtg="${g}">expand</button>`;
}
function genHits(g) {
  if (!PED.sel || !PED.sel.size) return "";
  const n = PED.ancGens[g - 1].filter(([id]) => PED.sel.has(String(id))).length;
  return n ? `<div class="hits">${n} highlighted</div>` : "";
}
function drawGenRow(g) {
  const tg = $(`[data-gtg-btn="${g}"]`), body = $("#anc-gen-" + g), rc = $("#anc-rc-" + g);
  if (tg) tg.textContent = PED.open.has(g) ? "▾" : "▸";
  if (body) body.innerHTML = genRowBody(g);
  if (rc) rc.innerHTML = `${fNum(PED.ancGens[g - 1].length)} / ${fNum(2 ** g)}${genHits(g)}`;
}
function drawAncestorList() {
  const box = $("#anc-list");
  if (!box || !PED || !PED.deep) return;
  const gens = ancestorGenerations();
  PED.ancGens = gens;
  PED.open = PED.open || new Set(gens.map((_, i) => i + 1).filter((g) => g <= ANC_AUTO_GEN));
  PED.sel = PED.sel || new Map();
  const rows = gens.map((list, i) => {
    const g = i + 1;
    return `<tr><td class="g"><button class="gtg" data-gtg="${g}" data-gtg-btn="${g}" title="Hide or expand this generation">${PED.open.has(g) ? "▾" : "▸"}</button> ${g}</td>
      <td class="rc" id="anc-rc-${g}">${fNum(list.length)} / ${fNum(2 ** g)}${genHits(g)}</td><td class="al" id="anc-gen-${g}">${genRowBody(g)}</td></tr>`;
  }).join("");
  const short = gens.length < PED.deep.depth ? `<div class="help" style="margin-top:6px">The save only goes back ${gens.length} generations for this horse.</div>` : "";
  const total = gens.reduce((a, l) => a + l.length, 0);
  box.innerHTML = `<div class="anc-tools"><label><input type="checkbox" id="anc-col" ${ANC_COLOURS ? "checked" : ""}> Gender colours</label>
      <button class="btn" data-gtgall="1" title="${total > 5000 ? `Shows all ${fNum(total)} ancestors — can take a moment` : ""}">Expand all</button><button class="btn" data-gtgall="0">Hide all</button>
      <span class="grow"></span><span id="anc-legend" class="anc-legend"></span><button class="btn" id="anc-copy">Copy all</button><button class="btn" id="anc-copy-tsv">Copy for spreadsheet</button><span class="small muted" id="anc-copied"></span></div>
    <div class="tbl-wrap"><table class="anc-table ${ANC_COLOURS ? "colours" : ""} nosort"><thead><tr><th>Gen</th><th>Recorded</th><th>Ancestors</th></tr></thead><tbody>${rows}</tbody></table></div>${short}`;
  drawPickLegend();
}
function drawPickLegend() {
  const el = $("#anc-legend");
  if (!el || !PED.sel) return;
  el.innerHTML = [...PED.sel.entries()].map(([id, c]) => {
    const n = PED.deep.nodes[id]; const t = PED.deep.times[id] || 1;
    return `<span class="pk-chip" style="--hl:${c}">${esc(n ? n.name : id)} ×${t}</span>`;
  }).join("");
  const clr = $("#anc-clear"); if (clr) clr.hidden = !PED.sel.size;
}
function setPick(id, on) {
  id = String(id);
  if (on && !PED.sel.has(id)) {
    const used = new Set(PED.sel.values());
    PED.sel.set(id, PICK_COLOURS.find((c) => !used.has(c)) || PICK_COLOURS[PED.sel.size % PICK_COLOURS.length]);
  } else if (!on) PED.sel.delete(id);
  const c = PED.sel.get(id);
  $$(`.anc-table .ai[data-id="${id}"]`).forEach((el) => { el.classList.toggle("hl", !!c); if (c) el.style.setProperty("--hl", c); else el.style.removeProperty("--hl"); });
  $$(`.anc-pick[data-id="${id}"]`).forEach((cb) => { cb.checked = !!c; cb.parentNode.style.setProperty("--hl", c || "transparent"); });
  PED.ancGens.forEach((_, i) => { const rc = $("#anc-rc-" + (i + 1)); if (rc) rc.innerHTML = `${fNum(PED.ancGens[i].length)} / ${fNum(2 ** (i + 1))}${genHits(i + 1)}`; });
  drawPickLegend();
  const first = $(`.anc-table .ai[data-id="${id}"]`);
  if (on && first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function copyText(txt, note) {
  const done = () => { const el = $("#anc-copied"); if (el) { el.textContent = note; setTimeout(() => (el.textContent = ""), 2500); } };
  const fallback = () => { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
}
document.addEventListener("click", (e) => {
  const tg = e.target.closest("[data-gtg]");
  if (tg && PED && PED.ancGens) { const g = +tg.dataset.gtg; if (PED.open.has(g)) PED.open.delete(g); else PED.open.add(g); drawGenRow(g); return; }
  const ta = e.target.closest("[data-gtgall]");
  if (ta && PED && PED.ancGens) {
    PED.ancGens.forEach((_, i) => (ta.dataset.gtgall === "1" ? PED.open.add(i + 1) : PED.open.delete(i + 1)));
    PED.ancGens.forEach((_, i) => drawGenRow(i + 1));
    return;
  }
  if (e.target.id === "anc-clear" && PED && PED.sel) { [...PED.sel.keys()].forEach((id) => setPick(id, false)); return; }
  const t4 = e.target.closest("[data-tg4], [data-tg4all]");
  if (t4) {
    const tree = $("#tree4"); if (!tree) return;
    const hidden = new Set((tree.dataset.hide || "").split(",").filter(Boolean).map(Number));
    if (t4.dataset.tg4all !== undefined) { [1, 2, 3, 4].forEach((g) => (t4.dataset.tg4all === "1" ? hidden.delete(g) : hidden.add(g))); }
    else { const g = +t4.dataset.tg4; if (hidden.has(g)) hidden.delete(g); else hidden.add(g); }
    tree.dataset.hide = [...hidden].join(",");
    [1, 2, 3, 4].forEach((g) => tree.classList.toggle("hide-g" + g, hidden.has(g)));
    tree.style.gridTemplateColumns = [1, 2, 3, 4].map((g) => (hidden.has(g) ? "0px" : "minmax(0, 1fr)")).join(" ");
    tree.style.columnGap = hidden.size ? "6px" : "";
    const deepest = Math.max(0, ...[1, 2, 3, 4].filter((g) => !hidden.has(g)));
    tree.style.gridTemplateRows = `repeat(16, minmax(${{ 4: 34, 3: 18, 2: 10, 1: 6, 0: 0 }[deepest]}px, auto))`;
    tree.style.rowGap = deepest <= 2 ? "0px" : "";
    $$("[data-tg4]").forEach((b) => { const g = +b.dataset.tg4, on = !hidden.has(g); b.classList.toggle("off", !on); b.textContent = (on ? "▾ " : "▸ ") + b.textContent.slice(2); });
    let note = $("#tree4-note");
    if (hidden.size === 4) { if (!note) tree.insertAdjacentHTML("afterend", '<div id="tree4-note" class="empty">All generations hidden · click Expand all</div>'); }
    else if (note) note.remove();
    return;
  }
  if (e.target.id === "anc-copy" && PED && PED.ancGens) {
    const nm = (id) => { const n = PED.deep.nodes[String(id)]; return `${isNum(n.died) && !/^†/.test(n.name) ? "† " : ""}${n.name} ${yr(n.birth)}`; };
    copyText(`${PED.horse.name} — ${PED.deep.depth} generations\n` + PED.ancGens.map((l, i) => `Gen ${i + 1} (${l.length} / ${2 ** (i + 1)}): ` + l.map(([id, p]) => `${p}: ${nm(id)}`).join(" · ")).join("\n"),
      "Copied as text");
  }
  if (e.target.id === "anc-copy-tsv" && PED && PED.ancGens) {
    const lines = ["Gen\tPosition\tSex\tName\tBorn\tDied\tRecord\tEarnings\tHorse ID"];
    PED.ancGens.forEach((l, i) => l.forEach(([id, p]) => {
      const n = PED.deep.nodes[String(id)];
      lines.push([i + 1, p, p.endsWith("D") ? "Female" : "Male", n.name, yr(n.birth), isNum(n.died) ? yr(n.died) : "", n.starts ? `${n.wins}/${n.starts}` : "unraced", n.earnings || 0, id].join("\t"));
    }));
    copyText(lines.join("\n"), `Copied ${fNum(lines.length - 1)} rows — paste into a spreadsheet`);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.classList && e.target.classList.contains("anc-pick") && PED && PED.sel) { setPick(e.target.dataset.id, e.target.checked); return; }
  if (e.target.id !== "anc-col") return;
  ANC_COLOURS = e.target.checked;
  try { localStorage.setItem("hrm.ancColours", ANC_COLOURS ? "1" : "0"); } catch (err) { /* not remembered */ }
  const t = $(".anc-table"); if (t) t.classList.toggle("colours", ANC_COLOURS);
});

pedigreePage.after = (route) => {
  const id = route.parts[1], depth = pedGens(route.q || {});
  $$("[data-gens]", APP).forEach((b) => b.addEventListener("click", () => { APP.dataset.keep = "1"; go(["pedigree", id], { gens: b.dataset.gens }); }));
  fetch(`/api/coi/${id}?gens=${depth}`).then((r) => r.json()).then((j) => {
    const el = $("#coi-val");
    if (el && isNum(j.coi)) el.textContent = (100 * j.coi).toFixed(j.coi < 0.001 && j.coi > 0 ? 3 : 2) + "%";
  }).catch(() => { const el = $("#coi-val"); if (el) el.textContent = "—"; });
  if (!PED || !PED.deep) return;
  drawAncestorList();
  $$("[data-anc]", APP).forEach((b) => b.addEventListener("click", () => {
    $$("[data-anc]", APP).forEach((x) => x.classList.toggle("on", x === b));
    $("#anc-rep").hidden = b.dataset.anc !== "rep";
    $("#anc-all").hidden = b.dataset.anc !== "all";
  }));
};

// ------------------------------------------------------------------ v2: Horse table tab
async function horseTablePage(route) {
  const q = route.q;
  let chip = "";
  if (q.sire || q.dam) {
    const pid = q.sire || q.dam;
    let nm = "#" + pid;
    try { nm = (await api("pedigree/" + pid)).horse.name; } catch (e) { /* keep id */ }
    chip = `<span class="chip">${q.sire ? "Sire" : "Dam"}: ${esc(nm)} <a href="${hashFor(["horse-table"], { ...q, sire: "", dam: "" })}" title="Remove">✕</a></span>`;
  }
  if (q.stable) chip += `<span class="chip">Stable #${esc(q.stable)} <a href="${hashFor(["horse-table"], { ...q, stable: "" })}">✕</a></span>`;
  return listPage({
    title: "Horse table", noun: "horses", endpoint: "horse_table", defaultSort: "earnings",
    ascDefault: ["name", "gender", "stable", "sire", "dam"], exportName: "horse_table", wide: true,
    intro: "Click any column heading to sort. Export CSV downloads every matching horse, not just this page.",
    filters: (q) => searchBox(q, "Horse name") + `<input type="search" data-q="stableq" value="${esc(q.stableq || "")}" placeholder="Stable name">` +
      seg("status", q, [["alive", "Alive"], ["dead", "Deceased"], ["all", "All"]], "alive") +
      select("gender", q, [["", "Any sex"], ["Colt", "Colts"], ["Filly", "Fillies"], ["Stallion", "Stallions"], ["Mare", "Mares"], ["Gelding", "Geldings"]]) +
      `<label class="lbl">Age <input type="number" min="0" data-q="agemin" value="${esc(q.agemin || "")}" placeholder="min"> to <input type="number" min="0" data-q="agemax" value="${esc(q.agemax || "")}" placeholder="max"></label>` +
      select("minstarts", q, [["", "Any starts"], ["1", "Raced"], ["5", "5+ starts"], ["10", "10+ starts"], ["20", "20+ starts"]]) +
      select("stakes", q, [["", "All horses"], ["1", "Stakes winners only"]]) + chip,
    cols: [
      { h: "Horse", sort: "name", f: (r) => `${horseThumb(r.id)}${L.horse(r.id, r.name)}` },
      { h: "Sex", sort: "gender", f: (r) => esc(r.gender) },
      { h: "Age", sort: "birth", cls: "num", f: (r) => fNum(age(r.birth, r.died)) },
      { h: "Stable", sort: "stable", f: (r) => L.stable(r.stable_id, r.stable) },
      { h: "Sire", sort: "sire", f: (r) => L.horse(r.sire_id, r.sire) },
      { h: "Dam", sort: "dam", f: (r) => L.horse(r.dam_id, r.dam) },
      { h: "Rating", sort: "rating", cls: "num grp-start", f: (r) => fNum(r.rating) },
      { h: "Peak", sort: "peak", cls: "num", f: (r) => fNum(r.peak) },
      { h: "Starts", sort: "starts", cls: "num grp-start", f: (r) => fNum(r.starts) },
      { h: "Wins", sort: "wins", cls: "num", f: (r) => fNum(r.wins) },
      { h: "2nd", sort: "seconds", cls: "num", f: (r) => fNum(r.seconds) },
      { h: "3rd", sort: "thirds", cls: "num", f: (r) => fNum(r.thirds) },
      { h: "Win %", sort: "winpct", cls: "num", f: (r) => pct(r.wins, r.starts) },
      { h: "G1", sort: "g1", cls: "num grp-start", f: (r) => fNum(r.g1) },
      { h: "G2", sort: "g2", cls: "num", f: (r) => fNum(r.g2) },
      { h: "G3", sort: "g3", cls: "num", f: (r) => fNum(r.g3) },
      { h: "Listed", sort: "listed", cls: "num", f: (r) => fNum(r.listed) },
      { h: "Earnings", sort: "earnings", cls: "num grp-start", f: (r) => fMoney(r.earnings) },
      { h: "Value", sort: "value", cls: "num", f: (r) => fMoneyShort(r.value) },
      { h: "Form", f: (r) => esc(r.form || "") },
      { h: "Last run", sort: "last_run", cls: "num", f: (r) => fDate(r.last_run) },
      { h: "Distance", cls: "grp-start", f: (r) => esc({ S: "Sprint", M: "Mile", I: "Intermediate", L: "Long", E: "Extended" }[r.distance_pref] || r.distance_pref || "—") },
      { h: "Condition", sort: "condition", cls: "num", f: (r) => (isNum(r.condition) ? fNum(r.condition) + "%" : "—") },
      { h: "Breeding ability", sort: "breeding", cls: "num", f: (r) => fNum(r.breeding, 1) },
      { h: "Colour", f: (r) => esc(r.color || "") },
    ],
  }, route);
}

// ------------------------------------------------------------------ v2: Stable table tab
async function stableTablePage(route) {
  let countries = [];
  return listPage({
    title: "Stable table", noun: "stables", endpoint: "stable_table", defaultSort: "prestige", ascDefault: ["name", "owner", "country"],
    exportName: "stable_table", wide: true,
    intro: "Race figures cover every result recorded under each stable. Cash and net worth are from each stable's latest monthly report.",
    filters: (q, data) => searchBox(q, "Stable name") + seg("status", q, [["active", "Active"], ["all", "Include closed"]], "active") +
      select("country", q, [["", "Any country"]].concat((data.countries || countries).map((c) => [c, c]))) +
      select("minhorses", q, [["", "Any size"], ["1", "1+ horses"], ["5", "5+ horses"], ["10", "10+ horses"], ["25", "25+ horses"], ["50", "50+ horses"]]),
    cols: [
      { h: "Stable", sort: "name", f: (r) => `${L.stable(r.id, r.name)}${r.liquidated ? ' <span class="badge dead">Closed</span>' : ""}${r.id === (STATUS.player_stable || {}).id ? ' <span class="badge good">Yours</span>' : ""}` },
      { h: "Owner", sort: "owner", f: (r) => L.person(r.owner_id, r.owner) },
      { h: "Country", sort: "country", f: (r) => esc(r.country || "—") },
      { h: "Horses", sort: "horses", cls: "num grp-start", f: (r) => `<a href="#/horse-table?stable=${r.id}">${fNum(r.horses)}</a>` },
      { h: "Avg rating", sort: "avg_rating", cls: "num", f: (r) => fNum(r.avg_rating, 1) },
      { h: "Top rating", sort: "top_rating", cls: "num", f: (r) => fNum(r.top_rating) },
      { h: "Best horse", f: (r) => L.horse(r.top_horse_id, r.top_horse) },
      { h: "Horses' value", sort: "horses_value", cls: "num", f: (r) => fMoneyShort(r.horses_value) },
      { h: "Starts", sort: "starts", cls: "num grp-start", f: (r) => fNum(r.starts) },
      { h: "Wins", sort: "wins", cls: "num", f: (r) => fNum(r.wins) },
      { h: "2nds", sort: "seconds", cls: "num", f: (r) => fNum(r.seconds) },
      { h: "3rds", sort: "thirds", cls: "num", f: (r) => fNum(r.thirds) },
      { h: "Win %", sort: "winpct", cls: "num", f: (r) => pct(r.wins, r.starts) },
      { h: "G1", sort: "g1", cls: "num", f: (r) => fNum(r.g1) },
      { h: "G2", sort: "g2", cls: "num", f: (r) => fNum(r.g2) },
      { h: "G3", sort: "g3", cls: "num", f: (r) => fNum(r.g3) },
      { h: "Listed", sort: "listed", cls: "num", f: (r) => fNum(r.listed) },
      { h: "Stakes won", sort: "prize", cls: "num", f: (r) => fMoneyShort(r.prize) },
      { h: "Last runner", sort: "last_run", cls: "num", f: (r) => fDate(r.last_run) },
      { h: "Cash", sort: "cash", cls: "num grp-start", f: (r) => fMoneyShort(r.cash) },
      { h: "Net worth", sort: "net_worth", cls: "num", f: (r) => fMoneyShort(r.net_worth) },
      { h: "Share price", sort: "share_price", cls: "num", f: (r) => (isNum(r.share_price) ? "$" + fNum(r.share_price, 2) : "—") },
      { h: "Staff", sort: "staff", cls: "num grp-start", f: (r) => fNum(r.staff) },
      { h: "Courses", sort: "courses", cls: "num", f: (r) => fNum(r.courses) },
      { h: "Prestige", sort: "prestige", cls: "num", f: (r) => fNum(r.prestige, 1) },
      { h: "Level", sort: "level", cls: "num", f: (r) => fNum(r.level) },
      { h: "Founded", sort: "founded", cls: "num", f: (r) => yr(r.founded) },
    ],
  }, route);
}

// ------------------------------------------------------------------ global search
const searchInput = $("#search"), searchBoxEl = $("#search-results");
let searchSel = -1;
function closeSearch() { searchBoxEl.classList.remove("open"); searchSel = -1; }
const runSearch = debounce(async () => {
  const v = searchInput.value.trim();
  if (v.length < 2 || !STATUS || !STATUS.loaded) return closeSearch();
  try {
    const d = await api("search?q=" + encodeURIComponent(v));
    if (searchInput.value.trim() !== v) return;
    searchBoxEl.innerHTML = d.results.length ? d.results.map((r) =>
      `<a href="#/${r.type}/${r.id}"><span>${esc(r.name)}</span><span class="kind">${r.type === "course" ? "racecourse" : r.type}${r.extra ? " · " + esc(r.extra) : ""}</span></a>`).join("")
      : `<div class="empty" style="padding:10px 12px">No matches</div>`;
    searchBoxEl.classList.add("open"); searchSel = -1;
  } catch (e) { closeSearch(); }
}, 250);
searchInput.addEventListener("input", runSearch);
searchInput.addEventListener("keydown", (e) => {
  const items = $$("a", searchBoxEl);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    searchSel = (searchSel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((a, i) => a.classList.toggle("sel", i === searchSel));
  } else if (e.key === "Enter") {
    const a = items[searchSel >= 0 ? searchSel : 0];
    if (a) { location.hash = a.getAttribute("href"); searchInput.value = ""; searchInput.blur(); closeSearch(); }
  } else if (e.key === "Escape") { closeSearch(); searchInput.blur(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) closeSearch();
  else if (e.target.closest(".search-results a")) { searchInput.value = ""; closeSearch(); }
});

// ------------------------------------------------------------------ load new database
function openLoad() {
  const last = STATUS && STATUS.last_path;
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "load-ov";
  ov.innerHTML = `<div class="modal"><h2>Load a new database</h2>
    <p class="muted">Loading a newer <code>database.db</code> updates the stored data: records in the new file replace the older versions, and history the game has deleted since (old results, transactions, news…) is kept. The stored data stays as it is until the new file has been checked.</p>
    <div class="warn">Save your game first so the newest information is in the file.</div>
    <div id="load-form">
      <h3>Load into</h3>
      <div class="load-into"><label><input type="radio" name="load-into" value="cur" checked> This database: <b>${esc((STATUS && STATUS.db && STATUS.db.name) || "current")}</b></label>
        <label><input type="radio" name="load-into" value="new"> A new database named <input type="text" id="load-newname" placeholder="e.g. Second career" style="width:220px"></label></div>
      <p class="help">Use a new database for a different save, so each save keeps its own history. You can switch between them on the <a href="#/databases" onclick="document.getElementById('load-ov').remove()">Databases</a> page.</p>
      <h3>From its location on this computer (recommended)</h3>
      <div class="row"><input type="text" id="load-path" value="${esc(last || "")}" placeholder="C:\\Users\\you\\...\\database.db"><button class="btn primary" id="load-path-btn">Load</button></div>
      <p class="help">Paste the full path to <code>database.db</code>, or to the folder it's in. It's remembered, so next time you can just press Load. To get the path in File Explorer, hold Shift, right-click the file and choose “Copy as path”.</p>
      <div class="or">or</div>
      <h3>Choose the file</h3>
      <input type="file" id="load-file" accept=".db,.sqlite,.sqlite3,application/octet-stream">
      <p class="help">Use this if you don't know where the file is. A 1 GB file takes a little longer this way.</p>
      <label class="small" style="display:block;margin-top:12px"><input type="checkbox" id="load-fresh"> Start fresh: throw away the stored data, including records kept from earlier loads, and keep only this file</label>
    </div>
    <div id="load-confirm" style="display:none"></div>
    <div id="load-progress" style="display:none"><div class="progress"><div id="load-bar"></div></div><div id="load-step" class="muted"></div></div>
    <div id="load-err"></div>
    <div style="text-align:right;margin-top:14px"><button class="btn" id="load-close">Close</button></div></div>`;
  document.body.appendChild(ov);
  const showErr = (m) => { $("#load-err").innerHTML = m ? `<div class="err">${esc(m)}</div>` : ""; };
  const busy = (on) => { $("#load-form").style.display = on ? "none" : ""; $("#load-progress").style.display = on ? "" : "none"; };
  const setP = (pct, step) => { $("#load-bar").style.width = pct + "%"; if (step) $("#load-step").textContent = step; };
  $("#load-close").onclick = () => ov.remove();
  const newDbName = () => {
    const pick = document.querySelector('input[name="load-into"]:checked');
    if (!pick || pick.value !== "new") return "";
    const n = $("#load-newname").value.trim();
    if (!n) { showErr("Type a name for the new database."); $("#load-newname").focus(); return false; }
    return n;
  };
  $("#load-newname").addEventListener("focus", () => { document.querySelector('input[name="load-into"][value="new"]').checked = true; });
  const poll = async () => {
    const s = await (await fetch("/api/import/progress")).json();
    setP(s.pct, s.step + "…");
    if (s.state === "running") return setTimeout(poll, 700);
    if (s.state === "error") { busy(false); showErr(s.error); return; }
    if (s.state === "confirm" && s.confirm) {
      $("#load-progress").style.display = "none";
      const box = $("#load-confirm");
      box.style.display = "";
      box.innerHTML = `<div class="warn"><b>${esc(s.confirm.message)}</b><br>What would you like to do?</div>
        <div style="display:grid;gap:8px">${s.confirm.options.map(([code, label], i) =>
          `<button class="btn ${i === 0 && code !== "cancel" ? "primary" : ""}" data-decision="${code}" style="text-align:left">${esc(label)}</button>`).join("")}</div>`;
      $$("[data-decision]", box).forEach((b) => (b.onclick = async () => {
        const decision = b.dataset.decision;
        const r = await fetch("/api/import/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
        box.style.display = "none"; box.innerHTML = "";
        if (decision === "cancel" || !r.ok) { busy(false); if (!r.ok) showErr((await r.json()).error); return; }
        $("#load-progress").style.display = ""; setP(0, "Continuing…"); poll();
      }));
      return;
    }
    if (s.state !== "done") { busy(false); return; }
    const res = s.result || {};
    const how = res.mode === "fresh" ? "Loaded as a fresh start." : res.mode === "merge_old" ? "Added the records the stored data was missing." : "Updated with the newer save.";
    setP(100, `Done. ${how}${res.kept ? ` Kept ${fNum(res.kept)} older records the new file no longer has.` : ""}`);
    TABLES_CACHE = null;
    await refreshStatus();
    setTimeout(() => { ov.remove(); if (location.hash === "#/databases") location.hash = "#/"; else render(); }, res.kept ? 2600 : 900);
  };
  $("#load-path-btn").onclick = async () => {
    showErr("");
    const path = $("#load-path").value.trim();
    if (!path) return showErr("Paste the path to database.db first.");
    const nd = newDbName();
    if (nd === false) return;
    const r = await fetch("/api/import/path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, fresh: $("#load-fresh").checked, new_db: nd || undefined }) });
    const j = await r.json();
    if (!r.ok) return showErr(j.error);
    busy(true); setP(0, "Starting…"); poll();
  };
  $("#load-file").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const nd = newDbName();
    if (nd === false) { e.target.value = ""; return; }
    showErr(""); busy(true); setP(0, "Sending the file to the viewer…");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import/upload");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(f.name));
    if ($("#load-fresh").checked) xhr.setRequestHeader("X-Fresh", "1");
    if (nd) xhr.setRequestHeader("X-New-Db", encodeURIComponent(nd));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) setP(Math.round((40 * ev.loaded) / ev.total), `Sending the file to the viewer… ${Math.round((100 * ev.loaded) / ev.total)}%`); };
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch (er) { /* ignore */ }
      if (xhr.status >= 300) { busy(false); showErr(j.error || "Upload failed."); return; }
      poll();
    };
    xhr.onerror = () => { busy(false); showErr("The upload failed. Is the viewer window still open?"); };
    xhr.send(f);
  };
}
window.openLoad = openLoad;
$("#load-btn").addEventListener("click", openLoad);

// ------------------------------------------------------------------ table text size
const TS_SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20];
const TS_DEFAULT = 13;
function getTableSize() {
  try { const v = parseFloat(localStorage.getItem("hrm.tableTextSize")); return TS_SIZES.includes(v) ? v : TS_DEFAULT; } catch (e) { return TS_DEFAULT; }
}
function setTableSize(v) {
  document.documentElement.style.setProperty("--tf", v + "px");
  if ($("#ts-val")) {
    $("#ts-val").textContent = v + "px";
    $("#ts-down").disabled = v <= TS_SIZES[0];
    $("#ts-up").disabled = v >= TS_SIZES[TS_SIZES.length - 1];
    $("#ts-reset").disabled = v === TS_DEFAULT;
  }
  try { localStorage.setItem("hrm.tableTextSize", String(v)); } catch (e) { /* not saved, still applied */ }
}
function stepTableSize(dir) {
  const cur = getTableSize(), i = TS_SIZES.indexOf(cur);
  setTableSize(TS_SIZES[Math.max(0, Math.min(TS_SIZES.length - 1, i + dir))]);
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("#ts-down, #ts-up, #ts-reset");
  if (!t) return;
  if (t.id === "ts-down") stepTableSize(-1); else if (t.id === "ts-up") stepTableSize(1); else setTableSize(TS_DEFAULT);
});
setTableSize(getTableSize());

// ------------------------------------------------------------------ viewer updates
function toggleHoverCards() {
  HOVER_CARDS = !HOVER_CARDS;
  try { localStorage.setItem("hrm.hoverCards", HOVER_CARDS ? "1" : "0"); } catch (e) { /* session only */ }
  hideCard(); renderFooter();
}
window.toggleHoverCards = toggleHoverCards;
function renderFooter() {
  const a = (STATUS && STATUS.app) || {};
  $("#foot").innerHTML = a.version ? `<a href="#/versions" title="Versions and what changed">HRM Viewer version ${esc(a.version)}</a> · <a href="#/versions">Versions &amp; changes</a>
    · <a href="#/settings">Settings</a>` : "";
}
function updateBanner() {
  const lu = STATUS && STATUS.app && STATUS.app.last_update;
  if (!lu || !lu.at || Date.now() / 1000 - lu.at > 3 * 86400) return "";
  try { if (localStorage.getItem("hrm.updateSeen") === String(lu.at)) return ""; } catch (e) { /* show it */ }
  return `<div class="banner ${lu.ok ? "" : "bad"}" id="upd-banner"><span>${lu.ok ? "✓ " : "⚠ "}${esc(lu.message)}</span>
    <button class="btn" onclick="try{localStorage.setItem('hrm.updateSeen','${lu.at}')}catch(e){};this.parentNode.remove()">OK</button></div>`;
}
async function waitForVersion(target, setMsg) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - start < 90000) {
    try {
      const s = await (await fetch("/api/status", { cache: "no-store" })).json();
      if (s.app && s.app.version === target) { location.reload(); return; }
      if (s.app && s.app.last_update && s.app.last_update.ok === false && s.app.last_update.at * 1000 > start) { location.reload(); return; }
    } catch (e) { /* still restarting */ }
    setMsg("Restarting the viewer…");
    await new Promise((r) => setTimeout(r, 1000));
  }
  setMsg("The viewer is taking a while to restart. Check its window, then refresh this page.");
}
// the install-an-update steps: drawn in the pop-up window (footer, Versions page) and on the Settings page, so both are the same
function updateIntro() {
  const a = (STATUS && STATUS.app) || {};
  return `<p class="muted">You have version <b>${esc(a.version || "?")}</b>. Updates only replace the viewer's program files: your stored data,
    load history and settings are never touched. The current version is backed up first, and if a new version doesn't start, the viewer puts the old one back by itself.</p>`;
}
function openUpdate(rollback, backupName) {
  $("#upd-ov") && $("#upd-ov").remove();
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "upd-ov";
  ov.innerHTML = `<div class="modal"><h2>${rollback ? "Go back to the previous version" : "Install an update"}</h2>${updateIntro()}
    <div class="upd-box"></div>
    <div style="text-align:right;margin-top:14px"><button class="btn" id="upd-close">Close</button></div></div>`;
  document.body.appendChild(ov);
  $("#upd-close").onclick = () => ov.remove();
  drawUpdate($(".upd-box", ov), rollback, backupName);
}
function drawUpdate(box, rollback, backupName) {
  const a = (STATUS && STATUS.app) || {};
  const back = (a.backups || []).find((b) => b.name === backupName) || (a.backups || [])[0];
  box.innerHTML = `<div class="upd-body"></div><div class="upd-err"></div>`;
  const body = $(".upd-body", box);
  const err = (m) => ($(".upd-err", box).innerHTML = m ? `<div class="err">${esc(m)}</div>` : "");
  const working = (m) => { body.innerHTML = `<div class="progress"><div style="width:100%;animation:none"></div></div><div class="muted">${esc(m)}</div>`; };
  const after = (j) => {
    if (j.restarting) { working("Installed. Restarting the viewer…"); waitForVersion(j.version, (m) => working(m)); }
    else working("Installed. Close the viewer's window and start it again with Start.bat to finish.");
  };
  if (rollback) {
    if (!back) { body.innerHTML = '<div class="empty">There is no earlier version to go back to.</div>'; return; }
    body.innerHTML = `<div class="upd-info">Go back to version <b>${esc(back.version)}</b>, backed up ${new Date(back.made * 1000).toLocaleString("en-NZ")}.
      Your current version (${esc(a.version)}) is saved first, so you can come back to it from the Versions page.</div>
      <button class="btn primary upd-go">Go back to version ${esc(back.version)}</button>`;
    $(".upd-go", body).onclick = async () => {
      err(""); working("Putting the previous version back…");
      const r = await fetch("/api/update/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: back.name }) }); const j = await r.json();
      if (!r.ok) { err(j.error); body.innerHTML = ""; return; }
      after(j);
    };
    return;
  }
  body.innerHTML = `<h3>Choose the update file</h3><input type="file" class="upd-file" accept=".zip">
    <p class="help">It's the <code>HRM-Viewer-update-…zip</code> file. There's no need to unzip it.</p>`;
  $(".upd-file", body).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    err("");
    const buf = await f.arrayBuffer();
    const r = await fetch("/api/update?check=1", { method: "POST", body: buf }); const j = await r.json();
    if (!r.ok) { err(j.error); return; }
    body.innerHTML = `<div class="upd-info">Install version <b>${esc(j.version)}</b> (you have ${esc(j.current)}).
      ${j.older ? "<br><b>This is an older version than the one you have.</b>" : j.same ? "<br>This is the version you already have; installing it again is harmless." : ""}
      ${j.notes ? `<div class="notes">${esc(j.notes)}</div>` : ""}</div>
      <button class="btn primary upd-go">Install version ${esc(j.version)}</button>`;
    $(".upd-go", body).onclick = async () => {
      err(""); working("Installing…");
      const r2 = await fetch("/api/update", { method: "POST", body: buf }); const j2 = await r2.json();
      if (!r2.ok) { err(j2.error); body.innerHTML = ""; return; }
      after(j2);
    };
  };
}
window.openUpdate = openUpdate;
// every "Install an update" button and link (Settings, the bottom of the page, Versions & changes) opens this one pop-up
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open-update]");
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  openUpdate();
}, true);

// ------------------------------------------------------------------ versions page
async function versionsPage() {
  const a = (STATUS && STATUS.app) || {};
  let log = [];
  try { log = await (await fetch("/changelog.json", { cache: "no-store" })).json(); } catch (e) { /* show the rest */ }
  const backups = a.backups || [];
  const lu = a.last_update;
  const cur = version_tuple(a.version);
  let html = settingsTabs("versions") + `<div class="page-head"><div><h1>Versions</h1><div class="sub">You have HRM Viewer version <b>${esc(a.version || "?")}</b>
    ${lu && lu.ok ? ` · last change ${new Date(lu.at * 1000).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</div></div>
    <button class="btn primary" data-open-update>Install an update</button></div>`;
  html += panel("Go back to an earlier version", backups.length ? table([
    { h: "Version", f: (b) => `<b>${esc(b.version)}</b>` },
    { h: "Saved", cls: "nowrap", f: (b) => new Date(b.made * 1000).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
    { h: "", f: (b) => `<button class="btn" data-back="${esc(b.name)}">Go back to version ${esc(b.version)}</button>` },
  ], backups) : '<div class="empty">No earlier versions are saved yet. One is saved automatically each time you install an update.</div>',
    "Earlier versions saved when you installed updates · your data isn't affected");
  html += `<div style="margin-top:16px">` + panel("What changed in each version", log.length ? `<div class="changelog">${log.map((v) => {
    const vt = version_tuple(v.version);
    const tag = cmpVer(vt, cur) === 0 ? '<span class="badge good">Installed</span>' : cmpVer(vt, cur) > 0 ? '<span class="badge listed">Newer</span>' : "";
    return `<div class="cl-item ${cmpVer(vt, cur) === 0 ? "cl-cur" : ""}"><div class="cl-head"><b>Version ${esc(v.version)}</b> <span>${esc(v.title || "")}</span> ${tag}
      <span class="muted small">${esc(v.date ? new Date(v.date + "T00:00:00Z").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "")}</span></div>
      <ul>${(v.changes || []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`;
  }).join("")}</div>` : '<div class="empty">No change list found.</div>') + `</div>`;
  return html;
}
versionsPage.after = () => {
  $$("[data-back]", APP).forEach((b) => b.addEventListener("click", () => openUpdate(true, b.dataset.back)));
};
function version_tuple(v) { return String(v || "0").split(".").map((x) => parseInt(x, 10) || 0); }
function cmpVer(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// ------------------------------------------------------------------ automatic updates: watch for new data
let AUTO_LAST = null, AUTO_TIMER = null;
async function autoPoll(soon) {
  clearTimeout(AUTO_TIMER);
  let a = null;
  try { a = await (await fetch("/api/auto")).json(); } catch (e) { /* viewer not reachable */ }
  if (a) {
    const ind = $("#auto-ind");
    if (ind) {
      const on = a.settings && a.settings.enabled;
      ind.hidden = !on && a.state !== "updating";
      ind.className = "auto-ind " + (a.state || "");
      ind.title = on ? `Automatic updates on · ${a.message || ""}` : "";
      ind.innerHTML = a.state === "updating" || a.job === "running" && a.running ? '<span class="spin"></span> Updating' : "● Auto";
    }
    if (AUTO_LAST && a.db === AUTO_LAST.db && a.loaded_at && a.loaded_at !== AUTO_LAST.loaded_at && !$("#load-ov")) {
      await refreshStatus();
      CARD_CACHE.clear(); TABLES_CACHE = null;
      $("#db-banner").insertAdjacentHTML("afterbegin", `<div class="banner" id="auto-banner"><span>✓ Updated from your save — game date <b>${fDate(a.game_date)}</b>.</span>
        <span><button class="btn primary" onclick="document.getElementById('auto-banner').remove();render()">Show the new data</button>
        <button class="btn" onclick="this.closest('.banner').remove()">Later</button></span></div>`);
      if ($("#auto-box")) drawAutoBox();
    }
    AUTO_LAST = a;
  }
  const fast = a && (a.state === "updating" || a.state === "waiting" || a.running);
  AUTO_TIMER = setTimeout(autoPoll, soon || fast ? 2500 : 10000);
}
document.addEventListener("click", (e) => { if (e.target.closest("#auto-ind")) location.hash = "#/settings"; });

// ------------------------------------------------------------------ export any table to CSV
function tableToCsv(tbl) {
  const clean = (el) => (el.offsetParent !== null ? el.innerText : el.textContent).replace(/[▲▼▸▾⤓]/g, "").replace(/\s*\n\s*(of \d)/g, " $1").replace(/\s*\n\s*/g, " · ").replace(/\s+/g, " ").trim();
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = [...tbl.tHead.rows[0].cells].map(clean);
  const keep = head.map((h) => h !== "");
  const lines = [head.filter((_, i) => keep[i]).map(q).join(",")];
  for (const tr of tbl.tBodies[0] ? tbl.tBodies[0].rows : []) {
    if (tr.cells.length === 1 && tr.cells[0].colSpan > 1) continue;   // fold-out form panels
    lines.push([...tr.cells].filter((_, i) => keep[i]).map((td) => q(td.dataset.csv !== undefined ? td.dataset.csv : clean(td))).join(","));
  }
  return "\ufeff" + lines.join("\r\n");
}
function csvName(tbl) {
  const p = tbl.closest(".panel"), h2 = p && p.querySelector(".panel-head h2"), h1 = $("#app h1");
  const name = [h1 && h1.innerText, h2 && h2.innerText].filter(Boolean).join(" - ") || "table";
  return name.replace(/[\\/:*?"<>|▾▸]+/g, "").replace(/\s+/g, " ").trim().slice(0, 90) + ".csv";
}
// one export button per table: in the panel's heading when the panel holds just that table, otherwise just above it.
// List pages already have "Export CSV" at the top (every matching row), so their table doesn't get a second one.
const ICON_DL = `<svg class="ic-dl" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L4.8 6.8M8 10l3.2-3.2M3 13h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function addCsvButtons(root) {
  const pageExport = root.querySelector("a.btn-csv[href^='/api/export/']");
  for (const tbl of root.querySelectorAll("table.data:not([data-csv]), table.raw-grid:not([data-csv])")) {
    tbl.dataset.csv = "1";
    if (!tbl.tHead || !tbl.tHead.rows.length) continue;
    if (tbl.parentElement.closest("table")) continue;      // a small table folded out inside another table's row
    const own = tbl.parentElement;
    const wrap = own && own.matches(".tbl-wrap, .wide-wrap, .grid-scroll") ? own : tbl;
    if (wrap.previousElementSibling && wrap.previousElementSibling.classList.contains("csv-bar")) continue;
    const paged = !!(wrap.parentNode && wrap.parentNode.querySelector(":scope > .pager"));
    const nRows = tbl.tBodies[0] ? [...tbl.tBodies[0].rows].filter((r) => !(r.cells.length === 1 && r.cells[0].colSpan > 1)).length : 0;
    // long tables scroll inside themselves with the headings kept in view
    if (wrap.classList.contains("tbl-wrap") && nRows > 30 && !tbl.closest(".panel.tall, .rpanel, .hcard")) wrap.classList.add("long");
    if (paged && pageExport) continue;
    const btn = document.createElement("button");
    btn.className = "btn btn-csv sm"; btn.type = "button";
    btn.innerHTML = ICON_DL + "CSV";
    btn.dataset.tip = paged ? "Download the rows on this page as a spreadsheet (CSV) file" : "Download this table as a spreadsheet (CSV) file";
    btn.onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([tableToCsv(tbl)], { type: "text/csv;charset=utf-8" }));
      a.download = csvName(tbl); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    // a quick filter for tables with plenty of rows (not those with their own filters)
    let tool = btn;
    if (nRows >= 25 && tbl.classList.contains("data") && !tbl.matches(".nofilter, .fin-detail, .hm-table, .fc-table, .fy, .fd-pay")) {
      tool = document.createElement("span");
      tool.className = "tbl-tools";
      tool.innerHTML = `<span class="tf"><input type="search" class="tbl-filter" placeholder="Filter rows…" aria-label="Filter rows"><span class="tf-n muted small"></span></span>`;
      tool.querySelector("input")._tbl = tbl;
      tool.appendChild(btn);
    }
    const panel = tbl.closest(".panel"), head = panel && panel.querySelector(":scope > .panel-head");
    const alone = panel && [...panel.querySelectorAll("table.data, table.raw-grid")].filter((t) => !t.parentElement.closest("table")).length === 1;
    const prev = wrap.previousElementSibling;
    const intoHead = (h) => {   // the panel's heading row, on the right
      let right = h.querySelector(":scope > .ph-right");
      if (!right) {
        right = document.createElement("div"); right.className = "ph-right";
        const note = h.querySelector(":scope > .note"); if (note) right.appendChild(note);
        h.appendChild(right);
      }
      right.appendChild(tool);
    };
    if (head && alone && !head.querySelector(".btn-csv")) { intoHead(head); continue; }
    if (prev && prev.classList.contains("panel-head") && !prev.querySelector(".btn-csv")) { intoHead(prev); continue; }
    if (prev && (/^H[2-4]$/.test(prev.tagName) || prev.classList.contains("rp-h")) && !prev.querySelector(".btn-csv")) {   // on the table's own heading line
      prev.classList.add("csv-h"); prev.appendChild(tool);
      continue;
    }
    const bar = document.createElement("div");
    bar.className = "csv-bar"; bar.appendChild(tool);
    wrap.parentNode.insertBefore(bar, wrap);
  }
}
new MutationObserver(() => addCsvButtons(APP)).observe(APP, { childList: true, subtree: true });
// quick filter: hide rows that don't contain the text (a row's fold-out goes with it); Esc clears
function filterTable(inp) {
  const tbl = inp._tbl, q = inp.value.trim().toLowerCase();
  if (!tbl || !tbl.tBodies[0]) return;
  let shown = 0, total = 0, keep = true;
  for (const tr of tbl.tBodies[0].rows) {
    const fold = tr.cells.length === 1 && tr.cells[0].colSpan > 1;
    if (fold) { if (!keep) tr.hidden = true; continue; }
    total++;
    keep = !q || tr.innerText.toLowerCase().includes(q);
    tr.classList.toggle("tf-out", !keep);
    if (keep) shown++;
  }
  tbl.classList.toggle("filtering", !!q);
  inp.parentNode.querySelector(".tf-n").textContent = q ? `${fNum(shown)} of ${fNum(total)}` : "";
}
document.addEventListener("input", (e) => { if (e.target.classList && e.target.classList.contains("tbl-filter")) filterTable(e.target); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.classList && e.target.classList.contains("tbl-filter")) { e.target.value = ""; filterTable(e.target); } });

// ------------------------------------------------------------------ awards (season awards; Group and Listed race wins are left out)
async function awardsPage(q) {
  const d = await api("awards");
  const view = q.view || "years", grp = q.group || "all";
  const mine = new Set(((STATUS && STATUS.my_stables) || []).map((x) => x.id));
  const meId = (STATUS && STATUS.player || {}).id;
  const linkFor = (x) => (x.etype === "horse" ? L.horse(x.eid, x.name) : x.etype === "person" ? L.person(x.eid, x.name) : L.stable(x.eid, x.name));
  const isMine = (x) => (x.etype === "person" && x.eid === meId) || (x.etype === "stable" && mine.has(x.eid)) || (x.stable_id && mine.has(x.stable_id) && x.etype === "horse");
  const tabs = `<div class="filters" style="margin-bottom:12px">${seg("view", q, [["years", "Year by year"], ["winners", "Most awards"]], "years")}
    ${view === "years" ? select("group", q, [["all", "All awards"]].concat(d.groups.map((g) => [g.key, g.title]))) : ""}
    <span class="help">Season awards only — Group 1, 2, 3 and Listed race wins are not included. Your own wins are highlighted.</span></div>`;
  let html = `<div class="page-head"><div><h1>Awards</h1><div class="sub">Winners of the season awards, year on year${d.years.length ? ` · ${d.years[d.years.length - 1]}–${d.years[0]}` : ""}</div></div></div>`;
  html += `<section class="panel">${tabs}`;
  if (!d.groups.length) return html + `<div class="empty">No awards in this database.</div></section>`;
  if (view === "winners") {
    html += table([
      { h: "#", cls: "num", f: (x) => fNum(d.winners.indexOf(x) + 1) },
      { h: "Winner", f: (x) => `${linkFor({ etype: x.etype, eid: x.id, name: x.name })} <span class="muted small">${x.etype}</span>` },
      { h: "Awards won", cls: "num", f: (x) => `<b>${fNum(x.wins)}</b>` },
      { h: "Which", f: (x) => x.awards.map(([n, c]) => `${esc(n)}${c > 1 ? ` ×${c}` : ""}`).join(" · ") },
      { h: "Years", f: (x) => esc(x.years.join(", ")) },
    ], d.winners.slice(0, 300), { rowClass: (x) => (isMine({ etype: x.etype, eid: x.id }) ? "me" : "") });
    return html + `<div class="help">Counts first places only (Hall of Fame nominations and Worst Horse of the Year aren't counted).</div></section>`;
  }
  html += `</section>`;
  for (const g of d.groups.filter((g) => grp === "all" || g.key === grp)) {
    const ys = d.years.filter((y) => g.awards.some((a) => a.years[String(y)]));
    const multi = g.key === "hof";
    const cell = (a, y) => {
      const list = a.years[String(y)] || [];
      if (!list.length) return '<span class="muted">—</span>';
      if (multi) return list.map((x) => `<div class="aw ${isMine(x) ? "aw-me" : ""}" title="${esc(x.description || "")}">${linkFor(x)}</div>`).join("");
      const w = list.find((x) => (x.rank || 1) === 1) || list[0];
      const rest = list.filter((x) => x !== w);
      const tip = [w.description, ...rest.map((x) => `${ord(x.rank)}: ${x.name}${x.value ? " (" + fMoneyShort(x.value) + ")" : ""}`)].filter(Boolean).join("\n");
      return `<div class="aw ${isMine(w) ? "aw-me" : ""}" title="${esc(tip)}">${linkFor(w)}
        <div class="aw-sub">${w.stable ? esc(w.stable) : ""}${w.value ? `${w.stable ? " · " : ""}${fMoneyShort(w.value)}` : ""}${rest.length ? ` · <span class="muted">+${rest.length} runner${rest.length > 1 ? "s" : ""}-up</span>` : ""}</div></div>`;
    };
    html += `<div style="margin-top:16px">` + panel(g.title, table([{ h: "Award", cls: "nowrap", f: (a) => `<b>${esc(a.label)}</b>` }]
      .concat(ys.map((y) => ({ h: String(y), f: (a) => cell(a, y) }))), g.awards, { wide: ys.length > 5 }),
      g.key === "hof" ? "Inductees and nominees each year" : "Hover a winner for the award details and runners-up") + `</div>`;
  }
  return html;
}

// ------------------------------------------------------------------ dark mode
// Builds the dark version of every rule in app.css that uses a light colour: backgrounds become dark,
// dark text becomes light, light borders become dim. Done once when the page loads, so new styles follow automatically.
function hexRgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, sat, l];
}
function hslRgb(h, sat, l) {
  if (!sat) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}
function darkColour(rgb, a, kind) {
  let [h, sat, l] = rgbHsl(...rgb);
  if (kind === "bg") {
    if (l >= 0.85) { l = 0.11 + (1 - l) * 0.9; sat = Math.min(sat, 0.3); }
    else if (l >= 0.6) { l = 0.2 + (0.85 - l) * 0.3; sat *= 0.7; }
    else return null;
  } else if (kind === "fg") {
    if (l < 0.4) l = 0.9 - l * 0.5;
    else if (l < 0.62) l = Math.max(l, 0.7);
    else return null;
  } else {
    if (l >= 0.7) { l = 0.24 + (1 - l) * 0.3; sat = Math.min(sat, 0.3); }
    else return null;
  }
  const [r, g, b] = hslRgb(h, sat, l);
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
}
function darkValue(val, kind) {
  let changed = false;
  let out = val.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(([^)]+)\)/g, (m, inner) => {
    let rgb, a = 1;
    if (m[0] === "#") rgb = hexRgb(m);
    else { const p = inner.split(/[ ,/]+/).filter(Boolean).map(Number); rgb = p.slice(0, 3); if (p.length > 3) a = p[3]; }
    const d = darkColour(rgb, a, kind);
    if (!d) return m;
    changed = true; return d;
  });
  if (kind === "fg" && /var\(--navy\)/.test(out)) { out = out.replace(/var\(--navy\)/g, "#d6e4ff"); changed = true; }
  return changed ? out : null;
}
function darkRules(rules) {
  let css = "";
  for (const r of rules) {
    if (r.type === CSSRule.MEDIA_RULE) { const inner = darkRules(r.cssRules); if (inner) css += `@media ${r.conditionText || r.media.mediaText} {${inner}}\n`; continue; }
    if (r.type !== CSSRule.STYLE_RULE || !r.selectorText || r.selectorText.startsWith("html.dark")) continue;
    let decl = "";
    for (let i = 0; i < r.style.length; i++) {
      const prop = r.style[i];
      if (prop.startsWith("--")) continue;
      const kind = /^background/.test(prop) ? "bg" : prop === "color" || prop === "fill" || prop === "caret-color" ? "fg" : /^(border|outline|box-shadow|stroke|text-decoration)/.test(prop) ? "line" : null;
      if (!kind) continue;
      const v = darkValue(r.style.getPropertyValue(prop), kind);
      if (v) decl += `${prop}: ${v}${r.style.getPropertyPriority(prop) ? " !important" : ""}; `;
    }
    if (!decl) continue;
    const sel = r.selectorText.split(",").map((x) => {
      x = x.trim();
      if (x.startsWith(":root")) return "html.dark";
      if (/^html\b/.test(x)) return x.replace(/^html/, "html.dark");
      return "html.dark " + x;
    }).join(", ");
    css += `${sel} { ${decl}}\n`;
  }
  return css;
}
function buildDarkCss() {
  if ($("#dark-css")) return;
  let css = "";
  for (const sh of document.styleSheets) {
    if (!sh.href || !/\/app\.css/.test(sh.href)) continue;
    try { css += darkRules(sh.cssRules); } catch (e) { /* not readable */ }
  }
  const st = document.createElement("style");
  st.id = "dark-css"; st.textContent = css;
  document.head.appendChild(st);
}
buildDarkCss();
function themeMode() { try { return localStorage.getItem("hrm.theme") || "light"; } catch (e) { return "light"; } }
function applyTheme(mode) {
  const dark = mode === "dark" || (mode === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  if (window.hrmColours) window.hrmColours();   // each mode has its own custom colours
  if ($("#colour-box")) drawColours();
}
// ------------------------------------------------------------------ your own colours (Settings > Colours), one set for light mode and one for dark
const COLOUR_KEYS = [["accent", "Accent", "Buttons, links, selected tabs", "--blue"], ["header", "Top bar", "The bar across the top", "--header"],
  ["heading", "Headings", "Big numbers and section titles", "--heading"], ["bg", "Page background", "Behind the cards", "--bg"],
  ["panel", "Cards", "Panels, tables and menus", "--panel"], ["line", "Lines", "Borders and table lines", "--line"], ["win", "Winning rows", "Rows for wins", "--win"]];
const COLOUR_PRESETS = {
  light: [["Standard", {}], ["Racing green", { accent: "#1f7a4d", header: "#0f3b2a", heading: "#0f3b2a" }], ["Royal purple", { accent: "#6b46c1", header: "#2d1b5e", heading: "#2d1b5e" }],
    ["Crimson", { accent: "#b91c1c", header: "#3b0a0a", heading: "#5a1010" }], ["Ocean", { accent: "#0e7490", header: "#073a4b", heading: "#073a4b" }],
    ["Warm", { accent: "#c2410c", header: "#3a2414", heading: "#3a2414", bg: "#f4efe7" }], ["Light top bar", { header: "#ffffff", bg: "#eef1f5" }]],
  dark: [["Standard", {}], ["Racing green", { accent: "#4cc38a", header: "#0c2a1e", heading: "#c9f0dc" }], ["Royal purple", { accent: "#a78bfa", header: "#1f1340", heading: "#e4dcff" }],
    ["Crimson", { accent: "#ff6b6b", header: "#2a0c0c", heading: "#ffd9d9" }], ["Ocean", { accent: "#38bdf8", header: "#06283a", heading: "#d3f1ff" }],
    ["Warm", { accent: "#fb923c", header: "#2a1a0e", heading: "#ffe6cf" }], ["Black", { header: "#000000", bg: "#000000", panel: "#0d0f14", line: "#1f2430" }]],
};
function colourMode() { return document.documentElement.classList.contains("dark") ? "dark" : "light"; }
function getColours() { try { return JSON.parse(localStorage.getItem("hrm.colours") || "{}"); } catch (e) { return {}; } }
function setColours(mode, c) {
  const all = getColours();
  if (c && Object.keys(c).length) all[mode] = c; else delete all[mode];
  try { localStorage.setItem("hrm.colours", JSON.stringify(all)); } catch (e) { /* this session only */ }
  if (window.hrmColours) window.hrmColours();
}
// the colour now in use, as #rrggbb (for the colour pickers)
function cssHex(v) {
  const probe = document.createElement("span");
  probe.style.color = `var(${v})`; document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || [0, 0, 0];
  probe.remove();
  return "#" + m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, "0")).join("");
}
function drawColours() {
  const box = $("#colour-box");
  if (!box) return;
  const mode = colourMode(), mine = getColours()[mode] || {};
  box.innerHTML = `<div class="muted small">Changing the colours for <span class="colour-mode">${mode === "dark" ? "dark" : "light"} mode</span>${mode === "dark" ? " · switch to Light above to change those" : " · switch to Dark above to change those"}. Changes show straight away.</div>
    <div class="colour-presets">${COLOUR_PRESETS[mode].map(([name, p], i) => {
      const sw = ["accent", "header", "heading"].map((k) => p[k] || (k === "accent" ? (mode === "dark" ? "#4d8dff" : "#1d63d6") : k === "header" ? "#0a1a3b" : mode === "dark" ? "#d6e4ff" : "#0a1a3b"));
      return `<button data-colpreset="${i}" data-tip="Use the ${esc(name)} colours"><span class="sw">${sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span>${esc(name)}</button>`; }).join("")}</div>
    <div class="colour-grid">${COLOUR_KEYS.map(([k, label, hint, v]) => `<label class="${mine[k] ? "set" : ""}" data-tip="${esc(hint)}"><input type="color" data-colour="${k}" value="${mine[k] || cssHex(v)}"><span class="cn">${label}</span><button class="cx" data-colreset="${k}" title="Back to standard">✕</button></label>`).join("")}</div>
    <div style="margin-top:8px"><button class="btn sm" data-colreset="all">Reset ${mode} colours</button></div>`;
}
document.addEventListener("input", (e) => {
  const i = e.target.closest("[data-colour]");
  if (!i) return;
  const mode = colourMode(), c = { ...(getColours()[mode] || {}) };
  c[i.dataset.colour] = i.value;
  setColours(mode, c);
  i.closest("label").classList.add("set");
});
document.addEventListener("click", (e) => {
  const p = e.target.closest("[data-colpreset]"), r = e.target.closest("[data-colreset]");
  if (!p && !r) return;
  e.preventDefault();
  const mode = colourMode();
  if (p) setColours(mode, { ...COLOUR_PRESETS[mode][+p.dataset.colpreset][1] });
  else if (r.dataset.colreset === "all") setColours(mode, {});
  else { const c = { ...(getColours()[mode] || {}) }; delete c[r.dataset.colreset]; setColours(mode, c); }
  drawColours();
});
function setTheme(mode) { try { localStorage.setItem("hrm.theme", mode); } catch (e) { /* this session only */ } applyTheme(mode); }
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themeMode()));
applyTheme(themeMode());

// ------------------------------------------------------------------ fonts
const SYSTEM_FONTS = ["Segoe UI", "Aptos", "Calibri", "Cambria", "Candara", "Consolas", "Constantia", "Corbel", "Arial", "Arial Narrow", "Verdana", "Tahoma",
  "Trebuchet MS", "Georgia", "Times New Roman", "Palatino Linotype", "Book Antiqua", "Century Gothic", "Franklin Gothic Medium", "Garamond",
  "Lucida Sans Unicode", "Bahnschrift", "Sitka Text", "Gill Sans MT", "Rockwell", "Leelawadee UI", "Nirmala UI", "Ebrima", "Segoe Print",
  "Comic Sans MS", "Courier New", "Lucida Console", "Impact"];
const FONT_DEFAULT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const FONT_CATS = { sans: "Clean (sans-serif)", condensed: "Narrow", serif: "Serif", mono: "Monospaced", display: "Display & fun", system: "On your computer" };
let FONT_LIST = null;
function fontStack(name, cat) {
  const tail = cat === "serif" ? "Georgia, serif" : cat === "mono" ? "Consolas, monospace" : "system-ui, Arial, sans-serif";
  return `"${name}", ${tail}`;
}
function currentFontName() { try { const f = localStorage.getItem("hrm.font"); return f ? f.split(",")[0].replace(/"/g, "").trim() : "Segoe UI"; } catch (e) { return "Segoe UI"; } }
function setFont(name, cat) {
  const v = name === "Segoe UI" ? FONT_DEFAULT : fontStack(name, cat);
  document.documentElement.style.setProperty("--font", v);
  try { if (name === "Segoe UI") localStorage.removeItem("hrm.font"); else localStorage.setItem("hrm.font", v); } catch (e) { /* this session only */ }
}

// ------------------------------------------------------------------ dropdown with styled items (fonts and colours)
function ddRender(box, cfg) {
  const cur = cfg.current();
  const curItem = cfg.groups.flatMap((g) => g.items).find((x) => x.value === cur) || cfg.groups[0].items[0];
  box.innerHTML = `<button type="button" class="dd-btn"><span class="dd-cur" style="${curItem.style || ""}">${curItem.swatch || ""}${esc(curItem.label)}</span><span class="dd-car">▾</span></button>
    <div class="dd-pop" hidden>${cfg.search ? `<input type="search" class="dd-q" placeholder="${esc(cfg.search)}">` : ""}<div class="dd-list"></div></div>`;
  const pop = box.querySelector(".dd-pop"), list = box.querySelector(".dd-list"), q = box.querySelector(".dd-q");
  const draw = () => {
    const f = q ? q.value.trim().toLowerCase() : "";
    list.innerHTML = cfg.groups.map((g) => {
      const items = g.items.filter((x) => !f || x.label.toLowerCase().includes(f));
      return items.length ? `${g.title ? `<div class="dd-h">${esc(g.title)}</div>` : ""}${items.map((x) => `<button type="button" class="dd-item ${x.value === cur ? "on" : ""}" data-v="${esc(x.value)}" style="${x.style || ""}">
        ${x.swatch || ""}<span>${esc(x.label)}</span>${x.sub ? `<span class="dd-sub">${esc(x.sub)}</span>` : ""}</button>`).join("")}` : "";
    }).join("") || '<div class="empty">Nothing matches.</div>';
  };
  draw();
  if (q) q.oninput = draw;
  box.querySelector(".dd-btn").onclick = () => {
    $$(".dd-pop").forEach((p) => { if (p !== pop) p.hidden = true; });
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { if (q) q.focus(); const on = list.querySelector(".on"); if (on) on.scrollIntoView({ block: "center" }); }
  };
  list.onclick = (e) => { const it = e.target.closest(".dd-item"); if (!it) return; cfg.onPick(it.dataset.v); ddRender(box, cfg); };
}
document.addEventListener("click", (e) => { if (!e.target.closest(".dd")) $$(".dd-pop").forEach((p) => (p.hidden = true)); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $$(".dd-pop").forEach((p) => (p.hidden = true)); });

const INK_COLOURS = [["", "Standard", null, null], ["black", "Black", "#000000", "#ffffff"], ["charcoal", "Charcoal", "#2b2f36", "#e8e8e8"],
  ["slate", "Slate", "#3d4a5c", "#c8d3e3"], ["navy", "Navy", "#0a1a3b", "#c9d8ff"], ["blue", "Royal blue", "#1d4fae", "#9cc0ff"],
  ["teal", "Teal", "#0f5f5c", "#8fe0d8"], ["green", "Forest green", "#1f5e33", "#9fe0b0"], ["olive", "Olive", "#4d5a1e", "#d3df9a"],
  ["brown", "Brown", "#5a3a1e", "#e8c9a8"], ["burgundy", "Burgundy", "#6e1630", "#f3a9bf"], ["plum", "Plum", "#4f2a6e", "#d6b8f2"], ["crimson", "Crimson", "#a3141c", "#ff9e9e"]];
function inkColour() { try { return localStorage.getItem("hrm.ink") || ""; } catch (e) { return ""; } }
function applyInk(k) {
  const c = INK_COLOURS.find((x) => x[0] === k);
  let st = $("#ink-css");
  if (!st) { st = document.createElement("style"); st.id = "ink-css"; document.head.appendChild(st); }
  st.textContent = c && c[2] ? `html:not(.dark) { --ink: ${c[2]}; } html.dark { --ink: ${c[3]}; }` : "";
}
function setInk(k) { try { if (k) localStorage.setItem("hrm.ink", k); else localStorage.removeItem("hrm.ink"); } catch (e) { /* this session only */ } applyInk(k); }
applyInk(inkColour());
async function drawFontDropdowns() {
  const fb = $("#font-dd"), ib = $("#ink-dd");
  if (!FONT_LIST) { try { FONT_LIST = await (await fetch("/fonts.json")).json(); } catch (e) { FONT_LIST = []; } }
  const fontItem = (x) => ({ value: x.name, label: x.name, style: `font-family:${esc(fontStack(x.name, x.cat))}`, sub: x.cat === "system" ? "on your computer" : "" });
  const groups = [{ title: "", items: [{ value: "Segoe UI", label: "Standard (Segoe UI)", style: `font-family:${esc(FONT_DEFAULT)}` }] }].concat(
    Object.entries(FONT_CATS).map(([k, t]) => ({ title: t, items: (k === "system" ? SYSTEM_FONTS.filter((n) => n !== "Segoe UI").map((n) => ({ name: n, cat: "system" })) : FONT_LIST.filter((x) => x.cat === k)).map(fontItem) })));
  if (fb) ddRender(fb, { current: currentFontName, groups, search: `Search ${FONT_LIST.length + SYSTEM_FONTS.length} fonts`,
    onPick: (v) => { const f = FONT_LIST.find((x) => x.name === v); setFont(v, f ? f.cat : "system"); } });
  const dark = document.documentElement.classList.contains("dark");
  if (ib) ddRender(ib, { current: inkColour, groups: [{ title: "", items: INK_COLOURS.map(([k, t, l, d]) => ({ value: k, label: t,
    style: l ? `color:${dark ? d : l}` : "", swatch: `<i class="dd-sw" style="background:${l ? (dark ? d : l) : "var(--ink)"}"></i>` })) }], onPick: setInk });
}

// ------------------------------------------------------------------ settings
function settingsTabs(on) {
  return `<div class="subtabs"><a href="#/settings" class="${on === "settings" ? "on" : ""}">General</a><a href="#/databases" class="${on === "databases" ? "on" : ""}">Databases</a>
    <a href="#/tables" class="${on === "tables" ? "on" : ""}">All tables</a><a href="#/versions" class="${on === "versions" ? "on" : ""}">Versions &amp; changes</a></div>`;
}
function settingsPage() {
  const ms = (STATUS && STATUS.my_stables) || [], cur = myStableId();
  const a = (STATUS && STATUS.app) || {};
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></label>`;
  const row = (title, help, control) => `<div class="set-row"><div><div class="set-t">${title}</div><div class="set-h">${help}</div></div><div class="set-c">${control}</div></div>`;
  const cr = chartDefaultRange();
  let html = settingsTabs("settings") + `<div class="page-head"><div><h1>Settings</h1><div class="sub">Settings are kept in this browser on this computer.</div></div></div>`;
  html += `<div class="grid cols-2">` + panel("Display", [
    row("Font", "The typeface used everywhere in the viewer. Each one is shown in its own style.", `<div id="font-dd" class="dd"></div>`),
    row("Font colour", "The colour of the main text. Each colour has a lighter version for dark mode.", `<div id="ink-dd" class="dd"></div>`),
    row("Appearance", "Light, dark, or follow your Windows setting.",
      `<div class="theme-pick">${[["light", "Light"], ["dark", "Dark"], ["auto", "Match Windows"]].map(([k, t]) => `<button data-theme="${k}" class="${themeMode() === k ? "on" : ""}">${t}</button>`).join("")}</div>`),
    row("Colours", "Pick your own colours. Light and dark mode each keep their own.", `<div id="colour-box" class="colour-box"></div>`),
    row("Text size", "Changes all text in the app, from 8px to 20px.",
      `<div class="tsize"><button id="ts-down" aria-label="Smaller text">A−</button><span class="val" id="ts-val"></span><button id="ts-up" aria-label="Larger text">A+</button><button id="ts-reset" class="reset">Reset</button></div>`),
    row("Hover cards", "A small summary pops up when you hover over a horse, person, stable, race or racecourse.", sw("set-cards", HOVER_CARDS)),
    row("Pedigree gender colours", "Orange for dams and teal for sires in the 8–16 generation family tree lists.", sw("set-pedcol", ANC_COLOURS)),
    row("Rows per page", "How many rows long tables (Horses, Races, Horse table, All tables…) show on each page. You can also change it under any table.",
      `<select id="set-rows"><option value="">Standard (50, or 100 for All tables)</option>${PAGE_SIZES.map((n) => `<option value="${n}" ${prefPageSize() === n ? "selected" : ""}>${fNum(n)}</option>`).join("")}</select>`),
    row("Side menu", "Show the full side menu, just its icons, or hide it. The ☰ button at the left of the menu bar does the same. On small windows the menu slides in over the page instead.",
      `<select id="set-side"><option value="full">Full</option><option value="mini">Icons only</option><option value="hidden">Hidden</option></select>`),
    row("Charts open showing", "The time range charts start on. You can still change it with the buttons on each chart. If a chart has less history than this, it shows all of it.",
      `<select id="set-range"><option value="all" ${cr === "all" ? "selected" : ""}>All of the history</option>
        <optgroup label="Years">${RANGES.filter((r) => r[0].endsWith("y")).map((r) => `<option value="${r[0]}" ${r[0] === cr ? "selected" : ""}>Last ${r[1]}</option>`).join("")}</optgroup>
        <optgroup label="Months">${RANGES.filter((r) => r[0].endsWith("m")).map((r) => `<option value="${r[0]}" ${r[0] === cr ? "selected" : ""}>Last ${r[1]}</option>`).join("")}</optgroup></select>`),
  ].join("")) +
    // right-hand column: your stables (compact), then the viewer and database panels underneath
    `<div class="set-stack">` + panel("Your stables", ms.length ? [
    row("Main stable", "Opened by “Your stables” and “Your horses” in the left menu.",
      `<select id="set-stable">${ms.map((x) => `<option value="${x.id}" ${String(x.id) === String(cur) ? "selected" : ""}>${esc(x.name)} — ${esc(x.role)}</option>`).join("")}</select>`),
    `<div class="set-h" style="margin-top:6px">${ms.length} stable${ms.length === 1 ? "" : "s"} you own or hold shares in. Use ◀ ▶ at the top of their pages to move between them.</div>`,
  ].join("") : '<div class="empty">No stables found for your player in this database.</div>') +
    panel("Viewer", [
    row("Version", `HRM Viewer <b>${esc(a.version || "")}</b>`, `<a class="btn" href="#/versions">Versions &amp; changes</a>`),
    STATUS && STATUS.desktop
      ? row("Desktop app", "You're using the HRM Viewer app. Add it to your desktop and Start menu to open it like any other program.", `<button class="btn" id="set-shortcut">Add shortcuts</button>`)
      : STATUS && STATUS.has_exe
        ? row("Desktop app", "HRM Viewer can open in its own window instead of the browser: close this, then double-click <b>HRM Viewer.exe</b> in the viewer's folder.", "")
        : "",
    row("Updates from GitHub", "New versions are published on GitHub. The viewer checks for them and offers to install.", `<div id="gh-box" class="gh-box"><span class="muted small">Checking…</span></div>`),
    row("Install an update", "Or choose an HRM-Viewer-update zip file you've downloaded. Your data isn't touched.", `<button class="btn primary" data-open-update>Install an update</button>`),
    row("Quick Guide", "How to use the main features, as a PDF. It's updated with every version (also in your HRM Viewer folder).",
      `<span style="display:inline-flex;gap:8px"><button class="btn" data-guide>Open the guide</button><a class="btn" href="/quick-guide.pdf" download="HRM Viewer - Quick Guide.pdf">Download PDF</a></span>`),
    row("Reset settings", "Put every setting on this page back to how it started. Your data isn't touched.", `<button class="btn" id="set-reset">Reset settings</button>`),
  ].join("")) +
    panel("Database", [
    row("Open database", `<b>${esc((STATUS && STATUS.db && STATUS.db.name) || "—")}</b>${STATUS && STATUS.meta && STATUS.meta.game_date ? ` · game date ${fDate(STATUS.meta.game_date)}` : ""}`,
      `<a class="btn" href="#/databases">Manage databases</a>`),
    row("Load a newer save", "Update the open database with a newer database.db, or load one as a new database.", `<button class="btn" onclick="openLoad()">Load database</button>`),
  ].join("")) + `</div></div>`;
  html += `<div style="margin-top:16px">` + panel("Automatic updates", `<div id="auto-box"><div class="muted">Loading…</div></div>`) + `</div>`;
  return html;
}
async function drawAutoBox() {
  const box = $("#auto-box");
  if (!box) return;
  const a = await (await fetch("/api/auto")).json();
  const st = a.settings || {};
  const opt = (v, list) => list.map(([x, t]) => `<option value="${x}" ${+v === x ? "selected" : ""}>${t}</option>`).join("");
  const stateTxt = { off: "Off", current: "Up to date", waiting: "Change seen", updating: "Updating…", skipped: "Not loaded", error: "Problem", nofile: "No file to watch" }[a.state] || "";
  box.innerHTML = `<div class="set-row"><div><div class="set-t">Update automatically when the save file changes</div>
      <div class="set-h">The viewer watches the <b>database.db</b> this database was loaded from. When the game saves, it waits until the file is finished and loads it the normal way (newest wins, history kept). It only does this for the same save, never for an older file or a different career.</div></div>
      <div class="set-c"><label class="switch"><input type="checkbox" id="auto-on" ${st.enabled ? "checked" : ""}><span></span></label></div></div>
    <div class="set-row"><div style="flex:1"><div class="set-t">File being watched</div><div class="set-h">${a.path ? `<code>${esc(a.path)}</code>${a.exists ? (a.file_mtime ? ` · last changed ${new Date(a.file_mtime * 1000).toLocaleString("en-NZ")}` : "") : ' · <b class="bad-t">not found</b>'}` : "None yet — enter the path to the game's database.db below."}</div>
        <div class="row-f"><input type="text" id="auto-path" value="${esc(a.path || "")}" placeholder="C:\\Users\\you\\...\\database.db" style="flex:1;min-width:320px">
          <button class="btn primary" id="auto-path-go">Watch this file</button></div>
        <div class="set-h">Paste the full path to the game's <code>database.db</code> (or the folder it's in). In File Explorer, hold Shift, right-click the file and choose “Copy as path”. It must be the same save as this database; if it's newer than the stored data it's loaded straight away.</div>
        <div id="auto-path-msg"></div></div>
      <div class="set-c"><button class="btn" id="auto-check" ${a.path && a.exists ? "" : "disabled"}>Check now</button></div></div>
    <div class="set-row"><div><div class="set-t">Wait after the file changes</div><div class="set-h">So a save that's still being written isn't loaded half-way.</div></div>
      <div class="set-c"><select id="auto-quiet">${opt(st.quiet, [[15, "15 seconds"], [30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"]])}</select></div></div>
    <div class="set-row"><div><div class="set-t">At most one update every</div><div class="set-h">Loading a 1 GB save takes a little while, so updates are spaced out if the game saves very often.</div></div>
      <div class="set-c"><select id="auto-gap">${opt(st.min_gap, [[60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"]])}</select></div></div>
    <div class="set-row"><div><div class="set-t">Status</div><div class="set-h"><span class="auto-pill ${esc(a.state)}">${stateTxt}</span> ${esc(a.message || "")}
      ${a.last_result && a.last_result.ok ? `<br>Last automatic update: ${new Date(a.last_result.at * 1000).toLocaleString("en-NZ")} · game date ${fDate(a.last_result.game_date)}` : ""}</div></div><div class="set-c"></div></div>`;
  const post = async (url, body) => { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); setTimeout(drawAutoBox, 600); autoPoll(true); };
  $("#auto-on").onchange = (e) => post("/api/auto", { enabled: e.target.checked });
  $("#auto-quiet").onchange = (e) => post("/api/auto", { quiet: +e.target.value });
  $("#auto-gap").onchange = (e) => post("/api/auto", { min_gap: +e.target.value });
  $("#auto-check").onclick = () => post("/api/auto/check");
  $("#auto-path-go").onclick = async () => {
    const path = $("#auto-path").value.trim();
    if (!path) return;
    const r = await fetch("/api/auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("#auto-path-msg").innerHTML = `<div class="err">${esc(j.error || "Couldn't watch that file.")}</div>`; return; }
    await refreshStatus(); autoPoll(true);
    setTimeout(async () => { await drawAutoBox(); const m = $("#auto-path-msg"); if (m) m.innerHTML = '<div class="ok-t">✓ Now watching that file.</div>'; }, 700);
  };
}
settingsPage.after = () => {
  drawGithubBox();
  drawColours();
  setTableSize(getTableSize());
  drawFontDropdowns();
  $$("[data-theme]", APP).forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme); $$("[data-theme]", APP).forEach((x) => x.classList.toggle("on", x === b)); drawFontDropdowns(); }));
  drawAutoBox();
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* this session only */ } };
  $("#set-cards").onchange = (e) => { HOVER_CARDS = e.target.checked; save("hrm.hoverCards", HOVER_CARDS ? "1" : "0"); hideCard(); };
  $("#set-pedcol").onchange = (e) => { ANC_COLOURS = e.target.checked; save("hrm.ancColours", ANC_COLOURS ? "1" : "0"); };
  $("#set-range").onchange = (e) => save("hrm.chartRange", e.target.value);
  $("#set-side").value = sideMenuMode();
  $("#set-rows").onchange = (e) => { if (e.target.value) save("hrm.pageSize", e.target.value); else { try { localStorage.removeItem("hrm.pageSize"); } catch (er) { /* none */ } } };
  $("#set-side").onchange = (e) => setSideMenu(e.target.value);
  const st = $("#set-stable");
  if (st) st.onchange = () => { setMyStable(st.value); renderSidebar(); };
  const sc = $("#set-shortcut");
  if (sc) sc.onclick = async () => {
    sc.disabled = true; sc.textContent = "Adding…";
    const r = await fetch("/api/desktop/shortcut", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    sc.textContent = r.ok ? "✓ Added" : "Add shortcuts"; sc.disabled = r.ok;
    if (!r.ok) sc.insertAdjacentHTML("afterend", `<div class="err" style="margin-top:6px">${esc(j.error || "Couldn't add the shortcuts.")}</div>`);
  };
  $("#set-reset").onclick = () => {
    try { Object.keys(localStorage).filter((k) => k.startsWith("hrm.")).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* nothing stored */ }
    HOVER_CARDS = true; ANC_COLOURS = true; setTableSize(TS_DEFAULT); setSideMenu("full"); setTheme("light"); setFont("Segoe UI", "system"); setInk(""); renderSidebar(); render();
  };
};

// ------------------------------------------------------------------ databases (several saves)
async function databasesPage() {
  const d = await (await fetch("/api/dbs")).json();
  const leg = d.list.find((x) => x.legacy);
  const mb = (b) => (b ? (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : Math.round(b / (1 << 20)) + " MB") : "—");
  let html = settingsTabs("databases") + `<div class="page-head"><div><h1>Databases</h1><div class="sub">Keep several saves side by side and switch between them. Each one is stored and updated separately.</div></div>
    <button class="btn primary" onclick="openLoad()">Load a database</button></div>`;
  if (leg) {
    const suggest = leg.player ? `${leg.player}` : "My save";
    html += panel("Move your stored data into the new structure", `<p>Your data from earlier versions is still stored the old way (<code>data\\current.db</code>).
      Moving it gives it its own folder and name, next to any other databases. It's moved, not copied, so it's instant and uses no extra space. Nothing in it changes.</p>
      <div class="row-f"><label>Name <input type="text" id="mig-name" value="${esc(suggest)}" style="width:260px"></label>
      <button class="btn primary" id="mig-go">Move it into the new structure</button><span id="mig-msg" class="small"></span></div>`, "", "hl-panel");
    html += `<div style="height:16px"></div>`;
  }
  const rows = d.list.map((x) => `<tr class="${x.active ? "me" : ""}">
      <td><b class="dbname" data-id="${x.id}">${esc(x.name)}</b> ${x.active ? '<span class="badge good">Open now</span>' : ""}${x.legacy ? ' <span class="badge">Old layout</span>' : ""}
        ${x.loaded ? "" : '<span class="badge">Empty</span>'}</td>
      <td>${esc(x.player || "—")}</td><td class="nowrap">${x.game_date ? fDate(x.game_date) : "—"}</td>
      <td class="num">${mb(x.size)}</td><td class="nowrap">${x.loaded_at ? fDate(x.loaded_at) : "—"}</td><td class="num">${fNum(x.loads)}</td>
      <td class="nowrap db-acts">${x.active ? "" : `<button class="btn primary" data-dbopen="${x.id}">Open</button>`}
        ${x.legacy ? "" : `<button class="btn" data-dbrename="${x.id}">Rename</button>`}
        ${x.active ? "" : `<button class="btn danger" data-dbdel="${x.id}">Delete</button>`}</td></tr>`).join("");
  html += panel("Your databases", `<div class="tbl-wrap"><table class="data"><thead><tr><th>Name</th><th>Player</th><th>Game date</th><th class="num">Size</th>
      <th>Last loaded</th><th class="num">Loads</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="db-msg" class="small" style="margin-top:8px"></div>`,
    `Stored in <code>${esc(d.folder)}${d.folder.includes("\\") ? "\\" : "/"}databases</code>`);
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Add a new database", `<p class="muted">Load a game save as a separate database, e.g. another career. Your other databases aren't touched.</p>
      <p><button class="btn primary" onclick="openLoad(); setTimeout(() => { const r = document.querySelector('input[name=load-into][value=new]'); if (r) { r.checked = true; document.getElementById('load-newname').focus(); } }, 50)">Load a save as a new database</button></p>`)}
    ${panel("Bring in databases from another HRM Viewer folder", `<p class="muted">If you kept an older copy of the viewer (for example a folder you unzipped before), you can bring its stored data in here as a separate database.</p>
      <div class="row-f"><input type="text" id="imp-path" placeholder="C:\\Users\\you\\Downloads\\HRM Viewer" style="flex:1;min-width:260px"></div>
      <div class="row-f"><label>Name <input type="text" id="imp-name" placeholder="optional — uses the player's name" style="width:240px"></label>
        <label><input type="checkbox" id="imp-move"> Move instead of copy (frees the space in the old folder)</label></div>
      <div class="row-f"><button class="btn primary" id="imp-go">Bring it in</button><span id="imp-msg" class="small"></span></div>
      <p class="help">Paste the path of the other viewer's folder (the one with Start.bat), its <code>data</code> folder, or a <code>current.db</code> file. A game <code>database.db</code> works too — it's loaded as a new database.</p>`)}</div>`;
  html += `<div id="db-progress" class="overlay" hidden><div class="modal"><h2 id="dbp-title">Working…</h2><div class="progress"><div id="dbp-bar"></div></div><div id="dbp-step" class="muted"></div><div id="dbp-err"></div>
    <div style="text-align:right;margin-top:12px"><button class="btn" id="dbp-close" hidden>Close</button></div></div></div>`;
  return html;
}
async function dbJobWait(title) {
  const box = $("#db-progress");
  box.hidden = false; $("#dbp-title").textContent = title; $("#dbp-err").innerHTML = ""; $("#dbp-close").hidden = true;
  for (;;) {
    const s = await (await fetch("/api/import/progress")).json();
    $("#dbp-bar").style.width = (s.pct || 0) + "%"; $("#dbp-step").textContent = (s.step || "") + (s.state === "running" ? "…" : "");
    if (s.state === "running") { await new Promise((r) => setTimeout(r, 600)); continue; }
    if (s.state === "error") { $("#dbp-err").innerHTML = `<div class="err">${esc(s.error)}</div>`; $("#dbp-close").hidden = false; $("#dbp-close").onclick = () => (box.hidden = true); return false; }
    return true;
  }
}
async function dbPost(action, body) {
  const r = await fetch("/api/dbs/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}
async function afterDbChange(goHome) {
  TABLES_CACHE = null;
  await refreshStatus();
  if (goHome) location.hash = "#/"; else render();
}
databasesPage.after = () => {
  const msg = (t, bad) => { const el = $("#db-msg"); if (el) el.innerHTML = t ? `<span class="${bad ? "bad-t" : ""}">${esc(t)}</span>` : ""; };
  const mig = $("#mig-go");
  if (mig) mig.onclick = async () => {
    mig.disabled = true; $("#mig-msg").textContent = "Moving…";
    try { await dbPost("migrate", { name: $("#mig-name").value.trim() }); await afterDbChange(false); }
    catch (e) { $("#mig-msg").innerHTML = `<span class="bad-t">${esc(e.message)}</span>`; mig.disabled = false; }
  };
  $$("[data-dbopen]", APP).forEach((b) => (b.onclick = async () => {
    try { await dbPost("switch", { id: b.dataset.dbopen }); if (await dbJobWait("Opening database")) await afterDbChange(true); }
    catch (e) { msg(e.message, true); }
  }));
  $$("[data-dbrename]", APP).forEach((b) => (b.onclick = () => {
    const nm = $(`.dbname[data-id="${b.dataset.dbrename}"]`);
    const cur = nm.textContent;
    nm.innerHTML = `<input type="text" value="${esc(cur)}" style="width:220px"> <button class="btn primary">Save</button>`;
    const inp = nm.querySelector("input"); inp.focus(); inp.select();
    const save = async () => { try { await dbPost("rename", { id: b.dataset.dbrename, name: inp.value.trim() }); await afterDbChange(false); } catch (e) { msg(e.message, true); } };
    nm.querySelector("button").onclick = save;
    inp.onkeydown = (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") render(); };
  }));
  $$("[data-dbdel]", APP).forEach((b) => (b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Click again to delete for good"; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = "Delete"; } }, 4000); return; }
    try { await dbPost("delete", { id: b.dataset.dbdel }); await afterDbChange(false); } catch (e) { msg(e.message, true); }
  }));
  const imp = $("#imp-go");
  if (imp) imp.onclick = async () => {
    $("#imp-msg").textContent = "";
    const path = $("#imp-path").value.trim();
    if (!path) { $("#imp-msg").innerHTML = '<span class="bad-t">Paste a folder or file path first.</span>'; return; }
    try {
      const j = await dbPost("import", { path, name: $("#imp-name").value.trim(), move: $("#imp-move").checked });
      if (await dbJobWait(j.kind === "save" ? "Loading the save into a new database" : "Bringing in the database")) await afterDbChange(true);
    } catch (e) { $("#imp-msg").innerHTML = `<span class="bad-t">${esc(e.message)}</span>`; }
  };
};

// ------------------------------------------------------------------ start
bindRunnerToggles(APP);
async function refreshStatus() {
  try { STATUS = await api("status"); } catch (e) { STATUS = null; }
  const m = (STATUS && STATUS.meta) || {};
  const dbn = STATUS && STATUS.db ? STATUS.db.name : "";
  $("#gamedate").innerHTML = STATUS ? `<span class="dbn">${esc(dbn || "Database")} ▾</span><b>${STATUS.loaded ? "Game date " + fDate(m.game_date) : "Empty"}</b>` : "";
  $("#db-banner").innerHTML = STATUS && STATUS.legacy && location.hash !== "#/databases" ? `<div class="banner"><span>Version 7.9 can keep several databases. Your stored data is still in the old layout:
    move it into the new structure so it gets its own name next to any other saves.</span><a class="btn primary" href="#/databases">Move it now</a></div>` : "";
  renderFooter();
  renderSidebar();
  if (STATUS && STATUS.job && STATUS.job.state === "running" && !$("#load-ov")) { /* an import started elsewhere; leave it */ }
}
window.addEventListener("hashchange", () => { render(); if (STATUS && STATUS.legacy) refreshStatus(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
(async () => {
  await refreshStatus();
  autoPoll();
  if (!STATUS) { APP.innerHTML = `<div class="err-box">Can't reach the viewer. Make sure its window is still open, then refresh this page.</div>`; return; }
  render();
})();
