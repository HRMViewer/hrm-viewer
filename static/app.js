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
  back: '<path d="M10 3 5 8l5 5"/>',
  fwd: '<path d="M6 3l5 5-5 5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  side: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M6 3v10"/>',
  moon: '<path d="M12.5 10A5.2 5.2 0 0 1 6 3.5a5.2 5.2 0 1 0 6.5 6.5z"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  key: '<rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 6.8h.5M6.6 6.8h.5M9.2 6.8h.5M11.8 6.8h.2M4.5 9.8h7"/>',
};
const icon = (k) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ""}</svg>`;
// Navigation: the top menu holds the main sections (what you're looking at); the side menu shows "You" shortcuts
// and the pages inside the current section, grouped by what you want to do (results, coming up, breeding…).
const SECTIONS = [
  { k: "home", label: "Home", ic: "home", href: "#/", routes: [""] },
  { k: "racing", label: "Racing", ic: "flag", href: "#/meetings", routes: ["meetings", "meeting", "races", "race", "courses", "course", "concepts", "concept", "qualifying"] },
  { k: "horses", label: "Horses", ic: "horse", href: "#/horses", routes: ["horses", "horse", "horse-table", "pedigrees", "pedigree", "notes"] },
  { k: "stables", label: "Stables", ic: "barn", href: "#/stables", routes: ["stables", "stable", "stable-table", "stable-rankings"] },
  { k: "people", label: "People", ic: "user", href: "#/people-overview", routes: ["people-overview", "people", "person", "jockeys"] },
  { k: "awards", label: "Awards", ic: "trophy", href: "#/awards", routes: ["awards"] },
  { k: "settings", label: "Settings", ic: "cog", href: "#/settings", routes: ["settings", "databases", "tables", "versions", "shortcuts", "tags"], right: true },
];
const SIDE = {
  home: null,   // filled in below: every other area's pages
  racing: [["Results", [["#/meetings", "list", "Meetings"], ["#/races", "flag", "All races"], ["#/races?type=G1", "trophy", "Group 1 results"]]],
    ["Coming up", [["#/meetings?when=upcoming", "clock", "Upcoming meetings"], ["#/races?when=upcoming", "flag", "Upcoming races"], ["#/races?when=upcoming&type=G1", "star", "Upcoming Group 1s"]]],
    ["Series & qualifying", [["#/concepts", "trophy", "Concepts"], ["#/qualifying", "star", "Qualifying"]]],
    ["Places", [["#/courses", "pin", "Racecourses"]]]],
  horses: [["Horses", [["#/horses", "horse", "All horses"], ["#/horse-table", "table", "Horse table"], ["#/notes", "tag", "Notes & tags"]]],
    ["Breeding", [["#/pedigrees", "tree", "Top sires"], ["#/pedigrees?kind=dams", "tree", "Top dams"], ["#/pedigrees?kind=damsires", "tree", "Broodmare sires"]]]],
  stables: [["Stables", [["#/stables", "barn", "All stables"], ["#/stable-table", "grid", "Stable table"], ["#/stable-rankings", "trophy", "Rankings"]]]],
  people: [["People", [["#/people-overview", "home", "Overview"], ["#/people", "user", "All people"], ["#/jockeys", "trophy", "Jockey stats"], ["#/people?role=Jockey&sort=jockey_wins", "trophy", "Top jockeys"], ["#/people?role=Jockey", "user", "Jockeys"],
    ["#/people?role=Trainer", "user", "Trainers"], ["#/people?role=Head%20trainer", "user", "Head trainers"], ["#/people?role=Manager", "user", "Managers"]]]],
  awards: [["Awards", [["#/awards", "trophy", "Awards by year"], ["#/awards?view=winners", "star", "Most awards"], ["#/awards?group=hof", "star", "Hall of Fame"]]],
    ["By award", [["#/awards?group=year", "trophy", "Horse of the Year"], ["#/awards?group=age", "horse", "Age divisions"], ["#/awards?group=distance", "flag", "Distance champions"],
      ["#/awards?group=breeding", "tree", "Breeding"], ["#/awards?group=people", "user", "People"], ["#/awards?group=stables", "barn", "Stables"], ["#/awards?group=special", "star", "Special awards"]]]],
  settings: [["Settings", [["#/settings", "cog", "General"], ["#/databases", "db", "Databases"], ["#/tables", "table", "All tables"], ["#/shortcuts", "key", "Shortcuts"], ["#/tags", "tag", "Tags"], ["#/versions", "info", "Versions & changes"]]]],
};
// on Home the side menu lists every area, each under its own heading
SIDE.home = [["Home", [["#/", "home", "Overview"]]]].concat(
  ["racing", "horses", "stables", "people", "awards", "settings"].map((k) => [SECTIONS.find((x) => x.k === k).label, SIDE[k].flatMap((g) => g[1])]));
function sectionOf(key) { return (SECTIONS.find((x) => x.routes.includes(key)) || SECTIONS[0]).k; }
const STAR_SVG = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m8 1.9 1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.1l-3.7 2 .8-4.1-3-2.8 4.1-.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
function renderNav() {
  const item = (x) => `<a href="${x.href}" data-k="${x.k}">${icon(x.ic)}<span>${x.label}</span></a>`;
  const chev = (d) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  $("#nav").innerHTML = `<button class="sb-toggle" id="sb-toggle" title="Hide or show the side menu" aria-label="Hide or show the side menu">☰</button>` +
    `<button class="sb-toggle nav-hist" id="nav-back" data-tip="Back (Alt + ←)" aria-label="Back">${chev("M10 3 5 8l5 5")}</button>` +
    `<button class="sb-toggle nav-hist" id="nav-fwd" data-tip="Forward (Alt + →)" aria-label="Forward">${chev("M6 3l5 5-5 5")}</button>` +
    `<button class="sb-toggle nav-hist" id="nav-reload" data-tip="Refresh this page (F5)" aria-label="Refresh this page">${chev("M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5")}</button>` +
    `<button class="sb-toggle nav-fav" id="nav-fav" data-tip="Add this page to your favourites" aria-label="Add this page to your favourites" aria-pressed="false">${STAR_SVG}</button>` +
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
  else if (e.target.closest("#nav-reload")) refreshPage();
  else if (e.target.closest("#nav-fav")) toggleFav();
});
// refresh: fetch the page's data again and redraw it, keeping your place
let REFRESHING = false;
async function refreshPage() {
  if (REFRESHING) return;
  REFRESHING = true;
  const b = $("#nav-reload"), y = window.scrollY;
  if (b) b.classList.add("spinning");
  try {
    CARD_CACHE.clear(); TABLES_CACHE = null; DYN_CACHE.clear();
    await refreshStatus();
    await loadHorsePics(true);
    await render();
    window.scrollTo(0, y);
  } finally {
    REFRESHING = false;
    if (b) b.classList.remove("spinning");
  }
}
// F5 does the same (Ctrl + F5 still reloads the whole viewer)
document.addEventListener("keydown", (e) => {
  if (e.key === "F5" && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); refreshPage(); }
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
  h += favSideHtml();
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
  favSideWire();
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

// ------------------------------------------------------------------ favourites and shortcut keys (15.2)
// Favourites: the ☆ in the menu bar adds the page you're on to the top of the side menu. They belong to the
// database (a horse or stable number means something different in another save), and are kept in this browser.
// Shortcut keys: any page, favourite or menu-bar action can have a key. None are set until you choose them.
const dbKeyId = () => ((STATUS && STATUS.db) || {}).id || "";
function normHash(h) {
  h = String(h || "").replace(/^#/, "") || "/";
  const [p, qs] = h.split("?");
  const q = [...new URLSearchParams(qs || "")].filter(([, v]) => v !== "").sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return "#" + (p || "/") + (q.length ? "?" + new URLSearchParams(q).toString() : "");
}
function getFavs() {
  try { const v = JSON.parse(localStorage.getItem("hrm.favs:" + dbKeyId()) || "[]"); return Array.isArray(v) ? v.filter((f) => f && f.h) : []; } catch (e) { return []; }
}
function setFavs(list) {
  try { localStorage.setItem("hrm.favs:" + dbKeyId(), JSON.stringify(list)); } catch (e) { /* this session only */ }
  renderSidebar(); favSync();
  if ((parseHash().parts[0] || "") === "shortcuts") drawShortcutLists();
}
const findFav = (h) => getFavs().find((f) => normHash(f.h) === normHash(h));
// the name a new favourite gets: its side-menu name if it's in the menu, otherwise the page's heading (+ the tab you're on)
const FAV_NAMES = { "#/": "Home", "#/people-overview": "People overview", "#/settings": "Settings", "#/stable-rankings": "Stable rankings", "#/horse-table": "Horse table", "#/stable-table": "Stable table" };
function sideLinks() { return SIDE.home.flatMap((g) => g[1]); }
function favIcon(h) {
  const k = (normHash(h).slice(2).split(/[/?]/)[0]) || "";
  const side = sideLinks().find((x) => normHash(x[0]) === normHash(h));
  if (side) return side[1];
  return ({ "": "home", horse: "horse", horses: "horse", "horse-table": "horse", person: "user", people: "user", jockeys: "trophy", "people-overview": "user", stable: "barn", stables: "barn",
    "stable-table": "grid", "stable-rankings": "trophy", race: "flag", races: "flag", meeting: "list", meetings: "list", course: "pin", courses: "pin", pedigree: "tree", pedigrees: "tree",
    awards: "trophy", notes: "tag", tags: "tag", settings: "cog", databases: "db", tables: "table", versions: "info", shortcuts: "key" })[k] || "star";
}
function pageTitle() {
  const cur = normHash(location.hash);
  if (FAV_NAMES[cur]) return FAV_NAMES[cur];
  const side = sideLinks().find((x) => normHash(x[0]) === cur);
  if (side) return side[2];
  let t = "";
  const h1 = APP.querySelector("h1");
  if (h1) {
    const c = h1.cloneNode(true);
    c.querySelectorAll(".badge, .tab-n, .hn-head").forEach((x) => x.remove());
    t = c.textContent.replace(/\s+/g, " ").trim();
  }
  const tabs = [...APP.querySelectorAll(".subtabs a")], on = tabs.find((a) => a.classList.contains("on"));
  if (on && tabs.indexOf(on) > 0) {
    const c = on.cloneNode(true); c.querySelectorAll(".tab-n").forEach((x) => x.remove());
    const lab = c.textContent.trim();
    if (lab && !t.toLowerCase().includes(lab.toLowerCase())) t = t ? `${t} · ${lab}` : lab;
  }
  return (t || (SECTIONS.find((x) => x.k === sectionOf(parseHash().parts[0] || "")) || {}).label || "Page").slice(0, 80);
}
function toggleFav() {
  const h = normHash(location.hash), list = getFavs(), i = list.findIndex((f) => normHash(f.h) === h);
  if (i >= 0) {
    const [gone] = list.splice(i, 1);
    setFavs(list);
    toast(`Removed <b>${esc(gone.t)}</b> from your favourites`, ["Undo", () => { const l = getFavs(); l.splice(i, 0, gone); setFavs(l); }], 4500);
  } else {
    const f = { h, t: pageTitle(), ic: favIcon(h) };
    list.push(f); setFavs(list);
    toast(`<span class="fav-star-t">★</span> Added <b>${esc(f.t)}</b> to your favourites`, ["Rename", () => favRename(h)], 4500);
  }
}
function favSync() {
  const b = $("#nav-fav");
  if (!b) return;
  const on = !!findFav(location.hash);
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
  const k = keyFor("act:fav"), tip = (on ? "Remove this page from your favourites" : "Add this page to your favourites") + (k ? ` (${keyText(k)})` : "");
  b.dataset.tip = tip; b.setAttribute("aria-label", tip);
  $$("#sidebar a[data-fav]").forEach((a) => a.classList.toggle("on", normHash(a.dataset.fav) === normHash(location.hash)));
}
window.addEventListener("hashchange", favSync);
function favSideHtml() {
  const favs = getFavs();
  let h = `<div class="sb-sec sb-fav-h">Favourites</div>`;
  if (!favs.length) return h + `<div class="sb-hint">Click <span class="fav-star-t">☆</span> in the menu bar to add the page you're on.</div>`;
  return h + `<div class="sb-favs">` + favs.map((f, i) => `<div class="sb-fav" data-i="${i}" draggable="true"><a href="${esc(f.h)}" data-fav="${esc(f.h)}" class="${normHash(f.h) === normHash(location.hash) ? "on" : ""}" draggable="false" data-tip="${esc(f.t)}${f.k ? ` (${esc(keyText(f.k))})` : ""}">${icon(f.ic || favIcon(f.h))}<span>${esc(f.t)}</span></a>` +
    `<span class="sb-fav-acts"><button class="sb-fav-b" data-fav-ren="${i}" data-tip="Rename" aria-label="Rename ${esc(f.t)}">✎</button><button class="sb-fav-b" data-fav-del="${i}" data-tip="Remove from favourites" aria-label="Remove ${esc(f.t)} from favourites">✕</button></span></div>`).join("") + `</div>`;
}
function favRename(h) {
  const list = getFavs(), i = list.findIndex((f) => normHash(f.h) === normHash(h));
  if (i < 0) return;
  if (isNarrow()) sideDrawer(true); else if (sideMenuMode() !== "full") setSideMenu("full");
  const a = $(`#sidebar .sb-fav[data-i="${i}"]`);
  if (!a) return;
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "sb-fav-in"; inp.value = list[i].t; inp.maxLength = 80; inp.setAttribute("aria-label", "Favourite's name");
  a.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (keep) => {
    if (done) return; done = true;
    const v = inp.value.trim(), l = getFavs();
    if (keep && v && l[i]) { l[i].t = v; setFavs(l); } else renderSidebar();
  };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
}
function favSideWire() {
  const box = $("#sidebar .sb-favs");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const r = e.target.closest("[data-fav-ren]"), d = e.target.closest("[data-fav-del]");
    if (!r && !d) return;
    e.preventDefault(); e.stopPropagation();
    const l = getFavs();
    if (r) return favRename(l[+r.dataset.favRen].h);
    const i = +d.dataset.favDel, [gone] = l.splice(i, 1);
    setFavs(l);
    toast(`Removed <b>${esc(gone.t)}</b> from your favourites`, ["Undo", () => { const x = getFavs(); x.splice(i, 0, gone); setFavs(x); }]);
  });
  // drag a favourite up or down to change the order
  let from = null;
  box.addEventListener("dragstart", (e) => { const a = e.target.closest(".sb-fav[data-i]"); if (!a) return; from = +a.dataset.i; a.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", a.dataset.fav); } catch (er) { /* fine */ } });
  box.addEventListener("dragover", (e) => {
    if (from == null) return;
    e.preventDefault();
    const a = e.target.closest(".sb-fav[data-i]");
    $$(".drop-above, .drop-below", box).forEach((x) => x.classList.remove("drop-above", "drop-below"));
    if (a) { const r = a.getBoundingClientRect(); a.classList.add(e.clientY < r.top + r.height / 2 ? "drop-above" : "drop-below"); }
  });
  box.addEventListener("drop", (e) => {
    if (from == null) return;
    e.preventDefault();
    const a = e.target.closest(".sb-fav[data-i]");
    if (a) {
      let to = +a.dataset.i + (a.classList.contains("drop-below") ? 1 : 0);
      const l = getFavs(), [m] = l.splice(from, 1);
      if (to > from) to--;
      l.splice(to, 0, m);
      from = null; setFavs(l);
    }
  });
  box.addEventListener("dragend", () => { from = null; renderSidebar(); });
}
// --- shortcut keys
const IS_MAC = () => (STATUS && STATUS.platform === "mac") || /Mac/.test(navigator.platform || "");
const KEY_NAMES = { Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\", Comma: ",", Period: ".", Slash: "/",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
  Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "Backspace", NumpadAdd: "NumPlus", NumpadSubtract: "NumMinus", NumpadMultiply: "NumTimes", NumpadDivide: "NumSlash", NumpadDecimal: "NumDot" };
function comboOf(e) {
  const c = e.code || "";
  const k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^Numpad\d$/.test(c) ? "Num" + c.slice(6) : /^F\d{1,2}$/.test(c) ? c : KEY_NAMES[c];
  if (!k) return null;   // a modifier on its own, or a key the viewer doesn't know
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", k].filter(Boolean).join("+");
}
function keyParts(combo) {
  const mac = IS_MAC(), names = mac ? { Ctrl: "⌃ Control", Alt: "⌥ Option", Shift: "⇧ Shift", Meta: "⌘ Cmd" } : { Meta: "Win" };
  const arrows = { Up: "↑", Down: "↓", Left: "←", Right: "→", NumPlus: "Num +", NumMinus: "Num −", NumTimes: "Num ×", NumSlash: "Num /", NumDot: "Num ." };
  return String(combo).split("+").map((p) => names[p] || arrows[p] || (/^Num\d$/.test(p) ? "Num " + p.slice(3) : p));
}
const keyText = (combo) => keyParts(combo).join(" + ");
const keyChips = (combo) => keyParts(combo).map((p) => `<kbd>${esc(p)}</kbd>`).join('<span class="kplus">+</span>');
// keys the viewer, the window or the browser already use
function reservedWhy(combo) {
  const plain = { F5: "Refresh this page", F11: "Full screen", F12: "Developer tools", Esc: "Closing things", Tab: "Moving between buttons", "Shift+Tab": "Moving between buttons", Enter: "Pressing the button you're on",
    Space: "Scrolling", Backspace: "Deleting text", Up: "Scrolling", Down: "Scrolling", Left: "Scrolling", Right: "Scrolling", PageUp: "Scrolling", PageDown: "Scrolling", Home: "Scrolling", End: "Scrolling",
    "Shift+Space": "Scrolling", "Alt+Left": "Back", "Alt+Right": "Forward", "Alt+F4": "Closing the window", "Ctrl+F5": "Reloading the viewer", "Shift+F5": "Reloading the viewer", "Ctrl+Shift+F5": "Reloading the viewer",
    "Ctrl+Tab": "Switching tabs", "Ctrl+Shift+Tab": "Switching tabs", "Meta+Tab": "Switching apps", "Alt+Tab": "Switching apps", "Ctrl+Alt+Delete": "Windows" };
  if (plain[combo]) return plain[combo];
  const mods = { C: "Copy", V: "Paste", X: "Cut", A: "Select all", Z: "Undo", Y: "Redo", "Shift+Z": "Redo", F: "Find", G: "Find next", P: "Print", R: "Reload", "Shift+R": "Reload", W: "Close", "Shift+W": "Close the window",
    Q: "Quit", N: "New window", "Shift+N": "New window", T: "New tab", "Shift+T": "Reopen tab", L: "The address bar", S: "Save", O: "Open", H: "Hide (Mac)", M: "Minimise (Mac)", "Shift+I": "Developer tools", "Shift+J": "Developer tools",
    "=": "Zoom in", "Shift+=": "Zoom in", "-": "Zoom out", "0": "Reset zoom", NumPlus: "Zoom in", NumMinus: "Zoom out", Num0: "Reset zoom", ",": "Preferences (Mac)", "[": "Back (Mac)", "]": "Forward (Mac)", Left: "Back (Mac)", Right: "Forward (Mac)" };
  // Ctrl (or Cmd on a Mac) with a letter: copy, paste, zoom and the rest, with or without Shift
  const parts = combo.split("+"), key = parts.pop(), has = (x) => parts.includes(x);
  if ((has("Ctrl") || has("Meta")) && !has("Alt") && !(has("Ctrl") && has("Meta"))) { const w = mods[(has("Shift") ? "Shift+" : "") + key]; if (w && (has("Meta") || !/Mac/.test(w))) return w; }
  if (has("Alt") && has("Meta") && key === "H") return "Hide others (Mac)";
  return "";
}
function getKeys() { try { const v = JSON.parse(localStorage.getItem("hrm.keys") || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
function setKeys(k) { try { localStorage.setItem("hrm.keys", JSON.stringify(k)); } catch (e) { /* this session only */ } }
const keyFor = (id) => (id.startsWith("fav:") ? (findFav(id.slice(4)) || {}).k : getKeys()[id]) || "";
function setKeyFor(id, combo) {
  if (id.startsWith("fav:")) {
    const l = getFavs(), f = l.find((x) => normHash(x.h) === normHash(id.slice(4)));
    if (!f) return;
    if (combo) f.k = combo; else delete f.k;
    try { localStorage.setItem("hrm.favs:" + dbKeyId(), JSON.stringify(l)); } catch (e) { /* this session only */ }
    renderSidebar();
  } else {
    const k = getKeys();
    if (combo) k[id] = combo; else delete k[id];
    setKeys(k);
  }
  favSync();
}
// everything that can have a key, in the order the Shortcuts tab lists it
const KEY_ACTIONS = [["act:back", "Back", "back"], ["act:fwd", "Forward", "fwd"], ["act:refresh", "Refresh this page", "refresh"], ["act:fav", "Add or remove this page from favourites", "star"],
  ["act:search", "Search box", "search"], ["act:side", "Show or hide the side menu", "side"], ["act:theme", "Switch between light and dark", "moon"], ["act:load", "Load new database", "upload"]];
const KEY_YOU = [["you:profile", "Your profile", "user"], ["you:stable", "Your stable", "barn"], ["you:horses", "Your horses", "horse"], ["you:races", "Your stable's races", "flag"]];
function keyTargets() {
  const groups = [["Favourites", getFavs().map((f) => ["fav:" + f.h, f.t, f.ic || favIcon(f.h), f.h])], ["Menu bar", KEY_ACTIONS], ["You", KEY_YOU], ["Home", [["#/", "Home", "home", "#/"]]]];
  for (const s of SECTIONS.filter((x) => x.k !== "home")) {
    const seen = new Set(), rows = [];
    for (const [title, links] of SIDE[s.k]) for (const [href, ic, lab] of links) {
      if (seen.has(href)) continue; seen.add(href);
      rows.push([href, SIDE[s.k].length > 1 && title !== s.label ? `${lab}` : lab, ic, href, title]);
    }
    groups.push([s.label, rows]);
  }
  return groups;
}
function keyLabel(id) {
  for (const [g, rows] of keyTargets()) { const r = rows.find((x) => x[0] === id); if (r) return g === "Favourites" ? `${r[1]} (favourite)` : r[1]; }
  return id;
}
function keyOwner(combo) {
  if (!combo) return null;
  for (const [id, c] of Object.entries(getKeys())) if (c === combo) return id;
  const f = getFavs().find((x) => x.k === combo);
  return f ? "fav:" + f.h : null;
}
function runShortcut(id) {
  const m = (STATUS && STATUS.meta) || {}, st = myStableId();
  const need = (v, what) => { if (!v) toast(`There's no ${what} in this database.`); return v; };
  if (id.startsWith("fav:")) { location.hash = id.slice(4); return; }
  if (id.startsWith("#")) { if (normHash(location.hash) !== normHash(id)) location.hash = id; return; }
  switch (id) {
    case "act:back": history.back(); break;
    case "act:fwd": history.forward(); break;
    case "act:refresh": refreshPage(); break;
    case "act:fav": toggleFav(); break;
    case "act:search": window.scrollTo(0, 0); searchInput.focus(); searchInput.select(); break;
    case "act:side": $("#sb-toggle").click(); break;
    case "act:theme": setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"); if ((parseHash().parts[0] || "") === "settings") render(); break;
    case "act:load": openLoad(); break;
    case "you:profile": if (need(m.player_id, "player profile")) location.hash = `#/person/${m.player_id}`; break;
    case "you:stable": if (need(st, "stable of yours")) location.hash = `#/stable/${st}`; break;
    case "you:horses": if (need(st, "stable of yours")) location.hash = `#/horse-table?stable=${st}`; break;
    case "you:races": if (need(st, "stable of yours")) location.hash = `#/stable/${st}/races`; break;
  }
}
let KEY_REC = null;   // the shortcut being set on the Shortcuts tab: { id, btn }
document.addEventListener("keydown", (e) => {
  if (KEY_REC || e.repeat || e.defaultPrevented) return;
  if (document.querySelector(".overlay")) return;   // a picture, chart or form is open on top
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
  // while you type, only keys held with Ctrl / Alt / Cmd (or F1–F12) count, and never AltGr (Ctrl + Alt), which types characters
  if (typing && (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F\d/.test(e.code || "") || (e.ctrlKey && e.altKey))) return;
  const c = comboOf(e), id = c && keyOwner(c);
  if (!id) return;
  e.preventDefault();
  runShortcut(id);
});
// recording a key on the Shortcuts tab: this runs before anything else so the key you press isn't acted on
window.addEventListener("keydown", (e) => {
  if (!KEY_REC) return;
  e.preventDefault(); e.stopPropagation();
  const { id, btn } = KEY_REC, mods = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const msg = (h, cls) => { const m = btn.closest(".kb-row").querySelector(".kb-msg"); if (m) { m.className = "kb-msg " + (cls || ""); m.innerHTML = h; } };
  if (e.code === "Escape" && !mods) return stopKeyRec();
  if ((e.code === "Backspace" || e.code === "Delete") && !mods) { setKeyFor(id, ""); stopKeyRec(); msg("Shortcut removed."); return; }
  const c = comboOf(e);
  if (!c) { btn.innerHTML = `<span class="kb-live">${[e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean).map((p) => keyChips(p)).join('<span class="kplus">+</span>')} + …</span>`; return; }
  const why = reservedWhy(c);
  if (why) { msg(`${esc(keyText(c))} is already used for <b>${esc(why)}</b>. Try another key, or press Esc to stop.`, "bad-t"); return; }
  const owner = keyOwner(c);
  if (owner === id) return stopKeyRec();
  if (owner) setKeyFor(owner, "");
  setKeyFor(id, c);
  stopKeyRec();
  if (owner) drawShortcutLists(`${esc(keyText(c))} was on <b>${esc(keyLabel(owner))}</b>, so it's been moved here.`, id);
  else drawShortcutLists("", id);
}, true);
function startKeyRec(btn) {
  stopKeyRec(true);
  KEY_REC = { id: btn.dataset.kid, btn };
  btn.classList.add("rec");
  btn.innerHTML = '<span class="kb-live">Press a key…</span>';
  const m = btn.closest(".kb-row").querySelector(".kb-msg");
  if (m) { m.className = "kb-msg"; m.innerHTML = `Hold ${IS_MAC() ? "⌘ Cmd, ⌥ Option or ⇧ Shift" : "Ctrl, Alt or Shift"} with a letter or number, or use F1–F12. Esc stops, Backspace removes it.`; }
}
function stopKeyRec(quiet) {
  if (!KEY_REC) return;
  const { btn, id } = KEY_REC;
  KEY_REC = null;
  if (!quiet && btn.isConnected) { btn.classList.remove("rec"); btn.innerHTML = keyBtnInner(keyFor(id)); const m = btn.closest(".kb-row").querySelector(".kb-msg"); if (m && !m.classList.contains("bad-t")) m.innerHTML = ""; }
  else if (btn.isConnected) { btn.classList.remove("rec"); btn.innerHTML = keyBtnInner(keyFor(id)); }
}
document.addEventListener("mousedown", (e) => { if (KEY_REC && !e.target.closest(".kb-set.rec")) stopKeyRec(); });
window.addEventListener("hashchange", () => { KEY_REC = null; });
const keyBtnInner = (combo) => (combo ? keyChips(combo) : '<span class="kb-none">Set a key</span>');
function shortcutsPage() {
  return settingsTabs("shortcuts") + `<div class="page-head"><div><h1>Shortcuts</h1><div class="sub">Give any page, favourite or menu-bar button its own key, then press it from anywhere in the viewer to go straight there. None are set to start with.</div></div>
    <div class="kb-tools fd-tools"><input type="search" id="kb-find" placeholder="Search pages" aria-label="Search pages"><button class="btn" id="kb-clear-all">Remove all shortcuts</button></div></div>
    <div class="kb-note" id="kb-note"></div><div id="kb-lists"></div>
    <div class="set-h" style="margin-top:14px">Shortcuts are kept in this browser on this computer. Favourites and their keys belong to the database that's open, so each save has its own. Keys don't do anything while you're typing in a box unless they use Ctrl, Alt or ${IS_MAC() ? "⌘ Cmd" : "the Windows key"}.</div>`;
}
function drawShortcutLists(note, flashId) {
  const box = $("#kb-lists");
  if (!box) return;
  const q = (($("#kb-find") || {}).value || "").trim().toLowerCase();
  const rowHtml = (g, [id, label, ic, href, sub]) => {
    const k = keyFor(id), fav = g === "Favourites", i = fav ? getFavs().findIndex((f) => "fav:" + f.h === id) : -1;
    const name = href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label);
    return `<div class="kb-row${flashId === id ? " flash" : ""}" data-row="${esc(id)}"><span class="kb-ic">${icon(ic)}</span><div class="kb-name">${name}${sub && sub !== g ? ` <span class="muted small">${esc(sub)}</span>` : ""}<div class="kb-msg"></div></div>
      ${fav ? `<span class="kb-fav-acts"><button class="btn sm" data-fav-up="${i}" title="Move up" ${i === 0 ? "disabled" : ""}>▲</button><button class="btn sm" data-fav-down="${i}" title="Move down" ${i === getFavs().length - 1 ? "disabled" : ""}>▼</button><button class="btn sm" data-fav-rn="${i}" title="Rename">Rename</button><button class="btn sm" data-fav-rm="${i}" title="Remove from favourites">Remove</button></span>` : ""}
      <button class="kb-set" data-kid="${esc(id)}" title="Click, then press the key you want">${keyBtnInner(k)}</button>
      <button class="kb-x" data-kclear="${esc(id)}" title="Remove this shortcut" aria-label="Remove this shortcut" ${k ? "" : "hidden"}>✕</button></div>`;
  };
  let h = "", any = false;
  for (const [g, rows] of keyTargets()) {
    const show = rows.filter((r) => !q || (r[1] + " " + g + " " + (r[4] || "")).toLowerCase().includes(q) || (keyFor(r[0]) && keyText(keyFor(r[0])).toLowerCase().includes(q)));
    if (g === "Favourites" && !q) {
      h += panel(`Favourites <span class="muted small" style="font-weight:400">· this database</span>`, rows.length ? show.map((r) => rowHtml(g, r)).join("")
        : `<div class="empty">No favourites yet. Click <span class="fav-star-t">☆</span> in the menu bar on any page to add it to the side menu, then give it a key here.</div>`);
      continue;
    }
    if (!show.length) continue;
    any = true;
    h += panel(g, show.map((r) => rowHtml(g, r)).join(""));
  }
  if (q && !any && !h) h = `<div class="empty">No pages match “${esc(q)}”.</div>`;
  box.innerHTML = `<div class="kb-grid">${h}</div>`;
  const n = $("#kb-note");
  if (n) { n.innerHTML = note || ""; n.hidden = !note; }
  const used = Object.keys(getKeys()).length + getFavs().filter((f) => f.k).length, ca = $("#kb-clear-all");
  if (ca) { ca.disabled = !used; ca.textContent = used ? `Remove all shortcuts (${used})` : "Remove all shortcuts"; delete ca.dataset.sure; }
}
shortcutsPage.after = () => {
  drawShortcutLists();
  const box = $("#kb-lists");
  $("#kb-find").addEventListener("input", () => drawShortcutLists());
  box.addEventListener("click", (e) => {
    const set = e.target.closest(".kb-set"), clr = e.target.closest("[data-kclear]");
    if (set) { if (set.classList.contains("rec")) stopKeyRec(); else startKeyRec(set); return; }
    if (clr) { setKeyFor(clr.dataset.kclear, ""); drawShortcutLists(); return; }
    const l = getFavs(), up = e.target.closest("[data-fav-up]"), dn = e.target.closest("[data-fav-down]"), rn = e.target.closest("[data-fav-rn]"), rm = e.target.closest("[data-fav-rm]");
    if (up || dn) { const i = +(up ? up.dataset.favUp : dn.dataset.favDown), j = up ? i - 1 : i + 1; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setFavs(l); return; }
    if (rm) { const i = +rm.dataset.favRm, [gone] = l.splice(i, 1); setFavs(l); toast(`Removed <b>${esc(gone.t)}</b> from your favourites`, ["Undo", () => { const x = getFavs(); x.splice(i, 0, gone); setFavs(x); }]); return; }
    if (rn) {
      const i = +rn.dataset.favRn, row = rn.closest(".kb-row"), nm = row.querySelector(".kb-name a");
      const inp = document.createElement("input"); inp.type = "text"; inp.value = l[i].t; inp.maxLength = 80; inp.className = "kb-rename"; inp.setAttribute("aria-label", "Favourite's name");
      nm.replaceWith(inp); inp.focus(); inp.select();
      let done = false;
      const fin = (keep) => { if (done) return; done = true; const v = inp.value.trim(), x = getFavs(); if (keep && v && x[i]) { x[i].t = v; setFavs(x); } else drawShortcutLists(); };
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") fin(true); if (ev.key === "Escape") fin(false); });
      inp.addEventListener("blur", () => fin(true));
    }
  });
  const ca = $("#kb-clear-all");
  ca.onclick = () => {
    if (!ca.dataset.sure) { ca.dataset.sure = "1"; ca.textContent = "Click again to remove them all"; ca.classList.add("danger"); return; }
    setKeys({});
    const l = getFavs(); l.forEach((f) => delete f.k);
    try { localStorage.setItem("hrm.favs:" + dbKeyId(), JSON.stringify(l)); } catch (e) { /* this session only */ }
    ca.classList.remove("danger"); renderSidebar(); favSync(); drawShortcutLists("All shortcuts removed.");
  };
};

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
  "": homePage, horses: horsesPage, notes: notesPage, tags: Object.assign(() => tagsPage(), { after: () => tagsPage.after() }), horse: (r) => (r.parts[2] === "awards" ? entityAwardsPage("horse", r) : r.parts[2] === "fans" ? horseFansPage(r.parts[1]) : r.parts[2] === "training" ? horseTrainingPage(r.parts[1]) : r.parts[2] === "races" ? horseRacesPage(r.parts[1]) : horsePage(r.parts[1])), races: racesPage, race: Object.assign((r) => racePage(r.parts[1]), { after: () => {
    $$("[data-openall]", APP).forEach((b) => b.addEventListener("click", () => {
      const open = b.textContent.startsWith("Open");
      $$(".rtoggle", APP).forEach((t) => { if (t.classList.contains("open") !== open) t.click(); });
      b.textContent = open ? "Close all form" : "Open all form";
    }));
  } }),
  stables: stablesPage, stable: (r) => (r.parts[2] === "races" ? stableRacesPage(r) : r.parts[2] === "financials" ? stableFinancePage(r) : r.parts[2] === "horse-money" ? stableHorseMoneyPage(r) : r.parts[2] === "awards" ? stableAwardsPage(r) : r.parts[2] === "racecourses" ? stableCoursesPage(r) : stablePage(r.parts[1])), people: peoplePage, "people-overview": peopleOverviewPage, jockeys: careersPage, person: Object.assign((r) => (r.parts[2] === "awards" ? entityAwardsPage("person", r) : r.parts[2] === "family" ? personFamilyPage(r) : r.parts[2] === "tree" ? personTreePage(r)
    : r.parts[2] === "dynasty" ? personDynastyPage(r) : r.parts[2] === "lifespans" ? personLifespansPage(r) : r.parts[2] === "season" ? jockeySeasonPage(r) : personPage(r.parts[1])),
    { after: (r) => (r.parts[2] === "tree" ? tcInit() : r.parts[2] === "dynasty" ? dtInit() : null) }),
  courses: coursesPage, course: Object.assign((r) => courseTabPage(r), { after: (r) => r.parts[2] === "records" && coursePage.after && coursePage.after(r) }), tables: tablesPage,
  compare: Object.assign((r) => comparePage(r), { after: (r) => comparePage.after(r) }),
  concepts: conceptsPage, concept: conceptPage, qualifying: qualifyingPage,
  pedigrees: pedigreesPage, pedigree: Object.assign((r) => pedigreePage(r.parts[1], r.q), { after: (r) => pedigreePage.after && pedigreePage.after(r) }), "horse-table": horseTablePage, "stable-table": stableTablePage, "stable-rankings": stableRankingsPage,
  versions: versionsPage, meetings: meetingsPage, awards: (r) => awardsPage(r.q || {}), settings: Object.assign(() => settingsPage(), { after: (r) => settingsPage.after(r) }), databases: Object.assign(() => databasesPage(), { after: () => databasesPage.after() }),
  shortcuts: Object.assign(() => shortcutsPage(), { after: () => shortcutsPage.after() }),
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
  favSync();
  if ((!STATUS || !STATUS.loaded) && !["databases", "versions", "settings", "shortcuts"].includes(key)) return welcome();
  const fn = PAGES[key];
  if (!fn) { APP.innerHTML = `<div class="err-box">Page not found. <a href="#/">Go home</a></div>`; return; }
  if (!APP.dataset.keep) APP.innerHTML = `<div class="loading">Loading…</div>`;
  delete APP.dataset.keep;
  try {
    await loadHorsePics();
    const html = await fn(route);
    if (seq !== RENDER_SEQ) return;
    if (typeof html === "string") {
      const tabKey = { courses: "racing", horses: "horses", "horse-table": "horses", pedigrees: "horses", stables: "stables", "stable-table": "stables", "stable-rankings": "stables" }[key];
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
// rows for horses (and people) in stables you own are highlighted in every table, except on the stable pages themselves
let OWN_MEMO = { st: undefined, set: new Set() };
function ownedSet() {
  if (OWN_MEMO.st !== STATUS) OWN_MEMO = { st: STATUS, set: new Set(((STATUS && STATUS.my_stables) || []).filter((s) => s.mine && !/^(Manager|Assistant manager)$/.test(s.role)).map((s) => s.id)) };
  return OWN_MEMO.set;
}
const OWN_OFF_ROUTES = ["stable", "stables", "stable-table", "stable-rankings"];
const ownHlOn = () => !OWN_OFF_ROUTES.includes(parseHash().parts[0] || "");
const isOwnRow = (r) => { const sid = r && (r.stable_id ?? r.horse_stable_id); return sid != null && ownedSet().has(+sid); };
const OWN_KEY = `<div class="own-foot"><span class="own-key"><i></i>In a stable you own</span></div>`;
function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return `<div class="empty">${opts.empty || "Nothing to show."}</div>`;
  // (not when every row is yours, e.g. your own horse's race record: then there's nothing to pick out)
  let ownOn = !opts.noOwn && ownHlOn();
  if (ownOn && rows.length > 1 && rows.every(isOwnRow)) ownOn = false;
  let owns = 0;
  const rowCls = (r) => { const c = opts.rowClass ? opts.rowClass(r) : ""; if (ownOn && isOwnRow(r)) { owns++; return (c + " own").trim(); } return c; };
  const head = cols.map((c) => {
    const cls = [c.cls || "", c.sort ? "sortable" : "", c.sort && opts.sort === c.sort ? "sorted" : ""].join(" ");
    const arrow = c.sort && opts.sort === c.sort ? (opts.dir === "asc" ? " ▲" : " ▼") : "";
    const asc = c.sort && opts.ascCols && opts.ascCols.includes(c.sort) ? ' data-asc="1"' : "";
    return `<th class="${cls}" ${c.sort ? `data-sort="${c.sort}"` : ""}${asc}>${c.h}${arrow}</th>`;
  }).join("");
  // optional row of group headings above the column headings: [[label, columns spanned, class], ...]
  const groups = opts.groups ? `<tr class="grp-row">${opts.groups.map(([t, n, c]) => `<th colspan="${n}" class="grp ${c || ""}">${t}</th>`).join("")}</tr>` : "";
  const body = rows.map((r) => `<tr class="${rowCls(r)}">${cols.map((c) => `<td class="${c.cls || ""}">${c.f(r)}</td>`).join("")}</tr>`).join("");
  const tcls = opts.tcls ? " " + opts.tcls : "";
  const key = owns ? OWN_KEY : "";
  return opts.wide ? `<div class="wide-wrap"><table class="data wide${tcls}"><thead>${groups}<tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${key}`
    : `<div class="tbl-wrap"><table class="data${tcls}"><thead>${groups}<tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${key}`;
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
// the same colours lightened for dark mode, so lines stand out against the dark background
const DARK_COLS = { "#1f5240": "#4cb98a", "#b5872c": "#e0b453", "#3e6e9e": "#6fa8e6", "#a8714a": "#d9a077", "#7a4f9a": "#b38ae0", "#c0504d": "#ef7a76", "#18202f": "#e2e7ef" };
const isDark = () => document.documentElement.classList.contains("dark");
const chCol = (c) => (isDark() && DARK_COLS[String(c).toLowerCase()]) || c;
const seriesCol = (s, i) => chCol(s.color || PALETTE[i % PALETTE.length]);
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
const YEAR_S = 365.25 * 86400;
function lineChart(series, opts = {}) {
  const id = "ch" + ++CHART_SEQ;
  CHARTS[id] = { series, opts: Object.assign({ yFmt: (v) => fNum(v), height: 220, invert: false, yInt: false, yMin: null, yMax: null, width: 680 }, opts), hidden: new Set(), range: chartDefaultRange() };
  if (opts.scale === "auto") CHARTS[id].opts.scale = autoScale(series);
  const ok = series.some((s) => s.points.filter((p) => isNum(p[1])).length) && series.flatMap((s) => s.points.filter((p) => isNum(p[1]))).length >= 2;
  if (!ok) { delete CHARTS[id]; return `<div class="empty">Not enough history to chart.</div>`; }
  return `<div class="chartbox" id="${id}">${chartInner(id)}</div>`;
}
// "auto": a log scale only when a few values dwarf the rest (the biggest is over 20 times the typical size),
// otherwise a plain linear scale; the Linear / Log switch still changes it
function autoScale(series) {
  const v = series.flatMap((s) => s.points.map((p) => Math.abs(p[1]))).filter((x) => isNum(x) && x > 0).sort((a, b) => a - b);
  if (v.length < 3) return "linear";
  return v[v.length - 1] / v[v.length >> 1] > 20 ? "symlog" : "linear";
}
// smoothing: each point averaged with its neighbours (one each side), so the trend shows through month-to-month swings
const smooth3 = (pts) => pts.map((p, i) => { const w = pts.slice(Math.max(0, i - 1), i + 2); const q = p.slice(); q[1] = w.reduce((a, x) => a + x[1], 0) / w.length; return q; });
// your racing season (Settings → Display): the day it starts, and whether race series keep their own season
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function seasonStart() { try { const v = localStorage.getItem("hrm.season"); return /^\d{2}-\d{2}$/.test(v || "") ? v : "08-01"; } catch (e) { return "08-01"; } }
function seriesOwnSeason() { try { return localStorage.getItem("hrm.seasonSeries") === "1"; } catch (e) { return false; } }
const seasonQS = (series) => "ss=" + (series && seriesOwnSeason() ? "auto" : seasonStart());
function seasonText() { const [m, d] = seasonStart().split("-").map(Number); return m === 1 && d === 1 ? "calendar years" : `seasons starting ${d} ${MONTHS_LONG[m - 1]}`; }
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
  // smoothing is offered on charts with plenty of points (not positions or counts)
  const canSmooth = o.smooth !== false && !o.invert && !o.yInt && C.series.some((s) => !s.dots && s.points.filter((p) => isNum(p[1])).length >= 24);
  const sm = canSmooth && C.smooth;
  const series = C.series.map((s, i) => { const pts = s.points.filter((p) => isNum(p[1]) && p[0] >= from).sort((a, b) => a[0] - b[0]);
    return { ...s, i, color: seriesCol(s, i), pts: sm && !s.dots && pts.length >= 3 ? smooth3(pts) : pts }; })
    .filter((s) => !C.hidden.has(s.i) && s.pts.length);
  const all = series.flatMap((s) => s.pts);
  const W = o.width, H = o.height, l = 64, r = 12, t = 10, b = 30;
  // only ranges that leave at least 4 points on the busiest line (1M is no use on a monthly chart)
  const inRange = (days) => Math.max(...C.series.map((s) => s.points.filter((p) => isNum(p[1]) && p[0] >= tMax - days * 86400).length));
  const ranges = o.ranges !== false && (tMax - tMin) / 86400 > 31 ? `<div class="ch-ranges">${RANGES.filter((x) => !x[2] || (x[2] * 86400 < tMax - tMin && (x[0] === rg[0] || inRange(x[2]) >= 4))).map((x) =>
    `<button class="${x[0] === rg[0] ? "on" : ""}" data-chrange="${x[0]}" title="Show ${x[2] ? "the last " + x[1] : "everything"}">${x[2] ? x[0].toUpperCase() : "All"}</button>`).join("")}</div>` : "";
  // the chart's tool row: linear/log switch (not for positions), time range, enlarge, picture and data downloads
  const canLog = !o.invert && !o.yInt;
  const scaleSw = canLog ? `<div class="ch-sw" role="group" aria-label="Scale"><button class="${o.scale === "symlog" ? "" : "on"}" data-chscale="linear" data-tip="Linear scale: equal steps for equal amounts">Linear</button><button class="${o.scale === "symlog" ? "on" : ""}" data-chscale="symlog" data-tip="Logarithmic scale: each gridline is 10 times the one below, so a few very big values don't squash the rest. Zero and negative values still show; hover for exact amounts.">Log</button></div>` : "";
  const smBtn = canSmooth ? `<button class="${sm ? "on" : ""}" data-chsmooth data-tip="${sm ? "Show the actual values again" : "Smooth the lines: each point is averaged with the ones either side, so the trend shows through the ups and downs. Hover values are smoothed too."}">Smooth</button>` : "";
  const tools = `<div class="ch-tools">${smBtn}${o.big ? "" : `<button data-chexp data-tip="Open this chart large">⤢</button>`}<button data-chpng data-tip="Download this chart as a picture (PNG)">PNG</button><button data-chcsv data-tip="Download the numbers behind this chart (CSV)">CSV</button></div>`;
  const rangeBtns = `<div class="ch-bar">${scaleSw}<span class="grow"></span>${ranges}${tools}</div>`;
  // legend: click to hide/show a line, double-click to show only that line; each entry shows the latest value in view
  const fmtOf = (s) => s.fmt || o.tipFmt || o.yFmt;
  const latestOf = (i) => { const sv = series.find((x) => x.i === i); return sv && sv.pts.length ? sv.pts[sv.pts.length - 1] : null; };
  const lastYr = o.years && all.length ? yearOf(Math.max(...all.map((p) => p[0]))) : null;
  const lead = lastYr ? `<span class="lg-lead">${lastYr}${(o.partialYears || {})[lastYr] ? ` <span class="muted">(${o.partialYears[lastYr]} of 12 months)</span>` : ""}</span>` : "";
  const legend = C.series.length > 1 ? `<div class="legend ch-legend">${lead}${C.series.map((s, i) => { const lp = latestOf(i);
    return `<span class="lg ${C.hidden.has(i) ? "off" : ""}" data-lg="${i}" title="Click to ${C.hidden.has(i) ? "show" : "hide"} this line · double-click to show only this line">
      <i style="background:${seriesCol(s, i)}"></i>${esc(s.name)}${lp && !C.hidden.has(i) ? ` <b class="lg-v">${(o.years ? s.fmt || o.yFmt : fmtOf(s))(lp[1])}</b>` : ""}</span>`; }).join("")}</div>`
    : (() => { const sv = series[0]; if (!sv || sv.pts.length < 2) return "";
      const vals = sv.pts.map((p) => p[1]), hi = sv.pts.reduce((a, p) => (p[1] > a[1] ? p : a)), lo = sv.pts.reduce((a, p) => (p[1] < a[1] ? p : a)), f = fmtOf(sv);
      const first = vals[0], last = vals[vals.length - 1], ch = first ? ((last - first) / Math.abs(first)) * 100 : null;
      const when = o.years ? (ts) => yearOf(ts) : fDate;
      return `<div class="ch-stats"><span>Latest <b>${f(last)}</b></span><span>High <b>${f(hi[1])}</b> <span class="muted">${when(hi[0])}</span></span><span>Low <b>${f(lo[1])}</b> <span class="muted">${when(lo[0])}</span></span>${
        isNum(ch) && !o.invert ? `<span>Change in view <b class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${fNum(ch, 0)}%</b></span>` : ""}</div>`; })();
  // same size as the chart, so the legend doesn't jump while lines are switched off and on
  if (all.length < 1) return rangeBtns + `<div class="empty ch-empty" style="aspect-ratio:${W}/${H}">Nothing to show — all lines are hidden. Click a name below to show it.</div>` + legend;
  let x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  if (o.years) { x0 -= YEAR_S / 2; x1 += YEAR_S / 2; }
  else if (x0 === x1) { x0 -= 86400 * 15; x1 += 86400 * 15; }
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
  C.geo = { x0, x1, l, r, W, H, t, b, X, Y, series, sm };
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
  const PM = (o.years && o.partialYears) || {};   // { year: months } for years with fewer than 12 months on record
  if (o.years) {
    // one column per year: the year's name under its dot, a faint line between years, no months or dates
    const ys = [...new Set(all.map((p) => yearOf(p[0])))].sort((a, b) => a - b);
    const every = Math.max(1, Math.ceil(ys.length / Math.max(4, Math.min(14, Math.floor((W - l - r) / 46)))));
    ys.forEach((y, i) => {
      if (i) { const xb = X(yearStart(y)); g += `<line x1="${xb}" x2="${xb}" y1="${t}" y2="${H - b}" stroke="#f1efe9"/>`; }
      if (i % every && i !== ys.length - 1) return;
      const xm = X(yearStart(y) + YEAR_S / 2);
      g += `<text x="${xm}" y="${H - b + 15}" text-anchor="middle" font-weight="700">${y}</text>`;
      if (PM[y]) g += `<text x="${xm}" y="${H - b + 27}" text-anchor="middle" fill-opacity="0.6">${PM[y]} mo</text>`;
    });
  } else if (yb - ya >= 1) {
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
  if (!o.years) g += `<text x="${l}" y="${H - 3}" text-anchor="start" fill-opacity="0.7">${fDate(x0)}</text><text x="${W - r}" y="${H - 3}" text-anchor="end" fill-opacity="0.7">${fDate(x1)}</text>`;
  if (yb === ya && !o.years) g += `<text x="${(l + W - r) / 2}" y="${H - 3}" text-anchor="middle" font-weight="700">${ya}</text>`;
  const lines = series.map((s) => {
    const xy = (p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`;
    const sw = s.dash ? 1.5 : 2, dash = s.dash ? 'stroke-dasharray="4 3"' : "";
    // a part year (the one in progress, or the first one on record): the stretch to it is faint and dotted, and its dot
    // hollow, so a few months don't read as a rise or a fall
    const part = (p) => !!PM[yearOf(p[0])];
    let line = "", run = [s.pts[0]];
    const flush = () => { if (run.length >= 2) line += `<polyline fill="none" stroke="${s.color}" stroke-width="${sw}" ${dash} points="${run.map(xy).join(" ")}"/>`; };
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1], c = s.pts[i];
      if (part(a) || part(c)) {
        flush(); run = [c];
        line += `<polyline fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-opacity=".55" stroke-dasharray="2 4" points="${xy(a)} ${xy(c)}"/>`;
      } else run.push(c);
    }
    flush();
    const dots = s.dots || (o.years && s.pts.length <= 30) ? s.pts.map((p) => {
      const hollow = part(p);
      return `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${p[3] ? 4.5 : hollow ? 3.5 : 3}" fill="${hollow ? "#fff" : p[3] || s.color}" stroke="${hollow ? s.color : "#fff"}" stroke-width="${hollow ? 1.5 : 1}"/>`;
    }).join("") : "";
    return line + dots;
  }).join("");
  // charts that are on a log scale say so on the picture itself too
  const tags = [LOG && "log scale", sm && "smoothed"].filter(Boolean).join(" · ");
  const logTag = tags ? `<text class="ch-logmark" x="${W - r - 4}" y="${t + 11}" text-anchor="end">${tags}</text>` : "";
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
  const yo = C.opts.years, ty = yo && yearOf(n.at), pm = yo && (C.opts.partialYears || {})[ty];
  const isLast = yo && ty === Math.max(...G.series.flatMap((s) => s.pts.map((p) => yearOf(p[0]))));
  const head = yo ? `${ty}${pm ? ` <span class="muted">· ${pm} of 12 months${isLast ? " so far" : " on record"}</span>` : ""}` : fDate(n.at);
  CHART_TIP.innerHTML = `<div class="d">${head}${G.sm ? ' <span class="muted">· smoothed</span>' : ""}</div>` + n.rows.filter((r) => r.exact).map((r) =>
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
  if (e.target.closest("[data-chsmooth]")) { C.smooth = !C.smooth; box.innerHTML = chartInner(box.id); return; }
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
  CHARTS[id] = { series: C.series, opts: { ...C.opts, width: 1200, height: 480, big: true }, hidden: new Set(C.hidden), range: C.range, smooth: C.smooth };
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
  if (dark) copy.querySelectorAll('circle[fill="#fff"]').forEach((c) => c.setAttribute("fill", "#151b26"));
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", vb.width); copy.setAttribute("height", vb.height);
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `text{font:${cs.fontSize} ${cs.fontFamily};fill:${cs.fill}}`;
  copy.insertBefore(style, copy.firstChild);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", dark ? "#151b26" : "#ffffff");
  copy.insertBefore(bg, style.nextSibling);
  // the legend underneath, as text, so the picture explains itself
  const C = CHARTS[box.id], names = C.series.map((s, i) => ({ n: s.name, c: seriesCol(s, i), off: C.hidden.has(i) })).filter((x) => !x.off);
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
  const day = C.opts.years ? (ts) => String(yearOf(ts)) : (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [[C.opts.years ? "Year" : "Date", ...C.series.map((s) => s.name)].map(q).join(",")];
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
// a tooltip mustn't stay behind when its button goes away with the page
window.addEventListener("hashchange", () => { clearTimeout(TIP_TIMER); TIP.hidden = true; TIP_FOR = null; });
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
    hideCard(); if ((parseHash().parts[0] || "") === "settings") render();
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

// ------------------------------------------------------------------ updates from GitHub: a prompt and a bar when a newer version is out,
// the Settings row, and a list of every version (to update or go back)
let GH = null;
const ghSkipped = () => { try { return localStorage.getItem("hrm.ghLater") || ""; } catch (e) { return ""; } };
const ghSkip = (v) => { try { localStorage.setItem("hrm.ghLater", v); } catch (e) { /* this session only */ } };
let GH_HIDE = false;      // bar closed for this session
let GH_PROMPTED = false;  // the pop-up is shown once each time the viewer opens
async function githubCheck(force) {
  try { GH = await (await fetch("/api/github" + (force ? "?force=1" : ""), { cache: "no-store" })).json(); } catch (e) { GH = null; }
  githubBanner();
  if (GH && GH.auto !== false && GH.newer && ghSkipped() !== GH.latest && !GH_PROMPTED && !document.querySelector(".overlay")) { GH_PROMPTED = true; githubPrompt(); }
  return GH;
}
function githubBanner() {
  const box = $("#gh-banner");
  if (!box) return;
  box.innerHTML = GH && GH.auto !== false && GH.newer && !GH_HIDE && ghSkipped() !== GH.latest ? `<div class="banner gh-ban"><span>⬆ <b>HRM Viewer ${esc(GH.latest)}</b> is available (you have ${esc(GH.current)}).</span>
    <span><button class="btn primary" data-gh-install>Install now</button> <button class="btn" data-gh-notes>What's new</button> <button class="btn" data-gh-hide title="Hide until the viewer is opened again">Later</button></span></div>` : "";
}
// release notes are short Markdown: headings, "- " lists and **bold**
function ghNotes(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>");
  let html = "", list = false;
  for (const line of String(md || "").split(/\r?\n/)) {
    const li = line.match(/^\s*[-*] (.*)/);
    if (li) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    const h = line.match(/^#+ (.*)/);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return (list ? html + "</ul>" : html) || '<p class="muted">No notes.</p>';
}
function ghModal(title, body, wide) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal${wide ? " gh-wide" : ""}"><h2>${title}</h2>${body}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-gh-close]")) ov.remove(); });
  return ov;
}
// the pop-up when the viewer opens and a newer version is out
function githubPrompt() {
  const ov = ghModal(`A new version is available`, `<p>HRM Viewer <b>${esc(GH.latest)}</b> is out — you have ${esc(GH.current)}. Installing takes a few seconds and your data isn't touched.
    If you don't like it, you can go back at any time from <span class="ui">Settings → All versions</span>.</p>
    <div class="gh-notes">${ghNotes(GH.notes)}</div>
    <div class="gh-acts"><button class="btn" data-gh-skip>Skip this version</button><span></span><button class="btn" data-gh-close>Remind me later</button> <button class="btn primary" data-gh-install>Install now</button></div>`);
  ov.addEventListener("click", (e) => {
    if (e.target.closest("[data-gh-skip]")) { ghSkip(GH.latest); githubBanner(); ov.remove(); }
    if (e.target.closest("[data-gh-install]")) ov.remove();
  });
}
async function drawGithubBox() {
  const box = $("#gh-box");
  if (!box) return;
  const g = GH || (await githubCheck(false)) || {};
  if (!box.isConnected) return;   // you've moved on to another page meanwhile
  const auto = g.auto !== false;
  box.innerHTML = `<label class="gh-auto"><input type="checkbox" data-gh-auto ${auto ? "checked" : ""}> Check for updates automatically</label>
    <div class="gh-status">${g.error ? `<span class="err-inline">${esc(g.error)}</span>`
      : g.newer ? `<b>Version ${esc(g.latest)} is available.</b> <button class="btn primary sm" data-gh-install>Install now</button>`
      : g.latest ? `✓ You have the latest version (${esc(g.current || "")}).`
      : !auto ? `<span class="muted">Automatic checks are off. Press Check now to look for a new version.</span>`
      : `✓ You have the latest version (${esc(g.current || "")}).`}</div>
    <div class="gh-links"><button class="btn sm" data-gh-check>Check now</button> <button class="btn sm" data-gh-versions>All versions</button></div>
    <div class="gh-links small">From <a href="https://github.com/${esc(g.repo || "")}" target="_blank" rel="noopener">github.com/${esc(g.repo || "")}</a></div>`;
}
// every version on GitHub: install a newer one, or go back to an older one
async function githubVersions() {
  const ov = ghModal("All versions", `<p class="muted small">Every version published on GitHub. Your data, photos and settings are kept whichever one you choose,
    and you can come back here to change again.</p><div class="gh-vlist"><span class="muted">Loading…</span></div>`, true);
  const list = $(".gh-vlist", ov);
  let j;
  try { j = await (await fetch("/api/github/releases?force=1", { cache: "no-store" })).json(); } catch (e) { j = { error: e.message }; }
  if (j.error) { list.innerHTML = `<div class="err">${esc(j.error)}</div>`; return; }
  if (!j.releases.length) { list.innerHTML = `<p class="muted">No versions published yet.</p>`; return; }
  list.innerHTML = j.releases.map((r) => `<div class="gh-v${r.current ? " is-cur" : ""}">
      <div class="gh-vh"><div><b>${esc(r.version)}</b> <span class="muted small">${r.published ? esc(new Date(r.published).toLocaleDateString()) : ""}</span>
        <div class="small">${esc(String(r.name || "").replace(/^HRM Viewer [\d.]+ — /, ""))}</div></div>
        <div>${r.current ? '<span class="gh-cur">You have this</span>' : `<button class="btn sm${r.newer ? " primary" : ""}" data-gh-pick="${esc(r.version)}" data-older="${r.newer ? "" : "1"}">${r.newer ? "Update to this" : "Go back to this"}</button>`}
        <button class="btn sm" data-gh-fold>Changes</button></div></div>
      <div class="gh-notes" hidden>${ghNotes(r.notes)}</div></div>`).join("");
  list.addEventListener("click", (e) => {
    const f = e.target.closest("[data-gh-fold]");
    if (f) { const n = f.closest(".gh-v").querySelector(".gh-notes"); n.hidden = !n.hidden; return; }
    const b = e.target.closest("[data-gh-pick]");
    if (!b) return;
    const v = b.getAttribute("data-gh-pick");
    if (b.dataset.older) {
      if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = `Go back to ${v}? Click again`; return; }
      // don't keep offering the newest version after choosing to go back from it
      const newest = j.releases[0] && j.releases[0].version;
      if (newest && newest !== v) ghSkip(newest);
    }
    ov.remove();
    githubInstall(v);
  });
}
async function githubInstall(version) {
  const target = version || (GH && GH.latest) || "the update";
  const ov = ghModal(`Installing ${esc(target)}`, `<div class="gh-work"><div class="progress"><div style="width:100%"></div></div><div class="muted">Downloading from GitHub…</div></div>`);
  const say = (m, err) => { $(".gh-work", ov).innerHTML = err ? `<div class="err">${esc(m)}</div><div style="text-align:right;margin-top:12px"><button class="btn" data-gh-close>Close</button></div>` : `<div class="progress"><div style="width:100%"></div></div><div class="muted">${esc(m)}</div>`; };
  try {
    const r = await fetch("/api/github/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(version ? { version } : {}) });
    const j = await r.json();
    if (!r.ok) return say(j.error || "The update couldn't be installed.", true);
    if (j.restarting) { say(`Installed ${j.version}. Restarting the viewer…`); waitForVersion(j.version, (m) => say(m)); }
    else say("Installed. Close HRM Viewer and open it again to finish.");
  } catch (e) { say("The update couldn't be installed: " + e.message, true); }
}
function githubNotesModal() {
  ghModal(`What's new in ${esc(GH.latest)}`, `<div class="gh-notes">${ghNotes(GH.notes)}</div>
    <div class="gh-acts"><a class="btn" href="${esc(GH.release_page || GH.page)}" target="_blank" rel="noopener">Open on GitHub</a><span></span><button class="btn" data-gh-close>Close</button> <button class="btn primary" data-gh-install>Install now</button></div>`)
    .addEventListener("click", (e) => { if (e.target.closest("[data-gh-install]")) e.currentTarget.remove(); });
}
document.addEventListener("change", async (e) => {
  const cb = e.target.closest("[data-gh-auto]");
  if (!cb) return;
  try {
    GH = await (await fetch("/api/github/auto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: cb.checked }) })).json();
  } catch (er) { cb.checked = !cb.checked; return; }
  githubBanner(); drawGithubBox();
});
document.addEventListener("click", async (e) => {
  const inst = e.target.closest("[data-gh-install]");
  if (inst) { e.preventDefault(); return githubInstall(inst.dataset.ver || ""); }
  if (e.target.closest("[data-gh-notes]")) { e.preventDefault(); return githubNotesModal(); }
  if (e.target.closest("[data-gh-hide]")) { GH_HIDE = true; return githubBanner(); }
  if (e.target.closest("[data-gh-versions]")) { e.preventDefault(); return githubVersions(); }
  if (e.target.closest("[data-gh-check]")) { $("#gh-box").innerHTML = '<span class="muted small">Checking…</span>'; await githubCheck(true); return drawGithubBox(); }
});
// check when the viewer opens, then every 6 hours while it's open
setTimeout(() => githubCheck(false), 2500);
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
  // group headings (spanning several columns) don't sort: only the column headings below them do
  if (table.classList.contains("nosort") || !th.textContent.trim() || th.colSpan > 1 || th.parentNode.classList.contains("grp-row")) return;
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
  [...th.parentNode.children].forEach((x) => x.removeAttribute("aria-sort"));
  th.dataset.cdir = dir;
  th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
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
  const count = `${fNum(data.total)} ${data.total === 1 ? singular(cfg.noun) : cfg.noun}`;
  return (cfg.noHead ? (cfg.head || "") : `<div class="page-head"><div><h1>${cfg.title}</h1><div class="sub">${count}</div></div>${exp}</div>${savedViewsBar()}`) + `
    <section class="panel">${cfg.noHead ? `<div class="panel-head"><h2>${cfg.title}</h2><span class="note">${count}</span>${exp ? `<span style="margin-left:auto">${exp}</span>` : ""}</div>` : ""}<div class="filters">${cfg.filters(q, data)}</div>${cfg.intro ? `<div class="note-line">${cfg.intro}</div>` : ""}
    ${table(cfg.rankCol ? [rankCol(sort)].concat(cfg.cols) : cfg.cols, cfg.rankCol ? numberRows(data) : data.rows, { sort, dir, rowClass: cfg.rowClass, wide: cfg.wide, ascCols: cfg.ascDefault, empty: "No matches. Try a different search or filter.", ...(cfg.rankCol ? { tcls: "ranked" } : {}), ...(cfg.tableOpts || {}) })}
    ${pager(data)}</section>`;
}
// a "#" column (16.7.11): each row's rank in the sorted column. The server works it out (_rank) over everything the filters
// keep, so the best is #1 whichever way it's sorted and on any page, and equal figures share a rank. Without one from the
// server it's the row's place in the list. A row with nothing in the sorted column gets no number.
const numberRows = (data) => (data.rows || []).map((r, i) => ({ ...r, _n: "_rank" in r ? r._rank : ((data.page || 1) - 1) * (data.page_size || 0) + i + 1 }));
const rankCol = (sort) => ({ h: `<span data-tip="Rank in the column you've sorted by: the best is #1, and equal figures share a rank. Click any column heading to rank by it.">#</span>`, cls: "num muted rank-col",
  f: (r) => (r._n === null || r._n === undefined || (sort in r && (r[sort] === null || r[sort] === undefined)) ? "" : fNum(r._n)) });
// "1 stable", "1 person": the singular of the nouns the lists use
const singular = (noun) => ({ people: "person", races: "race", horses: "horse", stables: "stable", meetings: "meeting", courses: "course", sires: "sire", dams: "dam",
  "broodmare sires": "broodmare sire", results: "result" }[noun] || noun.replace(/s$/, ""));
function searchBox(q, placeholder, name = "q") {
  return `<input type="search" data-q="${name}" value="${esc(q[name] || "")}" placeholder="${placeholder}" aria-label="${placeholder}">`;
}
function select(name, q, options, label) {
  return `<select data-q="${name}" title="${label || ""}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(q[name] || "") === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
}
function seg(name, q, options, def) {
  const cur = q[name] || def;
  return `<div class="seg" data-def="${esc(def || "")}">${options.map(([v, t]) => `<button data-seg="${name}" data-v="${v}" class="${cur === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
}
// ---- the standard filter bar. Every table's filters are built from these, in this order:
// what the table lists (viewSeg) · search (searchBox) · status (statusSeg) · dropdowns (select) · ranges (rangeBox),
// and a "Clear filters" button appears at the end whenever a filter is set (see markFilterBars).
// Wording: status is always Alive · Deceased · All (horses, people) or Active · Closed · All (stables), narrowest first;
// a dropdown with no filter says "Any …" ("All years" for years); search boxes say "Search …".
const STATUS_OPTS = {
  horse: [["alive", "Alive"], ["dead", "Deceased"], ["all", "All"]],
  person: [["alive", "Alive"], ["dead", "Deceased"], ["all", "All"]],
  stable: [["active", "Active"], ["closed", "Closed"], ["all", "All"]],
};
const statusSeg = (kind, q, def, name = "status") => seg(name, q, STATUS_OPTS[kind], def);
// a switch between what the table lists (Sires · Dams, Jockeys · Trainers, Expenses · Income): not a filter, so Clear leaves it
const viewSeg = (name, q, options, def) => seg(name, q, options, def).replace('<div class="seg"', '<div class="seg seg-view" data-view="1"');
const rangeBox = (label, from, to) => `<span class="frange"><span class="frange-l">${label}</span>${from}<span class="frange-to">to</span>${to}</span>`;
const yearOptions = (years, allValue = "") => [[allValue, "All years"]].concat((years || []).map((y) => [String(y), String(y)]));
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
  // "Clear filters" on every filter bar where a filter is set: puts that bar's filters back to their defaults
  // (the switch for what the table lists, like Sires · Dams, stays as it is)
  $$(".filters", APP).forEach((bar) => {
    const set = new Map();
    $$("[data-q]", bar).forEach((el) => {
      const k = el.dataset.q, v = route.q[k];
      const def = el.tagName === "SELECT" && el.options.length ? el.options[0].value : "";
      if (v !== undefined && v !== "" && v !== def) set.set(k, "");
    });
    $$(".seg:not([data-view])", bar).forEach((g) => {
      const b = g.querySelector("[data-seg]");
      if (!b) return;
      const k = b.dataset.seg, v = route.q[k];
      if (v !== undefined && v !== "" && v !== (g.dataset.def || "")) set.set(k, "");
    });
    if (!set.size) return;
    const btn = document.createElement("button");
    btn.className = "btn fb-clear";
    btn.type = "button";
    btn.textContent = "Clear filters";
    btn.title = "Put the filters back to how they start";
    btn.addEventListener("click", () => { const q = { ...route.q }; for (const k of set.keys()) delete q[k]; delete q.page; delete q.alive; APP.dataset.keep = "1"; go(route.parts, q); });
    bar.appendChild(btn);
  });
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

// home page horse tables: each one switches between all horses, those alive and those that have died
const HOME_HZ = {};
const HZ_LABELS = [["alive", "Alive"], ["dead", "Deceased"], ["all", "All"]];
const hzPick = (key, def) => { try { return localStorage.getItem("hrm.hz." + key) || def; } catch (e) { return def; } };
function hzPanel(key, title, cols, lists, opts = {}) {
  lists = lists && !Array.isArray(lists) ? lists : { all: lists || [], alive: lists || [], dead: [] };
  const cur = hzPick(key, opts.def || "all");
  HOME_HZ[key] = { cols, lists, opts };
  const seg = `<div class="seg hz-seg" role="group" aria-label="Which horses">${HZ_LABELS.map(([v, t]) =>
    `<button data-hz="${key}" data-v="${v}" class="${cur === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
  return `<section class="panel ${opts.cls || ""}" data-hz-panel="${key}"><div class="panel-head"><h2>${title}</h2><span class="note hz-note">${seg}${opts.link ? `<span>${opts.link}</span>` : ""}</span></div>
    <div class="hz-body">${hzTable(key, cur)}</div></section>`;
}
function hzTable(key, which) {
  const { cols, lists, opts } = HOME_HZ[key];
  const list = (lists[which] || []).map((r, i) => ({ ...r, _i: i + 1 }));
  const empty = { all: "No horses.", alive: "No horses alive.", dead: "No horses have died." }[which];
  return table(cols, list, { empty, rowClass: opts.rowClass });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hz]");
  if (!b || !HOME_HZ[b.dataset.hz]) return;
  const key = b.dataset.hz, v = b.dataset.v;
  try { localStorage.setItem("hrm.hz." + key, v); } catch (er) { /* this visit only */ }
  const p = b.closest("[data-hz-panel]");
  p.querySelectorAll("[data-hz]").forEach((x) => x.classList.toggle("on", x === b));
  // the CSV button belongs to the old table: take it away so a fresh one is made for the new table
  p.querySelectorAll(":scope > .panel-head .tbl-tools, :scope > .panel-head .btn-csv").forEach((x) => x.remove());
  p.querySelector(".hz-body").innerHTML = hzTable(key, v);
});

async function homePage() {
  const [d, alerts] = await Promise.all([api("home"), api("alerts").catch(() => null)]);
  const m = STATUS.meta || {};
  const me = d.me, st = STATUS.player_stable;
  let html = updateBanner() + `<div class="page-head"><div><div class="crumb">Game date ${fDate(m.game_date)}</div>
    <h1>${me ? esc(me.name) : "Your save"}</h1>
    <div class="sub">${me ? `${L.person(me.id, "Your profile")}` : ""}${st ? ` · ${L.stable(st.id, st.name)}` : ""}${me ? ` · <a href="#/person/${me.id}/season">Your season</a>` : ""}</div></div></div>`;
  html += alertsPanel(alerts);
  if (me) {
    html += tiles([
      ["Rides", fNum(me.jockey_starts)],
      ["Wins", fNum(me.jockey_wins), `Strike rate ${pct(me.jockey_wins, me.jockey_starts)}`],
      ["Jockey prize money", fMoneyShort(me.jockey_winnings)],
      ["Reputation", fNum(me.reputation, 1)],
      d.my_horses ? ["Horses in your stable", fNum((d.my_horses.alive || []).length)] : null,
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
    html += hzPanel("mine", `${esc(st.name)} horses`, [
      { h: "Horse", f: (r) => `${L.horse(r.id, r.name)}${isNum(r.died) ? ' <span class="badge dead">Dead</span>' : ""}` },
      { h: "Age", cls: "num", f: (r) => fNum(age(r.birth, r.died)) },
      { h: "Sex", f: (r) => esc(r.gender) },
      { h: "Rating", cls: "num", f: (r) => fNum(r.rating) },
      { h: "Form", f: (r) => esc(r.form || "") },
      { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
    ], d.my_horses, { def: "alive", cls: "span-2" });
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
  html += hzPanel("top", "Top earners", [
    { h: "Horse", f: (r) => `${L.horse(r.id, r.name)}${isNum(r.died) ? ' <span class="badge dead">Dead</span>' : ""}` },
    { h: "Age", cls: "num", f: (r) => fNum(age(r.birth, r.died)) },
    { h: "Sex", f: (r) => esc(r.gender) },
    { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable_name) },
    { h: "Earnings", cls: "num", f: (r) => fMoneyShort(r.earnings) },
  ], d.top_horses, { def: "alive", cls: "span-2", link: `<a href="#/horses">All horses</a>` });
  html += `</div>`;
  // leader boards for the whole save
  const ld = d.leaders || {};
  const num = (list) => list.map((r, i) => ({ ...r, _i: i + 1 }));
  const nCol = { h: "#", cls: "num muted", f: (r) => r._i };
  const hName = { h: "Horse", f: (r) => `${L.horse(r.id, r.name)}${isNum(r.died) ? ' <span class="badge dead">Dead</span>' : ""}` };
  const hStable = { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) };
  const board = (title, cols, list, link) => panel(title, table([nCol].concat(cols), num(list || []), { empty: "Nothing yet." }), link || "");
  const hboard = (key, title, cols, lists, link, def) => hzPanel(key, title, [nCol].concat(cols), lists, { link, def });
  html += `<div class="panel-head" style="margin-top:20px"><h2>Leaders across the whole save</h2><span class="note">Every horse, person and stable in this database</span></div>`;
  html += `<div class="grid cols-2 leaders">`;
  html += hboard("rated", "Highest rated horses", [hName, { h: "Age", cls: "num", f: (r) => fNum(age(r.birth, r.died)) }, hStable,
    { h: "Rating", cls: "num", f: (r) => `<b>${fNum(r.rating)}</b>` }, { h: "Peak", cls: "num", f: (r) => fNum(r.peak) }], ld.rated, `<a href="#/horse-table?sort=rating">Horse table</a>`, "alive");
  html += hboard("wins", "Most wins (horses)", [hName, hStable, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) }], ld.wins, `<a href="#/horse-table?sort=wins&status=all">More</a>`);
  html += board("Most jockey wins", [{ h: "Jockey", f: (r) => L.person(r.id, r.name) }, { h: "Rides", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.jockeys, `<a href="#/people?role=Jockey&sort=jockey_wins">Top jockeys</a>`);
  html += board("Most trainer wins", [{ h: "Trainer", f: (r) => L.person(r.id, r.name) }, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "Strike", cls: "num", f: (r) => pct(r.wins, r.starts) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.trainers);
  html += hboard("earners", "Top earners of all time", [hName, hStable, { h: "Record", cls: "num", f: (r) => `${fNum(r.starts)}: ${fNum(r.wins)} wins` },
    { h: "Earnings", cls: "num", f: (r) => `<b>${fMoneyShort(r.earnings)}</b>` }], ld.earners, `<a href="#/horse-table?sort=earnings&status=all">More</a>`);
  html += hboard("g1", "Most Group 1 wins", [hName, hStable, { h: "G1 wins", cls: "num", f: (r) => `<b>${fNum(r.g1)}</b>` },
    { h: "Earnings", cls: "num", f: (r) => fMoneyShort(r.earnings) }], ld.g1, `<a href="#/horse-table?sort=g1&status=all">More</a>`);
  html += board("Most successful stables", [{ h: "Stable", f: (r) => L.stable(r.id, r.name) }, { h: "Starts", cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `<b>${fNum(r.wins)}</b>` }, { h: "G1", cls: "num", f: (r) => fNum(r.g1) },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) }], ld.stables, `<a href="#/stable-table">Stable table</a>`);
  html += hboard("sires", "Leading sires (progeny earnings)", [{ h: "Sire", f: (r) => `${L.horse(r.id, r.name)}${isNum(r.died) ? ' <span class="badge dead">Dead</span>' : ""} <a class="small" href="#/pedigree/${r.id}">tree</a>` },
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
// ------------------------------------------------------------------ your own notes and tags on horses (15.7)
// Kept with each database by the viewer (not in the game), so they survive loading a newer save into it.
let NOTES = { tags: [], items: {} };
async function loadNotes() {
  try { const d = await api("notes"); NOTES = { tags: d.tags || [], items: d.items || {} }; } catch (e) { NOTES = { tags: [], items: {} }; }
  return NOTES;
}
const noteOf = (id) => NOTES.items["horse:" + id] || null;
const tagById = (t) => NOTES.tags.find((x) => x.id === t);
const TAG_COLOURS = [["blue", "Blue"], ["rose", "Pink"], ["amber", "Amber"], ["green", "Green"], ["purple", "Purple"], ["teal", "Teal"], ["red", "Red"], ["orange", "Orange"], ["navy", "Navy"], ["grey", "Grey"]];
const TAG_ICONS = {
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2.2 2.2 2.2 8.8 0 11M8 2.5c-2.2 2.2-2.2 8.8 0 11"/>',
  users: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13a4 4 0 0 1 8 0"/><circle cx="11.2" cy="6" r="1.8"/><path d="M10.6 9.4A3.6 3.6 0 0 1 14 13"/>',
  bag: '<path d="M3 5.5h10l-.8 8H3.8z"/><path d="M5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  note: '<path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5"/>',
  trophy: '<path d="M5 2.5h6v3.5a3 3 0 0 1-6 0z"/><path d="M5 3.5H2.8a2.2 2.2 0 0 0 2.4 2.9M11 3.5h2.2a2.2 2.2 0 0 1-2.4 2.9M8 9v2.5M5.5 13.5h5l-.6-2h-3.8z"/>',
  heart: '<path d="M8 13.2S2.5 10 2.5 6.2A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.2C13.5 10 8 13.2 8 13.2z"/>',
  bus: '<rect x="2.5" y="3" width="11" height="8.5" rx="1.5"/><path d="M2.5 7.5h11M5 11.5v1.5M11 11.5v1.5"/><circle cx="5" cy="9.5" r=".5"/><circle cx="11" cy="9.5" r=".5"/>',
  badge: '<circle cx="8" cy="6" r="3.5"/><path d="M5.8 8.8 5 14l3-1.5 3 1.5-.8-5.2"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/>',
  flag: '<path d="M3.5 14V2.5"/><path d="M3.5 3h8l-1.6 2.5L11.5 8h-8"/>',
};
const tagIc = (k) => `<svg class="fic" viewBox="0 0 16 16" aria-hidden="true">${TAG_ICONS[k] || TAG_ICONS.tag}</svg>`;
const tagChip = (t) => `<span class="tg ${t.color || "grey"}">${tagIc(t.icon || "tag")}${esc(t.name)}</span>`;
// a horse's tags (and a note icon you can point at) for lists and its page heading
function horseTagsHtml(id, withNote = true, auto = null) {
  const it = noteOf(id), extra = autoTagsInner(auto);
  if (!it) return extra ? `<span class="tgs">${extra}</span>` : "";
  const chips = (it.tags || []).map(tagById).filter(Boolean).map(tagChip).join("");
  const ln = latestNote(it), nn = (it.log || []).length, txt = ln ? ln.text + (nn > 1 ? `\n(+${nn - 1} more note${nn > 2 ? "s" : ""})` : "") : "";
  const note = withNote && txt ? `<a class="tg-note" href="#/horse/${id}/fans" data-tip="${esc(txt.slice(0, 240))}${txt.length > 240 ? "…" : ""}" aria-label="Your note">${tagIc("note")}</a>` : "";
  return chips || note || extra ? `<span class="tgs">${chips}${note}${extra}</span>` : "";
}
async function notesPost(path, body) {
  const r = await fetch("/api/notes/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) { /* below */ }
  if (!r.ok) throw new Error(j.error || "Couldn't save it.");
  return j;
}
async function saveHorseNote(id, patch) {
  const j = await notesPost("item", { kind: "horse", id, ...patch });
  if (j.item) NOTES.items[j.key] = j.item; else delete NOTES.items["horse:" + id];
  return j;
}
async function saveTagList(tags) {
  const j = await notesPost("tags", { tags });
  await loadNotes();
  return j;
}
const tagFilterOpts = () => [["", "Any tags"], ["_any", "Tagged by you"], ["_notes", "With your notes"]].concat(NOTES.tags.map((t) => [t.id, t.name]), AUTO_TAG_OPTS);
// automatic tags, from what the save itself records about a horse's fans and sponsor
const AUTO_TAG_OPTS = [["auto:sponsored", "Auto: Sponsored now"], ["auto:website", "Auto: Fan website (top 100)"], ["auto:club", "Auto: Supporters' club (top 50)"],
  ["auto:trips", "Auto: Fan club trips (top 20)"], ["auto:superfans", "Auto: Superfans (top 10)"], ["auto:merch", "Auto: Merchandise deal"]];
const FAN_STEPS = [[1, "No. 1 by fans", "trophy", "superfans"], [10, "Superfans", "heart", "superfans"], [20, "Fan club trips", "bus", "trips"], [50, "Supporters' club", "users", "club"], [100, "Fan website", "globe", "website"]];
const fanStep = (band) => (band > 0 ? FAN_STEPS.find(([b]) => band <= b) || null : null);
// a step it reached but isn't at any more: its rank now (living horses), or why it has none
const fanWas = (top, rank, died) => (died ? "died" : !isNum(rank) ? "now unranked" : rank > top ? "now #" + fNum(rank) : "");
function fShortN(n) {
  if (!isNum(n)) return "—";
  const a = Math.abs(n);
  return a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "M" : a >= 1e4 ? Math.round(n / 1e3) + "k" : fNum(n, 0);
}
// the automatic chips (outlined, so they read differently from your own tags)
function autoTagsInner(a) {
  if (!a) return "";
  const st = fanStep(a.band), out = [];
  if (st) {
    const was = fanWas(st[0], a.rank, a.died);
    const tip = `Best fan ranking reached: top ${st[0]} in the world · ${was ? (a.died ? "it has since died" : `not any more: ${isNum(a.rank) ? "#" + fNum(a.rank) + " now" : "no longer ranked"}`) : `still there: #${fNum(a.rank)} now`} · ${fShortN(a.fans)} fans`;
    out.push(`<span class="tg auto fan${was ? " was" : ""}" data-tip="${tip}">${tagIc(st[2])}${esc(st[1])}${was ? `<span class="tg-was">· ${was}</span>` : ""}</span>`);
  }
  if (a.sponsor) out.push(`<span class="tg auto spon" data-tip="Sponsored by ${esc(a.sponsor)}${isNum(a.pay) ? " · " + fMoneyShort(a.pay) + " a month" : ""}">${tagIc("badge")}Sponsored</span>`);
  if (a.merch) out.push(`<span class="tg auto merch" data-tip="Offered a merchandise deal (from your inbox)">${tagIc("bag")}Merch</span>`);
  return out.join("");
}
// colour swatches for a new tag
let HN_COLOUR = "", NT_COLOUR = "";
const nextColour = () => { const used = NOTES.tags.map((t) => t.color); return (TAG_COLOURS.find(([c]) => !used.includes(c)) || TAG_COLOURS[NOTES.tags.length % TAG_COLOURS.length])[0]; };
function tagColourPick(kind, cur) {
  const c0 = cur || nextColour();
  return `<span class="nt-cols tc-pick" role="radiogroup" aria-label="Colour for the new tag">${TAG_COLOURS.map(([c, n]) =>
    `<button type="button" class="nt-c ${c}${c === c0 ? " on" : ""}" data-tc="${kind}" data-c="${c}" role="radio" aria-checked="${c === c0}" aria-label="${n}" title="${n}"></button>`).join("")}</span>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tc]");
  if (!b) return;
  e.preventDefault();
  $$(".nt-c", b.parentNode).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
  if (b.dataset.tc === "hn") HN_COLOUR = b.dataset.c; else NT_COLOUR = b.dataset.c;
});
const pickedColour = (root) => { const on = root && $(".tc-pick .nt-c.on", root); return on ? on.dataset.c : nextColour(); };
// ------------------------------------------------------------------ a horse's tags and notes log (right-hand side of its Fans, sponsors & notes tab)
const noteLog = (it) => ((it && it.log) || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
const latestNote = (it) => noteLog(it)[0] || null;
const fWhen = (t) => (isNum(t) ? new Date(t * 1000).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
function horseTagsPanel(id) {
  const it = noteOf(id) || {}, on = new Set(it.tags || []);
  const chips = NOTES.tags.map((t) => `<button class="tg-tog ${t.color || "grey"}${on.has(t.id) ? " on" : ""}" data-hn-tag="${esc(t.id)}" aria-pressed="${on.has(t.id)}">${tagIc(t.icon || "tag")}${esc(t.name)}</button>`).join("");
  return `<section class="panel hn-panel" data-hn="${id}"><div class="panel-head"><h2>Your tags</h2><span class="note"><a href="#/tags">Create or edit tags in Settings</a></span></div>
    <div class="hn-tags">${chips || '<span class="muted small">No tags yet. Create them in <a href="#/tags">Settings → Tags</a>.</span>'}</div>
    <div class="small muted hn-state" style="margin-top:8px">Click a tag to put it on this horse or take it off.</div></section>`;
}
function noteEntry(n) {
  return `<li class="hl-item" data-nid="${esc(n.id)}"><div class="hl-meta"><span>${fWhen(n.at)}</span>${isNum(n.gd) ? `<span class="hl-gd">Game date ${fDate(n.gd)}</span>` : ""}${n.edited ? `<span class="hl-ed" data-tip="Edited ${fWhen(n.edited)}">edited</span>` : ""}
    <span class="hl-acts"><button class="lnk" data-hl-edit>Edit</button><button class="lnk danger-t" data-hl-del>Delete</button></span></div>
    <div class="hl-text">${esc(n.text)}</div></li>`;
}
function horseNotesPanel(id) {
  const log = noteLog(noteOf(id));
  return `<section class="panel hlog-panel" data-hl="${id}"><div class="panel-head"><h2>Your notes <span class="muted small" id="hl-n">${log.length ? fNum(log.length) : ""}</span></h2><span class="note">Only you see these · <a href="#/notes">All notes</a></span></div>
    <textarea class="hl-new" rows="3" maxlength="20000" placeholder="Write a note and press Enter to save it (Shift+Enter for a new line)" aria-label="New note"></textarea>
    <div class="hl-bar"><span class="small muted hl-state"></span><button class="btn sm primary" data-hl-add>Save note</button></div>
    <ol class="hl-log">${log.map(noteEntry).join("") || '<li class="hl-empty muted small">No notes yet. Anything goes: its website, fan club, plans, reminders…</li>'}</ol></section>`;
}
function hnRefreshHead(id) {
  const h = $("#hn-head");
  if (h) h.innerHTML = horseTagsHtml(id, false);
}
function hlRedraw(box, id, msg) {
  const log = noteLog(noteOf(id));
  $(".hl-log", box).innerHTML = log.map(noteEntry).join("") || '<li class="hl-empty muted small">No notes yet.</li>';
  $("#hl-n").textContent = log.length ? fNum(log.length) : "";
  if (msg) $(".hl-state", box).textContent = msg;
}
async function hlAdd(box) {
  const id = +box.dataset.hl, ta = $(".hl-new", box), text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const st = $(".hl-state", box);
  st.textContent = "Saving…";
  try { await saveHorseNote(id, { add: text }); ta.value = ""; hlRedraw(box, id, "Saved"); hnRefreshHead(id); ta.focus(); } catch (er) { st.textContent = er.message; }
}
async function hlSaveEdit(li) {
  const box = li.closest("[data-hl]"), id = +box.dataset.hl, ta = $(".hl-edit", li);
  try { await saveHorseNote(id, { edit: { id: li.dataset.nid, text: ta.value } }); hlRedraw(box, id, ta.value.trim() ? "Changed" : "Deleted"); hnRefreshHead(id); }
  catch (er) { $(".hl-state", box).textContent = er.message; }
}
document.addEventListener("click", async (e) => {
  const tbox = e.target.closest("[data-hn]");
  const tg = tbox && e.target.closest("[data-hn-tag]");
  if (tg) {
    const id = +tbox.dataset.hn, st = $(".hn-state", tbox), it = noteOf(id) || {}, tags = new Set(it.tags || []);
    tags.has(tg.dataset.hnTag) ? tags.delete(tg.dataset.hnTag) : tags.add(tg.dataset.hnTag);
    try {
      await saveHorseNote(id, { tags: [...tags] });
      tg.classList.toggle("on", tags.has(tg.dataset.hnTag)); tg.setAttribute("aria-pressed", tags.has(tg.dataset.hnTag));
      st.textContent = "Saved"; hnRefreshHead(id);
    } catch (er) { st.textContent = er.message; }
    return;
  }
  const box = e.target.closest("[data-hl]");
  if (!box) return;
  const id = +box.dataset.hl, li = e.target.closest(".hl-item");
  if (e.target.closest("[data-hl-add]")) return hlAdd(box);
  if (li && e.target.closest("[data-hl-edit]")) {
    const n = noteLog(noteOf(id)).find((x) => x.id === li.dataset.nid);
    if (!n) return;
    $(".hl-text", li).outerHTML = `<div class="hl-editbox"><textarea class="hl-edit" rows="3" maxlength="20000" aria-label="Edit note">${esc(n.text)}</textarea>
      <div class="hl-bar"><span class="small muted">Enter saves · Esc cancels</span><span><button class="btn sm" data-hl-cancel>Cancel</button> <button class="btn sm primary" data-hl-save>Save</button></span></div></div>`;
    $(".hl-acts", li).hidden = true;
    const ta = $(".hl-edit", li); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    return;
  }
  if (li && e.target.closest("[data-hl-save]")) return hlSaveEdit(li);
  if (li && e.target.closest("[data-hl-cancel]")) return hlRedraw(box, id);
  const del = li && e.target.closest("[data-hl-del]");
  if (del) {
    if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = "Delete this note?"; setTimeout(() => { if (del.isConnected) { delete del.dataset.sure; del.textContent = "Delete"; } }, 4000); return; }
    try { await saveHorseNote(id, { delete: li.dataset.nid }); hlRedraw(box, id, "Deleted"); hnRefreshHead(id); } catch (er) { $(".hl-state", box).textContent = er.message; }
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    const ta = e.target.closest && e.target.closest(".hl-new, .hl-edit");
    if (!ta) return;
    e.preventDefault();
    if (ta.classList.contains("hl-new")) hlAdd(ta.closest("[data-hl]")); else hlSaveEdit(ta.closest(".hl-item"));
  } else if (e.key === "Escape" && e.target.closest && e.target.closest(".hl-edit")) {
    const box = e.target.closest("[data-hl]");
    e.preventDefault(); e.stopPropagation(); hlRedraw(box, +box.dataset.hl);
  }
}, true);

// the Notes & tags page: every horse you've tagged or written about
async function notesPage(route) {
  const q = route.q || {};
  const d = await api("notes?detail=1");
  NOTES = { tags: d.tags || [], items: d.items || {} };
  const horses = d.horses || {};
  const count = {};
  Object.values(NOTES.items).forEach((it) => (it.tags || []).forEach((t) => (count[t] = (count[t] || 0) + 1)));
  let html = `<div class="page-head"><div><div class="crumb"><a href="#/horses">Horses</a></div><h1>Notes &amp; tags</h1>
    <div class="sub">Your own notes and tags on horses: websites, fan clubs, merchandise, plans, anything. Only you see them; they're kept with this database, so they stay when you load a newer save into it.</div></div></div>`;
  html += sectionTabs("horses", "notes");
  html += `<div class="nt-sum">${NOTES.tags.map((t) => `<a class="tg ${t.color || "grey"}" href="${hashFor(["notes"], { ...q, tag: t.id })}">${tagIc(t.icon || "tag")}${esc(t.name)} <b>${fNum(count[t.id] || 0)}</b></a>`).join("")}
    <a class="btn sm" href="#/tags">Create or edit tags</a></div>`;
  const text = (q.q || "").trim().toLowerCase(), tag = q.tag || "";
  const list = Object.entries(NOTES.items).filter(([k]) => k.startsWith("horse:")).map(([k, it]) => ({ id: +k.slice(6), ...it, ...(horses[+k.slice(6)] || {}) }))
    .filter((r) => (!tag || (tag === "_notes" ? (r.log || []).length : tag === "_any" ? (r.tags || []).length : (r.tags || []).includes(tag))))
    .filter((r) => !text || `${r.name || ""} ${(r.log || []).map((n) => n.text).join(" ")} ${r.stable || ""}`.toLowerCase().includes(text))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  html += `<div style="margin-top:16px">${panel(`Horses <span class="muted small">${fNum(list.length)}</span>`, `<div class="filters">${searchBox(q, "Search names and notes")}${select("tag", q, tagFilterOpts().filter(([k]) => !k.startsWith("auto:")))}</div>` + table([
    { h: "Horse", cls: "nowrap", f: (r) => `${horseThumb(r.id)}${r.name ? `<a href="#/horse/${r.id}/fans">${esc(r.name)}</a>` : `<span class="muted">Horse #${r.id} (not in this save)</span>`}${r.died ? ' <span class="badge dead">Dead</span>' : ""}` },
    { h: "Tags", f: (r) => (r.tags || []).map(tagById).filter(Boolean).map(tagChip).join(" ") || '<span class="muted">—</span>' },
    { h: "Latest note", cls: "nt-note", f: (r) => { const n = latestNote(r); return n ? esc(n.text.slice(0, 220)) + (n.text.length > 220 ? "…" : "") : '<span class="muted">—</span>'; } },
    { h: "Notes", cls: "num", f: (r) => fNum((r.log || []).length) },
    { h: "Stable", f: (r) => (r.stable_id ? L.stable(r.stable_id, r.stable) : '<span class="muted">—</span>') },
    { h: "Changed", cls: "num nowrap", f: (r) => (r.updated ? fDate(r.updated) : "—") },
  ], list, { empty: Object.keys(NOTES.items).length ? "No horses match." : "No notes or tags yet. Open any horse's Fans, sponsors & notes tab to add them." }))}</div>`;
  return html;
}

// Settings → Tags: create, rename, recolour and delete your tags
async function tagsPage() {
  await loadNotes();
  const count = {};
  Object.values(NOTES.items).forEach((it) => (it.tags || []).forEach((t) => (count[t] = (count[t] || 0) + 1)));
  let html = settingsTabs("tags") + `<div class="page-head"><div><h1>Tags</h1><div class="sub">Your own tags for horses. Make them here, then tick them on a horse's <b>Fans, sponsors &amp; notes</b> tab. They're kept with this database.</div></div></div>`;
  const tagRows = NOTES.tags.map((t, i) => `<div class="nt-row" data-nt="${i}"><span class="tg ${t.color || "grey"}">${tagIc(t.icon || "tag")}</span>
      <input type="text" class="nt-name" value="${esc(t.name)}" maxlength="40" aria-label="Tag name">
      <span class="nt-cols" role="group" aria-label="Colour">${TAG_COLOURS.map(([c, n]) => `<button class="nt-c ${c}${(t.color || "grey") === c ? " on" : ""}" data-nt-c="${c}" aria-label="${n}" aria-pressed="${(t.color || "grey") === c}" title="${n}"></button>`).join("")}</span>
      <a class="small nt-cnt" href="${hashFor(["notes"], { tag: t.id })}">${fNum(count[t.id] || 0)} horse${count[t.id] === 1 ? "" : "s"}</a>
      <button class="btn sm" data-nt-del="${i}">Delete</button></div>`).join("");
  html += panel("New tag", `<div class="nt-add"><input type="text" id="nt-new" maxlength="40" placeholder="Tag name, e.g. Social media" aria-label="New tag name">${tagColourPick("nt", NT_COLOUR)}<button class="btn primary" id="nt-add">Create tag</button><span class="small muted" id="nt-state"></span></div>`);
  html += `<div style="margin-top:16px">${panel(`Your tags <span class="muted small">${fNum(NOTES.tags.length)}</span>`, `<div class="nt-list">${tagRows || '<div class="empty">No tags yet.</div>'}</div>`, "Rename one by typing over it · click a colour to change it")}</div>`;
  html += notesBackupPanel();
  return html;
}
tagsPage.after = () => {
  const say = (m) => { const st = $("#nt-state"); if (st) st.textContent = m; };
  const save = async (tags, msg) => { try { await saveTagList(tags); await render(); say(msg); } catch (e) { say(e.message); } };
  const copy = () => NOTES.tags.map((t) => ({ ...t }));
  $$(".nt-name").forEach((inp) => {
    const go = () => { const i = +inp.closest("[data-nt]").dataset.nt, v = inp.value.trim(); if (!v || v === NOTES.tags[i].name) { inp.value = NOTES.tags[i].name; return; } const t = copy(); t[i].name = v; save(t, "Renamed."); };
    inp.addEventListener("change", go);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
  });
  $$("[data-nt-c]").forEach((b) => b.addEventListener("click", () => { const i = +b.closest("[data-nt]").dataset.nt, t = copy(); t[i].color = b.dataset.ntC; save(t, "Colour changed."); }));
  $$("[data-nt-del]").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.ntDel, n = Object.values(NOTES.items).filter((it) => (it.tags || []).includes(NOTES.tags[i].id)).length;
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.classList.add("danger"); b.textContent = n ? `Remove from ${n} horse${n === 1 ? "" : "s"}?` : "Click again to delete"; return; }
    const t = copy(); t.splice(i, 1); save(t, "Deleted.");
  }));
  const add = () => {
    const inp = $("#nt-new"), v = inp.value.trim();
    if (!v) return inp.focus();
    if (NOTES.tags.some((t) => t.name.toLowerCase() === v.toLowerCase())) return say("You already have that tag.");
    const color = pickedColour($(".nt-add")); NT_COLOUR = "";
    save(copy().concat([{ name: v, color }]), `Created “${v}”.`);
  };
  const ab = $("#nt-add");
  if (ab) ab.addEventListener("click", add);
  const ni = $("#nt-new");
  if (ni) { ni.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); }); }
};

async function horsesPage(route) {
  return listPage({
    title: "Horses", noun: "horses", endpoint: "horses", defaultSort: "earnings", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search horses") + statusSeg("horse", q, "alive") +
      select("gender", q, [["", "Any sex"], ["Colt", "Colts"], ["Filly", "Fillies"], ["Stallion", "Stallions"], ["Mare", "Mares"], ["Gelding", "Geldings"]]) + select("tag", q, tagFilterOpts()),
    cols: [
      { h: "Name", sort: "name", f: (r) => `${horseThumb(r.id)}${L.horse(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}${horseTagsHtml(r.id, true, r.auto)}` },
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

// a horse's page heading and its tabs (Overview · Awards)
function horseHead(d, on) {
  const h = d.horse, id = h.horse_horse_id;
  const a = age(h.horse_birth_date, h.horse_deceased_date);
  const dead = isNum(h.horse_deceased_date);
  const pic = horsePic(h.horse_horse_id);
  // the main photo is the horse's profile picture, next to its name
  return `<div class="page-head"><div class="hp-head">${pic ? `<img class="hp-avatar" src="${pic}" alt="${esc(h.horse_name)}" data-gallery="${h.horse_horse_id}" data-gname="${esc(h.horse_name)}" data-tip="Open the gallery">` : ""}<div><div class="crumb"><a href="#/horses">Horses</a></div>
    <h1>${esc(h.horse_name)} ${dead ? '<span class="badge dead">Deceased</span>' : ""}${removedBadge(d)}<span class="hn-head" id="hn-head">${horseTagsHtml(id, false)}</span></h1>
    <div class="sub">${a !== null ? a + "yo " : ""}${esc(h.horse_color || "")} ${esc((h.horse_gender || "").toLowerCase())} · ${esc(h.horse_breed || "")}
    · Foaled ${fDate(h.horse_birth_date)}${dead ? ` · Died ${fDate(h.horse_deceased_date)} ${esc(h.horse_death_cause || "")}` : ""}
    ${d.stable ? ` · ${L.stable(d.stable.id, d.stable.name)}` : ""}</div>${(d.traits || []).length ? `<div class="hp-traits">${chips(d.traits)}</div>` : ""}${removedNote(d)}</div></div>
    <div style="display:flex;gap:8px"><button class="btn" data-gallery="${h.horse_horse_id}" data-gname="${esc(h.horse_name)}">${ICON_PHOTO}${pic ? "Gallery" : "Add photos"}</button></div></div>
    <div class="subtabs"><a href="#/horse/${id}" class="${on === "overview" ? "on" : ""}">Overview</a><a href="#/horse/${id}/races" class="${on === "races" ? "on" : ""}">Races &amp; trials${(d.results || []).length ? ` <span class="tab-n">${fNum(d.results.length)}</span>` : ""}</a><a href="#/horse/${id}/awards" class="${on === "awards" ? "on" : ""}">Awards${(d.awards || []).length ? ` <span class="tab-n">${fNum(d.awards.length)}</span>` : ""}</a><a href="#/horse/${id}/fans" class="${on === "fans" ? "on" : ""}">Fans, sponsors &amp; notes</a><a href="#/horse/${id}/training" class="${on === "training" ? "on" : ""}">Training &amp; plans</a><a href="#/compare?kind=horse&a=${id}" class="st-cmp">Compare…</a></div>`;
}
// ------------------------------------------------------------------ 16.5: training, shoes, plans, rankings and syndicates on a horse
const nice = (s) => String(s || "").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
const pctTop = (v) => (isNum(v) ? (v <= 0.005 ? "Top 0.01%" : `Top ${v < 1 ? fNum(v, 2) : v < 10 ? fNum(v, 1) : fNum(v, 0)}%`) : "—");      // the game's "top x%" (lower is better)
const pctBetter = (v) => (isNum(v) ? pctTop((1 - v) * 100) : "—");      // a 0–1 share of horses beaten, shown as "top x%"
function effBar(v) {      // a training multiplier: 1.00 is neutral
  if (!isNum(v)) return '<span class="muted">—</span>';
  const d = v - 1, w = Math.min(50, Math.abs(d) * 250);
  return `<span class="eff"><span class="eff-t"><i class="${d >= 0 ? "up" : "down"}" style="width:${w}%;${d >= 0 ? "left:50%" : `left:${50 - w}%`}"></i></span><b class="${d > 0.004 ? "up" : d < -0.004 ? "dn" : ""}">${d >= 0 ? "+" : "−"}${fNum(Math.abs(d) * 100, 1)}%</b></span>`;
}
function horseRankPanels(m, h) {
  const rk = m.rankings || {}, sy = m.syndicates || [];
  let out = "";
  if (Object.keys(rk).length) {
    out += panel("Rankings", tiles([
      ["Career earnings", pctTop(rk.career), `of all horses · ${fMoneyShort(h.horse_career_earnings)}`],
      isNum(rk.age_rank) ? ["Earnings for its age", pctBetter(rk.age_rank), "of horses the same age"] : null,
      isNum(rk.offspring) ? ["Offspring earnings", pctTop(rk.offspring), fMoneyShort(rk.offspring_earnings)] : null,
      isNum(rk.pedigree) ? ["Pedigree", pctBetter(rk.pedigree), `family earnings ${fMoneyShort(rk.pedigree_earnings)}`] : null,
    ]), "Worked out by the game");
  }
  if (sy.length) {
    const s = sy[0], owned = s.shares - (s.available || 0);
    out += panel(`Syndicate${sy.length > 1 ? ` <span class="muted small">${sy.length} in all</span>` : ""}`, `<div class="small" style="margin-bottom:8px">
      <span class="badge ${s.status === "active" ? "good" : s.status === "open" ? "warn" : ""}">${esc(nice(s.status))}</span> Managed by ${L.stable(s.stable_id, s.stable)} ·
      ${fNum(s.shares)} shares at ${fMoney(s.price)} · ${fNum(owned)} sold, ${fNum(s.available)} left · ${fNum(s.fee, 1)}% management fee · since ${fDate(s.created)}
      ${s.distributed ? ` · ${fMoney(s.distributed)} paid out` : ""}</div>` + table([
      { h: "Shareholder", f: (r) => L.person(r.person_id, r.person) },
      { h: "Shares", cls: "num", f: (r) => `${fNum(r.shares)} <span class="muted small">${fNum(100 * r.shares / s.shares, 1)}%</span>` },
      { h: "Paid", cls: "num", f: (r) => fMoney(r.paid) }, { h: "Bought", cls: "num nowrap", f: (r) => fDate(r.date) },
    ], s.holders || [], { empty: "No shareholders yet." }), "Shares in this horse sold to people");
  }
  return out ? `<div class="grid cols-2" style="margin-top:16px">${out}</div>` : "";
}
const HQP_TYPE = { qualifier: "Qualifier", points: "Points" };
async function horseTrainingPage(id) {
  const [d, m] = await Promise.all([api("horse/" + id), api("horse_more/" + id)]);
  let html = horseHead(d, "training");
  const t = m.training, sh = m.shoes;
  html += `<div class="grid cols-2" style="margin-top:4px">`;
  html += panel("Training", t ? `${kvList([["Programme", esc(t.type || "—")], ["Food", esc(t.food || "—")], ["Care", esc(t.care || "—")]])}
    <table class="data eff-tbl" style="margin-top:10px"><thead><tr><th>Effect on training</th><th></th></tr></thead><tbody>
    ${[["Speed", t.speed], ["Stamina", t.stamina], ["Strength", t.strength], ["Acceleration", t.acceleration], ["Trainer", t.trainer], ["Head trainer", t.head_trainer], ["Stablehand", t.stablehand]]
      .map(([k, v]) => `<tr><td>${k}</td><td>${effBar(v)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No training set up.</div>', "How this horse is trained, fed and cared for");
  html += `<div>${panel("Shoes", sh ? kvList([["Material", esc(nice(sh.material))], ["Fitted", sh.position === "all" ? "All four" : esc(nice(sh.position))],
      ["Quality", fNum(sh.quality)], ["Durability left", fNum(sh.durability)], ["Fitted on", fDate(sh.applied)]]) : '<div class="empty">No shoes recorded.</div>')}
    <div style="margin-top:16px">${panel("Yearly schedule", m.schedule ? `<b>${esc(m.schedule.name)}</b><div class="small muted" style="margin-top:4px">${esc(m.schedule.about || "")}</div>
      <div class="small" style="margin-top:6px">${fNum(m.schedule.pre)} days' preparation before a race · ${fNum(m.schedule.recovery)} days' recovery after</div>` : '<div class="empty">No yearly schedule.</div>')}</div></div></div>`;
  const p = m.plan;
  html += `<div style="margin-top:16px">${panel("Race plan", p ? `<div style="margin-bottom:8px"><b>${esc(p.name)}</b>${p.since ? ` <span class="muted small">since ${fDate(p.since)}</span>` : ""}</div>` + table([
      { h: "#", cls: "num", f: (r) => fNum(r.n) }, { h: "Month", f: (r) => (r.month ? new Date(2000, r.month - 1, 1).toLocaleString("en-NZ", { month: "long" }) : "—") },
      { h: "Races", f: (r) => [r.grades ? esc(r.grades) : "", r.surface ? esc(r.surface) : "", r.dmin || r.dmax ? `${r.dmin ? fDist(r.dmin) : ""}–${r.dmax ? fDist(r.dmax) : ""}` : "", r.purse ? `purse ${fMoneyShort(r.purse)}+` : "", r.countries ? esc(r.countries) : ""].filter(Boolean).join(" · ") || "Any" },
      { h: "How", f: (r) => esc(nice(r.kind)) },
    ], p.legs || [], { empty: "No steps." }) : '<div class="empty">This horse has no race plan.</div>', "The races the game aims it at")}</div>`;
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Campaigns suggested", table([
      { h: "Season", cls: "num", f: (r) => esc(r.year) }, { h: "Campaign", f: (r) => esc(r.concept || "—") },
      { h: "Stage", f: (r) => esc(nice(r.stage)) }, { h: "Status", f: (r) => `<span class="badge ${r.status === "accepted" ? "good" : ""}">${esc(nice(r.status))}</span>` }, { h: "Date", cls: "num nowrap", f: (r) => fDate(r.date) },
    ], m.campaigns, { empty: "No campaign suggestions." }), "Triple Crowns and the like")}
    ${panel("Qualifying", table([
      { h: "For", f: (r) => esc(r.target) }, { h: "Type", f: (r) => esc(HQP_TYPE[r.type] || nice(r.type)) }, { h: "Points", cls: "num", f: (r) => fNum(r.points) },
      { h: "Earned in", f: (r) => (r.race_id ? L.race(r.race_id, r.source) : esc(r.source || "")) }, { h: "Date", cls: "num nowrap", f: (r) => fDate(r.date) },
      { h: "", f: (r) => (r.closed ? '<span class="muted small">closed</span>' : '<span class="badge good">open</span>') },
    ], m.qualifying, { empty: "Not qualified for anything yet." }), "Places earned in races that lead to bigger ones")}</div>`;
  html += horseRankPanels(m, d.horse);
  return html;
}
function kvList(kv) {
  return `<dl class="kvl">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

// ------------------------------------------------------------------ 16.5: a stable's facilities and farm sponsors; a course's sponsors
function sponsorTable(list, extra) {
  return table([
    { h: "Sponsor", f: (r) => `<b>${esc(r.brand)}</b>${r.current ? ' <span class="badge good">Now</span>' : ""}` }, { h: "Industry", f: (r) => esc(r.industry || "—") },
    ...(extra || []),
    { h: "A month", cls: "num", f: (r) => fMoney(r.monthly) }, { h: "From", cls: "num nowrap", f: (r) => fDate(r.start) }, { h: "To", cls: "num nowrap", f: (r) => fDate(r.end) },
    { h: "Paid", cls: "num", f: (r) => fMoney(r.paid) },
  ], list, { empty: "No sponsors." });
}
function stableMorePanels(m) {
  const f = m.facilities || [], sp = m.sponsors || [];
  if (!f.length && !sp.length) return "";
  const daily = f.reduce((a, x) => a + (x.daily || 0) * (x.n || 0), 0);
  return `<div class="grid cols-2" style="margin-top:16px">${panel(`Facilities <span class="muted small">${fNum(f.reduce((a, x) => a + x.n, 0))}</span>`, table([
      { h: "Facility", f: (r) => `<span data-tip="${esc(r.about || "")}">${esc(nice(r.type))}</span>${r.n > 1 ? ` <span class="muted small">×${fNum(r.n)}</span>` : ""}${r.working < r.n ? ' <span class="badge warn">not working</span>' : ""}` },
      { h: "Built", cls: "num nowrap", f: (r) => fDate(r.first) + (r.n > 1 && r.last !== r.first ? `<div class="muted small">latest ${fDate(r.last)}</div>` : "") },
      { h: "Cost to build", cls: "num", f: (r) => fMoneyShort(r.cost) }, { h: "A day", cls: "num", f: (r) => fMoney((r.daily || 0) * (r.n || 1)) },
    ], f, { empty: "None built." }), f.length ? `Running costs ${fMoney(daily)} a day · point at one for what it does` : "")}
    ${panel("Farm sponsors", sponsorTable(sp), "Sponsors of the stable itself")}</div>`;
}

// ------------------------------------------------------------------ 16.5: languages and syndicate shares on a person
function personMorePanels(d) {
  const sh = d.syndicate_shares || [];
  return sh.length ? `<div style="margin-top:16px">${panel(`Syndicate shares <span class="muted small">${fNum(sh.length)}</span>`, table([
    { h: "Horse", f: (r) => `${L.horse(r.horse_id, r.horse)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}` },
    { h: "Shares", cls: "num", f: (r) => `${fNum(r.shares)} <span class="muted small">of ${fNum(r.of)}</span>` }, { h: "Paid", cls: "num", f: (r) => fMoney(r.paid) },
    { h: "Bought", cls: "num nowrap", f: (r) => fDate(r.date) }, { h: "Managed by", f: (r) => L.stable(r.stable_id, r.stable) },
    { h: "Syndicate", f: (r) => `<span class="badge ${r.status === "active" ? "good" : ""}">${esc(nice(r.status))}</span>` },
  ], sh), "Horses they hold syndicate shares in")}</div>` : "";
}
const langChips = (l) => (l || []).map((x) => `<span class="lang" data-tip="${esc(x.language)} · skill ${fNum(x.skill, 0)}"><i style="width:${Math.max(4, Math.min(100, x.skill || 0))}%"></i>${esc(x.language)}</span>`).join("");

// ------------------------------------------------------------------ 16.5: a jockey's season
const SEASON_DELTA = (a, b, fmt, pctPts) => {
  if (!isNum(a) || !isNum(b)) return "";
  const d = a - b;
  if (Math.abs(d) < 1e-9) return '<span class="muted">same as then</span>';
  return `<span class="${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"} ${pctPts ? fNum(Math.abs(d) * 100, 1) + " pts" : fmt(Math.abs(d))}</span>`;
};
async function jockeySeasonPage(route) {
  const id = route.parts[1], q = route.q || {};
  const [d, s] = await Promise.all([api("person/" + id), api(`jockey_season/${id}?${seasonQS(false)}` + (q.year ? "&year=" + q.year : ""))]);
  let html = personHead(d, "season");
  const n = s.now, pv = s.prev, ps = s.prev_same;
  const cmp = ps || pv, cmpLab = ps ? `this time last season` : `last season`;
  html += `<div class="filters" style="margin:4px 0 12px">${select("year", { year: String(s.year) }, (s.years || []).map((y) => [String(y.key), `Season ${y.label}`]))}
    <span class="small muted">${seasonText().replace(/^./, (x) => x.toUpperCase())} (<a href="#/settings?s=season">change in Settings</a>) · compared with ${ps ? "the same point of " : ""}${esc(s.prev_label)}</span></div>`;
  html += tiles([
    ["Rides", fNum(n.rides), SEASON_DELTA(n.rides, cmp.rides, fNum) + ` <span class="muted small">vs ${fNum(cmp.rides)} ${cmpLab}</span>`],
    ["Wins", fNum(n.wins), SEASON_DELTA(n.wins, cmp.wins, fNum) + ` <span class="muted small">vs ${fNum(cmp.wins)}</span>`],
    ["Strike rate", isNum(n.strike) ? fNum(n.strike * 100, 1) + "%" : "—", SEASON_DELTA(n.strike, cmp.strike, null, true) + (isNum(cmp.strike) ? ` <span class="muted small">vs ${fNum(cmp.strike * 100, 1)}%</span>` : "")],
    ["Placed (top 3)", isNum(n.place_rate) ? fNum(n.place_rate * 100, 1) + "%" : "—", `${fNum(n.places)} rides` + (isNum(cmp.place_rate) ? ` · <span class="muted small">vs ${fNum(cmp.place_rate * 100, 1)}%</span>` : "")],
    ["Prize money", fMoneyShort(n.prize), SEASON_DELTA(n.prize, cmp.prize, fMoneyShort) + ` <span class="muted small">vs ${fMoneyShort(cmp.prize)}</span>`],
    ["Group & Listed wins", fNum(n.stakes), `vs ${fNum(cmp.stakes)} ${cmpLab}`],
  ]);
  const grp = (title, list, first, note) => panel(title, table([
    { h: first, f: (r) => r.label_html || esc(r.label || "—") },
    { h: "Rides", cls: "num", f: (r) => fNum(r.rides) }, { h: "Wins", cls: "num", f: (r) => fNum(r.wins) },
    { h: "Strike", cls: "num", f: (r) => `<span class="${r.strike >= (n.strike || 0) + 0.05 ? "up" : r.strike <= (n.strike || 0) - 0.05 ? "dn" : ""}">${fNum((r.strike || 0) * 100, 0)}%</span>` },
    { h: "Placed", cls: "num", f: (r) => `${fNum(100 * r.places / r.rides, 0)}%` }, { h: "Prize", cls: "num", f: (r) => fMoneyShort(r.prize) },
  ], list, { empty: "No rides." }), note || "");
  (s.by_course || []).forEach((r) => (r.label_html = L.course(r.key, r.label)));
  (s.trainers || []).forEach((r) => (r.label_html = L.person(r.key, r.label)));
  (s.horses || []).forEach((r) => (r.label_html = L.horse(r.key, r.label)));
  (s.stables || []).forEach((r) => (r.label_html = L.stable(r.key, r.label)));
  html += `<div class="grid cols-2" style="margin-top:16px">${grp("By course", s.by_course, "Course", "Green: well above your strike rate · red: well below")}
    <div>${grp("By distance", s.by_distance, "Distance")}<div style="margin-top:16px">${grp("By track", s.by_track, "Track")}</div></div></div>`;
  html += `<div class="grid cols-3" style="margin-top:16px">${grp("Best partnerships: trainers", s.trainers, "Trainer")}${grp("Horses", s.horses, "Horse")}${grp("Stables", s.stables, "Stable")}</div>`;
  if ((s.months || []).length) {
    const mx = Math.max(...s.months.map((m) => m.rides), 1);
    html += `<div style="margin-top:16px">${panel("Month by month", `<div class="ms-bars">${s.months.map((m) => `<div class="ms-m" data-tip="${fNum(m.rides)} rides · ${fNum(m.wins)} wins">
      <div class="ms-col"><i class="r" style="height:${100 * m.rides / mx}%"></i><i class="w" style="height:${100 * m.wins / mx}%"></i></div>
      <span>${new Date(2000, m.month - 1, 1).toLocaleString("en-NZ", { month: "short" })}</span></div>`).join("")}</div>
      <div class="small muted" style="margin-top:6px"><span class="ms-key r"></span> rides <span class="ms-key w"></span> wins</div>`)}</div>`;
  }
  html += `<div class="grid cols-2" style="margin-top:16px">${panel(`Booked rides <span class="muted small">${fNum((s.upcoming || []).length)}</span>`, table([
      { h: "Date", cls: "nowrap", f: (r) => fDate(r.race_time) }, { h: "Race", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
      { h: "Course", f: (r) => L.course(r.course_id, r.course) }, { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) }, { h: "For", f: (r) => L.stable(r.stable_id, r.stable) },
    ], s.upcoming || [], { empty: "No rides booked." }), "Races they're down to ride in")}
    ${panel(`Ride offers <span class="muted small">${fNum((s.offers || []).length)}</span>`, table([
      { h: "Offered", cls: "nowrap", f: (r) => fDate(r.offered) }, { h: "Race", f: (r) => (r.race_id ? L.race(r.race_id, r.race) : "—") }, { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
      { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) }, { h: "Fee", cls: "num", f: (r) => fMoney(r.fee) },
      { h: "Win chance", cls: "num", f: (r) => (isNum(r.win_pct) ? fNum(r.win_pct, 1) + "%" : "—") },
      { h: "Status", f: (r) => `<span class="badge ${/accept/.test(r.status) ? "good" : /pend|open|offer/.test(r.status) ? "warn" : ""}">${esc(nice(r.status))}</span>` },
    ], s.offers || [], { empty: "No ride offers." }), "Offers from stables to ride their horses")}</div>`;
  return html;
}

// ------------------------------------------------------------------ 16.5: compare two horses or two people side by side
async function comparePage(route) {
  const q = route.q || {}, kind = q.kind === "person" ? "person" : "horse";
  const ids = [q.a, q.b].map((x) => (x && /^-?\d+$/.test(x) ? x : ""));
  const load = (id) => (id ? (kind === "horse" ? Promise.all([api("horse/" + id), api("horse_more/" + id).catch(() => ({})), api("horse_fans/" + id).catch(() => ({}))]) : api("person/" + id)) : Promise.resolve(null));
  const [A, B] = await Promise.all(ids.map(load));
  let html = `<div class="page-head"><div><h1>Compare ${kind === "horse" ? "horses" : "people"}</h1><div class="sub">Pick two to see them side by side · ${seg("kind", q, [["horse", "Horses"], ["person", "People"]], "horse")}</div></div></div>`;
  const pick = (slot, data) => {
    const name = data ? (kind === "horse" ? data[0].horse.horse_name : data.person.person_full_name) : "";
    return `<div class="cmp-pick" data-slot="${slot}"><input type="text" class="cmp-in" placeholder="Search ${kind === "horse" ? "horses" : "people"}…" value="${esc(name)}" aria-label="Choose ${slot === "a" ? "the first" : "the second"}"><div class="cmp-res"></div></div>`;
  };
  const rowsH = (d) => {
    if (!d) return null;
    const [x, m, f] = d, h = x.horse, res = x.results || [], w = res.filter((r) => r.rank === 1).length, pl = res.filter((r) => r.rank && r.rank <= 3).length;
    const rk = (m || {}).rankings || {};
    return {
      head: L.horse(h.horse_horse_id, h.horse_name),
      v: [["Sex", esc(h.horse_gender || "")], ["Age", fNum(age(h.horse_birth_date, h.horse_deceased_date))], ["Stable", x.stable ? L.stable(x.stable.id, x.stable.name) : "—"],
        ["Sire", x.sire ? L.horse(x.sire.id, x.sire.name) : "—"], ["Dam", x.dam ? L.horse(x.dam.id, x.dam.name) : "—"],
        ["Rating", h.horse_international_rating, fNum], ["Peak rating", h.horse_peak_rating, fNum], ["Starts", res.length, fNum], ["Wins", w, fNum],
        ["Strike rate", res.length ? w / res.length : null, (v) => fNum(v * 100, 1) + "%"], ["Placed", res.length ? pl / res.length : null, (v) => fNum(v * 100, 1) + "%"],
        ["G1 wins", h.horse_g1_wins, fNum], ["Earnings", h.horse_career_earnings, fMoneyShort], ["Value", h.horse_value_calculated, fMoneyShort],
        ["Speed", h.horse_speed, (v) => fNum(v, 1)], ["Stamina", h.horse_stamina, (v) => fNum(v, 1)], ["Acceleration", h.horse_acceleration, (v) => fNum(v, 1)], ["Strength", h.horse_strength, (v) => fNum(v, 1)],
        ["Intelligence", h.horse_intelligence, (v) => fNum(v, 1)], ["Temperament", h.horse_temperament, (v) => fNum(v, 1)],
        ["Fans", (f || {}).fans, fShortN], ["World rank by fans", (f || {}).rank, (v) => "#" + fNum(v), true],
        ["Earnings rank", rk.career, pctTop, true], ["Pedigree", rk.pedigree, pctBetter], ["Foals", x.offspring_total, fNum]],
    };
  };
  const rowsP = (d) => {
    if (!d) return null;
    const p = d.person, j = (d.jobs || []).find((x) => !x.end);
    const st = p.person_jockey_starts, wn = p.person_jockey_wins;
    return {
      head: L.person(p.person_person_id, p.person_full_name),
      v: [["Age", fNum(age(p.person_birth_date, p.person_deceased_date))], ["Job now", j ? `${esc(j.role)} at ${L.stable(j.stable_id, j.stable)}` : "—"],
        ["Fame", p.person_fame_calculated, (v) => fNum(v, 0)], ["Reputation", p.person_reputation, (v) => fNum(v, 1)],
        ["Rides", st, fNum], ["Wins as jockey", wn, fNum], ["Strike rate", st ? wn / st : null, (v) => fNum(v * 100, 1) + "%"], ["Jockey prize money", p.person_jockey_winnings, fMoneyShort],
        ["Jockey skill", p.person_jockey_skill, (v) => fNum(v, 1)], ["Trainer wins", p.person_trainer_wins, fNum], ["Trainer skill", p.person_trainer_skill, (v) => fNum(v, 1)],
        ["Head trainer wins", p.person_head_trainer_wins, fNum], ["Manager skill", p.person_manager_skill, (v) => fNum(v, 1)],
        ["Awards", (d.awards || []).length, fNum], ["Languages", (d.languages || []).map((l) => esc(l.language)).join(", ") || "—"],
        ["Owns", (d.owns || []).map((s) => L.stable(s.id, s.name)).join(", ") || "—"]],
    };
  };
  const R = [A, B].map(kind === "horse" ? rowsH : rowsP);
  let body = `<div class="cmp-grid"><div></div><div>${pick("a", A)}</div><div>${pick("b", B)}</div>`;
  if (R[0] || R[1]) {
    const base = (R[0] || R[1]).v;
    body += `<div></div><div class="cmp-h">${R[0] ? R[0].head : ""}</div><div class="cmp-h">${R[1] ? R[1].head : ""}</div>`;
    base.forEach((row, i) => {
      const [lab, , fmt, lowBetter] = row;
      const va = R[0] ? R[0].v[i][1] : null, vb = R[1] ? R[1].v[i][1] : null;
      const cell = (v, o) => {
        if (!fmt) return v ?? "—";
        if (!isNum(v)) return '<span class="muted">—</span>';
        const better = isNum(o) && v !== o && (lowBetter ? v < o : v > o);
        return `<span class="${better ? "cmp-best" : ""}">${fmt(v)}</span>`;
      };
      body += `<div class="cmp-l">${lab}</div><div>${cell(va, vb)}</div><div>${cell(vb, va)}</div>`;
    });
  }
  body += `</div>`;
  html += panel("Side by side", body, "The better figure of the two is in bold green");
  return html;
}
comparePage.after = (route) => {
  const q = route.q || {}, kind = q.kind === "person" ? "person" : "horse";
  $$(".cmp-pick").forEach((box) => {
    const inp = $(".cmp-in", box), res = $(".cmp-res", box);
    let t = null;
    inp.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = inp.value.trim();
        if (v.length < 2) { res.innerHTML = ""; return; }
        const r = ((await api("search?q=" + encodeURIComponent(v))).results || []).filter((x) => x.type === kind);
        res.innerHTML = r.slice(0, 8).map((x) => `<button type="button" data-id="${x.id}">${esc(x.name)} <span class="muted small">${esc(x.extra || "")}</span></button>`).join("") || '<div class="muted small">No matches.</div>';
      }, 200);
    });
    res.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-id]");
      if (b) go(["compare"], { ...q, kind, [box.dataset.slot]: b.dataset.id });
    });
  });
};

// ------------------------------------------------------------------ 16.5: saved views on lists (kept as favourites)
function savedViewsBar() {
  const path = (location.hash.replace(/^#/, "").split("?")[0] || "/");
  const mine = getFavs().filter((f) => normHash(f.h).replace(/^#/, "").split("?")[0] === path && normHash(f.h).includes("?"));
  return `<div class="sv-bar">${mine.map((f) => `<a class="sv-chip${normHash(f.h) === normHash(location.hash) ? " on" : ""}" href="${esc(f.h)}">${esc(f.t)}</a>`).join("")}
    <button type="button" class="btn sm" data-save-view data-tip="Keep these filters and this sort as a saved view in your favourites">☆ Save this view</button></div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-save-view]");
  if (!b) return;
  const bar = b.closest(".sv-bar");
  if ($(".sv-new", bar)) return;
  const wrap = document.createElement("span");
  wrap.className = "sv-new";
  wrap.innerHTML = `<input type="text" maxlength="80" placeholder="Name this view, e.g. My stallions" aria-label="Name for this view"><button type="button" class="btn sm primary">Save</button>`;
  b.replaceWith(wrap);
  const inp = $("input", wrap);
  inp.focus();
  const save = () => {
    const name = inp.value.trim() || pageTitle();
    const h = normHash(location.hash), list = getFavs().filter((f) => normHash(f.h) !== h);
    list.push({ h, t: name, ic: favIcon(h) });
    setFavs(list);
    toast(`<span class="fav-star-t">★</span> Saved <b>${esc(name)}</b>: it's in your favourites`, null, 4000);
    render();
  };
  $("button", wrap).addEventListener("click", save);
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") save(); else if (ev.key === "Escape") render(); });
});

// ------------------------------------------------------------------ 16.5: alerts on Home
const ALERT_META = {
  offer: ["Ride offer to answer", "mail"], ride: ["Riding soon", "flag"], sponsor_end: ["Sponsor deal ending", "badge"], farm_sponsor_end: ["Farm sponsor ending", "badge"],
  fan: ["Fan milestone", "users"], qualified: ["Qualified", "trophy"],
};
function alertsPanel(a) {
  const list = (a && a.alerts) || [];
  if (!list.length) return "";
  const now = a.now;
  const when = (t) => { const d = Math.floor(t / 86400) - Math.floor(now / 86400); return d === 0 ? "today" : d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} ago`; };
  const line = (x) => {
    switch (x.kind) {
      case "offer": return `${L.horse(x.horse_id, x.horse)} in ${x.race_id ? L.race(x.race_id, x.race) : "a race"} · ${fMoney(x.fee)} fee · answer ${when(x.date)}`;
      case "ride": return `${L.horse(x.horse_id, x.horse)} in ${L.race(x.race_id, x.race)} ${grade(x.grade)} · ${when(x.date)} (${fDate(x.date)})`;
      case "sponsor_end": return `${L.horse(x.horse_id, x.horse)}'s deal with <b>${esc(x.brand)}</b> (${fMoneyShort(x.monthly)}/mo) ends ${when(x.date)}`;
      case "farm_sponsor_end": return `${L.stable(x.stable_id, x.stable)}'s deal with <b>${esc(x.brand)}</b> (${fMoneyShort(x.monthly)}/mo) ends ${when(x.date)}`;
      case "fan": return `${L.horse(x.horse_id, x.horse)}: ${esc(x.subject || "")} · ${when(x.date)} · <a href="#/horse/${x.horse_id}/fans">fans</a>`;
      case "qualified": return `${L.horse(x.horse_id, x.horse)} ${x.type === "qualifier" ? "qualified for" : "earned points towards"} <b>${esc(x.target)}</b> in ${esc(x.source || "")} · ${when(x.date)}`;
      default: return "";
    }
  };
  return `<section class="panel alerts"><div class="panel-head"><h2>For you <span class="muted small">${fNum(list.length)}</span></h2><span class="note">Rides, offers, sponsor deals ending in the next 60 days, fan milestones and qualifying in the last month or two</span></div>
    <ul class="al-list">${list.slice(0, 14).map((x) => `<li class="al-${x.kind}"><span class="al-ic">${tagIc((ALERT_META[x.kind] || ["", "tag"])[1])}</span><b class="al-k">${(ALERT_META[x.kind] || [x.kind])[0]}</b><span class="al-t">${line(x)}</span></li>`).join("")}</ul>
    ${list.length > 14 ? `<div class="small muted">and ${fNum(list.length - 14)} more</div>` : ""}</section>`;
}

// ------------------------------------------------------------------ 16.5: back up and bring back your notes and tags (Settings → Tags)
function notesBackupPanel() {
  return `<div style="margin-top:16px">${panel("Back up your notes and tags", `<div class="nb">
    <a class="btn" href="/api/notes/export" download>Download a backup</a>
    <label class="btn">Bring back a backup…<input type="file" id="nb-file" accept=".json,application/json" hidden></label>
    <label class="small"><input type="checkbox" id="nb-replace"> Replace what's here (otherwise the backup is added to your notes)</label>
    <span class="small muted" id="nb-state"></span></div>
    <p class="small muted" style="margin:8px 0 0">The backup is one file with every tag, note and date. Bringing one back never doubles up a note you already have.</p>`)}</div>`;
}
document.addEventListener("change", async (e) => {
  if (e.target.id !== "nb-file" || !e.target.files.length) return;
  const st = $("#nb-state"), f = e.target.files[0];
  st.textContent = "Reading…";
  try {
    const data = JSON.parse(await f.text());
    const r = await fetch("/api/notes/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, mode: $("#nb-replace").checked ? "replace" : "merge" }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Couldn't bring that back.");
    await loadNotes();
    st.textContent = `Done: ${fNum(j.notes_added)} note${j.notes_added === 1 ? "" : "s"} added from ${fNum(j.horses)} horse${j.horses === 1 ? "" : "s"}.`;
  } catch (er) { st.textContent = er instanceof SyntaxError ? "That isn't an HRM Viewer notes backup." : er.message; }
  e.target.value = "";
});

// a horse's Fans, sponsors & notes tab: what the save records about its fans and sponsors, and your own notes and tags
const FAN_KIND = { website: ["Fan website", "globe"], club: ["Supporters' club", "users"], trips: ["Fan club trip", "bus"], superfans: ["Superfans", "heart"], fans: ["Fans", "users"], merch: ["Merchandise deal", "bag"] };
async function horseFansPage(id) {
  const [d, f] = await Promise.all([api("horse/" + id), api("horse_fans/" + id)]);
  let html = horseHead(d, "fans");
  const sp = f.sponsors || [], now = sp.find((x) => x.current), inbox = f.inbox || [];
  const merch = inbox.filter((m) => m.kind === "merch"), merchSum = merch.reduce((a, m) => a + (+m.payout || 0), 0);
  const paid = sp.reduce((a, x) => a + (x.paid || 0), 0);
  const st = fanStep(f.band), stWas = st ? fanWas(st[0], f.rank, f.died) : "";
  html += tiles([
    ["Fans", fShortN(f.fans), f.died ? "When it died" : "Now"],
    ["World rank by fans", f.died ? "—" : isNum(f.rank) ? "#" + fNum(f.rank) : "—", f.died ? "Living horses only" : `of ${fNum(f.of)} living horses with fans`],
    ["Fan level", st ? esc(st[1]) : "—", st ? (stWas ? `Best reached: top ${st[0]} · <b class="fl-not">not any more</b> (${stWas})` : `Best reached: top ${st[0]} · still there`) : "Not yet in the top 100"],
    ["Sponsor now", now ? esc(now.brand) : "None", now ? `${fMoneyShort(now.monthly)} a month · ${esc(now.industry || "")}` : sp.length ? `${fNum(sp.length)} in the past` : ""],
    ["Sponsorship paid", fMoneyShort(paid), `${fNum(sp.length)} sponsor${sp.length === 1 ? "" : "s"} in all`],
    merch.length ? ["Merchandise offers", fNum(merch.length), merchSum ? fMoneyShort(merchSum) + " offered in all" : ""] : null,
  ]);
  // the fan steps, as a ladder
  const ladder = (f.levels || []).slice().map((l) => {
    const ic = (FAN_STEPS.find((x) => x[0] === l.top) || [])[2];
    const msg = inbox.find((m) => ({ 100: "website", 50: "club", 20: "trips", 10: "superfans" })[l.top] === m.kind);
    const was = l.reached ? fanWas(l.top, f.rank, f.died) : "";
    return `<li class="fl-step${l.reached ? " on" : ""}${was ? " was" : ""}"><span class="fl-dot">${tagIc(ic)}</span><div><b>${esc(l.label)}</b> <span class="muted small">top ${l.top}</span>${was ? ` <span class="fl-not">Not any more · ${was}</span>` : ""}
      <div class="small muted">${esc(l.about.replace(/ \(top \d+ by fans\)$/, ""))}${msg ? ` · <span class="fl-when">${fDate(msg.date)}</span>` : ""}</div></div></li>`;
  }).join("");
  const ladderPanel = panel("Fan milestones", `<ol class="fl">${ladder}</ol>
    <p class="small muted fl-foot">The save keeps the best world fan ranking each horse has reached, so this works for every horse; steps marked <i>Not any more</i> are ones it has since dropped out of. For your own horses, the dates come from your inbox.</p>`,
    st ? `Reached top ${st[0]}${f.died ? "" : isNum(f.rank) ? ` · #${fNum(f.rank)} now` : " · unranked now"}` : "Not reached yet");
  html += `<div class="hf-layout"><div class="hf-main">${ladderPanel}`;
  // sponsors
  html += `<div style="margin-top:16px">${panel(`Sponsors <span class="muted small">${fNum(sp.length)}</span>`, table([
    { h: "Sponsor", f: (r) => `<b>${esc(r.brand)}</b>${r.current ? ' <span class="badge good">Now</span>' : ""}` },
    { h: "Industry", f: (r) => esc(r.industry || "—") },
    { h: "A month", cls: "num", f: (r) => fMoney(r.monthly) },
    { h: "Win bonus", cls: "num", f: (r) => (isNum(r.bonus) ? fNum(r.bonus * 100, 0) + "%" : "—") },
    { h: "From", cls: "num nowrap", f: (r) => fDate(r.start) },
    { h: "To", cls: "num nowrap", f: (r) => (r.current ? `<span class="muted">${fDate(r.end)}</span>` : fDate(r.end)) },
    { h: "Wins in contract", cls: "num", f: (r) => fNum(r.wins) },
    { h: "Paid", cls: "num", f: (r) => `<b>${fMoney(r.paid)}</b>` },
  ], sp, { empty: "No sponsors yet." }), "Brand deals: a monthly payment, plus a bonus for wins")}</div>`;
  // the player's inbox
  if (inbox.length || d.stable && d.stable.id === ((STATUS && STATUS.meta) || {}).player_stable_id) {
    html += `<div style="margin-top:16px">${panel("From your inbox", table([
      { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) },
      { h: "What", f: (r) => { const k = FAN_KIND[r.kind] || [r.kind, "tag"]; return `<span class="tg auto">${tagIc(k[1])}${esc(k[0])}</span>`; } },
      { h: "Message", f: (r) => esc(r.subject || "") },
      { h: "Fans then", cls: "num", f: (r) => esc(r.fans || "—") },
      { h: "Rank then", cls: "num", f: (r) => (isNum(r.rank) ? "#" + fNum(r.rank) : "—") },
      { h: "Money", cls: "num", f: (r) => (isNum(+r.payout) && r.payout ? `${fMoney(+r.payout)} <span class="muted small">offered</span>` : isNum(r.cost) && r.cost ? `${fMoney(r.cost)} <span class="muted small">asked</span>` : "—") },
      { h: "Replied", f: (r) => (r.replied ? "Yes" : '<span class="muted">No</span>') },
    ], inbox.slice().reverse(), { empty: "No fan or merchandise messages about this horse." }), "Fan and merchandise messages about this horse")}</div>`;
  }
  html += `</div><aside class="hf-side">${horseTagsPanel(f.id)}${horseNotesPanel(f.id)}</aside></div>`;
  return html;
}
async function horsePage(id) {
  const [d, more] = await Promise.all([api("horse/" + id), api("horse_more/" + id).catch(() => ({}))]);
  const h = d.horse;
  const res = d.results || [];
  const wins = res.filter((r) => r.rank === 1).length, seconds = res.filter((r) => r.rank === 2).length, thirds = res.filter((r) => r.rank === 3).length;
  let html = horseHead(d, "overview");
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
  const physical = kv([
    ["Breed", esc(h.horse_breed)], ["Colour", esc(h.horse_color)], ["Height", fNum(h.horse_height, 1) + " cm"], ["Weight", fNum(h.horse_weight, 0) + " kg"],
    ["Grade", fNum(h.horse_grade)],
    ["Stud fee", h.horse_stud_fee ? fMoney(h.horse_stud_fee) : "—"], ["Pregnant", h.horse_is_pregnant ? "Yes" : "No"],
  ]);

  // three small boxes on one line (16.7.10): they stay side by side down to narrow windows
  html += `<div class="hp-trio">${panel("Physical", physical, "", "compact")}${panel("Pedigree", pedigree, `<a href="#/pedigree/${h.horse_horse_id}">Full pedigree</a>`, "compact")}${panel("Connections", connections, "", "compact")}</div>`;
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

  // the last five starts; every start, and the horse's trials, are on the Races & trials tab (16.7.11)
  html += `<div style="margin-top:16px">${panel("Last 5 starts", table(raceRecordCols(), res.slice(0, 5), { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No races yet." }),
    res.length ? `<a href="#/horse/${h.horse_horse_id}/races">All ${fNum(res.length)} starts &amp; trials</a>` : `<a href="#/horse/${h.horse_horse_id}/races">Trials</a>`)}</div>`;

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

  html += `<div style="margin-top:16px">${panel("Health history", table([
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
    ${panel("Awards", expandable(awTable, aw.length, SHOW), (aw.length ? (awSummary ? awSummary + " · " : "") + `${aw.length} in all · ` : "") + `<a href="#/horse/${h.horse_horse_id}/awards">Awards tab</a>`)}
    ${panel("News", events(ev, SHOW), ev.length > SHOW ? `latest ${SHOW} of ${ev.length}` : "")}</div>`;

  html += `<div style="margin-top:16px">${panel("Offspring", table([
    { h: "Name", f: (r) => `${L.horse(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}` },
    { h: "Sex", f: (r) => esc(r.gender) }, { h: "Foaled", cls: "nowrap", f: (r) => fDate(r.birth) }, { h: "Age", cls: "num nowrap", f: (r) => ageCell(r.birth, r.died) },
    { h: h.horse_sex === "Female" ? "Sire" : "Dam", f: (r) => L.horse(r.mate_id, r.mate_name) },
    { h: "G1 wins", cls: "num", f: (r) => fNum(r.g1) }, { h: "Earnings", cls: "num", f: (r) => fMoney(r.earnings) },
  ], d.offspring, { empty: "No offspring." }), (d.offspring_total > d.offspring.length ? `Top ${d.offspring.length} of ${fNum(d.offspring_total)} by earnings` : `${fNum(d.offspring_total)} foals`) +
    (d.offspring_total ? ` · <a href="#/horse-table?${h.horse_sex === "Female" ? "dam" : "sire"}=${h.horse_horse_id}&status=all">Open in Horse table</a>` : ""), "tall")}</div>`;
  html += horseRankPanels(more || {}, h);
  html += horseStatCharts(d, runs);
  html += `<div style="margin-top:16px">${allFields(h)}</div>`;
  return html;
}
// a horse's race record: the columns used by Last 5 starts (Overview) and the Races & trials tab
const raceRecordCols = () => [
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
];
// ------------------------------------------------------------------ 16.7.11: a horse's Races & trials tab
// every start, then its timing trials: each session (a day at a course), and its times at every distance side by side
async function horseRacesPage(id) {
  const [d, t] = await Promise.all([api("horse/" + id), api("horse_trials/" + id).catch(() => ({ trials: [] }))]);
  const h = d.horse, res = d.results || [], tr = t.trials || [];
  const wins = res.filter((r) => r.rank === 1).length, seconds = res.filter((r) => r.rank === 2).length, thirds = res.filter((r) => r.rank === 3).length;
  // trial sessions: one per day and course, newest first
  const sessMap = new Map();
  tr.forEach((x) => {
    const k = `${x.date}|${x.course_id}`;
    if (!sessMap.has(k)) sessMap.set(k, { key: k, date: x.date, course_id: x.course_id, course: x.course, track: x.track, surface: x.surface, runs: [] });
    sessMap.get(k).runs.push(x);
  });
  const sess = [...sessMap.values()].sort((a, b) => b.date - a.date);
  sess.forEach((s) => {
    const js = [...new Map(s.runs.filter((x) => x.jockey_id).map((x) => [x.jockey_id, x])).values()];
    s.jockeys = js.map((x) => L.person(x.jockey_id, x.jockey)).join(", ") || "—";
    s.field = Math.max(0, ...s.runs.map((x) => x.field || 0));
    const placed = s.runs.filter((x) => isNum(x.place));
    s.bestPlace = placed.length ? Math.min(...placed.map((x) => x.place)) : null;
    s.avgPlace = placed.length ? placed.reduce((a, x) => a + x.place, 0) / placed.length : null;
    s.fastest = placed.filter((x) => x.place === 1).length;
    s.condition = s.runs.find((x) => isNum(x.condition))?.condition;
    s.speed = s.runs.find((x) => isNum(x.speed_revealed))?.speed_revealed;
    s.stamina = s.runs.find((x) => isNum(x.stamina_revealed))?.stamina_revealed;
    s.harness = s.runs.some((x) => x.harness);
  });
  const anyRevealed = sess.some((s) => isNum(s.speed) || isNum(s.stamina)), anyHarness = sess.some((s) => s.harness);
  let html = horseHead(d, "races");
  html += tiles([
    ["Starts", fNum(res.length), res.length ? `${fNum(wins)}-${fNum(seconds)}-${fNum(thirds)} · strike rate ${pct(wins, res.length)}` : "No races yet"],
    ["Prize money", fMoneyShort(res.reduce((a, r) => a + (+r.prize || 0), 0)), "From its race record"],
    ["Last start", res.length ? fDate(res[0].date) : "—", res.length ? `${isNum(res[0].rank) ? ord(res[0].rank) : "—"}${res[0].runners ? ` of ${res[0].runners}` : ""} · ${esc(res[0].race_name || "Historic race")}` : ""],
    ["Trial sessions", fNum(sess.length), sess.length ? `${fNum(tr.length)} timed runs` : "None recorded"],
    ["Last trial", sess.length ? fDate(sess[0].date) : "—", sess.length ? esc(sess[0].course || "") : ""],
    ["Fastest in a trial", fNum(tr.filter((x) => x.place === 1).length), tr.length ? "Distances where it beat everyone timed with it" : ""],
  ]);
  html += `<div style="margin-top:16px">${panel("Race record", table(raceRecordCols(), res, { rowClass: (r) => (r.rank === 1 ? "win" : ""), empty: "No races yet." }), `${fNum(res.length)} starts`, "tall")}</div>`;
  if (!sess.length) {
    html += `<div style="margin-top:16px">${panel("Trials", `<div class="empty">No timing trials recorded for this horse.</div>`, "")}</div>`;
    return html;
  }
  // the sessions
  html += `<div style="margin-top:16px">${panel("Trial sessions", table([
    { h: "Date", cls: "nowrap", f: (s) => fDate(s.date) },
    { h: "Racecourse", f: (s) => `${L.course(s.course_id, s.course)} <span class="muted small">${esc(s.track || "")}${s.surface ? " · " + esc(s.surface) : ""}</span>` },
    { h: "Jockey", f: (s) => s.jockeys },
    { h: "Condition", cls: "num", f: (s) => (isNum(s.condition) ? fNum(s.condition, 0) + "%" : "—") },
    { h: "Distances", cls: "num", f: (s) => `${fNum(s.runs.length)} <span class="muted small">${fDist(Math.min(...s.runs.map((x) => x.distance)))}–${fDist(Math.max(...s.runs.map((x) => x.distance)))}</span>` },
    { h: "Horses timed", cls: "num", f: (s) => fNum(s.field) },
    { h: "Best place", cls: "num", f: (s) => (isNum(s.bestPlace) ? ord(s.bestPlace) : "—") },
    { h: "Average place", cls: "num", f: (s) => (isNum(s.avgPlace) ? fNum(s.avgPlace, 1) : "—") },
    { h: "Fastest at", cls: "num", f: (s) => (s.fastest ? `${fNum(s.fastest)} distance${s.fastest === 1 ? "" : "s"}` : "—") },
  ].concat(anyRevealed ? [{ h: "Speed shown", cls: "num", f: (s) => (isNum(s.speed) ? fNum(s.speed, 1) : "—") }, { h: "Stamina shown", cls: "num", f: (s) => (isNum(s.stamina) ? fNum(s.stamina, 1) : "—") }] : [])
    .concat(anyHarness ? [{ h: "Harness", f: (s) => (s.harness ? "Yes" : "No") }] : []), sess),
    "A session is a day at one course · places are against every horse timed there that day at the same distance")}</div>`;
  // its time at every distance, session by session (newest on the left); its best time at each distance is marked
  const cols = sess.slice(0, 8), dists = [...new Set(tr.map((x) => x.distance))].sort((a, b) => a - b);
  const cell = (s, dist) => s.runs.find((x) => x.distance === dist);
  const bestAt = new Map(dists.map((dist) => [dist, Math.min(...tr.filter((x) => x.distance === dist && x.time > 0).map((x) => x.time))]));
  const head = `<tr><th class="num">Distance</th>${cols.map((s) => `<th class="num">${fDate(s.date)}<div class="muted small tr-sub">${esc(s.course || "")}</div></th>`).join("")}<th class="num">Best</th></tr>`;
  const body = dists.map((dist) => `<tr><td class="num"><b>${fDist(dist)}</b></td>${cols.map((s) => {
    const x = cell(s, dist);
    if (!x || !(x.time > 0)) return `<td class="num muted">—</td>`;
    const gap = isNum(x.best) && x.time > x.best ? `+${(x.time - x.best).toFixed(2)}s` : "fastest";
    const isBest = x.time === bestAt.get(dist) && sess.length > 1;
    return `<td class="num tr-cell${x.place === 1 ? " tr-top" : ""}${isBest ? " tr-best" : ""}" data-tip="${esc(`${fDist(dist)} on ${fDate(s.date)} at ${s.course || "the course"}: ${fTime(x.time)} · ${x.place ? ord(x.place) + " of " + x.field : ""} · fastest there ${fTime(x.best)} · ${(dist / x.time * 3.6).toFixed(1)} km/h`)}">
      ${fTime(x.time)}<div class="tr-sub">${x.place ? `${ord(x.place)}/${fNum(x.field)}` : ""} · ${gap}</div></td>`;
  }).join("")}<td class="num"><b>${fTime(bestAt.get(dist))}</b><div class="tr-sub">${(dist / bestAt.get(dist) * 3.6).toFixed(1)} km/h</div></td></tr>`).join("");
  html += `<div style="margin-top:16px">${panel("Trial times by distance", `<div class="wide-wrap"><table class="data wide tr-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <div class="legend"><span><i class="tr-key top"></i>Fastest horse timed at that distance that day</span>${sess.length > 1 ? `<span><i class="tr-key best"></i>Its best time at that distance</span>` : ""}<span>Under each time: its place among the horses timed with it, and how far behind the fastest</span></div>`,
    sess.length > cols.length ? `Latest ${cols.length} of ${sess.length} sessions` : `${fNum(sess.length)} session${sess.length === 1 ? "" : "s"}`)}</div>`;
  return html;
}
// 16.7.11: charts at the foot of a horse's Overview: its seasons, prize money by season, and its race ratings
function horseStatCharts(d, runs) {
  const yOf = (t) => new Date(t * 1000).getUTCFullYear();
  // its seasons: starts each year split by result, and prize money each year (years in between with no runs are kept, so gaps show)
  let seasons = "", prize = "";
  if (runs.length) {
    const y0 = yOf(runs[0].date), y1 = yOf(runs[runs.length - 1].date), years = [];
    for (let y = y0; y <= y1; y++) years.push(y);
    const at = (fn) => years.map((y) => runs.filter((r) => yOf(r.date) === y && fn(r)).length);
    seasons = colChart({ labels: years.map(String), stacked: true, total: "Starts", fmt: (v) => fNum(v), tip: (v) => fNum(v), title: "Starts each year by result", empty: "No races yet.",
      series: [{ name: "Won", color: "var(--viz-1)", values: at((r) => r.rank === 1) }, { name: "2nd", color: "var(--viz-2)", values: at((r) => r.rank === 2) },
        { name: "3rd", color: "var(--viz-3)", values: at((r) => r.rank === 3) }, { name: "Unplaced", color: "var(--viz-other)", values: at((r) => !(r.rank >= 1 && r.rank <= 3)) }] });
    prize = colChart({ labels: years.map(String), title: "Prize money each year", empty: "No prize money yet.",
      series: [{ name: "Prize money", color: "var(--viz-1)", values: years.map((y) => runs.filter((r) => yOf(r.date) === y).reduce((a, r) => a + (+r.prize || 0), 0)) }] });
  }
  const rated = runs.filter((r) => isNum(r.rating) && r.rating > 0);
  const best = rated.reduce((m, r) => Math.max(m, r.rating), 0);
  const ratings = rated.length ? lineChart([{ name: "Race rating", color: "#1d63d6", dots: true,
    points: rated.map((r) => [r.date, r.rating, `${r.race_name || "Historic race"} · ${r.course || ""} · ${fDist(r.distance)} · ${ord(r.rank)}${r.runners ? ` of ${r.runners}` : ""}`, r.rating === best ? "#d4a017" : null, r.race_id ? `#/race/${r.race_id}` : null]) }],
    { tipFmt: (v) => fNum(v), yInt: true, height: 240, width: 1400 }) : '<div class="empty">No rated runs yet.</div>';
  const wins = runs.filter((r) => r.rank === 1).length;
  if (!runs.length) return "";     // nothing to chart until it has raced
  return `<div class="panel-head" style="margin-top:20px"><h2>Form charts</h2></div>
    <div class="grid cols-2">
    ${panel("Season by season", seasons || '<div class="empty">No races yet.</div>', runs.length ? `${fNum(runs.length)} starts · ${fNum(wins)} wins` : "")}
    ${panel("Prize money by season", prize || '<div class="empty">No races yet.</div>', `${fMoneyShort(runs.reduce((a, r) => a + (+r.prize || 0), 0))} in all`)}
    </div><div style="margin-top:16px">${panel("Race ratings", ratings + (rated.length ? `<div class="legend"><span><i style="background:#d4a017"></i>Best: ${fNum(best)}</span><span>The game's rating for each run · click a dot to open the race</span></div>` : ""),
      rated.length ? `${fNum(rated.length)} rated runs` : "")}</div>`;
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
  const ownOn = ownHlOn();
  let owns = 0;
  const body = rows.map((x, i) => {
    const c = x.career || [0, 0, 0, 0];
    const wp = c[0] ? `${Math.round((100 * c[1]) / c[0])}% / ${Math.round((100 * (c[1] + c[2] + c[3])) / c[0])}%` : "—";
    const sub = `${isNum(x.birth) ? fNum(age(x.birth, race.race_time)) + "yo " : ""}${esc(x.color || "")} ${esc(x.gender || "")}` +
      ` · <span class="lbl">J:</span> ${L.person(x.jockey_id, x.jockey, "No jockey yet")}` + (x.trainer ? ` · <span class="lbl">T:</span> ${L.person(x.trainer_id, x.trainer)}` : "") +
      (x.stable ? ` · ${L.stable(x.stable_id, x.stable)}` : "");
    const horse = `<div class="rname">${L.horse(x.horse_id, x.horse)} <span class="bar">(${isNum(x.gate) ? x.gate : "–"})</span></div><div class="rsub">${sub}</div>`;
    const form = `<span class="form">${esc(x.form || "") || '<span class="muted">first start</span>'}</span>`;
    const arrow = `<button class="rtoggle" data-i="${i}" title="Show form">▸</button>`;
    const own = ownOn && isOwnRow(x);
    if (own) owns++;
    const cls = (kind === "results" ? (x.rank === 1 ? "win" : x.jockey_id === myId ? "me" : "") : x.jockey_id === myId ? "me" : "") + (own ? " own" : "");
    const cells = kind === "results"
      ? `<td>${pos(x.rank)}</td><td class="rhorse">${horse}</td><td>${form}</td><td class="num">${rec(x.career)}</td><td class="num">${wp}</td>
         <td class="num">${fNum(x.rating)}</td><td class="num">${fTime(x.time)}</td><td class="num">${wt && isNum(x.time) && x.rank > 1 ? "+" + (x.time - wt).toFixed(2) + "s" : ""}</td>
         <td class="num">${isNum(x.odds) ? `<span class="box">${fNum(x.odds, 1)}</span>` : "—"}</td><td class="num">${fMoney(x.prize)}</td><td>${arrow}</td>`
      : `<td class="num"><span class="gate">${isNum(x.gate) ? x.gate : "–"}</span></td><td class="rhorse">${horse}</td><td>${form}</td><td class="num">${rec(x.career)}</td><td class="num">${wp}</td>
         <td>${x.last ? `${ord(x.last.rank)}${x.last.runners ? ` of ${x.last.runners}` : ""} <span class="muted small">${isNum(x.last.days) ? x.last.days + " days ago" : ""}</span>` : '<span class="muted">—</span>'}</td>
         <td class="num"><span class="box">${fNum(x.rating)}</span></td><td>${arrow}</td>`;
    return `<tr class="rline ${cls}">${cells}</tr><tr class="rdetail" hidden><td colspan="${cols}"><div class="rpanel" data-race="${race.race_id}" data-horse="${x.horse_id}"></div></td></tr>`;
  }).join("");
  return `<div class="tbl-wrap"><table class="data runners"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${owns ? OWN_KEY : ""}`;
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
  racing: [["meetings", "#/meetings", "Meetings"], ["races", "#/races", "Races"], ["concepts", "#/concepts", "Concepts"], ["qualifying", "#/qualifying", "Qualifying"], ["courses", "#/courses", "Racecourses"]],
  horses: [["horses", "#/horses", "All horses"], ["horse-table", "#/horse-table", "Horse table"], ["pedigrees", "#/pedigrees", "Pedigrees"], ["notes", "#/notes", "Notes &amp; tags"]],
  stables: [["stables", "#/stables", "All stables"], ["stable-table", "#/stable-table", "Stable table"], ["stable-rankings", "#/stable-rankings", "Rankings"]],
};
function sectionTabs(sec, active) {
  return `<div class="subtabs">${(SECTION_TABS[sec] || []).map(([k, h, t]) => `<a href="${h}" class="${k === active ? "on" : ""}">${t}</a>`).join("")}</div>`;
}
// ------------------------------------------------------------------ 16.6: Racing → Concepts and Qualifying
async function conceptsPage() {
  const d = await api("concepts?" + seasonQS(true));
  let html = raceSubTabs("concepts") + `<div class="page-head"><div><h1>Concepts</h1><div class="sub">Triple Crowns and other race series: win every race in one season to sweep it.
    ${seriesOwnSeason() ? "Each series keeps its own season, from its first race to its last" : `Seasons are your ${seasonText()}`} (<a href="#/settings?s=season">change in Settings</a>). A horse that has won every race run so far is marked <b>on for the sweep</b>.</div></div></div>`;
  const status = (c) => {
    const nx = c.next_season;
    if (!c.season) return `<span class="muted small">Not started yet${nx ? `<br>first race ${fDate(nx.start)}` : ""}</span>`;
    let out = "";
    if (c.alive && c.alive.won === c.alive.of) out = `<span class="badge good">Swept</span><div class="small">by ${L.horse(c.alive.horse_id, c.alive.horse)}</div>`;
    else if (c.alive && !c.season_done) out = `<span class="badge warn">On for the sweep</span><div class="small">${L.horse(c.alive.horse_id, c.alive.horse)} · ${fNum(c.alive.won)} of ${fNum(c.alive.of)} won</div>`;
    else out = `<span class="muted small">${c.season_done ? "Not swept" : "No sweep this season"}</span>`;
    return out + (c.season_done && nx ? `<div class="muted small">Next season starts ${fDate(nx.start)}</div>` : "");
  };
  html += panel(`Series <span class="muted small">${fNum(d.concepts.length)}</span>`, table([
    { h: "Series", f: (c) => `<a href="#/concept/${c.id}"><b>${esc(c.name)}</b></a>${c.about ? `<div class="muted small">${esc(c.about)}</div>` : ""}` },
    { h: "Season", cls: "nowrap", f: (c) => esc(c.season || (c.next_season ? c.next_season.label : "—")) },
    { h: "Its races", f: (c) => `<ol class="cc-legs">${c.legs.map((l) => `<li>${l.race_id ? L.race(l.race_id, l.race) : esc(l.race)} <span class="muted small">${esc(l.course || "")}</span>
        <div class="small">${l.winner ? `Won by ${L.horse(l.winner.horse_id, l.winner.horse)}` : l.date ? `<span class="muted">${fDate(l.date)}</span>` : '<span class="muted">Not run</span>'}</div></li>`).join("")}</ol>` },
    { h: "This season", f: status },
    { h: "Swept", cls: "num", f: (c) => (c.sweeps ? `${fNum(c.sweeps)}× <div class="muted small">last ${esc(c.last_sweep)}</div>` : '<span class="muted">never</span>') },
  ], d.concepts, { empty: "No concepts in this save." }));
  return html;
}
async function conceptPage(route) {
  const id = route.parts[1], q = route.q || {};
  const d = await api("concept/" + id + "?" + seasonQS(true));
  const c = d.concept, seasons = d.seasons || [];
  const run = seasons.filter((s) => s.started);
  const S = seasons.find((s) => s.label === q.season) || run[0] || seasons[0];
  let html = raceSubTabs("concepts") + `<div class="page-head"><div><div class="crumb"><a href="#/concepts">Concepts</a></div><h1>${esc(c.name)}</h1>
    <div class="sub">${c.about ? esc(c.about) + " · " : ""}${fNum(d.legs.length)} races · win all of them in one season to sweep it${d.points_scale.length ? ` · points ${d.points_scale.map((p) => fNum(p)).join("–")} for the first ${d.points_scale.length} in each race` : ""}</div></div></div>`;
  const swept = seasons.filter((s) => s.sweep);
  const cur = run[0];
  html += tiles([["Seasons run", fNum(run.length)], ["Swept", fNum(swept.length), swept.length ? `last by ${esc(swept[0].sweep.horse || "")} (${esc(swept[0].label)})` : "never"],
    cur ? ["This season", esc(cur.label), cur.alive && cur.alive.won === cur.alive.of ? `Swept by ${esc(cur.alive.horse)}` : cur.alive && !cur.done ? `${esc(cur.alive.horse)} on for the sweep (${cur.alive.won} of ${cur.alive.of})` : cur.done ? "Not swept" : "No sweep possible"] : null]);
  html += `<div style="margin-top:16px">${panel("Season by season", `<div class="tbl-wrap"><table class="data cc-grid"><thead><tr><th>Season</th>${d.legs.map((l, i) => `<th>${i + 1}. ${esc(l.race)}<div class="muted small">${esc(l.course || "")}</div></th>`).join("")}<th>Swept by</th></tr></thead><tbody>
    ${seasons.map((s) => {
      const ws = s.legs.map((l) => l.winner && l.winner.horse_id).filter(Boolean), dup = ws.filter((w, i) => ws.indexOf(w) !== i);
      return `<tr class="${s.sweep ? "win" : ""}"><td class="nowrap"><a href="#/concept/${c.id}?season=${encodeURIComponent(s.label)}">${esc(s.label)}</a></td>${s.legs.map((l) => `<td>${l.winner ? `<span class="${dup.includes(l.winner.horse_id) ? "cc-dbl" : ""}">${L.horse(l.winner.horse_id, l.winner.horse)}</span><div class="muted small">${esc(l.winner.jockey || "")}</div>`
        : l.race_id ? `<span class="muted small">${L.race(l.race_id, fDate(l.date))}</span>` : '<span class="muted">—</span>'}</td>`).join("")}
        <td>${s.sweep ? `<b>${L.horse(s.sweep.horse_id, s.sweep.horse)}</b><div class="muted small">${L.stable(s.sweep.stable_id, s.sweep.stable)}</div>` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`, "Highlighted: a horse that won more than one of the races that season · — : not run that season (or before the save began)")}</div>`;
  if (S && d.points_scale.length) {
    html += `<div style="margin-top:16px">${panel(`Points table, ${esc(S.label)}`, `<div class="filters" style="margin-bottom:8px">${select("season", { season: S.label }, seasons.filter((s) => s.started).map((s) => [s.label, s.label]))}</div>` + table([
      { h: "#", cls: "num muted", f: (r) => r._n }, { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
      { h: "Points", cls: "num", f: (r) => `<b>${fNum(r.points)}</b>` }, { h: "Wins", cls: "num", f: (r) => fNum(r.wins) }, { h: "Placed in", cls: "num", f: (r) => `${fNum(r.legs)} of ${fNum(d.legs.length)}` },
    ], S.table.map((r, i) => Object.assign({ _n: i + 1 }, r)), { empty: "No races run that season yet." }), `${d.points_scale.map((p) => fNum(p)).join("–")} points for the first ${d.points_scale.length} in each race`)}</div>`;
  }
  return html;
}
async function qualifyingPage(route) {
  const q = route.q || {};
  const d = await api("qualifying" + (q.target ? "?target=" + encodeURIComponent(q.target) : ""));
  let html = raceSubTabs("qualifying");
  const typ = (t) => (t.type === "points" ? `Points <span class="muted small">${esc(t.scale || "")}</span>` : "Qualifiers");
  if (d.target) {
    const t = d.target, pts = t.type === "points";
    const nx = t.next, ls = t.last;
    html += `<div class="page-head"><div><div class="crumb"><a href="#/qualifying">Qualifying</a></div><h1>${esc(t.name)} ${grade(t.grade)}</h1>
      <div class="sub">${t.course_id ? L.course(t.course_id, t.course) + " · " : ""}${pts ? `Places go to the horses with the most points from ${fNum(t.feeders.length)} races (points for the first five home; the scale differs by race)` : `Horses qualify by finishing in the places in ${fNum(t.feeders.length)} races`}
      ${nx ? ` · next run ${L.race(nx.race_id, fDate(nx.date))}` : ""}${ls ? ` · last run ${L.race(ls.race_id, fDate(ls.date))}` : ""}</div></div></div>`;
    html += `<div class="grid cols-2" style="margin-top:4px">${panel(`${pts ? "Points standings" : "Qualified so far"} <span class="muted small">${fNum(t.standings.length)}</span>`, table([
      { h: "#", cls: "num muted", f: (r) => r._n }, { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) }, { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) },
      pts ? { h: "Points", cls: "num", f: (r) => `<b>${fNum(r.points)}</b>` } : { h: "Qualified in", f: (r) => r.earned.filter((x) => x.type === "qualifier").map((x) => (x.race_id ? L.race(x.race_id, x.source) : esc(x.source))).join(", ") },
      { h: "From", f: (r) => r.earned.map((x) => `${x.race_id ? L.race(x.race_id, x.source) : esc(x.source)}${pts ? ` <span class="muted small">${fNum(x.points)}</span>` : ""}`).join("<br>") },
    ], t.standings.map((r, i) => Object.assign({ _n: i + 1 }, r)), { empty: "No one has earned a place yet this time round." }), t.past_cycles ? `This time round · ${fNum(t.past_cycles)} results from earlier years not counted` : "This time round")}
      ${panel(`Races that lead to it <span class="muted small">${fNum(t.feeders.length)}</span>`, table([
        { h: "Race", f: (f) => (f.last || f.next ? L.race((f.next || f.last).race_id, f.source) : esc(f.source)) }, { h: "Course", f: (f) => esc(String(f.course || "").replace(/\b\w/g, (x) => x.toUpperCase())) },
        { h: pts ? "Points" : "Places", f: (f) => (pts ? esc(f.points || "") : `Top ${fNum(f.qualifiers || 1)}`) },
        { h: "Next", cls: "num nowrap", f: (f) => (f.next ? fDate(f.next.date) : '<span class="muted">—</span>') },
      ], t.feeders), pts ? "Points for the first five home" : "The first few home qualify")}</div>`;
    return html;
  }
  html += `<div class="page-head"><div><h1>Qualifying</h1><div class="sub">Races you have to earn a place in: by points (like the Kentucky Derby) or by finishing in the places in certain races. Click one for the standings and the races that lead to it.</div></div></div>`;
  html += panel(`Races <span class="muted small">${fNum(d.targets.length)}</span>`, table([
    { h: "Race", f: (t) => `<a href="${hashFor(["qualifying"], { target: t.cal })}"><b>${esc(t.name)}</b></a> ${grade(t.grade)}` },
    { h: "Course", f: (t) => (t.course_id ? L.course(t.course_id, t.course) : "—") }, { h: "How to get in", f: typ },
    { h: "Races leading to it", cls: "num", f: (t) => fNum(t.feeder_n) }, { h: "Horses in so far", cls: "num", f: (t) => fNum(t.open) },
    { h: "Yours", cls: "num", f: (t) => (t.yours ? `<span class="badge good">${fNum(t.yours)}</span>` : '<span class="muted">—</span>') },
    { h: "Next run", cls: "num nowrap", f: (t) => (t.next ? L.race(t.next.race_id, fDate(t.next.date)) : '<span class="muted">—</span>') },
  ], d.targets, { empty: "No qualifying races in this save." }));
  return html;
}

function raceSubTabs(active) { return sectionTabs("racing", active); }
async function racesPage(route) {
  return raceSubTabs("races") + await listPage({
    title: "Races", noun: "races", endpoint: "races", defaultSort: "date", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search races") +
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
    filters: (q, data) => searchBox(q, "Search meetings or courses") +
      seg("when", q, [["past", "Results"], ["upcoming", "Upcoming"], ["all", "All"]], "past") +
      select("country", q, [["", "Any country"]].concat((data.countries || []).map((c) => [c, c]))) +
      select("group", q, [["", "Any meeting"], ["1", "With a Group race"]]) +
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
  const filters = searchBox(q, "Search horses or races") + seg("result", q, [["wins", "Wins"], ["placed", "Placed (1st–3rd)"], ["", "All runs"]], "") +
    select("type", q, [["", "Any race type"], ["G1", "Group 1"], ["G2", "Group 2"], ["G3", "Group 3"], ["listed", "Listed"], ["stakes", "Stakes"], ["open", "Open"], ["allowance", "Allowance"], ["juvenile", "Juvenile"], ["maiden", "Maiden"], ["maiden_2yo", "Maiden 2yo"]]) +
    select("year", q, yearOptions(d.years));
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
    filters: (q) => searchBox(q, "Search stables") + statusSeg("stable", q, "active"),
    cols: [
      { h: "Stable", sort: "name", cls: "nowrap", f: (r) => `${L.stable(r.id, r.name)}${r.liquidated ? ' <span class="badge dead">Closed</span>' : ""}${r.id === (STATUS.player_stable || {}).id ? ' <span class="badge good">Yours</span>' : ""}` },
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
    <div class="sub">Owner ${d.owner ? L.person(d.owner.id, d.owner.name) : "—"}${(() => {
      const mg = (d.staff || []).filter((x) => x.role === "Manager");
      return mg.length ? ` · Manager ${mg.map((x) => `${L.person(x.id, x.name)}${x.id === (STATUS.meta || {}).player_id ? ' <span class="badge good">You</span>' : ""}`).join(", ")}` : "";
    })()}${d.city ? ` · ${esc(d.city.city)}, ${esc(d.city.country)}` : ""} · Founded ${fDate(s.stable_founded_date)}</div>${removedNote(d)}</div>
    <div style="display:flex;gap:8px"><a class="btn primary" href="#/stable/${id}/races">Every race</a><a class="btn" href="#/horses?stable=${id}&status=all">All horses ever</a></div></div>
    <div class="subtabs"><a href="#/stable/${id}" class="${on === "overview" ? "on" : ""}">Overview</a><a href="#/stable/${id}/financials" class="${on === "financials" ? "on" : ""}">Financials</a><a href="#/stable/${id}/horse-money" class="${on === "horse-money" ? "on" : ""}">Horse finances</a><a href="#/stable/${id}/awards" class="${on === "awards" ? "on" : ""}">Awards</a>${(d.racecourses_owned || []).length || on === "racecourses" ? `<a href="#/stable/${id}/racecourses" class="${on === "racecourses" ? "on" : ""}">Racecourses <span class="tab-n">${fNum((d.racecourses_owned || []).length)}</span></a>` : ""}</div>`;
}
// the stable's money charts (moved here from the Overview tab in 10.2): same data, now on a log scale
const STABLE_LOG = { scale: "auto", logC: 1000, yFmt: fMoneyShort, tipFmt: fMoney };

async function stablePage(id) {
  const [d, more] = await Promise.all([api("stable/" + id), api("stable_more/" + id).catch(() => ({}))]);
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
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Staff", table([
    { h: "Role", f: (r) => esc(r.role) }, { h: "Name", f: (r) => L.person(r.id, r.name) }, { h: "Since", cls: "nowrap", f: (r) => fDate(r.start) },
    { h: "Salary", cls: "num", f: (r) => fMoney(r.salary) },
  ], d.staff, { empty: "No staff." }))}
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
  html += stableMorePanels(more || {});
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

// Financials → Month by month: one year at a time (newest first), each month with ▸ for its categories
function finMonthly(months) {
  if (!months.length) return '<div class="empty">No monthly figures for this stable.</div>';
  const MN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => b - a);
  const cats = (o, sign) => Object.entries(o || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(finLabel(k))}</td><td class="num">${finAmt(v)}</td></tr>`).join("") || `<tr><td class="muted" colspan="2">No ${sign}.</td></tr>`;
  const body = years.map((y, yi) => {
    const ms = months.filter((m) => m.year === y).sort((a, b) => b.date - a.date);
    const tot = ms.reduce((a, m) => [a[0] + m.income_total, a[1] + m.expense_total], [0, 0]);
    return `<tbody data-mb-year="${y}" ${yi ? "hidden" : ""}>${ms.map((m, i) => {
      const net = m.income_total - m.expense_total, d = new Date(m.date * 1000), key = `${y}-${i}`;
      return `<tr class="mb-row"><td><button class="fin-tg" data-mb="${key}" title="Show the categories">▸</button> <b>${MN[d.getUTCMonth()]}</b> <span class="muted small">${d.getUTCFullYear()}</span></td>
        <td class="num">${finAmt(m.income_total)}</td><td class="num">${finAmt(m.expense_total)}</td><td class="num">${finAmt(net, net >= 0 ? "pos" : "neg")}</td></tr>
        <tr class="fin-items" data-mb-row="${key}" hidden><td colspan="4"><div class="mb-cats">
          <div><h4>Income</h4><table class="data nosort mb-cat">${cats(m.income, "income")}</table></div>
          <div><h4>Expenses</h4><table class="data nosort mb-cat">${cats(m.expenses, "expenses")}</table></div></div></td></tr>`;
    }).join("")}<tr class="mb-total"><td>${y} total <span class="muted small">${ms.length} month${ms.length === 1 ? "" : "s"}</span></td><td class="num">${finAmt(tot[0])}</td><td class="num">${finAmt(tot[1])}</td>
      <td class="num">${finAmt(tot[0] - tot[1], tot[0] - tot[1] >= 0 ? "pos" : "neg")}</td></tr></tbody>`;
  }).join("");
  return `<div class="fd-tools"><div class="seg" role="group" aria-label="Year">${years.map((y, i) => `<button data-mb-y="${y}" class="${i ? "" : "on"}">${y}</button>`).join("")}</div>
    <span class="grow"></span><button class="btn sm" data-mb-all="open">Open all</button><button class="btn sm" data-mb-all="close">Close all</button></div>
    <div class="tbl-wrap"><table class="data fin-monthly nosort"><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th></tr></thead>${body}</table></div>`;
}
document.addEventListener("click", (e) => {
  const y = e.target.closest("[data-mb-y]");
  if (y) {
    const p = y.closest(".panel");
    p.querySelectorAll("[data-mb-y]").forEach((b) => b.classList.toggle("on", b === y));
    p.querySelectorAll("tbody[data-mb-year]").forEach((tb) => (tb.hidden = tb.dataset.mbYear !== y.dataset.mbY));
    return;
  }
  const t = e.target.closest("[data-mb]");
  if (t) {
    const row = t.closest("table").querySelector(`[data-mb-row="${t.dataset.mb}"]`);
    row.hidden = !row.hidden; t.textContent = row.hidden ? "▸" : "▾";
    return;
  }
  const all = e.target.closest("[data-mb-all]");
  if (all) {
    const tb = all.closest(".panel").querySelector("tbody[data-mb-year]:not([hidden])");
    if (!tb) return;
    const open = all.dataset.mbAll === "open";
    tb.querySelectorAll("[data-mb-row]").forEach((r) => (r.hidden = !open));
    tb.querySelectorAll("[data-mb]").forEach((b) => (b.textContent = open ? "▾" : "▸"));
  }
});

// an ownership group (stables a person owns outright, and the stables those, or a parent stable, hold a majority of):
// the switch between one stable and the whole group on Financials and Horse finances
function groupSwitch(d, q, what) {
  const g = d.group;
  if (!g) return "";
  const on = q.group === "1", me = d.stable.stable_stable_id;
  const who = (s) => (s.holder_kind ? ` <span class="muted small">${fNum(s.pct, s.pct % 1 ? 1 : 0)}% ${s.holder_kind === "person" ? "owned by" : "held by"} ${esc(s.holder)}${s.closed ? " · closed" : ""}</span>` : "");
  const list = g.stables.map((s) => `<li class="${s.parent_id ? "sub" : ""}">${s.id === me ? `<b>${esc(s.name)}</b>` : L.stable(s.id, s.name)}${who(s)}</li>`).join("");
  const about = g.person ? `Everything ${L.person(g.person.id, g.person.name)} owns outright, and the stables those hold a majority of` : "A parent stable and the stables it holds a majority of";
  return `<div class="grp-bar">${seg("group", q, [["", "This stable"], ["1", `Whole group · ${g.stables.length} stables`]], "")}
    <div class="grp-about small">${on ? `<b>${what} for the whole group, added together.</b> ` : ""}${about}:</div><ul class="grp-list small">${list}</ul></div>`;
}
async function stableFinancePage(route) {
  const id = route.parts[1], q = route.q;
  const grpOn = q.group === "1";
  const [d, fin] = await Promise.all([api("stable/" + id), api(`stable_finance/${id}?` + new URLSearchParams({ ...(q.year ? { year: q.year } : {}), ...(q.month ? { month: q.month } : {}), ...(q.dir === "in" ? { dir: "in" } : {}), ...(grpOn ? { group: "1" } : {}) }))]);
  let html = stableHead(d, "financials") + groupSwitch(d, q, "Financials");
  const G = !!(fin.group && fin.group_monthly);
  const lf = (G ? fin.group_latest : d.latest_finance) || {}, monthly = (G ? fin.group_monthly : d.finance) || [];
  if (G) {
    const moved = (fin.internal || []).filter((x) => x.total);
    html += `<div class="note-line grp-note">The monthly figures below are each stable's own, added up, so money moved between the group's stables counts as income in one and spending in another (the net is unaffected). The payment detail leaves those moves out.${moved.length ? ` Moved between them: ${moved.map((x) => `${x.year} ${fMoneyShort(x.total)} (${fNum(x.n)} payment${x.n === 1 ? "" : "s"})`).join(" · ")}.` : ""}</div>`;
  }
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
      { name: "Income", color: "#1f5240", dots: true, points: years.map((y) => [yearStart(y.year) + YEAR_S / 2, y.income_total]) },
      { name: "Expenses", color: "#c0504d", dots: true, points: years.map((y) => [yearStart(y.year) + YEAR_S / 2, y.expense_total]) },
      { name: "Net", color: "#3e6e9e", dash: true, dots: true, points: years.map((y) => [yearStart(y.year) + YEAR_S / 2, y.net]) }],
      { ...STABLE_LOG, ranges: false, years: true, height: 240, partialYears: Object.fromEntries(years.filter((y) => y.months < 12).map((y) => [y.year, y.months])) }),
      years.some((y) => y.months < 12) ? "One dot per year · hollow dots are part years" : "One dot per year") : ""}</div>`;
  html += `<div style="margin-top:16px">${panel("Income by category", finYearTable(years, fin.income_cats || [], "income", "income_total"))}</div>
    <div style="margin-top:16px">${panel("Expenses by category", finYearTable(years, fin.expense_cats || [], "expenses", "expense_total", true), "The game's own expense categories · the detail below breaks them down")}</div>`;
  html += `<div style="margin-top:16px">${panel("Month by month", finMonthly(fin.months || []), "Each month's income and expenses · ▸ shows the categories")}</div>`;
  // detail: the transaction log, one year at a time: category → type → each payment
  const det = fin.detail, dys = fin.detail_years || [];
  const inc = fin.detail_dir === "in";
  const W = inc ? { what: "Income", paid: "Received in", payee: "Paid by", total: "Total received", filter: "Search payments", payments: "Payments", none: "No money received that year." }
    : { what: "Expense", paid: "Paid out in", payee: "Paid to", total: "Total paid out", filter: "Search payments", payments: "Payments", none: "No payments recorded that year." };
  // any year and month on record: the payment log has each payment for recent years; for the rest (the game keeps
  // only a yearly total of older payments) the breakdown comes from the monthly figures, by category
  const MNS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const snap = (fin.months || []).map((m) => ({ y: m.year, mo: new Date(m.date * 1000).getUTCMonth() + 1, m }));
  const allYears = [...new Set([...dys, ...snap.map((x) => x.y)])].filter(Boolean).sort((a, b) => b - a);
  const year = fin.detail_year || allYears[0];
  const logMonths = dys.includes(year) ? fin.detail_months || [] : [];
  const yearMonths = [...new Set([...logMonths, ...snap.filter((x) => x.y === year).map((x) => x.mo)])].sort((a, b) => a - b);
  const qMonth = yearMonths.includes(+q.month) ? +q.month : 0;
  const period = (qMonth ? MNS[qMonth - 1] + " " : "") + year;
  const fromLog = !!(det && det.year === year && (det.month || 0) === qMonth && (!qMonth || logMonths.includes(qMonth)));
  const dirSeg = viewSeg("dir", q, [["out", "Expenses"], ["in", "Income"]], "out");
  const pick = dirSeg + (allYears.length ? select("year", { year: String(year) }, allYears.map((y) => [String(y), String(y)]), "Which year")
    + select("month", { month: String(qMonth || "") }, [["", "Whole year"]].concat(yearMonths.map((m) => [String(m), MNS[m - 1] + (logMonths.length && !logMonths.includes(m) ? " (monthly figures)" : "")])), "Which month") : "");
  const fdBar = (pct, cls) => `<span class="sbar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`;
  let body;
  if (!fromLog) {
    // from the monthly figures: categories only (no individual payments that far back)
    const rowsM = snap.filter((x) => x.y === year && (!qMonth || x.mo === qMonth));
    const tot = {};
    rowsM.forEach((x) => Object.entries((inc ? x.m.income : x.m.expenses) || {}).forEach(([k, v]) => { tot[k] = (tot[k] || 0) + (v || 0); }));
    const cats = Object.entries(tot).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((a, c) => a + c[1], 0);
    const from = fin.detail_from ? new Date(fin.detail_from * 1000) : null;
    const why = from
      ? `The game's payment log only goes back to ${MNS[from.getUTCMonth()]} ${from.getUTCFullYear()} (it keeps a yearly total of older payments), so this is from the monthly figures, by category.`
      : "The game hasn't kept individual payments for this stable, so this is from the monthly figures, by category.";
    body = !cats.length ? `<div class="fd-tools">${pick}</div><div class="empty">${!allYears.length ? "The game hasn't kept individual payments for this stable (older years are only kept as yearly totals)."
        : rowsM.length ? W.none : "No figures for " + esc(period) + "."}</div>`
      : `<div class="fd-summary">
          <div><span class="lbl">${W.paid} ${esc(period)}</span><b>${finAmt(total)}</b></div>
          <div><span class="lbl">Months</span><b>${fNum(rowsM.length)}</b></div>
          <div><span class="lbl">Biggest category</span><b>${esc(finLabel(cats[0][0]))}</b> <span class="muted">${total ? fNum((100 * cats[0][1]) / total, 0) + "%" : ""}</span></div>
        </div>
        <div class="fd-tools">${pick}</div>
        <div class="note-line">${why}</div>
        <div class="tbl-wrap"><table class="data fin-detail nosort${inc ? " is-in" : ""}"><thead><tr><th>Category</th><th class="num">Total</th><th class="num">A month</th><th class="fd-share">Share</th></tr></thead>
        <tbody>${cats.map(([k, v]) => { const p = total ? (100 * v) / total : 0; return `<tr class="fin-cat"><td><b>${esc(finLabel(k))}</b></td><td class="num"><b>${finAmt(v)}</b></td><td class="num">${finAmt(v / Math.max(1, rowsM.length))}</td>
          <td class="fd-share">${fdBar(p, "cat")}<span class="sval">${fNum(p, p < 10 ? 1 : 0)}%</span></td></tr>`; }).join("")}</tbody>
        <tfoot><tr><td>${W.total}</td><td class="num">${finAmt(total)}</td><td class="num">${finAmt(total / Math.max(1, rowsM.length))}</td><td></td></tr></tfoot></table></div>`;
  } else if (!det.categories.length) body = `<div class="fd-tools">${pick}</div><div class="empty">${W.none}</div>`;
  else {
    const payee = (x) => (x.to_type === "person" && x.to_name ? L.person(x.to_id, x.to_name) : x.to_type === "stable" && x.to_name ? L.stable(x.to_id, x.to_name)
      : x.to_type === "racecourse" && x.to_name ? L.course(x.to_id, x.to_name) : esc(finLabel(x.to_type || "—")));
    const bar = (pct, cls) => `<span class="sbar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`;
    const payRows = (list, extra) => list.map((x) => `<tr data-fsearch="${esc(`${x.note || ""} ${x.to_name || ""} ${extra}`.toLowerCase())}"><td class="nowrap">${fDate(x.date)}</td><td>${payee(x)}</td><td>${esc(x.note || "")}</td><td class="num">${fMoney(x.amount)}</td></tr>`).join("");
    const sid = id;
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
        const hs = t.horses || null;
        const search = [t.type, finLabel(c.cat), ...t.items.map((x) => `${x.note || ""} ${x.to_name || ""}`), ...(hs || []).map((h) => h.name || "")].join(" ").toLowerCase();
        rowsHtml += `<tr class="fin-type" data-fcat-of="${ci}" data-fsearch="${esc(search)}" ${shut ? "hidden" : ""}><td><button class="fin-tg" data-fin="${key}" title="${hs ? "Show it by horse" : "Show each payment"}">▸</button> ${esc(t.type || "Other")}${hs ? ` <span class="muted small">· by horse (${fNum(hs.filter((h) => h.hid).length)})</span>` : ""}</td>
          <td class="num">${fNum(t.n)}</td><td class="num">${finAmt(t.total)}</td><td class="num">${t.n ? finAmt(t.total / t.n) : "—"}</td>
          <td class="fd-share">${bar(tp, "type")}<span class="sval muted">${fNum(tp, 0)}% of ${esc(finLabel(c.cat).toLowerCase())}</span></td></tr>
          <tr class="fin-items" data-fin-row="${key}" hidden><td colspan="5">${hs ? fdHorses(hs, t, key, payRows, W, sid) : ""}<div ${hs ? `data-fh-flat="${key}" hidden` : ""}><table class="data fd-pay nosort"><thead><tr><th>Date</th><th>${W.payee}</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>
          ${payRows(t.items, `${t.type} ${finLabel(c.cat)}`) || '<tr><td colspan="4" class="muted">No payments.</td></tr>'}
          </tbody></table>${t.n > t.items.length ? `<div class="muted small">Newest ${fNum(t.items.length)} of ${fNum(t.n)} payments.</div>` : ""}</div></td></tr>`;
      });
    });
    const nPay = det.categories.reduce((a, c) => a + c.n, 0);
    body = `<div class="fd-summary">
        <div><span class="lbl">${W.paid} ${esc(period)}</span><b>${finAmt(det.total)}</b></div>
        <div><span class="lbl">Payments</span><b>${fNum(nPay)}</b></div>
        <div><span class="lbl">Biggest category</span><b>${esc(finLabel(top.cat))}</b> <span class="muted">${det.total ? fNum((100 * top.total) / det.total, 0) + "%" : ""}</span></div>
      </div>
      <div class="fd-tools">${pick}<input type="search" class="fd-filter" placeholder="${W.filter}" aria-label="${W.filter}">
        <span class="grow"></span><button class="btn sm" data-fd-all="open" data-tip="Show every type in every category">Open all</button><button class="btn sm" data-fd-all="close" data-tip="Fold everything back to the categories">Close all</button></div>
      ${!qMonth && yearMonths.some((m) => !logMonths.includes(m)) ? `<div class="note-line">The payment log covers ${MNS[logMonths[0] - 1]}–${MNS[logMonths[logMonths.length - 1] - 1]} ${year} only; pick an earlier month to see it from the monthly figures.</div>` : ""}
      <div class="fd-none empty" hidden>Nothing matches that filter.</div>
      <div class="tbl-wrap"><table class="data fin-detail nosort${inc ? " is-in" : ""}"><thead><tr><th>Category / type</th><th class="num">Payments</th><th class="num">Total</th><th class="num">Average</th><th class="fd-share">Share</th></tr></thead>
      <tbody>${rowsHtml}</tbody><tfoot><tr><td>${W.total}</td><td class="num">${fNum(nPay)}</td><td class="num">${finAmt(det.total)}</td><td class="num">${nPay ? finAmt(det.total / nPay) : "—"}</td><td></td></tr></tfoot></table></div>`;
  }
  html += `<div style="margin-top:16px">${panel(`${W.what} detail${allYears.length ? " · " + esc(period) : ""}`, body,
    fromLog ? "From the game's payment log, so it can differ a little from the monthly totals above · ▸ shows each payment" : "From the game's monthly figures, by category")}</div>`;
  return html;
}
// breeding money received, one more level down: each horse (the stable's stallions), its covers, total and average fee
function fdHorses(hs, t, key, payRows, W, sid) {
  const tot = hs.reduce((a, h) => a + (h.total || 0), 0), max = Math.max(...hs.map((h) => h.total || 0), 1);
  const covers = hs.some((h) => h.items.some((x) => /^Breeding fee/.test(x.note || "")));
  const rows = hs.map((h, hi) => {
    const k = `${key}-${hi}`, p = tot ? (100 * (h.total || 0)) / tot : 0;
    const who = h.hid ? L.horse(h.hid, h.name || "Horse " + h.hid) : '<span class="muted">Horse not found</span>';
    const notes = [h.gender && h.gender !== "Stallion" ? esc(h.gender) : "", h.hid && h.stable_id && String(h.stable_id) !== String(sid) ? (h.stable ? `now at ${L.stable(h.stable_id, h.stable)}` : "now elsewhere") : ""].filter(Boolean).join(" · ");
    const search = [h.name || "", ...h.items.map((x) => `${x.note || ""} ${x.to_name || ""}`)].join(" ").toLowerCase();
    return `<tr class="fh-row" data-fsearch="${esc(search)}"><td><button class="fh-tg" data-fh-tg="${k}" title="Show this horse's payments">▸</button> ${who}${notes ? ` <span class="muted small">${notes}</span>` : ""}</td>
      <td class="num">${fNum(h.n)}</td><td class="num"><b>${finAmt(h.total)}</b></td><td class="num">${h.n ? finAmt(h.total / h.n) : "—"}</td>
      <td class="fd-share"><span class="sbar type"><i style="width:${((100 * (h.total || 0)) / max).toFixed(1)}%"></i></span><span class="sval muted">${fNum(p, p < 10 ? 1 : 0)}%</span></td></tr>
      <tr class="fh-pay" data-fh-row="${k}" hidden><td colspan="5"><table class="data fd-pay nosort"><thead><tr><th>Date</th><th>${W.payee}</th><th>Note</th><th class="num">Amount</th></tr></thead>
      <tbody>${payRows(h.items, `${h.name || ""} ${t.type}`)}</tbody></table>${h.n > h.items.length ? `<div class="muted small">Newest ${fNum(h.items.length)} of ${fNum(h.n)} payments.</div>` : ""}</td></tr>`;
  }).join("");
  return `<div class="fh-tools"><div class="seg" role="group" aria-label="Show"><button class="on" data-fh-view="horse" data-k="${key}">By horse</button><button data-fh-view="pay" data-k="${key}">Each payment</button></div>
      <span class="muted small">${fNum(hs.filter((h) => h.hid).length)} horse${hs.filter((h) => h.hid).length === 1 ? "" : "s"} · biggest first</span></div>
    <div data-fh-horses="${key}"><table class="data fd-horses nosort"><thead><tr><th>Horse</th><th class="num">${covers ? "Covers" : "Payments"}</th><th class="num">Total</th><th class="num">${covers ? "Average fee" : "Average"}</th><th class="fd-share">Share</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>All horses</td><td class="num">${fNum(hs.reduce((a, h) => a + h.n, 0))}</td><td class="num">${finAmt(tot)}</td><td class="num">${finAmt(tot / Math.max(1, hs.reduce((a, h) => a + h.n, 0)))}</td><td></td></tr></tfoot></table></div>`;
}
document.addEventListener("click", (e) => {
  const tg = e.target.closest("[data-fh-tg]");
  if (tg) {
    const row = document.querySelector(`[data-fh-row="${tg.dataset.fhTg}"]`);
    if (row) { row.hidden = !row.hidden; tg.textContent = row.hidden ? "▸" : "▾"; tg.title = row.hidden ? "Show this horse's payments" : "Hide the payments"; }
    return;
  }
  const v = e.target.closest("[data-fh-view]");
  if (v) {
    const k = v.dataset.k, horse = v.dataset.fhView === "horse";
    v.parentNode.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === v));
    const hb = document.querySelector(`[data-fh-horses="${k}"]`), fb = document.querySelector(`[data-fh-flat="${k}"]`);
    if (hb) hb.hidden = !horse;
    if (fb) fb.hidden = horse;
  }
});
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

// ------------------------------------------------------------------ people: Family tree tab and Dynasty tab
const yrs = (r) => (r.birth ? yr(r.birth) : "?") + (r.died ? "–" + yr(r.died) : "");
const pLink = (r) => (r && r.id ? `${L.person(r.id, r.name)}${r.died ? ' <span class="muted">†</span>' : ""}${r.is_player ? ' <span class="badge good">You</span>' : ""}` : '<span class="muted">—</span>');
// what an ancestor is to you: Father, Grandmother, 3× great-grandfather...
const ancWord = (gen, male) => {
  const w = male ? ["father", "grandfather"] : ["mother", "grandmother"];
  const g = gen === 1 ? w[0] : gen === 2 ? w[1] : gen === 3 ? "great-" + w[1] : gen === 4 ? "great-great-" + w[1] : `${gen - 2}× great-${w[1]}`;
  return g.charAt(0).toUpperCase() + g.slice(1);
};
const treeLink = (id) => `<a class="tree-l" href="#/person/${id}/family" title="Their family tree">tree</a>`;
const PATH_WORD = (path) => path.split("").map((c) => (c === "F" ? "father" : "mother")).join("'s ").replace(/^./, (x) => x.toUpperCase());

async function personFamilyPage(route) {
  const id = route.parts[1], q = route.q || {};
  const [d, f] = await Promise.all([api("person/" + id), api("family/" + id)]);
  let html = personHead(d, "family");
  const me = f.person, T = f.tree, rel = f.relatives || [];
  const known = Object.keys(T).length, living = rel.filter((r) => !r.died).length;
  html += tiles([
    ["Ancestors known", fNum(known), `of ${fNum(510)} places in 8 generations`],
    ["Generations back", fNum(f.deepest), f.deepest < 8 ? "the save has no older records" : "as far as the tree goes"],
    ["Blood relatives", fNum(rel.length), `${fNum(living)} alive`],
    ["Spouses & partners", fNum((f.spouses || []).length), (f.spouses || []).filter((x) => !x.divorced && !x.ended).map((x) => esc(x.name || "")).join(", ") || ""],
  ]);
  // ancestors: four generations as a chart, then up to eight as an outline
  const node = (path) => {
    const r = T[path], gen = path.length, row = parseInt(path.replace(/F/g, "0").replace(/M/g, "1"), 2) * (16 >> gen);
    const style = `grid-column:${gen};grid-row:${row + 1} / span ${16 >> gen};`;
    const cls = path.endsWith("F") ? "m" : "f";
    if (!r || !r.name) return `<div class="node g${gen} unk ${cls}" style="${style}" title="${esc(PATH_WORD(path))}">Not recorded</div>`;
    return `<div class="node g${gen} ${cls}" style="${style}" title="${esc(PATH_WORD(path))}"><a class="go" href="#/person/${r.id}" title="Open their page">↗</a>
      <div class="nm"><a href="#/person/${r.id}/family">${esc(r.name)}</a></div><div class="meta">${yrs(r)}${r.job ? " · " + esc(r.job) : ""}</div></div>`;
  };
  const paths = [];
  for (let g = 1; g <= 4; g++) for (let i = 0; i < 1 << g; i++) paths.push(i.toString(2).padStart(g, "0").replace(/0/g, "F").replace(/1/g, "M"));
  // the outline: one line per known ancestor, nested under their child, all eight generations
  const outline = (path, depth) => {
    const kids = ["F", "M"].map((c) => path + c).filter((k) => T[k] && T[k].name);
    if (!kids.length) return "";
    return `<ul class="fam-ol">${kids.map((k) => `<li><details ${depth < 2 ? "open" : ""}><summary><span class="fam-rel">${esc(ancWord(k.length, k.endsWith("F")))}</span>
      ${pLink(T[k])} <span class="muted small">${yrs(T[k])} · ${esc(PATH_WORD(k))}</span></summary>${outline(k, depth + 1)}</details></li>`).join("")}</ul>`;
  };
  const deep = Object.keys(T).some((k) => k.length > 4);
  html += panel("Ancestors", known ? `<div class="tree fam-tree">${paths.map(node).join("")}</div>
      <div class="legend"><span><i style="background:#5b84ad"></i>Father's side of each person</span><span><i style="background:#c07a8f"></i>Mother's side</span>
      <span>Click a name to see their family tree · ↗ opens their page</span></div>
      <h3 class="fam-h">All ${f.gens} generations <button class="btn sm" data-fam-all="1">Open all</button> <button class="btn sm" data-fam-all="0">Close all</button></h3>
      <div class="fam-outline"><div class="fam-root">${pLink(me)} <span class="muted small">${yrs(me)}</span></div>${outline("", 0)}</div>
      ${deep ? "" : `<p class="help">Nobody further back than ${f.deepest} generation${f.deepest === 1 ? "" : "s"} is recorded yet: the game only links parents and children born since your career began.</p>`}`
    : `<div class="empty">The save doesn't record ${esc(me.name)}'s parents. The game links parents and children for people born since your career began, so trees grow as generations pass.</div>`);
  // relatives, nearest first, in groups
  const reach = q.reach || "close";
  const inReach = (r) => reach === "all" || (reach === "close" ? r.up + r.down <= 2 : r.up <= 3 && r.down <= 3);
  const st = q.status || (q.alive === "1" ? "alive" : "all");
  const shown = rel.filter((r) => inReach(r) && (st === "all" || (st === "alive" ? !r.died : !!r.died)));
  const GROUPS = [
    ["Parents & grandparents", (r) => r.down === 0], ["Brothers & sisters", (r) => r.up === 1 && r.down === 1],
    ["Children & grandchildren", (r) => r.up === 0], ["Aunts & uncles", (r) => r.down === 1 && r.up >= 2],
    ["Nieces & nephews", (r) => r.up === 1 && r.down >= 2], ["Cousins", (r) => r.up >= 2 && r.down >= 2],
  ];
  const cols = [
    { h: "Name", cls: "nowrap", f: (r) => `${pLink(r)} ${treeLink(r.id)}` },
    { h: "Relation", f: (r) => `<b>${esc(r.relation)}</b>` },
    { h: "Born", cls: "num", f: (r) => yr(r.birth) }, { h: "Age", cls: "num nowrap", f: (r) => ageCell(r.birth, r.died) },
    { h: "Job now", f: (r) => (r.job ? esc(r.job) : '<span class="muted">—</span>') },
    { h: "Stable", f: (r) => (r.stable_id ? L.stable(r.stable_id, r.stable) : r.owns_id ? `Owns ${L.stable(r.owns_id, r.owns)}` : '<span class="muted">—</span>') },
    { h: "Married to", f: (r) => (r.spouses || []).map((x) => L.person(x.id, x.name)).join(", ") || '<span class="muted">—</span>' },
  ];
  const sp = (f.spouses || []);
  let relHtml = `<div class="filters">${viewSeg("reach", q, [["close", "Close family"], ["extended", "+ Aunts, uncles & cousins"], ["all", "Everyone"]], "close")}
    ${statusSeg("person", { status: q.status || (q.alive === "1" ? "alive" : "") }, "all")}</div>`;
  if (sp.length) relHtml += `<h3 class="fam-h">Spouses & partners</h3>` + table([
    { h: "Name", f: (r) => pLink(r) }, { h: "", f: (r) => (r.partner ? "Partner" : r.divorced ? `Divorced ${yr(r.divorced)}` : r.ended ? `Ended ${yr(r.ended)}` : "Married") },
    { h: "Married", cls: "num", f: (r) => (r.married ? fDate(r.married) : "—") }, { h: "Age", cls: "num", f: (r) => ageCell(r.birth, r.died) },
    { h: "Job now", f: (r) => (r.job ? esc(r.job) : "—") }], sp);
  let any = false;
  for (const [title, test] of GROUPS) {
    const list = shown.filter(test);
    if (!list.length) continue;
    any = true;
    relHtml += `<h3 class="fam-h">${title} <span class="muted small">${list.length}</span></h3>` + table(cols, list);
  }
  if (!any) relHtml += `<div class="empty">${rel.length ? "No relatives in this range. Try Everyone." : "No blood relatives are recorded in the save yet."}</div>`;
  html += panel("Relatives", relHtml, "Worked out from the parents and children the save records · nearest first");
  return html;
}
// ------------------------------------------------------------------ Tree chart tab: a drawn family tree
// Ancestors above (each couple side by side, their parents above them), the person in the middle with brothers and sisters
// beside them and partners next to them, and children and grandchildren below, joined by lines.
const TC = { W: 168, H: 54, GX: 14, GY: 46, CG: 10 };
async function personTreePage(route) {
  const id = route.parts[1], q = route.q || {};
  const up = Math.max(1, Math.min(8, +q.up || 4)), down = Math.max(0, Math.min(4, q.down === undefined ? 3 : +q.down));
  const sibs = q.sibs !== "0";
  const [d, f] = await Promise.all([api("person/" + id), api("family/" + id)]);
  let html = personHead(d, "tree");
  const T = f.tree, C = f.cards || {}, me = f.person;
  const boxes = [], lines = [];
  const box = (r, x, y, extra) => boxes.push({ r, x, y, extra: extra || "" });
  const card = (pid) => C[pid] || C[String(pid)] || null;
  // --- ancestors: widths first (only known people take room), then positions
  const has = (p) => T[p] && T[p].name;
  const wUp = (path) => {
    if (path.length >= up) return TC.W;
    const ps = ["F", "M"].filter((c) => has(path + c));
    if (!ps.length) return TC.W;
    const w = ps.map((c) => wUp(path + c)).reduce((a, b) => a + b, 0) + TC.GX * (ps.length - 1);
    return Math.max(TC.W, w);
  };
  const depthUp = (path) => (path.length >= up ? path.length : Math.max(path.length, ...["F", "M"].filter((c) => has(path + c)).map((c) => depthUp(path + c))));
  const maxUp = depthUp("");
  const rowY = (gen) => (maxUp - gen) * (TC.H + TC.GY);   // gen 0 = the person's row
  // place a person's parents centred over them; returns nothing, draws boxes and lines
  const placeUp = (path, cx) => {
    if (path.length >= up) return;
    const ps = ["F", "M"].filter((c) => has(path + c));
    if (!ps.length) return;
    const ws = ps.map((c) => wUp(path + c));
    let x = cx - (ws.reduce((a, b) => a + b, 0) + TC.GX * (ps.length - 1)) / 2;
    const y = rowY(path.length + 1), mids = [];
    ps.forEach((c, i) => {
      const mx = x + ws[i] / 2;
      box(T[path + c], mx - TC.W / 2, y);
      mids.push(mx);
      placeUp(path + c, mx);
      x += ws[i] + TC.GX;
    });
    // couple line, then down to the child
    const yMid = y + TC.H / 2, from = mids.length === 2 ? (mids[0] + mids[1]) / 2 : mids[0];
    if (mids.length === 2) lines.push(`M${mids[0] + TC.W / 2},${yMid} H${mids[1] - TC.W / 2}`);
    lines.push(`M${from},${mids.length === 2 ? yMid : y + TC.H} V${rowY(path.length) - TC.GY / 2} H${cx} V${rowY(path.length)}`);
  };
  // --- descendants: a person with their partners beside them and each partner's children below that couple
  const wFam = (fam, level) => {
    const kids = level < down ? fam.children : [];
    const kw = kids.map((k) => wDown(k, level + 1)).reduce((a, b) => a + b, 0) + TC.GX * Math.max(0, kids.length - 1);
    return Math.max(TC.W, kw);
  };
  const wDown = (node, level) => {
    const fs = (node.families || []).filter((x) => x.partner || (level < down && x.children.length));
    const own = TC.W + fs.filter((x) => x.partner).length * (TC.W + TC.CG);
    const fw = fs.map((x) => wFam(x, level)).reduce((a, b) => a + b, 0) + TC.GX * Math.max(0, fs.length - 1);
    return Math.max(own, fw);
  };
  // a person's row: former partners on the left, the person, current partners on the right (so no line crosses a box)
  const rowOf = (fs) => {
    const ps = fs.filter((x) => x.partner);
    const left = ps.filter((x) => x.divorced || x.ended), right = ps.filter((x) => !x.divorced && !x.ended);
    return { left, right, rowW: TC.W + ps.length * (TC.W + TC.CG), meOff: left.length * (TC.W + TC.CG) };
  };
  const placeDown = (node, cx, y, level, isMe) => {
    const fs = (node.families || []).filter((x) => x.partner || (level < down && x.children.length));
    const row = rowOf(fs);
    const meX = cx - row.rowW / 2 + row.meOff;
    if (!isMe) box(card(node.id), meX, y);
    const pos = {};
    row.left.forEach((fam, i) => {
      const px = meX - (row.left.length - i) * (TC.W + TC.CG);
      box(card(fam.partner), px, y, "divorced");
      pos[fam.partner] = px;
      lines.push({ d: `M${px + TC.W},${y + TC.H / 2} H${i === row.left.length - 1 ? meX : px + TC.W + TC.CG}`, cls: "div" });
    });
    row.right.forEach((fam, i) => {
      const px = meX + (i + 1) * (TC.W + TC.CG);
      box(card(fam.partner), px, y, "partner");
      pos[fam.partner] = px;
      if (i === 0) lines.push({ d: `M${meX + TC.W},${y + TC.H / 2} H${px}`, cls: "wed" });
    });
    if (level >= down) return;
    // children under each couple (or under the person for children with an unknown other parent)
    const ws = fs.map((x) => wFam(x, level));
    let x = cx - (ws.reduce((a, b) => a + b, 0) + TC.GX * Math.max(0, fs.length - 1)) / 2;
    const cy = y + TC.H + TC.GY;
    fs.forEach((fam, i) => {
      const kids = fam.children;
      const px = fam.partner ? pos[fam.partner] : null;
      const from = px === null ? meX + TC.W / 2 : px > meX ? (meX + TC.W + px) / 2 : (px + TC.W + meX) / 2;
      if (kids.length) {
        const kws = kids.map((k) => wDown(k, level + 1));
        let kx = x + (ws[i] - (kws.reduce((a, b) => a + b, 0) + TC.GX * (kids.length - 1))) / 2;
        const tops = [];
        kids.forEach((k, j) => {
          const kcx = kx + kws[j] / 2;
          tops.push(kcx);
          // a child's own row puts them first, then their partners: the child's box sits at the left of their own row
          const kr = rowOf((k.families || []).filter((z) => z.partner || (level + 1 < down && z.children.length)));
          placeDown(k, kcx, cy, level + 1, false);
          tops[j] = kcx - kr.rowW / 2 + kr.meOff + TC.W / 2;
          kx += kws[j] + TC.GX;
        });
        const bar = cy - TC.GY / 2;
        // from the middle of the couple's line (adjacent partners) or the bottom of the person's box
        const adjacent = px !== null && Math.abs(px - meX) <= TC.W + TC.CG + 1;
        lines.push(`M${from},${adjacent ? y + TC.H / 2 : y + TC.H} V${bar}`);
        lines.push(`M${Math.min(from, ...tops)},${bar} H${Math.max(from, ...tops)}`);
        tops.forEach((t) => lines.push(`M${t},${bar} V${cy}`));
      }
      x += ws[i] + TC.GX;
    });
  };
  // --- the person's row: older brothers and sisters, the person (with partners), younger ones
  const sib = sibs ? (f.siblings || []) : [];
  const older = sib.filter((r) => (r.birth || 0) <= (me.birth || 0)), younger = sib.filter((r) => (r.birth || 0) > (me.birth || 0));
  const meNode = { id: me.id, families: f.descendants || [] };
  const meW = wDown(meNode, 0);
  const leftW = older.length * (TC.W + TC.GX), rightW = younger.length * (TC.W + TC.GX);
  const ancW = wUp("");
  const total = Math.max(ancW, leftW + meW + rightW) + 40;
  const rMe = rowOf((meNode.families || []).filter((x) => x.partner || (0 < down && x.children.length)));
  const meRow = rMe.rowW;
  const cx = 20 + leftW + meW / 2 + Math.max(0, (total - 40 - (leftW + meW + rightW)) / 2);
  const meX = cx - meRow / 2 + rMe.meOff;
  const y0 = rowY(0);
  box(me, meX, y0, "focus");
  placeDown(meNode, cx, y0, 0, true);
  const meMid = meX + TC.W / 2;
  // the parents sit over the person (not the whole row), siblings hang off the same bar
  placeUp("", meMid);
  const sibX = [];
  const rowStart = meX - rMe.meOff, rowEnd = rowStart + meRow;
  older.forEach((r, i) => { const x = rowStart - (older.length - i) * (TC.W + TC.GX); box(r, x, y0, r.half ? "half" : ""); sibX.push(x + TC.W / 2); });
  younger.forEach((r, i) => { const x = rowEnd + TC.GX + i * (TC.W + TC.GX); box(r, x, y0, r.half ? "half" : ""); sibX.push(x + TC.W / 2); });
  if (sibX.length && (has("F") || has("M"))) {
    const bar = y0 - TC.GY / 2;
    lines.push(`M${Math.min(meMid, ...sibX)},${bar} H${Math.max(meMid, ...sibX)}`);
    sibX.forEach((sx) => lines.push(`M${sx},${bar} V${y0}`));
  }
  // --- size, then shift everything so nothing is cut off
  const xs = boxes.map((b) => b.x), ys = boxes.map((b) => b.y);
  const minX = Math.min(...xs) - 20, minY = Math.min(...ys) - 20;
  const width = Math.max(...xs) - minX + TC.W + 20, height = Math.max(...ys) - minY + TC.H + 20;
  const shift = (dd) => dd.replace(/([MLHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g, (m0, c, a, b) =>
    c === "H" ? `H${+a - minX}` : c === "V" ? `V${+a - minY}` : `${c}${+a - minX},${+b - minY}`);
  const svg = lines.map((l) => (typeof l === "string" ? `<path d="${shift(l)}"/>` : `<path class="${l.cls}" d="${shift(l.d)}"/>`)).join("");
  const B = boxes.map((b) => {
    const r = b.r || {};
    const sex = r.sex === "Male" ? "m" : r.sex === "Female" ? "f" : "";
    const tag = b.extra === "divorced" ? ' <span class="tc-tag">· divorced</span>' : b.extra === "half" ? ' <span class="tc-tag">· half-sibling</span>' : "";
    return `<div class="tc-box ${sex} ${b.extra} ${r.died ? "dead" : ""}" style="left:${b.x - minX}px;top:${b.y - minY}px">
      ${r.id ? `<a class="tc-nm" href="#/person/${r.id}/tree" title="Make ${esc(r.name || "")} the centre of the tree">${esc(r.name || "")}</a>` : "Not recorded"}${r.is_player ? ' <span class="badge good">You</span>' : ""}
      <div class="tc-meta">${r.birth ? yrs(r) : ""}${r.job ? " · " + esc(r.job) : ""}${tag}</div>
      ${r.id ? `<a class="tc-go" href="#/person/${r.id}" title="Open their page">↗</a>` : ""}</div>`;
  }).join("");
  const tools = `<div class="filters tc-tools">
    <span class="small muted">Ancestors</span>${seg("up", { up: String(up) }, [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"], ["8", "8"]].map(([v, t]) => [v, t + (v === "1" ? " gen" : "")]), "4")}
    <span class="small muted">Descendants</span>${seg("down", { down: String(down) }, [["0", "None"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], "3")}
    ${seg("sibs", q, [["", "Brothers & sisters"], ["0", "Hide them"]], "")}
    <span class="grow"></span><button class="btn sm" data-tc-zoom="-1" title="Zoom out">−</button><button class="btn sm" data-tc-zoom="0">Fit</button><button class="btn sm" data-tc-zoom="1" title="Zoom in">+</button></div>`;
  html += panel("Family tree chart", boxes.length > 1 ? tools + `<div class="tc-wrap" id="tc-wrap"><div class="tc-size" id="tc-size"><div class="tc" id="tc" style="width:${width}px;height:${height}px">
      <svg width="${width}" height="${height}">${svg}</svg>${B}</div></div></div>
      <div class="legend"><span><i style="background:#5b84ad"></i>Male</span><span><i style="background:#c07a8f"></i>Female</span><span>— married · - - divorced</span>
      <span>Click a name to put them in the centre · ↗ opens their page · drag to move around</span></div>`
    : `<div class="empty">The save doesn't link ${esc(me.name)} to any parents, children, brothers, sisters or partners yet, so there's no tree to draw. The game links families for people born since your career began.</div>`,
    "Ancestors above, children below · grey boxes = died");
  return html;
}
personTreePage.after = () => tcInit();
function tcInit() {
  const wrap = $("#tc-wrap"), tc = $("#tc");
  if (!wrap || !tc) return;
  let z = 1;
  try { z = +sessionStorage.getItem("hrm.tcZoom") || 1; } catch (e) { /* default */ }
  const size = $("#tc-size");
  const setZ = (v) => {
    z = Math.max(0.3, Math.min(1.6, v));
    tc.style.transform = `scale(${z})`;
    size.style.width = tc.offsetWidth * z + "px"; size.style.height = tc.offsetHeight * z + "px";
    try { sessionStorage.setItem("hrm.tcZoom", z); } catch (e) { /* this view */ }
  };
  setZ(z);
  // centre on the person
  const focus = $(".tc-box.focus", tc);
  if (focus) { wrap.scrollLeft = (focus.offsetLeft + TC.W / 2) * z - wrap.clientWidth / 2; wrap.scrollTop = Math.max(0, (focus.offsetTop + TC.H / 2) * z - wrap.clientHeight / 2); }
  wrap.closest(".panel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tc-zoom]");
    if (!b) return;
    const v = +b.dataset.tcZoom;
    setZ(v === 0 ? Math.min(1, wrap.clientWidth / tc.offsetWidth) : z * (v > 0 ? 1.2 : 1 / 1.2));
  });
  // drag to pan
  let drag = null;
  wrap.addEventListener("pointerdown", (e) => { if (e.target.closest("a, button")) return; drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop }; wrap.classList.add("dragging"); });
  window.addEventListener("pointermove", (e) => { if (!drag) return; wrap.scrollLeft = drag.l - (e.clientX - drag.x); wrap.scrollTop = drag.t - (e.clientY - drag.y); });
  window.addEventListener("pointerup", () => { drag = null; wrap.classList.remove("dragging"); });
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fam-all]");
  if (!b) return;
  b.closest(".panel").querySelectorAll(".fam-outline details").forEach((x) => (x.open = b.dataset.famAll === "1"));
});

// ------------------------------------------------------------------ family pages: shared pieces (15.5)
const famInitials = (name) => String(name || "?").replace(/^(?:†\s*|\([A-Z]{1,3}\)\s*)+/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const famAv = (r, cls = "") => `<span class="fav ${r && r.died ? "dead" : r && r.sex === "Female" ? "f" : "m"} ${cls}" aria-hidden="true">${esc(famInitials(r && r.name))}</span>`;
const famIc = (k, cls = "") => `<svg class="fic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${({
  trophy: '<path d="M5 2.5h6v3a3 3 0 0 1-6 0zM5 3.5H3a2 2 0 0 0 2 2.5M11 3.5h2a2 2 0 0 1-2 2.5M8 8.5V11M5.5 13.5h5"/>',
  rings: '<circle cx="6" cy="9" r="3.5"/><circle cx="10" cy="9" r="3.5"/>',
  cake: '<path d="M2.5 13.5h11M3.5 13.5V9h9v4.5M8 9V6.5M8 4.5v-.5"/>',
  cross: '<path d="M8 2v12M5 5h6"/>',
  barn: '<path d="M2.5 7 8 3l5.5 4v7h-11z"/><path d="M6 14v-4h4v4"/>',
  flag: '<path d="M3.5 14V2.5"/><path d="M3.5 3h8l-1.6 2.5L11.5 8h-8"/>',
  star: '<path d="m8 2.5 1.7 3.6 3.8.4-2.9 2.6.8 3.8L8 11l-3.4 1.9.8-3.8-2.9-2.6 3.8-.4z"/>',
  crown: '<path d="M2.5 12h11l1-7-3.5 2.5L8 3 5 7.5 1.5 5z"/>',
  heart: '<path d="M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 4.8a2.8 2.8 0 0 1 5.5 1.5c0 3.9-5.5 7.2-5.5 7.2z"/>',
})[k] || ""}</svg>`;
// what someone does now: their current job, or the last one they had, or owner of a stable
function famRole(r) {
  if (r.job) return r.job;
  const c = (r.careers || []).slice().sort((a, b) => (b.start || 0) - (a.start || 0))[0];
  if (c) return c.role + (c.end ? " (former)" : "");
  if ((r.owned || r.stables || []).some((s) => !s.gone)) return "Owner";
  return "";
}
// "Different races won: 120 as jockey · 138 as trainer · 144 as manager"
const famWinsTip = (r) => `Different races won (each once): ${[["jockey", r.j_wins], ["trainer", r.t_wins], ["manager", r.m_wins]].filter(([, n]) => n).map(([k, n]) => `${fNum(n)} as ${k}`).join(" · ")}`;
// "Trainer of the Year ×2 · Hall of Fame"
const famAwards = (list) => {
  const n = {};
  (list || []).forEach((a) => (n[a.label] = (n[a.label] || 0) + 1));
  return Object.entries(n).map(([k, v]) => `${k}${v > 1 ? " ×" + v : ""}`);
};
const famChips = (r, max = 4) => {
  const out = [];
  if (r.wins) out.push(`<span class="fchip" data-tip="${esc(famWinsTip(r))}">${fNum(r.wins)} win${r.wins === 1 ? "" : "s"}</span>`);
  if (r.g1) out.push(`<span class="fchip gold">${fNum(r.g1)} × G1</span>`);
  famAwards(r.award_list).slice(0, Math.max(0, max - out.length)).forEach((a) => out.push(`<span class="fchip gold">${famIc("trophy")} ${esc(a)}</span>`));
  return out.join("");
};
const famAge = (b, d) => (isNum(b) ? Math.floor(((d || (STATUS && STATUS.meta && STATUS.meta.game_date) || Date.now() / 1000) - b) / (365.2425 * 86400)) : null);
// dynasty data for each person, kept while the same save is loaded (switching views doesn't fetch it again)
const DYN_CACHE = new Map();
function dynastyData(id) {
  const key = id + ":" + ((STATUS && STATUS.meta && STATUS.meta.loaded_at) || "");
  if (!DYN_CACHE.has(key)) DYN_CACHE.set(key, api("dynasty/" + id).catch((e) => { DYN_CACHE.delete(key); throw e; }));
  return DYN_CACHE.get(key);
}

// ------------------------------------------------------------------ Lifespans tab: the person and their ancestors on one time line
async function personLifespansPage(route) {
  const id = +route.parts[1], q = route.q || {};
  const [d, ls] = await Promise.all([api("person/" + id), api("lifespans/" + id)]);
  let html = personHead(d, "lifespans");
  const me = ls.person, now = ls.game_date || (STATUS && STATUS.meta && STATUS.meta.game_date) || Date.now() / 1000;
  const maxGen = Math.max(0, ...ls.people.map((p) => p.gen));
  const up = q.up === "all" || !q.up ? maxGen : Math.min(maxGen, +q.up || maxGen);
  const withSib = q.with === "sibs" || q.with === "both", withKids = q.with === "kids" || q.with === "both";
  const shown = ls.people.filter((p) => (p.path === "S" ? withSib : p.path === "C" ? withKids : p.gen <= up) && isNum(p.birth));
  const genName = (g) => (g === 1 ? "Parents" : g === 2 ? "Grandparents" : g === 3 ? "Great-grandparents" : `${g - 2}× great-grandparents`);
  const relOf = (p) => (p.path === "" ? (p.id === id ? "This person" : "") : p.path === "S" ? (p.half ? "Half-" + (p.sex === "Female" ? "sister" : "brother") : p.sex === "Female" ? "Sister" : "Brother")
    : p.path === "C" ? (p.sex === "Female" ? "Daughter" : "Son") : p.path.length === 1 ? (p.path === "F" ? "Father" : "Mother") : PATH_WORD(p.path));
  // the years shown: from the earliest birth to the game date
  const y0 = Math.floor(Math.min(...shown.map((p) => yearOf(p.birth))) / 10) * 10, y1 = yearOf(now) + 1;
  const span = Math.max(1, (Date.UTC(y1, 11, 31) / 1000) - Date.UTC(y0, 0, 1) / 1000);
  const P = (ts) => Math.max(0, Math.min(100, ((ts - Date.UTC(y0, 0, 1) / 1000) / span) * 100));
  const step = y1 - y0 > 60 ? 10 : 5;
  const ticks = [];
  for (let y = y0; y <= y1; y += step) ticks.push(y);
  const lines = ticks.map((y) => `<i style="left:${P(Date.UTC(y, 0, 1) / 1000).toFixed(2)}%"></i>`).join("") + `<i class="now" style="left:${P(now).toFixed(2)}%"></i>`;
  const row = (p) => {
    const end = p.died || now, sex = p.died ? "dead" : p.sex === "Female" ? "f" : "m";
    const clamp = (a, b) => [Math.max(a, p.birth), Math.min(b || end, end)];
    // careers: each job, plus owning a stable (only from when they were alive)
    const segs = (p.careers || []).map((c) => ({ role: c.role, a: c.start, b: c.end, where: c.stable }))
      .concat((p.owned || []).filter((o) => o.founded && o.founded >= p.birth).map((o) => ({ role: "Owner", a: o.founded, b: null, where: o.name })))
      .filter((s) => isNum(s.a));
    const segHtml = segs.map((s) => { const [a, b] = clamp(s.a, s.b); return b > a ? `<span class="ls-car ${sex}" style="left:${P(a).toFixed(2)}%;width:${(P(b) - P(a)).toFixed(2)}%" data-tip="${esc(`${s.role}${s.where ? " · " + s.where : ""} · ${yearOf(s.a)}–${s.b ? yearOf(s.b) : "now"}`)}"></span>` : ""; }).join("");
    const mk = [];
    (p.children || []).forEach((b) => mk.push(`<span class="ls-mk kid" style="left:${P(b).toFixed(2)}%" data-tip="Child born ${yearOf(b)}"></span>`));
    (p.marriages || []).filter((m) => m.date).forEach((m) => mk.push(`<span class="ls-mk wed" style="left:${P(m.date).toFixed(2)}%" data-tip="Married ${yearOf(m.date)}${m.divorced ? ` · divorced ${yearOf(m.divorced)}` : ""}"></span>`));
    if (p.first_win) mk.push(`<span class="ls-mk win" style="left:${P(p.first_win).toFixed(2)}%" data-tip="First win ${fDate(p.first_win)}"></span>`);
    if (p.first_g1) mk.push(`<span class="ls-mk g1" style="left:${P(p.first_g1.date).toFixed(2)}%" data-tip="${esc(`First Group 1 · ${p.first_g1.horse || ""} · ${p.first_g1.race || ""} · ${fDate(p.first_g1.date)}`)}"></span>`);
    (p.award_list || p.awards || []).forEach((a) => mk.push(`<span class="ls-mk aw" style="left:${P(a.date || Date.UTC(a.year, 11, 1) / 1000).toFixed(2)}%" data-tip="${esc(`${a.year} · ${a.label}`)}"></span>`));
    const roles = [...new Set(segs.map((s) => s.role))].slice(0, 3).join(" · ");
    const age = famAge(p.birth, p.died);
    return `<div class="ls-lab${p.id === id ? " me" : ""}">${famAv(p, "sm")}<div class="ls-who"><div>${p.id === id ? `<b>${esc(p.name)}</b>` : L.person(p.id, p.name)}</div><div class="small muted">${esc(relOf(p))}</div></div></div>
      <div class="ls-trk"><span class="ls-life ${sex}" style="left:${P(p.birth).toFixed(2)}%;width:${(P(end) - P(p.birth)).toFixed(2)}%" data-tip="${esc(`${p.name} · ${yearOf(p.birth)}–${p.died ? yearOf(p.died) + ` (aged ${age})` : `now (${age})`}`)}"></span>${segHtml}${mk.join("")}
      <span class="ls-cap" style="${P(p.birth) > 62 ? `right:${(100 - P(end)).toFixed(2)}%;text-align:right` : `left:${P(p.birth).toFixed(2)}%`}">${yearOf(p.birth)} – ${p.died ? yearOf(p.died) : ""}${roles ? ` · <b class="${sex}">${esc(roles)}</b>` : ""}${p.wins ? ` · ${fNum(p.wins)} win${p.wins === 1 ? "" : "s"}` : ""}</span></div>`;
  };
  let body = "";
  for (let g = up; g >= 1; g--) {
    const list = shown.filter((p) => p.gen === g && p.path !== "S" && p.path !== "C").sort((a, b) => (a.path < b.path ? -1 : 1));
    if (list.length) body += `<div class="ls-grp">${genName(g)}</div>` + list.map(row).join("");
  }
  const mine = shown.filter((p) => p.path === "" || p.path === "S").sort((a, b) => (a.birth || 0) - (b.birth || 0));
  body += `<div class="ls-grp">${esc(me.name || "")}${withSib ? " and brothers &amp; sisters" : ""}</div>` + mine.map(row).join("");
  const kidsRows = shown.filter((p) => p.path === "C").sort((a, b) => (a.birth || 0) - (b.birth || 0));
  if (kidsRows.length) body += `<div class="ls-grp">Children</div>` + kidsRows.map(row).join("");
  const axis = ticks.map((y) => `<span style="left:${P(Date.UTC(y, 0, 1) / 1000).toFixed(2)}%">${y}</span>`).join("");
  const tools = `<div class="filters">${seg("up", { up: q.up || "all" }, [["1", "Parents"], ["2", "Grandparents"], ["3", "Great-grandparents"], ["all", "Everyone"]].filter(([v]) => v === "all" || +v <= Math.max(1, maxGen)), "all")}
    ${seg("with", q, [["", "Ancestors"], ["sibs", "+ Brothers &amp; sisters"], ["kids", "+ Children"], ["both", "+ Both"]], "")}</div>`;
  const anc = ls.people.filter((p) => p.gen >= 1);
  html += panel("Lifespans", tools + `<div class="ls-scroll"><div class="ls"><div></div><div class="ls-axis">${axis}</div>
      <div class="ls-body"><div class="ls-lines">${lines}</div>${body}</div></div></div>
      <div class="legend ls-legend"><span><i class="ls-key life"></i>Life</span><span><i class="ls-key car"></i>Racing career (point at it for the job)</span><span><i class="ls-key aw"></i>Season award</span>
      <span><i class="ls-key g1"></i>First Group 1</span><span><i class="ls-key win"></i>First win</span><span><i class="ls-key wed"></i>Married</span><span><i class="ls-key kid"></i>Child born</span><span><i class="ls-key now"></i>Game date</span></div>
      ${anc.length ? "" : `<p class="help">The save doesn't link ${esc(me.name)}'s parents. The game links parents and children born since your career began, so this fills in as generations pass.</p>`}`,
    "Each bar is a life; the darker part is their career · point at anything for details");
  // facts across the people shown
  const facts = [];
  const parentAges = shown.filter((p) => (p.children || []).length).map((p) => (p.children[0] - p.birth) / (365.2425 * 86400));
  if (parentAges.length) facts.push(["Average age at their first child", fNum(parentAges.reduce((a, b) => a + b, 0) / parentAges.length, 0)]);
  const fw = shown.filter((p) => p.first_win).map((p) => [p, (p.first_win - p.birth) / (365.2425 * 86400)]).sort((a, b) => a[1] - b[1])[0];
  if (fw) facts.push(["Youngest first win", `${esc(fw[0].name)}, ${Math.floor(fw[1])}`]);
  const car = shown.map((p) => { const s = (p.careers || []).filter((c) => isNum(c.start)); if (!s.length) return null;
    const a = Math.min(...s.map((c) => c.start)), b = Math.max(...s.map((c) => c.end || p.died || now)); return [p, (b - a) / (365.2425 * 86400)]; }).filter(Boolean).sort((a, b) => b[1] - a[1])[0];
  if (car) facts.push(["Longest career", `${esc(car[0].name)}, ${Math.round(car[1])} years`]);
  const meRow = ls.people.find((p) => p.id === id);
  const oldest = anc.filter((p) => meRow && (p.died || now) > meRow.birth).sort((a, b) => b.gen - a.gen || (a.birth || 0) - (b.birth || 0))[0];
  if (oldest && meRow) facts.push([`${esc(String(me.name).split(" ")[0])} and ${esc(relOf(oldest).toLowerCase())} ${esc(oldest.name)}`, `${Math.max(0, Math.floor(((oldest.died || now) - meRow.birth) / (365.2425 * 86400)))} years together`]);
  const roles = {};
  shown.forEach((p) => new Set((p.careers || []).map((c) => c.role).concat((p.owned || []).length ? ["Owner"] : [])).forEach((r) => (roles[r] = (roles[r] || 0) + 1)));
  const tw = shown.reduce((a, p) => a + (p.wins || 0), 0), tg = shown.reduce((a, p) => a + (p.g1 || 0), 0), ta = shown.reduce((a, p) => a + (p.award_list || p.awards || []).length, 0);
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("At a glance", facts.length ? `<div class="kv-list">${facts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>` : '<div class="empty">Not enough recorded yet.</div>')}
    ${panel("Careers in the family", (Object.keys(roles).length ? `<div class="fchips">${Object.entries(roles).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<span class="fchip">${n} ${esc(r.toLowerCase())}${n > 1 ? "s" : ""}</span>`).join("")}</div>` : '<div class="muted">No jobs recorded.</div>')
      + `<div class="kv-list" style="margin-top:12px"><div><span>Wins between them</span><b>${fNum(tw)}</b></div><div><span>Group 1 wins</span><b>${fNum(tg)}</b></div><div><span>Season awards won</span><b>${fNum(ta)}</b></div></div>`, "Everyone on the chart above")}</div>`;
  return html;
}

// ------------------------------------------------------------------ Dynasty tab: Overview · Tree · Chronicle
async function personDynastyPage(route) {
  const id = +route.parts[1], q = route.q || {};
  const [d, y] = await Promise.all([api("person/" + id), dynastyData(id)]);
  let html = personHead(d, "dynasty");
  const M = y.members || [], byId = {};
  M.forEach((r) => (byId[r.id] = r));
  const view = ["tree", "chronicle"].includes(q.view) ? q.view : "overview";
  const name = esc(y.surname || "This");
  const switcher = `<div class="dy-views">${viewSeg("view", { view }, [["overview", "Overview"], ["tree", "Family tree"], ["chronicle", "Chronicle"]], "overview")}</div>`;
  const ctx = { id, q, y, M, byId, name };
  return html + switcher + (view === "tree" ? dynastyTree(ctx) : view === "chronicle" ? dynastyChronicle(ctx) : dynastyOverview(ctx));
}
function dynastyOverview({ id, q, y, M, byId, name }) {
  const members = M.filter((r) => r.kind === "member"), wed = M.filter((r) => r.kind === "married"), divd = M.filter((r) => r.kind === "divorced");
  const sum = (list, k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const head = byId[y.head];
  const hof = members.flatMap((r) => (r.award_list || []).filter((a) => a.cat === "hall_of_fame").map((a) => a.year)).sort()[0];
  const founded = Math.min(...M.map((r) => r.birth).filter(isNum));
  let html = `<div class="dy-hero"><div class="dy-crest" aria-hidden="true">${esc(famInitials(y.surname))}</div>
    <div class="dy-hero-t"><div class="dy-kick">${y.generations} generation${y.generations === 1 ? "" : "s"}${isNum(founded) ? ` · since ${yearOf(founded)}` : ""}</div>
      <h2>The ${name} dynasty</h2>
      <div class="dy-sub">${y.founders.length ? `Founded by ${y.founders.map((x) => (byId[x] ? L.person(x, byId[x].name) : "")).join(" &amp; ")} · ` : ""}${fNum(y.total)} ${name}${y.total === 1 ? "" : "s"}, ${fNum(y.living)} alive${wed.length ? ` · ${fNum(wed.length)} married in` : ""}
        ${y.unlinked_same_name ? ` · <a href="#/people?q=${encodeURIComponent(y.surname)}">${fNum(y.unlinked_same_name)} other ${name}${y.unlinked_same_name === 1 ? "" : "s"}</a> aren't linked to this family in the save` : ""}</div>
      <div class="dy-badges">${head ? `<span class="dy-badge gold">${famIc("crown")} Head of the family: ${L.person(head.id, head.name)}</span>` : ""}
        ${(y.family_stables || []).filter((s) => !s.gone).length ? `<span class="dy-badge">${famIc("barn")} ${fNum((y.family_stables || []).filter((s) => !s.gone).length)} family stable${(y.family_stables || []).filter((s) => !s.gone).length === 1 ? "" : "s"}</span>` : ""}
        ${hof ? `<span class="dy-badge">${famIc("trophy")} Hall of Fame ${hof}</span>` : ""}</div></div></div>`;
  const inJ = sum(wed.concat(divd), "j_wins");
  html += tiles([
    ["Jockey wins", fNum(sum(members, "j_wins")), inJ ? `+ ${fNum(inJ)} by those who married in` : ""],
    ["Trainer wins", fNum(sum(members, "t_wins"))],
    ["Manager wins", fNum(sum(members, "m_wins")), "shared with co-managers"],
    ["Group 1 wins", fNum(sum(members, "g1"))],
    ["Season awards", fNum(sum(members, "awards"))],
    ["Prize money", fMoneyShort(sum(members, "prize"))],
    ["Stables owned", fNum((y.family_stables || []).filter((s) => !s.gone).length), (y.family_stables || []).some((s) => s.gone) ? `+ ${fNum((y.family_stables || []).filter((s) => s.gone).length)} closed` : ""],
  ]);
  // the most decorated members, and the family's stables
  const score = (r) => (r.awards || 0) * 1000 + (r.g1 || 0) * 50 + (r.wins || 0);
  const pride = members.filter((r) => score(r) > 0).sort((a, b) => score(b) - score(a)).slice(0, 4);
  const pc = (r, sub) => `<div class="fpc">${famAv(r)}<div class="fpc-t"><div class="fpc-n">${L.person(r.id, r.name)}${r.id === id ? ' <span class="badge">This person</span>' : ""}</div><div class="fpc-s">${sub}</div><div class="fchips">${famChips(r, 5)}</div></div></div>`;
  const prideHtml = pride.length ? pride.map((r) => pc(r, `Generation ${r.gen || "?"}${famRole(r) ? " · " + esc(famRole(r)) : ""}${r.died ? ` · died ${yearOf(r.died)}` : ""}`)).join("") : `<div class="empty">No wins or awards in the family yet.</div>`;
  const fs = (y.family_stables || []).slice().sort((a, b) => (a.gone ? 1 : 0) - (b.gone ? 1 : 0) || (b.wins || 0) - (a.wins || 0));
  const famIds = new Set(fs.map((s) => s.id));
  const elsewhere = {};
  M.filter((r) => r.stable_id && !r.died && !famIds.has(r.stable_id)).forEach((r) => (elsewhere[r.stable_id] = elsewhere[r.stable_id] || { name: r.stable, who: [] }).who.push(r));
  const stHtml = (fs.length ? fs.map((s) => `<div class="fpc${s.gone ? " gone" : ""}"><span class="fpc-ic">${famIc("barn")}</span><div class="fpc-t"><div class="fpc-n">${L.stable(s.id, s.name)}${s.gone ? ' <span class="badge dead">Closed</span>' : ""}</div>
      <div class="fpc-s">${s.founded ? `Founded ${yearOf(s.founded)}` : "Founded —"}${byId[s.owner] ? ` · owner ${L.person(s.owner, byId[s.owner].name)}` : ""}${(s.family_staff || []).length ? ` · ${(s.family_staff || []).length} of the family work${(s.family_staff || []).length === 1 ? "s" : ""} here` : ""}</div>
      <div class="fchips"><span class="fchip">${fNum(s.wins)} wins</span>${s.g1 ? `<span class="fchip gold">${fNum(s.g1)} × G1</span>` : ""}<span class="fchip">${fNum(s.horses)} horses</span></div></div></div>`).join("") : '<div class="empty">Nobody in the family owns a stable.</div>')
    + Object.entries(elsewhere).sort((a, b) => b[1].who.length - a[1].who.length).slice(0, 4).map(([sid, e]) => `<div class="fpc other"><span class="fpc-ic">${famIc("barn")}</span><div class="fpc-t"><div class="fpc-n">${L.stable(+sid, e.name)}</div>
      <div class="fpc-s">Not family-owned · ${e.who.map((r) => `${L.person(r.id, r.name)}${r.job ? ` (${esc(r.job.toLowerCase())})` : ""}`).join(", ")}</div></div></div>`).join("");
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Pride of the family", `<div class="fpc-list">${prideHtml}</div>`, "Most decorated members")}${panel("Family stables", `<div class="fpc-list">${stHtml}</div>`)}</div>`;
  // generations
  const gens = [...new Set(M.map((r) => r.gen).filter(Boolean))].sort((a, b) => a - b);
  const pp = (r) => `<a class="dy-pp${r.kind !== "member" ? " in" : ""}${r.died ? " gone" : ""}${r.id === id ? " me" : ""}" href="#/person/${r.id}/dynasty">${famAv(r, "xs")}${esc(r.kind === "member" && (r.surname || "").toLowerCase() === (y.surname || "").toLowerCase() ? String(r.name).replace(/^(?:†\s*|\([A-Z]{1,3}\)\s*)+/, "").split(" ")[0] : r.name)}${r.kind === "divorced" ? " · div." : ""}</a>`;
  html += `<div style="margin-top:16px">${panel("Generations", gens.map((g) => { const list = M.filter((r) => r.gen === g).sort((a, b) => (a.kind === "member" ? 0 : 1) - (b.kind === "member" ? 0 : 1) || (a.birth || 0) - (b.birth || 0));
    const mm = list.filter((r) => r.kind === "member").length;
    return `<div class="dy-gen"><div><b>Generation ${g}</b><div class="small muted">${g === 1 ? "Founders" : `${fNum(mm)} ${name}${mm === 1 ? "" : "s"}`}</div></div><div class="dy-pps">${list.map(pp).join("")}</div></div>`; }).join(""), "Dashed = married into the family · click a name for their dynasty view")}</div>`;
  // everyone in a table
  const kind = q.who || "member";
  const dst = q.status || (q.alive === "1" ? "alive" : "all");
  const list = M.filter((r) => kind === "all" || r.kind === kind).filter((r) => dst === "all" || (dst === "alive" ? !r.died : !!r.died));
  html += `<div style="margin-top:16px">${panel("Members", `<div class="filters">${viewSeg("who", q, [["member", `${name}s (${members.length})`], ["married", `Married in (${wed.length})`]].concat(divd.length ? [["divorced", `Divorced (${divd.length})`]] : []).concat([["all", "Everyone"]]), "member")}
      ${statusSeg("person", { status: q.status || (q.alive === "1" ? "alive" : "") }, "all")}</div>` + table([
    { h: "Gen", cls: "num", f: (r) => (r.gen ? r.gen : "—") },
    { h: "Name", cls: "nowrap", f: (r) => `${pLink(r)} ${treeLink(r.id)}${r.kind === "divorced" ? ' <span class="badge">Divorced</span>' : r.kind === "married" ? ' <span class="badge">Married in</span>' : ""}${r.id === y.head ? ` <span class="badge gold-b">${famIc("crown")} Head</span>` : ""}` },
    { h: "Born", cls: "num", f: (r) => yr(r.birth) }, { h: "Age", cls: "num nowrap", f: (r) => ageCell(r.birth, r.died) },
    { h: "Job now", f: (r) => (r.job ? esc(r.job) : '<span class="muted">—</span>') },
    { h: "Stable", f: (r) => (r.stable_id ? L.stable(r.stable_id, r.stable) : '<span class="muted">—</span>') },
    { h: "Owns", f: (r) => (r.stables || []).map((s) => L.stable(s.id, s.name)).join(", ") || '<span class="muted">—</span>' },
    { h: "Jockey wins", cls: "num", f: (r) => fNum(r.j_wins) }, { h: "Trainer wins", cls: "num", f: (r) => fNum(r.t_wins) },
    { h: '<span data-tip="Every race their stable won while they were a manager there, shared with any co-manager">Manager wins</span>', cls: "num", f: (r) => fNum(r.m_wins) },
    { h: "G1", cls: "num", f: (r) => fNum(r.g1) }, { h: "Awards", cls: "num", f: (r) => (r.awards ? `<span data-tip="${esc(famAwards(r.award_list).join(" · "))}">${fNum(r.awards)}</span>` : "0") },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) },
    { h: "Married to", f: (r) => (r.spouses || []).map((x) => `${L.person(x.id, x.name)}${x.divorced ? ` <span class="muted small">(divorced ${yr(x.divorced)})</span>` : ""}`).join(", ") || '<span class="muted">—</span>' },
  ], list, { empty: "Nobody here." }))}</div>`;
  return html;
}
// the drawn tree: from the founders down, partners beside each member, children below; highlight by job or awards
function dynastyTree({ id, q, y, M, byId, name }) {
  const hl = q.hl || "", showWed = q.wed !== "0", layout = q.layout === "outline" ? "outline" : "drawn";
  const isHi = (r) => (hl === "jockey" ? /jockey/i.test(famRole(r)) || r.j_wins > 0 : hl === "trainer" ? /trainer/i.test(famRole(r)) || r.t_wins > 0
    : hl === "award" ? (r.awards || 0) > 0 || (r.g1 || 0) > 0 : hl === "working" ? !!r.job : false);
  const short = (r) => (r.kind === "member" && (r.surname || "").toLowerCase() === (y.surname || "").toLowerCase() ? String(r.name).replace(/^(?:†\s*|\([A-Z]{1,3}\)\s*)+/, "").split(" ")[0] : r.name);
  const card = (r, extra = "") => {
    const cls = [r.kind !== "member" ? "in" : "", r.died ? "gone" : "", r.id === id ? "me" : "", hl ? (isHi(r) ? "hi" : "dim") : "", extra].join(" ");
    const sub = r.died ? `${yr(r.birth)}–${yr(r.died)}` : `${yr(r.birth)}${famRole(r) ? " · " + esc(famRole(r)) : ""}`;
    const chips = [r.wins ? `<span class="fchip" data-tip="${esc(famWinsTip(r))}">${fNum(r.wins)} wins</span>` : "", r.g1 ? `<span class="fchip gold">${fNum(r.g1)} G1</span>` : "", r.awards ? `<span class="fchip gold" data-tip="${esc(famAwards(r.award_list).join(" · "))}">${famIc("trophy")} ${fNum(r.awards)}</span>` : ""].join("");
    return `<div class="dt-card ${cls}">${famAv(r, "sm")}<a class="dt-n" href="#/person/${r.id}/dynasty?view=tree" title="${esc(r.name)}: open their dynasty view">${esc(short(r))}</a><div class="dt-y">${sub}</div>${chips ? `<div class="dt-chips">${chips}</div>` : ""}${r.id === y.head ? `<span class="dt-head" data-tip="Head of the family">${famIc("crown")}</span>` : ""}</div>`;
  };
  const seen = new Set();
  const node = (x) => {
    const r = byId[x];
    if (!r || seen.has(x)) return "";
    seen.add(x);
    const sps = showWed ? (r.spouses || []).map((s) => byId[s.id] ? { ...byId[s.id], _div: s.divorced, _end: s.ended } : null).filter(Boolean).filter((s) => !seen.has(s.id) || s.kind !== "member") : [];
    sps.forEach((s) => { if (s.kind !== "member") seen.add(s.id); });
    const couple = card(r) + sps.map((s) => `<span class="dt-lk${s._div ? " div" : ""}" ${s._div ? `data-tip="Divorced ${yr(s._div)}"` : ""}>${famIc("heart")}</span>${card(s)}`).join("");
    const kids = (r.children || []).concat(sps.flatMap((s) => s.children || [])).filter((k, i, a) => a.indexOf(k) === i).map((k) => byId[k])
      .filter((k) => k && k.kind === "member" && !seen.has(k.id)).sort((a, b) => (a.birth || 0) - (b.birth || 0));
    const kidHtml = kids.map((k) => node(k.id)).filter(Boolean);
    return `<li><div class="dt-cp">${couple}</div>${kidHtml.length ? `<ul>${kidHtml.map((h) => h).join("")}</ul>` : ""}</li>`;
  };
  let treeHtml;
  if (layout === "drawn") {
    const roots = y.founders.filter((x) => byId[x]);
    const parts = roots.map((x) => node(x)).filter(Boolean);
    treeHtml = `<div class="dt-wrap" id="dt-wrap"><div class="dt-size" id="dt-size"><div class="dt-inner" id="dt-inner">${parts.map((p) => `<div class="dt"><ul>${p}</ul></div>`).join("")}</div></div></div>`;
  } else {
    const line = (r) => `${pLink(r)} <span class="muted small">${yrs(r)}${r.job ? " · " + esc(r.job) : ""}</span>${(r.spouses || []).length ? ` <span class="dyn-sp">♥ ${r.spouses.map((x) => x.divorced ? `<span class="dyn-div">${L.person(x.id, x.name)} <span class="small">(divorced ${yr(x.divorced)})</span></span>` : L.person(x.id, x.name)).join(", ")}</span>` : ""}`;
    const s2 = new Set();
    const branch = (x, depth) => {
      const r = byId[x];
      if (!r || s2.has(x)) return "";
      s2.add(x);
      const kids = (r.children || []).map((k) => byId[k]).filter((k) => k && k.kind === "member").sort((a, b) => (a.birth || 0) - (b.birth || 0));
      return kids.length ? `<li><details ${depth < 3 ? "open" : ""}><summary><span class="dyn-g">G${r.gen || "?"}</span>${line(r)}</summary><ul>${kids.map((k) => branch(k.id, depth + 1)).join("")}</ul></details></li>`
        : `<li class="leaf"><span class="dyn-g">G${r.gen || "?"}</span>${line(r)}</li>`;
    };
    treeHtml = `<div class="fam-tools"><button class="btn sm" data-fam-all="1">Open all</button> <button class="btn sm" data-fam-all="0">Close all</button></div>
      <ul class="dyn-tree fam-outline">${y.founders.map((x) => branch(x, 0)).join("")}</ul>`;
  }
  const tools = `<div class="filters">${viewSeg("layout", q, [["", "Drawn"], ["outline", "Outline"]], "")}
    <span class="small muted">Highlight</span>${seg("hl", q, [["", "Nobody"], ["jockey", "Jockeys"], ["trainer", "Trainers"], ["award", "Award &amp; G1 winners"], ["working", "Working now"]], "")}
    ${layout === "drawn" ? seg("wed", q, [["", "Married in"], ["0", "Hide them"]], "") : ""}
    ${layout === "drawn" ? `<span class="grow"></span><button class="btn sm" data-dt-zoom="-1" aria-label="Zoom out">−</button><button class="btn sm" data-dt-zoom="0">Fit</button><button class="btn sm" data-dt-zoom="1" aria-label="Zoom in">+</button>` : ""}</div>`;
  let html = panel(`The ${name} family tree`, tools + treeHtml + (layout === "drawn" ? `<div class="legend"><span><i class="dt-key hi"></i>Highlighted</span><span><i class="dt-key in"></i>Married in</span>
      <span>${famIc("heart")} married · on a dashed line, divorced</span><span><i class="dt-key gone"></i>Died</span><span>${famIc("crown")} head of the family</span><span>Click a name to see the tree from them · drag to move around</span></div>` : ""),
    "Founders at the top, each generation below");
  // branches: each of the founders' children and everyone descended from them
  const fam0 = y.founders.map((x) => byId[x]).filter(Boolean);
  const kids0 = [...new Set(fam0.flatMap((r) => r.children || []))].map((k) => byId[k]).filter((k) => k && k.kind === "member").sort((a, b) => (a.birth || 0) - (b.birth || 0));
  const below = (x, acc = new Set()) => { (byId[x] && byId[x].children || []).forEach((k) => { if (byId[k] && byId[k].kind === "member" && !acc.has(k)) { acc.add(k); below(k, acc); } }); return acc; };
  if (kids0.length) {
    const br = kids0.map((k) => {
      const ds = [...below(k.id)].map((x) => byId[x]), all = [k].concat(ds);
      const w = all.reduce((a, r) => a + (r.wins || 0), 0), g = all.reduce((a, r) => a + (r.g1 || 0), 0), aw = all.reduce((a, r) => a + (r.awards || 0), 0);
      const alive = all.filter((r) => !r.died).length;
      return `<div class="fpc${k.died ? " gone" : ""}"><div class="fpc-t"><div class="fpc-n">${L.person(k.id, String(k.name).replace(/^(?:†\s*|\([A-Z]{1,3}\)\s*)+/, "").split(" ")[0] + "'s line")} <span class="fchip">${ds.length ? `${fNum(ds.length)} descendant${ds.length === 1 ? "" : "s"}` : "No children"}</span></div>
        <div class="fpc-s">${[famRole(k) ? esc(famRole(k)) : "", k.died ? `died ${yearOf(k.died)}` : "", `${fNum(alive)} of ${fNum(all.length)} alive`].filter(Boolean).join(" · ")}</div>
        <div class="fchips">${w ? `<span class="fchip">${fNum(w)} wins</span>` : ""}${g ? `<span class="fchip gold">${fNum(g)} × G1</span>` : ""}${aw ? `<span class="fchip gold">${famIc("trophy")} ${fNum(aw)}</span>` : ""}</div></div></div>`;
    }).join("");
    html += `<div style="margin-top:16px">${panel("Branches", `<div class="fpc-grid">${br}</div>`, "Each of the founders' children and everyone descended from them")}</div>`;
  }
  return html;
}
// the family's story: births, marriages, deaths, stables, first wins, Group 1s and awards, decade by decade
function dynastyChronicle({ id, q, y, M, byId, name }) {
  const show = q.show || "", order = q.order || "";
  const fam = ["born", "died", "married", "divorced"], race = ["first_win", "first_g1", "award", "stable"];
  const ev = (y.events || []).filter((e) => !show || (show === "family" ? fam : race).includes(e.kind))
    .filter((e) => e.kind !== "stable" || !byId[e.who] || !byId[e.who].birth || e.date >= byId[e.who].birth);
  if (order === "old") ev.reverse();
  const P = (x) => (byId[x] ? L.person(x, byId[x].name) : "someone");
  const K = { born: ["cake", "born"], died: ["cross", "died"], married: ["rings", "wed"], divorced: ["rings", "div"], first_win: ["flag", "win"], first_g1: ["star", "g1"], award: ["trophy", "aw"], stable: ["barn", "st"] };
  const text = (e) => {
    const r = byId[e.who] || {};
    switch (e.kind) {
      case "born": return `${P(e.who)} is born`;
      case "died": return `${P(e.who)} dies${isNum(r.birth) ? `, aged ${famAge(r.birth, e.date)}` : ""}`;
      case "married": return `${P(e.who)} marries ${P(e.with)}`;
      case "divorced": return `${P(e.who)} and ${P(e.with)} divorce`;
      case "first_win": return `${P(e.who)}'s first winner${isNum(r.birth) ? `, aged ${famAge(r.birth, e.date)}` : ""}`;
      case "first_g1": return `${P(e.who)}'s first Group 1: ${e.race && e.race.horse_id ? L.horse(e.race.horse_id, e.race.horse) : "a win"}${e.race && e.race.race ? ` in the ${e.race.race_id ? L.race(e.race.race_id, e.race.race) : esc(e.race.race)}` : ""}`;
      case "award": return `${P(e.who)}: <b>${esc(e.label)}</b>`;
      case "stable": return `${P(e.who)} founds ${L.stable(e.stable_id, e.stable)}`;
    }
    return "";
  };
  let tl = "", dec = null;
  for (const e of ev) {
    const yy = yearOf(e.date), dd = Math.floor(yy / 10) * 10;
    if (dd !== dec) { dec = dd; tl += `<div class="cr-dec">${dd}s</div>`; }
    const [ic, cls] = K[e.kind] || ["star", ""];
    tl += `<div class="cr-ev"><div class="cr-yr" data-tip="${esc(fDate(e.date))}">${yy}</div><div class="cr-dot ${cls}">${famIc(ic)}</div><div class="cr-tx">${text(e)}</div></div>`;
  }
  const tools = `<div class="filters">${viewSeg("show", q, [["", "Everything"], ["family", "Family"], ["racing", "Racing"]], "")}${seg("order", q, [["", "Newest first"], ["old", "Oldest first"]], "")}</div>
    <div class="legend cr-legend"><span>${famIc("cake")} Born</span><span>${famIc("rings")} Married</span><span>${famIc("cross")} Died</span><span>${famIc("flag")} First win</span><span>${famIc("star")} First Group 1</span><span>${famIc("trophy")} Award</span><span>${famIc("barn")} Stable</span></div>`;
  // the side column: living members per year, wins per decade, milestones
  const now = y.game_date || (STATUS && STATUS.meta && STATUS.meta.game_date) || Date.now() / 1000;
  const mem = M.filter((r) => r.kind === "member" && isNum(r.birth));
  const ya = mem.length ? yearOf(Math.min(...mem.map((r) => r.birth))) : null, yb = yearOf(now);
  const pts = [];
  if (ya !== null) for (let yy = ya; yy <= yb; yy++) {
    const t0 = Date.UTC(yy, 0, 1) / 1000, t1 = Date.UTC(yy, 11, 31) / 1000;
    pts.push([Date.UTC(yy, 6, 2) / 1000, mem.filter((r) => r.birth <= t1 && (!r.died || r.died >= t0)).length]);
  }
  const chart = pts.length >= 2 ? lineChart([{ name: `Living ${name}s`, color: "#3e6e9e", points: pts }], { years: true, yInt: true, ranges: false, smooth: false, width: 420, height: 230, yFmt: (v) => fNum(v) }) : '<div class="empty">Not enough history yet.</div>';
  const dec2 = {};
  Object.entries(y.wins_by_year || {}).forEach(([yy, n]) => { const k = Math.floor(+yy / 10) * 10; dec2[k] = (dec2[k] || 0) + n; });
  const dmax = Math.max(1, ...Object.values(dec2));
  const wd = Object.keys(dec2).length ? `<div class="cr-bars">${Object.entries(dec2).sort((a, b) => a[0] - b[0]).map(([k, n]) => `<div class="cr-bar"><span>${k}s</span><div class="t"><i style="width:${((100 * n) / dmax).toFixed(1)}%"></i></div><b>${fNum(n)}</b></div>`).join("")}</div>` : '<div class="empty">No wins yet.</div>';
  const firstOf = (list, f) => list.filter(f).sort((a, b) => a.date - b.date)[0];
  const allEv = y.events || [];
  const g1 = firstOf(allEv, (e) => e.kind === "first_g1"), aw = firstOf(allEv, (e) => e.kind === "award");
  const best = Object.entries(y.wins_by_year || {}).sort((a, b) => b[1] - a[1])[0];
  const maxG = Math.max(0, ...mem.map((r) => r.gen || 0));
  const nextGen = mem.filter((r) => r.gen === maxG && r.first_win).sort((a, b) => a.first_win - b.first_win)[0];
  const ms = [g1 && ["First Group 1", `${yearOf(g1.date)} · ${P(g1.who)}`], aw && ["First season award", `${yearOf(aw.date)} · ${P(aw.who)}`],
    best && ["Best year", `${best[0]} · ${fNum(best[1])} wins`], nextGen && maxG > 1 && [`First winner in G${maxG}`, `${yearOf(nextGen.first_win)} · ${P(nextGen.id)}`]].filter(Boolean);
  return `<div class="cr-layout"><div class="cr-main">${panel("Family chronicle", tools + (tl ? `<div class="cr-rail">${tl}</div>` : '<div class="empty">Nothing to show.</div>'),
      "Births, marriages, deaths, stables and the big wins")}</div>
    <div class="cr-side">${panel(`Living ${name}s`, chart, "Each year")}${panel("Wins by decade", wd, "Jockey and trainer, every family member")}
      ${panel("Milestones", ms.length ? `<div class="kv-list">${ms.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>` : '<div class="empty">None yet.</div>')}</div></div>`;
}
// zoom and drag for the drawn dynasty tree
function dtInit() {
  const wrap = $("#dt-wrap"), inner = $("#dt-inner"), size = $("#dt-size");
  if (!wrap || !inner) return;
  let z = 1;
  try { z = +sessionStorage.getItem("hrm.dtZoom") || 1; } catch (e) { /* default */ }
  const setZ = (v) => {
    z = Math.max(0.3, Math.min(1.6, v));
    inner.style.transform = `scale(${z})`;
    size.style.width = inner.offsetWidth * z + "px"; size.style.height = inner.offsetHeight * z + "px";
    try { sessionStorage.setItem("hrm.dtZoom", z); } catch (e) { /* this view */ }
  };
  setZ(z);
  const me = $(".dt-card.me", inner);
  if (me) wrap.scrollLeft = Math.max(0, (me.offsetLeft + me.offsetWidth / 2) * z - wrap.clientWidth / 2);
  wrap.closest(".panel").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dt-zoom]");
    if (!b) return;
    const v = +b.dataset.dtZoom;
    setZ(v === 0 ? Math.min(1, (wrap.clientWidth - 8) / inner.offsetWidth) : z * (v > 0 ? 1.2 : 1 / 1.2));
  });
  let drag = null;
  wrap.addEventListener("pointerdown", (e) => { if (e.target.closest("a, button")) return; drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop }; wrap.classList.add("dragging"); });
  window.addEventListener("pointermove", (e) => { if (!drag) return; wrap.scrollLeft = drag.l - (e.clientX - drag.x); wrap.scrollTop = drag.t - (e.clientY - drag.y); });
  window.addEventListener("pointerup", () => { drag = null; wrap.classList.remove("dragging"); });
}

// ------------------------------------------------------------------ horse / person awards tab
// Every season award and Group/Listed race win of a horse, or of a person (their own awards, and the race wins they rode,
// trained, managed or looked after).
async function entityAwardsPage(kind, route) {
  const id = route.parts[1], q = route.q || {};
  const [d, aw] = await Promise.all([api(kind + "/" + id), api(`awards_of/${kind}/${id}`)]);
  let html = kind === "horse" ? horseHead(d, "awards") : personHead(d, "awards");
  const all = aw.awards || [];
  const name = kind === "horse" ? d.horse.horse_name : d.person.person_full_name;
  if (!all.length) return html + `<div class="empty">${esc(name)} hasn't won or placed in any awards yet. <a href="#/awards">See all awards</a></div>`;
  const GR = { g1_race: "G1", g2_race: "G2", g3_race: "G3", listed_race: "listed" };
  const result = (a) => (a.kind === "race" ? "won" : a.cat === "hall_of_fame_nominee" ? "nominee" : a.cat === "worst_overall" ? "worst" : (a.rank || 1) === 1 ? "won" : "placed");
  // a person's own awards, the horse and concept awards of horses they worked with, and Group/Listed race wins
  const grp = (a) => (a.kind === "race" ? "race" : a.horse_award ? "horse" : "season");
  const season = all.filter((a) => grp(a) === "season"), horseAw = all.filter((a) => grp(a) === "horse"), races = all.filter((a) => a.kind === "race");
  const grades = Object.keys(GR).map((c) => [c, races.filter((a) => a.cat === c).length]).filter(([, n]) => n)
    .map(([c, n]) => `${n}× ${GR[c] === "listed" ? "Listed" : GR[c]}`).join(" · ");
  const hasRole = (a, r) => (a.role || "").split(" & ").includes(r);
  const roles = ["Owner", "Manager", "Head trainer", "Trainer", "Jockey", "Caretaker"].filter((r) => all.some((a) => hasRole(a, r)));
  const wonN = (l) => l.filter((a) => result(a) === "won").length;
  const tl = kind === "person" ? [
    ["Own awards", fNum(season.length), season.length ? `${fNum(wonN(season))} won · given to ${esc(name.split(" ")[0])}` : "None yet"],
    ["Horse, stable & concept awards", fNum(horseAw.length), horseAw.length ? `${fNum(wonN(horseAw))} won · horses and stables they worked with` : "None yet"],
    ["Group & Listed wins", fNum(races.length), grades || "None yet"],
  ] : [
    ["Season awards", fNum(season.length), season.length ? `${fNum(wonN(season))} won` : "None yet"],
    ["Group & Listed wins", fNum(races.length), grades || "None yet"],
  ];
  if (kind === "person") roles.forEach((r) => { const l = all.filter((a) => a.kind !== "season" || a.horse_award).filter((a) => hasRole(a, r)); const st = l.filter((a) => a.stable_award).length, ho = l.filter((a) => a.horse_award && !a.stable_award).length, rw = l.filter((a) => a.kind === "race").length;
    tl.push([`As ${r.toLowerCase()}`, fNum(l.length), [ho ? `${fNum(ho)} horse award${ho === 1 ? "" : "s"}` : "", st ? `${fNum(st)} stable award${st === 1 ? "" : "s"}` : "", rw ? `${fNum(rw)} race win${rw === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")]); });
  html += tiles(tl);
  const years = [...new Set(all.map((a) => a.year).filter(Boolean))].sort((a, b) => b - a);
  const type = q.type || "all", res = q.result || "all", yr = q.year || "", term = (q.q || "").toLowerCase();
  const typeOpts = kind === "person"
    ? [["all", `Everything (${all.length})`], ["season", `Own awards (${season.length})`], ["horse", `Horse & stable awards (${horseAw.length})`], ["race", `Race wins (${races.length})`]]
      .concat(roles.length > 1 ? roles.map((r) => [r, `As ${r.toLowerCase()} (${all.filter((a) => hasRole(a, r)).length})`]) : [])
    : [["all", `Everything (${all.length})`], ["season", `Season awards (${season.length})`], ["race", `Race wins (${races.length})`]];
  const rows = all.filter((a) => (type === "all" || grp(a) === type || hasRole(a, type)) && (res === "all" || result(a) === "won") && (!yr || String(a.year) === String(yr))
    && (!term || `${a.label || ""} ${a.description || ""} ${a.horse || ""} ${a.stable || ""} ${a.jockey || ""}`.toLowerCase().includes(term)));
  const badge = (a) => ({ won: `<span class="badge good">${a.kind === "race" ? "Won" : a.cat === "hall_of_fame" ? "Inducted" : "Winner"}</span>`,
    placed: `<span class="badge">Runner-up · ${ord(a.rank)}</span>`, nominee: `<span class="badge">Nominated</span>`, worst: `<span class="badge dead">Worst of the year</span>` }[result(a)]);
  const cols = [
    { h: "Year", cls: "nowrap", f: (a) => (a.year ? `<b>${a.year}</b>` : "—") },
    { h: "Award", f: (a) => (a.kind === "race" ? `${grade(GR[a.cat])} <span class="small muted">race win</span>` : esc(a.label)) },
    { h: "Result", cls: "nowrap", f: badge },
    { h: "Details", f: (a) => (a.kind === "race" && a.race_id ? L.race(a.race_id, a.description, "Race") : a.description ? esc(a.description) : '<span class="muted">—</span>') },
  ];
  if (kind === "person") cols.splice(2, 0, { h: "Role", f: (a) => (a.role ? esc(a.role) : '<span class="muted">Own award</span>') }, { h: "Horse", f: (a) => (a.stable_award ? `<span class="muted small">Stable:</span> ${L.stable(a.stable_id, a.stable)}` : (a.kind === "race" || a.horse_award) && a.horse_id ? L.horse(a.horse_id, a.horse) : '<span class="muted">—</span>') });
  else cols.splice(2, 0, { h: "Jockey", f: (a) => (a.jockey_id ? L.person(a.jockey_id, a.jockey) : '<span class="muted">—</span>') });
  cols.push({ h: "Stable", f: (a) => (a.stable_id ? L.stable(a.stable_id, a.stable) : '<span class="muted">—</span>') });
  html += `<section class="panel"><div class="filters">
    ${viewSeg("type", q, typeOpts, "all")}${searchBox(q, kind === "person" ? "Search awards, horses or stables" : "Search awards, jockeys or stables")}
    ${seg("result", q, [["won", "Wins only"], ["all", "Wins and places"]], "all")}
    ${select("year", q, yearOptions(years), "Only this year's awards")}</div>
    ${table(cols, rows, { rowClass: (a) => (result(a) === "won" ? "win" : ""), empty: "No awards match these filters." })}
    <div class="help">The stable is the one ${kind === "horse" ? "the horse raced for" : "they worked for"} at the time.${kind === "person" ? " Horse awards and race wins are those of horses they rode, trained, managed or looked after; stable awards (Stable of the Year, the Thravang Award, Breeder of the Year) go to the stable's managers and its owner. A manager shares in every one won while they managed the stable (the game names only one manager on each)." : ""} <a href="#/awards">All season awards</a></div></section>`;
  return html;
}

// ------------------------------------------------------------------ stable awards tab
// Every award tied to the stable: awards to the stable itself, awards won by its horses while they were in this stable
// (season awards and Group/Listed race wins) and awards won by its employees while they worked here.
async function stableAwardsPage(route) {
  const id = route.parts[1], q = route.q || {};
  const [d, aw] = await Promise.all([api("stable/" + id), api("stable_awards/" + id)]);
  let html = stableHead(d, "awards");
  const all = aw.awards || [];
  if (!all.length) {
    return html + `<div class="empty">${esc(d.stable.stable_name)}, its horses and its employees haven't won or placed in any awards yet.
      <div class="help" style="margin-top:6px">Stable, horse, race-win and employee awards appear here once they have been given out. <a href="#/awards">See all awards</a></div></div>`;
  }
  // what the filter calls each row: the stable itself, a horse's season award, a horse's Group/Listed race win, or an employee
  const group = (a) => (a.etype === "stable" ? "stable" : a.etype === "person" ? "staff" : a.kind === "race" ? "race" : "horse");
  // a race win, a first place, or no place at all (a Hall of Fame induction) is a win; 2nd and 3rd are the runners-up the game lists
  // Worst Horse of the Year is an award nobody wants: shown as such, never counted as a win
  const result = (a) => (a.kind === "race" ? "won" : a.cat === "hall_of_fame_nominee" ? "nominee" : a.cat === "worst_overall" ? "worst" : (a.rank || 1) === 1 ? "won" : "placed");
  const count = (list) => list.length;
  const wins = (list) => list.filter((a) => result(a) === "won").length;
  const by = { stable: all.filter((a) => group(a) === "stable"), horse: all.filter((a) => group(a) === "horse"), race: all.filter((a) => group(a) === "race"), staff: all.filter((a) => group(a) === "staff") };
  const grades = ["g1_race", "g2_race", "g3_race", "listed_race"].map((c) => [c, by.race.filter((a) => a.cat === c).length]).filter(([, n]) => n)
    .map(([c, n]) => `${n}× ${{ g1_race: "G1", g2_race: "G2", g3_race: "G3", listed_race: "Listed" }[c]}`).join(" · ");
  html += tiles([
    ["Stable awards", fNum(count(by.stable)), count(by.stable) ? `${fNum(wins(by.stable))} won` : "None yet"],
    ["Horse awards", fNum(count(by.horse)), count(by.horse) ? `${fNum(wins(by.horse))} won · season awards` : "None yet"],
    ["Race wins", fNum(count(by.race)), grades || "No Group or Listed wins yet"],
    ["Employee awards", fNum(count(by.staff)), count(by.staff) ? `${fNum(wins(by.staff))} won` : "None yet"],
  ]);
  // filters: what kind, wins only or placings too, which year, and a text search
  const years = [...new Set(all.map((a) => a.year).filter(Boolean))].sort((a, b) => b - a);
  const type = q.type || "all", res = q.result || "all", yr = q.year || "", term = (q.q || "").toLowerCase();
  const rows = all.filter((a) => (type === "all" || group(a) === type) && (res === "all" || result(a) === "won") && (!yr || String(a.year) === String(yr))
    && (!term || `${a.who || d.stable.stable_name} ${a.label} ${a.description || ""}`.toLowerCase().includes(term)));
  const tabs = `<div class="filters">
    ${viewSeg("type", q, [["all", `Everything (${all.length})`], ["stable", `Stable (${by.stable.length})`], ["horse", `Horse awards (${by.horse.length})`], ["race", `Race wins (${by.race.length})`], ["staff", `Employees (${by.staff.length})`]], "all")}
    ${searchBox(q, "Search awards or names")}
    ${seg("result", q, [["won", "Wins only"], ["all", "Wins and places"]], "all")}
    ${select("year", q, yearOptions(years), "Only this year's awards")}</div>`;
  const who = (a) => (a.etype === "horse" ? `${L.horse(a.eid, a.who)} <span class="small muted">horse</span>` : a.etype === "person" ? `${L.person(a.eid, a.who)} <span class="small muted">employee</span>`
    : `${esc(d.stable.stable_name)} <span class="small muted">stable</span>`);
  const badge = (a) => ({ won: `<span class="badge good">${a.kind === "race" ? "Won" : a.cat === "hall_of_fame" ? "Inducted" : "Winner"}</span>`,
    placed: `<span class="badge">Runner-up · ${ord(a.rank)}</span>`, nominee: `<span class="badge">Nominated</span>`,
    worst: `<span class="badge dead">Worst of the year</span>` }[result(a)]);
  const gradeOf = { g1_race: "G1", g2_race: "G2", g3_race: "G3", listed_race: "listed" };
  html += `<section class="panel">${tabs}${table([
    { h: "Year", cls: "nowrap", f: (a) => (a.year ? `<b>${a.year}</b>` : "—") },
    { h: "Who", f: who },
    { h: "Award", f: (a) => (a.kind === "race" ? `${grade(gradeOf[a.cat])} <span class="small muted">race win</span>` : esc(a.label)) },
    { h: "Result", cls: "nowrap", f: badge },
    { h: "Details", f: (a) => (a.kind === "race" ? (a.race_id ? L.race(a.race_id, a.description, "Race") : esc(a.description || "—")) : a.description ? esc(a.description) : '<span class="muted">—</span>') },
  ], rows, { rowClass: (a) => (result(a) === "won" ? "win" : ""), empty: "No awards match these filters." })}
    <div class="help">Horses and employees are counted for the time they were at this stable: a horse that wins here and is later sold keeps the award with this stable. <a href="#/awards">All season awards</a></div></section>`;
  return html;
}

// ------------------------------------------------------------------ stable horse finances tab
const HM_STATUS = { current: ["In the stable", "good"], sold: ["Sold", ""], died: ["Died", "dead"], left: ["Left", ""] };
function hmBreakdown(book, total, color) {
  const rows = Object.entries(book).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="muted small">Nothing recorded.</div>';
  return `<table class="hm-mini">${rows.map(([k, v]) => { const pc = total ? (100 * v) / total : 0;
    return `<tr><td>${esc(k)}</td><td class="num">${finAmt(v)}</td><td class="hm-bar"><span class="sbar"><i style="width:${Math.max(0, Math.min(100, pc)).toFixed(1)}%;background:${color}"></i></span></td><td class="num muted">${fNum(pc, pc < 10 ? 1 : 0)}%</td></tr>`; }).join("")}</table>`;
}
async function stableHorseMoneyPage(route) {
  const id = route.parts[1], q = route.q || {}, grpOn = q.group === "1";
  const [d, hm] = await Promise.all([api("stable/" + id), api("stable_horse_money/" + id + (grpOn ? "?group=1" : ""))]);
  let html = stableHead(d, "horse-money") + groupSwitch(d, q, "Horse finances");
  const G = !!hm.group;
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
    const search = `${h.name} ${(HM_STATUS[h.status] || [""])[0]} ${h.now_stable || ""} ${(h.with || []).map((w) => w.name).join(" ")}`.toLowerCase();
    return `<tr class="hm-row" data-hm-status="${h.status === "current" ? "current" : "past"}" data-hm-search="${esc(search)}">
      <td><button class="fin-tg" data-hm="${i}" title="Show this horse's money in detail">▸</button> ${L.horse(h.id, h.name)}${G && h.with ? `<div class="muted small hm-with">${h.with.map((w) => esc(w.name)).join(" · ")}</div>` : ""}</td>
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
      <input type="search" class="hm-filter fd-filter" placeholder="Search horses" aria-label="Search horses">
      <div class="seg"><button data-hm-show="current">In the stable ${fNum(cur.length)}</button><button data-hm-show="past">Past ${fNum(hs.length - cur.length)}</button><button class="on" data-hm-show="all">All ${fNum(hs.length)}</button></div><span class="grow"></span>
      <span class="muted small">▸ for each horse's breakdown · click a heading to sort</span></div>
    <div class="fd-none empty" hidden>No horses match.</div>
    <div class="tbl-wrap"><table class="data hm-table"><thead><tr><th>Horse</th><th>Status</th><th>With the stable</th><th class="num">Starts</th><th class="num">Wins</th>
      <th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num" data-tip="Net as a share of what was spent on the horse">Return</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot><tr><td colspan="5">All horses shown</td><td class="num hm-t-inc">${finAmt(inc)}</td><td class="num hm-t-exp">${finAmt(exp)}</td><td class="num hm-t-net">${finAmt(inc - exp, inc - exp >= 0 ? "pos" : "neg")}</td><td></td></tr></tfoot></table></div>`,
    G ? "Only money while the horse was with the group's stables, added up (moves between them left out)" : "Only money while the horse was with this stable")}</div>`;
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
let LANGS = null;
async function peoplePage(route) {
  if (!LANGS) LANGS = (await api("people?meta=1&lang=__none__").catch(() => ({}))).languages || [];
  return listPage({
    title: "People", noun: "people", endpoint: "people", defaultSort: "fame", ascDefault: ["name"],
    filters: (q) => searchBox(q, "Search people") + statusSeg("person", q, "alive") +
      select("role", q, [["", "Any role"], ["Jockey", "Jockeys"], ["Trainer", "Trainers"], ["Head trainer", "Head trainers"], ["Manager", "Managers"], ["Assistant manager", "Assistant managers"], ["Scout", "Scouts"], ["Stablehand", "Stablehands"]]) +
      (LANGS && LANGS.length ? select("lang", q, [["", "Any language"]].concat(LANGS.map((l) => [l, "Speaks " + l]))) : ""),
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
      { h: "Languages", f: (r) => ((r.languages || []).length ? esc(r.languages.join(", ")) : '<span class="muted">—</span>') },
    ],
  }, route);
}

// ------------------------------------------------------------------ People → Overview
// Part 1: one section each for jockeys, trainers and managers, all drawn by roleSection().
// Part 2: the latest awards and news as small compact panels (compactPanel()), collapsed by default.
const PO_SECTIONS = {
  jockeys: { title: "Jockeys", noun: "jockeys", races: "Rides" },
  trainers: { title: "Trainers", noun: "trainers", races: "Runners" },
  managers: { title: "Managers", noun: "managers", races: "Runners", note: "A stable's race counts for every manager it had on the day, so co-managers share the same wins. (The game itself writes only one manager on each race.)" },
};

// one people section; the three sections only differ in their wording (PO_SECTIONS)
function roleSection(meta, sec, ctx) {
  const people = sec.people || [];
  const z = (v) => (v ? fNum(v) : '<span class="muted">0</span>');
  const first = sec.everyone ? (sec.page - 1) * 25 : 0;
  const rows = people.map((r, i) => Object.assign({ _n: first + i + 1 }, r));
  const table_ = people.length ? table([
    { h: "#", cls: "num muted", f: (r) => r._n },
    { h: "Name", cls: "nowrap", f: (r) => `${L.person(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}${r.is_player ? ' <span class="badge good">You</span>' : ""}
      <div class="muted small">${r.died ? "Died " + yr(r.died) : r.job ? esc(r.job) : "Not working now"}${r.birth ? ` · ${fNum(age(r.birth, r.died))}yo` : ""}</div>` },
    { h: "Stable", f: (r) => (r.stable_id ? L.stable(r.stable_id, r.stable) : '<span class="muted">—</span>') },
    { h: meta.races, cls: "num", f: (r) => fNum(r.starts) },
    { h: "Wins", cls: "num", f: (r) => `${fNum(r.wins)} <span class="muted small">${r.starts ? pct(r.wins, r.starts) : ""}</span>` },
    { h: "Prize money", cls: "num", f: (r) => fMoneyShort(r.prize) },
    { h: "Group", cls: "num po-g", f: (r) => (r.group ? `<b>${fNum(r.group)}</b> <span class="muted small">${[["G1", r.G1], ["G2", r.G2], ["G3", r.G3]].filter(([, n]) => n).map(([g, n]) => `${n}×${g}`).join(" ")}</span>` : z(0)) },
    { h: "Listed", cls: "num po-l", f: (r) => z(r.listed) },
    { h: "Group + Listed", cls: "num", f: (r) => (r.total_gl ? `<b>${fNum(r.total_gl)}</b>` : z(0)) },
    { h: "Latest race", f: (r) => (r.last_race ? `${L.race(r.last_race.race_id, r.last_race.race)}
        <div class="muted small">${fDate(r.last_race.date)}${r.last_race.rank ? " · " + ord(r.last_race.rank) : ""}</div>` : '<span class="muted">No races yet</span>') },
  ], rows) : `<div class="empty">No ${meta.noun} ${ctx.who === "now" ? "working now " : ""}had races ${ctx.year ? "in " + ctx.year : "on record"}.</div>`;
  const when = ctx.year ? `in ${ctx.year}` : "of all time";
  const scope = ctx.who === "now" ? "working now" : "everyone";
  const more = sec.everyone
    ? `All ${fNum(sec.total)} ${meta.noun} (${scope}), by wins ${when} · <a href="#" data-po-all="">Top 8 only</a>`
    : `Top ${fNum(people.length)} ${scope === "everyone" ? "" : "working now "}by wins ${when}${sec.total > people.length ? ` · <a href="#" data-po-all="${sec.key}">Show all ${fNum(sec.total)}</a>` : ""}`;
  const pg = sec.everyone && sec.pages > 1 ? `<div class="pager"><span>${fNum(first + 1)}–${fNum(first + people.length)} of ${fNum(sec.total)}</span><span class="grow"></span>
    <button class="btn" data-page="1" ${sec.page <= 1 ? "disabled" : ""}>First</button><button class="btn" data-page="${sec.page - 1}" ${sec.page <= 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${fNum(sec.page)} of ${fNum(sec.pages)}</span>
    <button class="btn" data-page="${sec.page + 1}" ${sec.page >= sec.pages ? "disabled" : ""}>Next</button><button class="btn" data-page="${sec.pages}" ${sec.page >= sec.pages ? "disabled" : ""}>Last</button></div>` : "";
  return panel(meta.title, table_ + pg + (meta.note && people.length ? `<p class="help">${meta.note}</p>` : ""), more, `po-sec${sec.everyone ? " po-all" : ""}`);
}

// compact panel: the first few items, collapsed by default. Expanding shows the rest of what was loaded;
// a fuller view can be added later by registering it in COMPACT_FULL (it then gets an "Open" link in the header).
const COMPACT_FULL = { /* awards: "#/...", news: "#/..." */ };
function compactPanel({ key, title, items, row, empty, shown = 4 }) {
  const list = items || [];
  const body = list.length ? `<ul class="cp-list">${list.map((it, i) => `<li class="${i >= shown ? "cp-more" : ""}">${row(it)}</li>`).join("")}</ul>` : `<div class="empty">${empty}</div>`;
  const more = list.length > shown ? `<button class="cp-toggle" data-cp="${key}" aria-expanded="false">Show ${fNum(list.length - shown)} more ▾</button>` : "";
  const full = COMPACT_FULL[key] ? `<a class="small" href="${COMPACT_FULL[key]}">Open</a>` : "";
  return `<section class="panel cp collapsed" data-cp-panel="${key}"><div class="panel-head"><h2>${title}</h2><span class="note">${full}</span></div>${body}${more}</section>`;
}
// Show all / Top 8 only on a People overview section
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-po-all]");
  if (!a) return;
  e.preventDefault();
  const q = Object.assign({}, parseHash().q, { all: a.dataset.poAll });
  delete q.page;
  if (!q.all) delete q.all;
  location.hash = "#/people-overview" + (Object.keys(q).length ? "?" + new URLSearchParams(q) : "");
  if (a.dataset.poAll) setTimeout(() => { const s = document.querySelector(".po-all"); if (s) s.scrollIntoView({ block: "start" }); }, 600);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cp]");
  if (!b) return;
  const p = b.closest(".cp"), open = p.classList.toggle("collapsed") === false;
  b.setAttribute("aria-expanded", open);
  b.textContent = open ? "Show fewer ▴" : `Show ${fNum(p.querySelectorAll(".cp-more").length)} more ▾`;
});

async function peopleOverviewPage(route) {
  const q = (route && route.q) || {};
  const d = await api("people_overview?" + new URLSearchParams(Object.fromEntries(Object.entries({ year: q.year, who: q.who, all: q.all, page: q.page }).filter(([, v]) => v))));
  const ctx = { year: d.year, who: d.who };
  let html = `<div class="page-head"><div><div class="crumb">People</div><h1>People overview</h1>
    <div class="sub">Jockeys, trainers and managers ${d.year ? "in " + d.year : "of all time"}: their races and their Group and Listed wins.</div></div>
    <div><a class="btn" href="#/people">All people</a></div></div>
    <div class="filters">${seg("who", q, [["", "Working now"], ["all", "All (incl. retired)"]], "")}
      ${select("year", q, yearOptions(d.years), "Show one year's races")}</div>`;
  const secs = (d.sections || []).map((sec) => roleSection(PO_SECTIONS[sec.key], sec, ctx)).join("");
  const awards = compactPanel({ key: "awards", title: "Latest awards", items: d.awards, empty: "No awards to people yet.",
    row: (a) => `<div class="cp-d">${a.date ? fDate(a.date) : a.year || ""}</div><div><b>${esc(a.label || "")}</b>${a.rank > 1 ? ` <span class="muted small">${ord(a.rank)}</span>` : ""}
      <div class="small">${a.pid ? L.person(a.pid, a.person) : esc(a.person || "")}</div></div>` });
  const news = compactPanel({ key: "news", title: "Latest news", items: d.news, empty: "No news about people yet.",
    row: (n) => `<div class="cp-d">${fDate(n.date)}</div><div class="small">${esc(n.text || n.type)}</div>` });
  html += `<div class="po-layout"><div class="po-main">${secs || '<div class="empty">This save has no staff or race results to show.</div>'}</div>
    <aside class="po-side">${awards}${news}</aside></div>`;
  return html;
}

// People → Jockeys: each person's jockey, trainer and stable numbers side by side
const CAREER_VIEWS = [["jockeys", "Jockeys"], ["trainers", "Trainers"], ["managers", "Stable managers"], ["all", "Everyone"]];
async function careersPage(route) {
  const q = route.q, view = CAREER_VIEWS.some(([v]) => v === q.view) ? q.view : "jockeys";
  const dflt = { jockeys: "jockey_wins", trainers: "trainer_wins", managers: "mgmt_winnings", all: "jockey_wins" }[view];
  const me = (STATUS.meta || {}).player_id;
  const strike = (w, n) => (n ? pct(w, n) : "—");
  const z = (v, f) => (v ? f(v) : '<span class="muted">—</span>');
  const html = await listPage({
    title: "Jockeys, trainers & stables", noun: "people", endpoint: "careers", defaultSort: dflt, ascDefault: ["name"], wide: true,
    intro: "Everyone's riding, training and stable-management record side by side. Trainer numbers include head trainer races. Stable numbers are for the stable where they work now (their main job). Click a heading to sort.",
    filters: (qq) => viewSeg("view", qq, CAREER_VIEWS, "jockeys") + searchBox(qq, "Search people") + statusSeg("person", qq, "alive") +
      select("job", qq, [["", "Any job now"], ["Jockey", "Jockey now"], ["Trainer", "Trainer now"], ["Head trainer", "Head trainer now"], ["Manager", "Manager now"], ["Assistant manager", "Assistant manager now"]]),
    tableOpts: { tcls: "careers", groups: [["", 3], ["Jockey", 4, "g-j"], ["Trainer", 4, "g-t"], ["Stable", 5, "g-s"]] },
    rowClass: (r) => (r.id === me ? "me" : ""),
    cols: [
      { h: "Name", sort: "name", f: (r) => `${L.person(r.id, r.name)}${r.died ? ' <span class="badge dead">Dead</span>' : ""}${r.id === me ? ' <span class="badge good">You</span>' : ""}` },
      { h: "Age", cls: "num", sort: "birth", f: (r) => fNum(age(r.birth, r.died)) },
      { h: "Job now", f: (r) => (r.jobs && r.jobs.length ? [...new Set(r.jobs.map((j) => j.role))].map(esc).join(", ") : '<span class="muted">—</span>') },
      { h: "Rides", cls: "num g-j", sort: "jockey_starts", f: (r) => z(r.j_starts, fNum) },
      { h: "Wins", cls: "num g-j", sort: "jockey_wins", f: (r) => z(r.j_wins, fNum) },
      { h: "Strike", cls: "num g-j", sort: "jockey_strike", f: (r) => strike(r.j_wins, r.j_starts) },
      { h: "Prize money", cls: "num g-j", sort: "jockey_winnings", f: (r) => z(r.j_prize, fMoneyShort) },
      { h: "Starts", cls: "num g-t", sort: "trainer_starts", f: (r) => z(r.t_starts, fNum) },
      { h: "Wins", cls: "num g-t", sort: "trainer_wins", f: (r) => z(r.t_wins, fNum) },
      { h: "Strike", cls: "num g-t", sort: "trainer_strike", f: (r) => strike(r.t_wins, r.t_starts) },
      { h: "Prize money", cls: "num g-t", sort: "trainer_winnings", f: (r) => z(r.t_prize, fMoneyShort) },
      { h: "Name", cls: "g-s", f: (r) => (r.stable_id ? L.stable(r.stable_id, r.stable) : '<span class="muted">—</span>') },
      { h: "Wins", cls: "num g-s", f: (r) => (r.stable_id ? `${fNum(r.s_wins)} <span class="muted small">/ ${fNum(r.s_starts)}</span>` : "") },
      { h: "Prize money", cls: "num g-s", f: (r) => (r.stable_id ? fMoneyShort(r.s_prize) : "") },
      { h: "Managed", cls: "num g-s", f: (r) => (r.managed_ever ? `${fNum(r.managed_ever)} stable${r.managed_ever === 1 ? "" : "s"}` : '<span class="muted">—</span>') },
      { h: '<span data-tip="The game\'s own career figure for prize money while managing">As manager</span>', cls: "num g-s", sort: "mgmt_winnings", f: (r) => z(r.m_prize, fMoneyShort) },
    ],
  }, route);
  return html;
}

// a person's page heading and its tabs (Overview · Awards)
function personHead(d, on) {
  const p = d.person, id = p.person_person_id;
  const dead = isNum(p.person_deceased_date);
  const current = (d.jobs || []).filter((j) => !j.end);
  return `<div class="page-head"><div><div class="crumb"><a href="#/people">People</a></div>
    <h1>${esc(p.person_full_name)} ${dead ? '<span class="badge dead">Deceased</span>' : ""}${removedBadge(d)}${p.person_is_player === "true" ? ' <span class="badge good">You</span>' : ""}</h1>
    <div class="sub">${fNum(age(p.person_birth_date, p.person_deceased_date))} years old · ${esc(p.person_sex || "")}${d.city ? ` · ${esc(d.city.city)}, ${esc(d.city.country)}` : ""}
    ${current.length ? " · " + current.map((j) => `${esc(j.role)} at ${L.stable(j.stable_id, j.stable)}`).join(", ") : ""}
    ${d.owns && d.owns.length ? " · Owns " + d.owns.map((s) => L.stable(s.id, s.name)).join(", ") : ""}</div>
    ${(d.languages || []).length ? `<div class="sub langs">Speaks ${langChips(d.languages)}</div>` : ""}${removedNote(d)}</div></div>
    <div class="subtabs"><a href="#/person/${id}" class="${on === "overview" ? "on" : ""}">Overview</a><a href="#/person/${id}/awards" class="${on === "awards" ? "on" : ""}">Awards</a>
      <a href="#/person/${id}/family" class="${on === "family" ? "on" : ""}">Family tree</a><a href="#/person/${id}/tree" class="${on === "tree" ? "on" : ""}">Tree chart</a><a href="#/person/${id}/lifespans" class="${on === "lifespans" ? "on" : ""}">Lifespans</a><a href="#/person/${id}/dynasty" class="${on === "dynasty" ? "on" : ""}">${esc(p.person_last_name || "Family")} dynasty</a>${p.person_jockey_starts > 0 || on === "season" ? `<a href="#/person/${id}/season" class="${on === "season" ? "on" : ""}">Jockey season</a>` : ""}<a href="#/compare?kind=person&a=${id}" class="st-cmp">Compare…</a></div>`;
}
// ------------------------------------------------------------------ a person's Overview tab
// Part 1: one section per role (jockey, trainer, manager), all drawn by roleRecordSection().
// Part 2: their latest awards and news as compact panels (compactPanel(), shared with People → Overview).
const ROLE_META = {
  jockey: { title: "As a jockey", noun: "jockey", races: "rides", none: "No rides recorded." },
  trainer: { title: "As a trainer", noun: "trainer or head trainer", races: "runners trained", none: "No runners trained." },
  manager: { title: "As a manager", noun: "manager", races: "runners for stables they managed", none: "No runners while managing a stable.",
    note: "Every race their stable ran while they were a manager there, shared with any co-manager. (The game itself writes only one manager on each race.)" },
};
const ROLE_SHOW = 6;     // races shown before "Show all"
function roleRecordSection(key, rec, person) {
  const m = ROLE_META[key];
  const jobs = (rec.jobs_now || []).map((j) => `${esc(j.role)} at ${L.stable(j.stable_id, j.stable)}${j.since ? ` <span class="muted small">since ${yr(j.since)}</span>` : ""}`).join(" · ");
  const note = [jobs || `<span class="muted">Not working as a ${m.noun} now</span>`, rec.ranking > 0 ? `Ranked ${fNum(rec.ranking)}` : ""].filter(Boolean).join(" · ");
  if (!rec.starts && !(rec.jobs_now || []).length) {
    return `<section class="panel rr rr-empty"><div class="panel-head"><h2>${m.title}</h2><span class="note">${note}</span></div>
      <div class="empty">${m.none}</div></section>`;
  }
  const stat = (lbl, val, sub) => `<div class="rr-stat"><span class="lbl">${lbl}</span><b>${val}</b>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
  const split = [["G1", rec.G1], ["G2", rec.G2], ["G3", rec.G3]].filter(([, n]) => n).map(([g, n]) => `${n}×${g}`).join(" ");
  const stats = `<div class="rr-stats">${stat("Races", fNum(rec.starts), m.races)}${stat("Wins", fNum(rec.wins), rec.starts ? pct(rec.wins, rec.starts) + " strike rate" : "")}
    ${stat("Placed (top 3)", fNum(rec.places), rec.starts ? pct(rec.places, rec.starts) : "")}${stat("Prize money", fMoneyShort(rec.prize), "from these races")}
    ${stat("Group wins", fNum(rec.group), split)}${stat("Listed wins", fNum(rec.listed))}${stat("Group + Listed", fNum(rec.group + rec.listed), "")}</div>${m.note ? `<p class="help">${m.note}</p>` : ""}`;
  const races = rec.races || [];
  const racesHtml = races.length ? expandable(table([
    { h: "Date", cls: "nowrap", f: (r) => fDate(r.date) },
    { h: "Race", f: (r) => `${L.race(r.race_id, r.race, '<span class="muted">Historic race</span>')} ${grade(r.type)}` },
    { h: "Horse", f: (r) => L.horse(r.horse_id, r.horse) },
    key === "manager" ? { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) } : { h: "Course", f: (r) => L.course(r.course_id, r.course) },
    { h: "Pos", cls: "num", f: (r) => (r.rank ? ord(r.rank) : "—") }, { h: "Prize", cls: "num", f: (r) => fMoneyShort(r.prize) },
  ], races.map((r, i) => Object.assign({ _i: i }, r)), { rowClass: (r) => `${r.rank === 1 ? "win" : ""} ${r._i >= ROLE_SHOW ? "more-row" : ""}` }), races.length, ROLE_SHOW)
    : `<div class="empty">${m.none}</div>`;
  // Group and Listed wins: separately, or all together
  const bw = rec.big_wins || [];
  const grp = bw.filter((w) => w.type !== "listed"), lst = bw.filter((w) => w.type === "listed");
  const winRow = (w) => `<li data-k="${w.type === "listed" ? "listed" : "group"}"><span class="muted small">${fDate(w.date)}</span> ${grade(w.type)} ${L.race(w.race_id, w.race)}
    <span class="muted small">·</span> ${L.horse(w.horse_id, w.horse)}</li>`;
  const winsHtml = bw.length ? `<div class="seg rr-seg" role="tablist">
      <button data-rr="all" class="on">All ${fNum(bw.length)}</button><button data-rr="group">Group ${fNum(grp.length)}</button><button data-rr="listed">Listed ${fNum(lst.length)}</button></div>
      <ul class="po-wins rr-wins" data-show="all">${bw.map(winRow).join("")}</ul>
      <div class="empty rr-none" data-none="group" hidden>No Group wins.</div><div class="empty rr-none" data-none="listed" hidden>No Listed wins.</div>`
    : `<div class="empty">No Group or Listed wins as a ${m.noun} yet.</div>`;
  return `<section class="panel rr"><div class="panel-head"><h2>${m.title}</h2><span class="note">${note}</span></div>${stats}
    <div class="rr-grid"><div><h3 class="rr-h">Latest races <span class="muted small">${fNum(rec.starts)} in all</span></h3>${racesHtml}</div>
      <div><h3 class="rr-h">Group &amp; Listed wins</h3>${winsHtml}</div></div></section>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-rr]");
  if (!b) return;
  const sec = b.closest(".rr"), k = b.dataset.rr, list = sec.querySelector(".rr-wins");
  sec.querySelectorAll("[data-rr]").forEach((x) => x.classList.toggle("on", x === b));
  list.dataset.show = k;
  let any = false;
  list.querySelectorAll("li").forEach((li) => { const on = k === "all" || li.dataset.k === k; li.hidden = !on; any = any || on; });
  sec.querySelectorAll(".rr-none").forEach((n) => (n.hidden = any || n.dataset.none !== k));
});

async function personPage(id) {
  const d = await api("person/" + id);
  const p = d.person, R = d.roles || {};
  let html = personHead(d, "overview");
  // Group and Listed races won in any role (a race counts once even if they rode and trained the winner)
  const allBig = new Map();
  Object.values(R).forEach((r) => (r.big_wins || []).forEach((w) => allBig.set(w.race_id, w)));
  const bigs = [...allBig.values()];
  const now = (d.jobs || []).filter((j) => !j.end);
  html += tiles([
    ["Job now", now.length ? esc([...new Set(now.map((j) => j.role))].join(", ")) : "—", now.length ? now.map((j) => esc(j.stable || "")).join(", ") : "Not working at a stable"],
    ["Group wins", fNum(bigs.filter((w) => w.type !== "listed").length), "in any role"], ["Listed wins", fNum(bigs.filter((w) => w.type === "listed").length), "in any role"],
    ["Awards", fNum((d.awards || []).length)], ["Reputation", fNum(p.person_reputation, 1)], ["Fame", fNum(p.person_fame_calculated, 0)],
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
  // the two parts: roles (wide) and awards & news (narrow)
  const roles = ["jockey", "trainer", "manager"].map((k) => roleRecordSection(k, R[k] || {}, p)).join("");
  const awards = compactPanel({ key: "awards", title: "Latest awards", items: d.awards, empty: "No awards yet.",
    row: (a) => `<div class="cp-d">${a.date ? fDate(a.date) : esc(a.year || "")}</div><div><b>${esc(a.label || (a.category || "").replace(/_/g, " "))}</b>${a.rank > 1 ? ` <span class="muted small">${ord(a.rank)}</span>` : ""}
      ${a.horse_id ? `<div class="small">${L.horse(a.horse_id, a.horse)} <span class="muted">· as ${esc((a.role || "").toLowerCase())}</span></div>` : ""}
      ${a.stable_award ? `<div class="small">${L.stable(a.stable_id, a.stable)} <span class="muted">· as ${esc((a.role || "").toLowerCase())}</span></div>` : ""}
      ${a.description && !a.horse_id && !a.stable_award ? `<div class="muted small">${esc(a.description)}</div>` : ""}</div>` });
  const news = compactPanel({ key: "news", title: "Latest news", items: d.events, empty: "No news yet.",
    row: (n) => `<div class="cp-d">${fDate(n.date)}</div><div class="small">${esc(n.text || n.type)}</div>` });
  html += `<div class="po-layout" style="margin-top:16px"><div class="po-main">${roles}</div><aside class="po-side">${awards}${news}
    <div class="small"><a href="#/person/${p.person_person_id}/awards">Awards tab · every award and race win</a></div></aside></div>`;
  // stables they own outright (with the stables those hold a majority of), and other stables of theirs with sub-stables:
  // one click to the group's combined financials and horse finances
  if ((d.owned_groups || []).length) {
    html += `<div style="margin-top:16px">${panel("Stables they own", d.owned_groups.map((g) => {
      const many = g.stables.length > 1, k = g.key, qs = many ? "?group=1" : "";
      return `<div class="og">
        <div class="og-h"><b>${g.full ? "Owned outright" : `Majority owner of ${esc(g.stables[0].name)}`}</b>${many ? ` <span class="muted small">· ${fNum(g.stables.length)} stables, with the stables they hold a majority of</span>` : ""}
          <span class="og-btns"><a class="btn sm" href="#/stable/${k}/financials${qs}">${many ? "Group financials" : "Financials"}</a> <a class="btn sm" href="#/stable/${k}/horse-money${qs}">${many ? "Group horse finances" : "Horse finances"}</a></span></div>
        <ul class="grp-list small">${g.stables.map((s) => `<li class="${s.parent_id ? "sub" : ""}">${L.stable(s.id, s.name)} <span class="muted">${fNum(s.pct, s.pct % 1 ? 1 : 0)}% ${s.holder_kind === "person" ? "owned by" : "held by"} ${esc(s.holder || "")}${s.closed ? " · closed" : ""}</span></li>`).join("")}</ul></div>`;
    }).join(""), "Financials and horse finances added up for each group")}</div>`;
  }
  html += `<div class="grid cols-2" style="margin-top:16px">${panel("Jobs", table([
    { h: "Role", f: (r) => esc(r.role) }, { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) },
    { h: "From", cls: "nowrap", f: (r) => fDate(r.start) }, { h: "To", cls: "nowrap", f: (r) => (r.end ? fDate(r.end) : "Now") }, { h: "Salary", cls: "num", f: (r) => fMoney(r.salary) },
  ], d.jobs, { empty: "No jobs on record." }))}
    ${panel("Traits", chips(d.traits))}</div>`;
  html += personMorePanels(d);
  html += `<div style="margin-top:16px">${allFields(p)}</div>`;
  return html;
}

// ------------------------------------------------------------------ racecourses
async function coursesPage(route) {
  const data = await api("courses?" + new URLSearchParams(withSize(route.q)));
  const q = route.q;
  return `<div class="page-head"><div><h1>Racecourses</h1><div class="sub">${fNum(data.total)} racecourses</div></div></div>
    <section class="panel"><div class="filters">${searchBox(q, "Search courses or towns")}${select("country", q, [["", "Any country"]].concat(data.countries.map((c) => [c, c])))}</div>
    ${table([
      { h: "Racecourse", f: (r) => L.course(r.id, r.name) }, { h: "Town", f: (r) => esc(r.city || "") }, { h: "Country", f: (r) => esc(r.country || "") },
      { h: "Surface", f: (r) => esc(r.surface || "—") }, { h: "Direction", f: (r) => esc(r.direction || "—") },
      { h: "Capacity", cls: "num", f: (r) => fNum(r.capacity) }, { h: "Owner", f: (r) => L.stable(r.owner_id, r.owner) },
    ], data.rows, { empty: "No matches." })}${pager(data)}</section>`;
}

// ------------------------------------------------------------------ a racecourse's tabs (16.7.8)
function courseHead(d, on) {
  const c = d.course, id = c.racecourse_racecourse_id;
  const tab = (k, label) => `<a href="#/course/${id}${k ? "/" + k : ""}" class="${on === (k || "overview") ? "on" : ""}">${label}</a>`;
  return `<div class="page-head"><div><div class="crumb"><a href="#/courses">Racecourses</a></div>
    <h1>${esc(c.racecourse_name)}</h1><div class="sub">${esc(c.racecourse_location_city || "")}, ${esc(c.racecourse_location_country || "")}
    ${c.racecourse_nickname ? " · “" + esc(c.racecourse_nickname) + "”" : ""}${d.owner ? ` · owned by ${L.stable(d.owner.id, d.owner.name)}` : ""}</div>${removedNote(d)}</div>
    <a class="btn" href="#/races?course=${id}&when=all">All races here</a></div>
    <div class="subtabs">${tab("", "Overview")}${tab("upcoming", "Upcoming races")}${tab("results", "Results")}${tab("records", "Track records")}${tab("sectionals", "Sectional records")}${tab("finances", "Finances")}</div>`;
}
async function courseTabPage(route) {
  const id = route.parts[1], on = route.parts[2];
  if (on === "upcoming" || on === "results") return courseRacesPage(route);
  if (on === "finances") return courseFinancePage(route);
  const d = await api("course/" + id);
  if (on === "records") return courseHead(d, "records") + trackRecordsPanel(d, d.course);
  if (on === "sectionals") return courseHead(d, "sectionals") + sectionRecordsPanel(d, d.course);
  return coursePage(id, d);
}
async function courseRacesPage(route) {
  const id = route.parts[1], upcoming = route.parts[2] === "upcoming";
  const d = await api("course/" + id);
  const q = { ...route.q, course: id, when: upcoming ? "upcoming" : "past" };
  return listPage({
    title: upcoming ? "Upcoming races" : "Results", noun: "races", endpoint: "races", defaultSort: "date", ascDefault: ["name"], noHead: true, head: courseHead(d, upcoming ? "upcoming" : "results"),
    filters: (q) => searchBox(q, "Search races") +
      select("type", q, [["", "Any type"], ["G1", "Group 1"], ["G2", "Group 2"], ["G3", "Group 3"], ["listed", "Listed"], ["stakes", "Stakes"], ["open", "Open"], ["allowance", "Allowance"], ["juvenile", "Juvenile"], ["maiden", "Maiden"]]),
    cols: [
      { h: "Date", sort: "date", cls: "nowrap", f: (r) => fDateTime(r.race_time) },
      { h: "Race", sort: "name", f: (r) => `${L.race(r.race_id, r.race_name)} ${grade(r.race_type)}` },
      { h: "Distance", sort: "distance", cls: "num", f: (r) => fDist(r.distance) },
      { h: "Purse", sort: "purse", cls: "num", f: (r) => fMoney(r.purse) },
      { h: upcoming ? "Entries" : "Runners", cls: "num", f: (r) => (r.runners ? fNum(r.runners) : '<span class="muted">—</span>') },
    ].concat(upcoming ? [] : [
      { h: "Winner", f: (r) => L.horse(r.winner_id, r.winner_name, '<span class="muted">—</span>') },
      { h: "Jockey", f: (r) => (r.winner_jockey_id ? L.person(r.winner_jockey_id, r.winner_jockey) : '<span class="muted">—</span>') },
      { h: "Stable", f: (r) => (r.winner_stable_id ? L.stable(r.winner_stable_id, r.winner_stable) : '<span class="muted">—</span>') },
      { h: "Time", cls: "num", f: (r) => (isNum(r.winner_time) ? fTime(r.winner_time) : '<span class="muted">—</span>') },
    ]),
  }, { parts: route.parts, q });
}

// ------------------------------------------------------------------ charts for money pages (16.7.9)
// Column charts (grouped or stacked), a profit chart (blue above zero, red below), ranked meter lists, a split bar and
// deltas. Colours are CSS variables (--viz-*, light and dark steps of a colour-blind-checked palette); text never wears
// a series colour; every chart has a legend for two or more series and a table of the same numbers beside it; hovering
// (or tabbing to) a column shows every series at that point.
const VZ = new Map();
let VZ_N = 0;
function vzNice(lo, hi) {
  const guess = (hi - lo || 1) / 4, pow = Math.pow(10, Math.floor(Math.log10(guess)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= guess);
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step, ticks = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.abs(t) < step / 1e6 ? 0 : t);
  return { min, max, ticks };
}
// a column from the baseline to v, 4px rounded at its data end, square at the baseline
function vzCol(x, w, yBase, yEnd, round = true) {
  const h = Math.abs(yEnd - yBase);
  if (h < 0.5) return "";
  const r = round ? Math.min(4, w / 2, h) : 0, up = yEnd < yBase, top = Math.min(yBase, yEnd), bot = Math.max(yBase, yEnd);
  if (!r) return `M${x},${top}h${w}v${h}h${-w}z`;
  return up ? `M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bot}Z`
    : `M${x},${top}V${bot - r}Q${x},${bot} ${x + r},${bot}H${x + w - r}Q${x + w},${bot} ${x + w},${bot - r}V${top}Z`;
}
// opts: labels (x), series [{name, color, values}], stacked, signed (one series coloured by sign), fmt (axis), tip (values),
// total (label for a total row in the hover), long (full labels for the hover), height
function colChart(o) {
  const labels = o.labels || [], series = (o.series || []).filter((s) => s.values.some((v) => isNum(v) && v)), fmt = o.fmt || fMoneyShort, tip = o.tip || fMoney;
  if (!labels.length || !series.length) return `<div class="empty">${o.empty || "No money recorded in this period."}</div>`;
  const W = o.wide ? 1240 : 600, H = o.height || 230, padL = 60, padR = 6, padT = 12, padB = 26, plotW = W - padL - padR, plotH = H - padT - padB;
  let lo = 0, hi = 0;
  labels.forEach((_, i) => {
    if (o.stacked) {
      let pos = 0, neg = 0;
      series.forEach((s) => { const v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; });
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    } else series.forEach((s) => { const v = s.values[i]; if (isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
  });
  const sc = vzNice(lo, hi), y = (v) => padT + ((sc.max - v) / (sc.max - sc.min || 1)) * plotH, band = plotW / labels.length;
  const nb = o.stacked ? 1 : series.length, bw = Math.max(3, Math.min(24, (band * 0.72 - (nb - 1) * 2) / nb));
  const id = "vz" + ++VZ_N;
  let g = "";
  sc.ticks.forEach((t) => { g += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`; });
  let marks = "";
  const every = Math.ceil(labels.length / (o.wide ? 24 : 12));
  labels.forEach((lab, i) => {
    const cx = padL + band * i + band / 2;
    if (o.stacked) {
      let pos = 0, neg = 0;
      const segs = series.map((s) => ({ s, v: s.values[i] || 0 })).filter((x) => x.v);
      const lastPos = segs.filter((x) => x.v > 0).pop(), lastNeg = segs.filter((x) => x.v < 0).pop();
      segs.forEach((x) => {
        const from = x.v > 0 ? pos : neg, to = from + x.v;
        if (x.v > 0) pos = to; else neg = to;
        const isEnd = x === lastPos || x === lastNeg;
        const y0 = y(from) + (from === 0 ? 0 : (x.v > 0 ? -1 : 1)), y1 = y(to) + (isEnd ? 0 : (x.v > 0 ? 1 : -1));     // 2px surface gap between segments
        marks += `<path d="${vzCol(cx - bw / 2, bw, y0, y1, isEnd)}" style="fill:${x.s.color}"/>`;
      });
    } else {
      const x0 = cx - (nb * bw + (nb - 1) * 2) / 2;
      series.forEach((s, k) => {
        const v = s.values[i];
        if (!isNum(v) || !v) return;
        const col = o.signed ? (v < 0 ? "var(--viz-8)" : "var(--viz-1)") : s.color;
        marks += `<path d="${vzCol(x0 + k * (bw + 2), bw, y(0), y(v))}" style="fill:${col}"/>`;
      });
    }
    marks += `<rect class="band" data-vz="${id}" data-i="${i}" tabindex="0" x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" aria-label="${esc(lab)}"/>`;
    if (i % every === 0 || i === labels.length - 1) g += `<text class="xl" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
  });
  g += `<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>`;
  VZ.set(id, { labels: o.long || labels, series, tip, total: o.total, signed: o.signed });
  const legend = series.length > 1 ? `<div class="vz-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `<div class="vz"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || "Chart")}"><g>${g}</g><g>${marks}</g></svg>${legend}</div>`;
}
function vzTipHtml(d, i) {
  let h = `<div class="h">${esc(d.labels[i])}</div>`, total = 0;
  d.series.forEach((s) => {
    const v = s.values[i];
    if (!isNum(v) || (!v && d.series.length > 2)) return;     // a stack's empty parts are left out
    total += v;
    const col = d.signed ? (v < 0 ? "var(--viz-8)" : "var(--viz-1)") : s.color;
    h += `<div class="r"><i style="background:${col}"></i><span>${esc(s.name)}</span><b>${esc(d.tip(v))}</b></div>`;
  });
  if (d.total) h += `<div class="r t"><i></i><span>${esc(d.total)}</span><b>${esc(d.tip(total))}</b></div>`;
  return h;
}
function vzTip() {
  let t = document.querySelector(".vz-tip");
  if (!t) { t = document.createElement("div"); t.className = "vz-tip"; document.body.appendChild(t); }
  return t;
}
function vzShow(el, x, y) {
  const d = VZ.get(el.dataset.vz);
  if (!d) return;
  const t = vzTip();
  t.innerHTML = vzTipHtml(d, +el.dataset.i);
  t.style.display = "block";
  const r = t.getBoundingClientRect();
  t.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + "px";
  t.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y - r.height / 2)) + "px";
}
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest && e.target.closest("[data-vz]");
  if (el) vzShow(el, e.clientX, e.clientY); else { const t = document.querySelector(".vz-tip"); if (t) t.style.display = "none"; }
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest && e.target.closest("[data-vz]");
  if (el) { const r = el.getBoundingClientRect(); vzShow(el, r.right, r.top + r.height / 2); }
});
document.addEventListener("focusout", () => { const t = document.querySelector(".vz-tip"); if (t) t.style.display = "none"; });
// ranked bars, one hue: name, bar, amount and share (largest first)
function meterList(rows, o = {}) {
  const list = rows.filter((r) => isNum(r.value) && r.value).sort((a, b) => b.value - a.value);
  if (!list.length) return `<div class="empty">${o.empty || "None in this period."}</div>`;
  const max = Math.max(...list.map((r) => Math.abs(r.value))), color = o.color || "var(--viz-1)";
  return `<div class="meters">${list.map((r) => `<div class="meter-row"><div class="n">${esc(r.name)}${r.note ? `<small>${r.note}</small>` : ""}</div>
    <div class="track" role="img" aria-label="${esc(r.name)}: ${esc((o.fmt || fMoney)(r.value))}"><div class="fill" style="width:${(100 * Math.abs(r.value)) / max}%;background:${r.color || color}"></div></div>
    <div class="v">${(o.fmt || fMoney)(r.value)}${isNum(r.share) ? `<small>${Math.round(r.share * 100)}%</small>` : ""}</div></div>`).join("")}</div>`;
}
// one whole split into parts: each part's share printed on it where it fits, a legend of names
function splitBar(parts, o = {}) {
  const list = parts.filter((p) => p.value > 0), tot = list.reduce((a, p) => a + p.value, 0);
  if (!tot) return "";
  return `<div class="split-bar" role="img" aria-label="${esc(list.map((p) => `${p.name} ${Math.round((100 * p.value) / tot)}%`).join(", "))}">${list.map((p) => {
    const pc = (100 * p.value) / tot;
    return `<div class="${p.dark ? "dk" : ""}" style="flex:${p.value} 1 0;background:${p.color}" title="${esc(p.name)}: ${esc((o.fmt || fMoney)(p.value))} (${Math.round(pc)}%)">${pc >= 9 ? Math.round(pc) + "%" : ""}</div>`;
  }).join("")}</div><div class="vz-legend">${list.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join("")}</div>`;
}
// change against an earlier period, with an arrow so it isn't colour alone
function deltaHtml(cur, prev, o = {}) {
  if (!isNum(cur) || !isNum(prev) || !prev) return "";
  const ch = (cur - prev) / Math.abs(prev), up = ch > 0.005, down = ch < -0.005, good = o.lowerIsBetter ? down : up, bad = o.lowerIsBetter ? up : down;
  return `<span class="delta ${good ? "good" : bad ? "bad" : "flat"}">${up ? "▲" : down ? "▼" : "■"} ${Math.abs(ch) < 10 ? Math.round(Math.abs(ch) * 100) + "%" : "×" + fNum(Math.abs(cur / prev), 1)} ${esc(o.vs || "vs the 12 months before")}</span>`;
}
const ordinal = (n) => { const sfx = ["th", "st", "nd", "rd"], v = n % 100; return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]); };
const placeText = (p) => (p ? `${ordinal(p[0])} of ${fNum(p[1])}` : "—");
// the income types, each always the same colour; the rare ones go to Other
const INCOME_COLOR = { "Tickets": "var(--viz-1)", "Food, drink & parking": "var(--viz-2)", "Media rights": "var(--viz-3)", "Betting commission": "var(--viz-4)", "Sponsorship": "var(--viz-5)", "Subsidy": "var(--viz-6)", "Fees": "var(--viz-7)" };
const INCOME_DARK_TEXT = { "Betting commission": 1 };
function incomeGroup(cat) { return cat === "Sponsor event bonuses" ? "Sponsorship" : INCOME_COLOR[cat] ? cat : "Other"; }
function incomeStack(rows) {
  const names = Object.keys(INCOME_COLOR).concat(["Other"]);
  return names.map((n) => ({ name: n, color: INCOME_COLOR[n] || "var(--viz-other)",
    values: rows.map((r) => Object.entries(r.income_cats || {}).reduce((a, [c, v]) => a + (incomeGroup(c) === n ? v : 0), 0)) }));
}

// grouped bars: one group per label (a year or a month), one bar per series, with a zero line for losses (16.7.8)
function groupBars(labels, series, opts = {}) {
  const fmt = opts.fmt || fMoneyShort, tip = opts.tipFmt || fMoney, W = 680, H = opts.height || 230, padL = 58, padB = 26, padT = 10;
  const vals = series.flatMap((s) => s.values).filter(isNum);
  if (!labels.length || !vals.some((v) => v)) return '<div class="empty">No money recorded in this period.</div>';
  // round steps for the axis (1, 2 or 5 times a power of ten), wide enough for the highest and lowest bar
  const rawMax = Math.max(0, ...vals), rawMin = Math.min(0, ...vals), guess = (rawMax - rawMin || 1) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(guess))), step = [1, 2, 5, 10].map((m) => m * pow).find((x) => x >= guess);
  const max = Math.ceil(rawMax / step) * step, min = Math.floor(rawMin / step) * step, span = max - min || 1;
  const y = (v) => padT + ((max - v) / span) * (H - padT - padB);
  const gw = (W - padL) / labels.length, bw = Math.min(26, (gw * 0.8) / series.length);
  const ticks = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(t);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="gbars" role="img" preserveAspectRatio="xMidYMid meet">`;
  ticks.forEach((t) => { svg += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="gb-grid"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="gb-ax">${esc(fmt(t))}</text>`; });
  svg += `<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="gb-zero"/>`;
  labels.forEach((lab, i) => {
    const x0 = padL + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, k) => {
      const v = s.values[i];
      if (!isNum(v)) return;
      const top = y(Math.max(0, v)), h = Math.max(v ? 1 : 0, Math.abs(y(v) - y(0)));
      svg += `<rect x="${x0 + k * bw}" y="${top}" width="${bw - 2}" height="${h}" rx="2" fill="${s.color}"><title>${esc(lab)} · ${esc(s.name)}: ${esc(tip(v))}</title></rect>`;
    });
    svg += `<text x="${padL + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle" class="gb-ax">${esc(lab)}</text>`;
  });
  svg += "</svg>";
  const legend = `<div class="gb-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
  return `<div class="gb-box">${svg}${legend}</div>`;
}
const FIN_SERIES = (rows) => [
  { name: "Income", color: "#2f9e5b", values: rows.map((r) => r.income) },
  { name: "Expenses", color: "#d0453c", values: rows.map((r) => r.expenses) },
  { name: "Profit", color: "#1d63d6", values: rows.map((r) => r.profit) },
];

async function stableCoursesPage(route) {
  const id = route.parts[1];
  const [d, sc] = await Promise.all([api("stable/" + id), api("stable_courses/" + id)]);
  const list = sc.courses || [];
  let html = stableHead(d, "racecourses");
  if (!list.length) return html + panel("Racecourses", '<div class="empty">This stable doesn\'t own a racecourse.</div>');
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ms = sc.months12 || [], p = sc.prev12 || {};
  const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const tot = { income: sum("income_12m"), expenses: sum("expenses_12m"), profit: sum("profit_12m"), meetings: sum("meetings_12m") };
  const pctTxt = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : "—");
  html += tiles([
    ["Racecourses", fNum(list.length), list.filter((r) => r.for_sale).length ? `${list.filter((r) => r.for_sale).length} for sale` : "owned by this stable"],
    ["Income", fMoneyShort(tot.income), p.complete && p.income ? deltaHtml(tot.income, p.income) : "last 12 months"],
    ["Expenses", fMoneyShort(tot.expenses), p.complete && p.expenses ? deltaHtml(tot.expenses, p.expenses, { lowerIsBetter: true }) : "last 12 months"],
    ["Profit", `<span class="${tot.profit >= 0 ? "up" : "dn"}">${fMoneyShort(tot.profit)}</span>`, `${pctTxt(tot.income ? tot.profit / tot.income : null)} of income kept`],
    ["Meetings", fNum(tot.meetings), "last 12 months"],
    ["Income per meeting", tot.meetings ? fMoneyShort(tot.income / tot.meetings) : "—", "last 12 months"],
  ]);
  const short = ms.map((m) => `${MON[m.month - 1]} ${String(m.year).slice(2)}`), long = ms.map((m) => `${MONTHS_LONG[m.month - 1]} ${m.year}`);
  html += `<div class="grid cols-2">
    ${panel("Income and expenses, month by month", colChart({ labels: short, long, series: [{ name: "Income", color: "var(--viz-1)", values: ms.map((m) => m.income) }, { name: "Expenses", color: "var(--viz-2)", values: ms.map((m) => m.expenses) }], title: "Income and expenses by month" }), "All this stable's racecourses together")}
    ${panel("Profit, month by month", colChart({ labels: short, long, series: [{ name: "Profit", color: "var(--viz-1)", values: ms.map((m) => m.profit) }], signed: true, title: "Profit by month" }), "Above the line: made money · below: lost money")}</div>`;
  if (list.length > 1) {
    html += `<div class="grid cols-2" style="margin-top:16px">${panel("Income by racecourse", meterList(list.map((r) => ({ name: r.name, value: r.income_12m, share: tot.income ? r.income_12m / tot.income : null }))), "Last 12 months")}
      ${panel("Profit by racecourse", colChart({ labels: list.map((r) => r.name.length > 14 ? r.name.slice(0, 13) + "…" : r.name), long: list.map((r) => r.name), series: [{ name: "Profit", color: "var(--viz-1)", values: list.map((r) => r.profit_12m) }], signed: true, title: "Profit by racecourse" }), "Last 12 months")}</div>`;
  }
  html += `<div style="margin-top:16px">${panel("Racecourses owned", table([
    { h: "Racecourse", f: (r) => `${L.course(r.id, r.name)}${r.demolished ? ' <span class="badge dead">Demolished</span>' : ""}${r.for_sale ? ' <span class="badge">For sale</span>' : ""}<div class="muted small">${esc([r.city, r.country].filter(Boolean).join(", "))}</div>` },
    { h: "Capacity", cls: "num", f: (r) => fNum(r.capacity) },
    { h: "Licence", f: (r) => esc(r.licence || "—") },
    { h: "Track", cls: "num", f: (r) => (isNum(r.track_condition) ? fNum(r.track_condition, 0) + "%" : "—") },
    { h: "Facilities", cls: "num", f: (r) => (isNum(r.facilities) ? fNum(r.facilities, 0) + "%" : "—") },
    { h: "Meetings", cls: "num", f: (r) => fNum(r.meetings_12m) },
    { h: "Income", cls: "num", f: (r) => `${fMoney(r.income_12m)}<div class="muted small">${placeText(r.income_rank)}</div>` },
    { h: "Expenses", cls: "num", f: (r) => fMoney(r.expenses_12m) },
    { h: "Profit", cls: "num", f: (r) => `<span class="${r.profit_12m >= 0 ? "up" : "dn"}">${fMoney(r.profit_12m)}</span><div class="muted small">${placeText(r.profit_rank)}</div>` },
    { h: "Margin", cls: "num", f: (r) => pctTxt(r.income_12m ? r.profit_12m / r.income_12m : null) },
    { h: "", f: (r) => `<a href="#/course/${r.id}/finances">Finances</a> · <a href="#/course/${r.id}/upcoming">Races</a>` },
  ], list, { wide: true }), "Last 12 months (this month so far and the 11 before) · ranks are among all racecourses")}</div>`;
  return html;
}

async function courseFinancePage(route) {
  const id = route.parts[1];
  const [d, f] = await Promise.all([api("course/" + id), api("course_finances/" + id)]);
  const c = f.course, l = f.last12, p = f.prev12 || {}, cmp = p.complete;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let html = courseHead(d, "finances");
  const margin = (r) => (r.income ? r.profit / r.income : null);
  const pctTxt = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : "—");
  const perMeet = (v, n) => (n ? v / n : null);
  const tickets = (c.racecourse_last_month_vip_sold || 0) + (c.racecourse_last_month_normal_sold || 0) + (c.racecourse_last_month_standing_sold || 0);
  const fill = c.racecourse_last_month_race_days && c.racecourse_max_attendance ? tickets / c.racecourse_last_month_race_days / c.racecourse_max_attendance : null;
  // headline figures for the last 12 months, against the 12 before when the game still keeps those in detail
  html += tiles([
    ["Income", fMoneyShort(l.income), cmp ? deltaHtml(l.income, p.income) : "last 12 months"],
    ["Expenses", fMoneyShort(l.expenses), cmp ? deltaHtml(l.expenses, p.expenses, { lowerIsBetter: true }) : "prize money and running costs"],
    ["Profit", `<span class="${l.profit >= 0 ? "up" : "dn"}">${fMoneyShort(l.profit)}</span>`, `${pctTxt(margin(l))} of income kept${cmp && p.profit ? " · " + deltaHtml(l.profit, p.profit) : ""}`],
    ["Income per meeting", isNum(perMeet(l.income, l.meetings)) ? fMoneyShort(perMeet(l.income, l.meetings)) : "—",
      `${fNum(l.meetings)} meetings, ${fNum(l.races)} races${isNum(f.typical_per_meeting) ? ` · a typical racecourse takes ${fMoneyShort(f.typical_per_meeting)}` : ""}`],
    ["Income rank", placeText((f.rank || {}).income), `profit rank ${placeText((f.rank || {}).profit)} · among all racecourses`],
    ["Crowds last month", fNum(tickets), fill !== null ? `${pctTxt(fill)} of capacity per meeting` : "no meetings last month"],
  ]);
  if (!cmp && (p.income || p.expenses)) html += `<div class="stat-note" style="margin:-6px 0 12px">No comparison with the 12 months before: the game only keeps a yearly total for some of them.</div>`;
  // where the money comes from and goes
  const incRows = Object.entries(l.income_cats || {}).map(([k, v]) => ({ name: k, value: v, share: l.income ? v / l.income : null, color: INCOME_COLOR[incomeGroup(k)] || "var(--viz-other)",
    note: l.meetings ? `${fMoneyShort(v / l.meetings)} per meeting` : "" }));
  const groups = {};
  incRows.forEach((r) => { const g = incomeGroup(r.name); groups[g] = (groups[g] || 0) + r.value; });
  const split = splitBar(Object.keys(INCOME_COLOR).concat(["Other"]).map((n) => ({ name: n, value: groups[n] || 0, color: INCOME_COLOR[n] || "var(--viz-other)", dark: INCOME_DARK_TEXT[n] })));
  const expRows = Object.entries(l.expense_cats || {}).map(([k, v]) => ({ name: k, value: v, share: l.expenses ? v / l.expenses : null,
    note: l.meetings ? `${fMoneyShort(v / l.meetings)} per meeting` : "", color: "var(--viz-2)" }));
  html += `<div class="grid cols-2">${panel("Where the money comes from", split + meterList(incRows, { empty: "No income in the last 12 months." }), "Last 12 months")}
    ${panel("Where it goes", meterList(expRows, { empty: "No expenses in the last 12 months." }) + (l.surplus ? `<div class="stat-note" style="margin-top:10px">Also paid out as surplus: ${fMoney(l.surplus)} (not counted as an expense).</div>` : ""), "Last 12 months")}</div>`;
  // month by month
  const ms = f.months12 || [];
  const short = ms.map((m) => `${MON[m.month - 1]} ${String(m.year).slice(2)}`), long = ms.map((m) => `${MONTHS_LONG[m.month - 1]} ${m.year}`);
  const ie = (rows) => [{ name: "Income", color: "var(--viz-1)", values: rows.map((r) => r.income) }, { name: "Expenses", color: "var(--viz-2)", values: rows.map((r) => r.expenses) }];
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Income and expenses, month by month", colChart({ labels: short, long, series: ie(ms), title: "Income and expenses by month" }), "Last 12 months · by the month the money was paid")}
    ${panel("Profit, month by month", colChart({ labels: short, long, series: [{ name: "Profit", color: "var(--viz-1)", values: ms.map((m) => m.profit) }], signed: true, title: "Profit by month" }), "Above the line: made money · below: lost money")}</div>`;
  const topCat = (cats) => { const e = Object.entries(cats || {}).sort((a, b) => b[1] - a[1])[0]; return e ? `${esc(e[0])} <span class="muted small">${fMoneyShort(e[1])}</span>` : '<span class="muted">—</span>'; };
  html += `<div style="margin-top:16px">${panel("Income by type, month by month", colChart({ labels: short, long, series: incomeStack(ms), stacked: true, total: "Total income", title: "Income by type by month", wide: true }) + table([
      { h: "Month", f: (m) => `<b>${MONTHS_LONG[m.month - 1]} ${m.year}</b>` },
      { h: "Meetings", cls: "num", f: (m) => (m.meetings ? fNum(m.meetings) : '<span class="muted">—</span>') },
      { h: "Races", cls: "num", f: (m) => (m.races ? fNum(m.races) : '<span class="muted">—</span>') },
      { h: "Income", cls: "num", f: (m) => fMoney(m.income) }, { h: "Biggest income", f: (m) => topCat(m.income_cats) },
      { h: "Expenses", cls: "num", f: (m) => fMoney(m.expenses) }, { h: "Biggest expense", f: (m) => topCat(m.expense_cats) },
      { h: "Profit", cls: "num", f: (m) => `<span class="${m.profit >= 0 ? "up" : "dn"}">${fMoney(m.profit)}</span>` },
    ], ms.slice().reverse()), "Tickets, food, media rights, subsidy and running costs are paid once a month, often the month after the meetings they're for")}</div>`;
  // year by year
  const ys = f.years || [];
  const yl = ys.map((y) => String(y.year));
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Income and expenses, year by year", colChart({ labels: yl, series: ie(ys), title: "Income and expenses by year" }), "Calendar years")}
    ${panel("Profit, year by year", colChart({ labels: yl, series: [{ name: "Profit", color: "var(--viz-1)", values: ys.map((y) => y.profit) }], signed: true, title: "Profit by year" }), "Above the line: made money · below: lost money")}</div>`;
  html += `<div style="margin-top:16px">${panel("Year by year", table([
      { h: "Year", f: (y) => `<b>${y.year}</b>${y.itemised ? "" : ' <span class="muted small" title="The game only keeps a yearly total of these payments">yearly total</span>'}` },
      { h: "Meetings", cls: "num", f: (y) => fNum(y.meetings) }, { h: "Races", cls: "num", f: (y) => fNum(y.races) },
      { h: "Income", cls: "num", f: (y) => fMoney(y.income) }, { h: "Expenses", cls: "num", f: (y) => fMoney(y.expenses) },
      { h: "Profit", cls: "num", f: (y) => `<span class="${y.profit >= 0 ? "up" : "dn"}">${fMoney(y.profit)}</span>` },
      { h: "Margin", cls: "num", f: (y) => pctTxt(margin(y)) },
      { h: "Per meeting", cls: "num", f: (y) => (isNum(y.per_meeting_income) ? fMoneyShort(y.per_meeting_income) : "—") },
      { h: "Per race", cls: "num", f: (y) => (y.races ? fMoneyShort(y.income / y.races) : "—") },
      { h: "Prize money", cls: "num", f: (y) => (y.itemised && y.prize_paid ? `${fMoneyShort(y.prize_paid)} <span class="muted small">${pctTxt(y.income ? y.prize_paid / y.income : null)}</span>` : '<span class="muted">—</span>') },
      { h: "Surplus paid out", cls: "num", f: (y) => (y.surplus ? fMoney(y.surplus) : '<span class="muted">—</span>') },
    ], ys.slice().reverse(), { empty: "No money recorded for this racecourse yet." }), "Margin is the share of income kept as profit · prize money also shows its share of income · years marked “yearly total” only have one total in the save")}</div>`;
  const itemYears = ys.filter((y) => y.itemised && (y.income || y.expenses)).slice(-6);
  if (itemYears.length) {
    const cats = (key) => [...new Set(itemYears.flatMap((y) => Object.keys(y[key])))];
    const rowsFor = (key, label) => cats(key).map((cat) => ({ cat, label, vals: itemYears.map((y) => y[key][cat] || 0) }));
    html += `<div style="margin-top:16px">${panel("By type, year by year", table([{ h: "", f: (r) => `${esc(r.cat)} <span class="muted small">${r.label.toLowerCase()}</span>` }]
      .concat(itemYears.map((y, k) => ({ h: String(y.year), cls: "num", f: (r) => (r.vals[k] ? fMoney(r.vals[k]) : '<span class="muted">—</span>') }))),
      rowsFor("income_cats", "Income").concat(rowsFor("expense_cats", "Expense"))), "The years the game keeps every payment for")}</div>`;
  }
  // meetings
  html += `<div style="margin-top:16px">${panel("Meetings", table([
      { h: "Date", cls: "nowrap", f: (m) => L.race(m.first_race_id, fDate(m.date)) }, { h: "Meeting", f: (m) => esc(m.name || "") },
      { h: "Races", cls: "num", f: (m) => fNum(m.races) }, { h: "Runners", cls: "num", f: (m) => (m.runners ? fNum(m.runners) : '<span class="muted">—</span>') },
      { h: "Biggest race", f: (m) => (m.top_race_id ? `${L.race(m.top_race_id, m.top_race_name)} ${grade(m.top_grade)}` : "—") },
      { h: "Total purses", cls: "num", f: (m) => (m.purse ? fMoney(m.purse) : '<span class="muted">—</span>') },
      { h: "Betting commission", cls: "num", f: (m) => (isNum(m.betting) ? fMoney(m.betting) : '<span class="muted">—</span>') },
      { h: "Prize money paid", cls: "num", f: (m) => (isNum(m.prizes) ? fMoney(m.prizes) : '<span class="muted">—</span>') },
    ], f.meetings || [], { empty: "No meetings yet." }), "Money paid on the day itself; tickets, food, media rights, subsidy and running costs are settled monthly")}</div>`;
  // prices and budgets against the average racecourse
  const av = f.averages || {};
  const vsAvg = (k, money = true) => {
    const v = c[k], a = av[k];
    if (!isNum(v)) return "—";
    const val = money ? fMoney(v) : fNum(v);
    if (!isNum(a) || !a) return val;
    const ch = (v - a) / a;
    return `${val} <span class="stat-note">${Math.abs(ch) < 0.03 ? "about average" : `${ch > 0 ? "▲" : "▼"} ${Math.round(Math.abs(ch) * 100)}% vs average ${fMoney(a)}`}</span>`;
  };
  const pct = (v) => (isNum(v) ? `${fNum(100 * v, 1)}%` : "—");
  html += `<div class="grid cols-3" style="margin-top:16px">
    ${panel("Prices", kv([["VIP ticket", vsAvg("racecourse_vip_ticket_price")], ["Normal ticket", vsAvg("racecourse_normal_ticket_price")], ["Standing ticket", vsAvg("racecourse_standing_ticket_price")],
      ["Parking", vsAvg("racecourse_parking_price")], ["Food", vsAvg("racecourse_food_price")], ["Drink", vsAvg("racecourse_drink_price")]]), "Against the average racecourse")}
    ${panel("Budgets", kv([["Staff", vsAvg("racecourse_staff_budget")], ["Maintenance", vsAvg("racecourse_maintenance_budget")], ["Marketing", vsAvg("racecourse_marketing_budget")],
      ["Prize pool contribution", vsAvg("racecourse_prize_pool_contribution")], ["Monthly dividend", isNum(c.racecourse_monthly_dividend) ? fMoney(c.racecourse_monthly_dividend) : "—"]]), "Against the average racecourse")}
    ${panel("Business", kv([["Owner", f.owner ? L.stable(f.owner.id, f.owner.name) : "—"],
      ["Betting commission rate", !isNum(c.racecourse_betting_commission_rate) ? "—" : c.racecourse_betting_commission_rate < 1 ? pct(c.racecourse_betting_commission_rate) : `${fNum(c.racecourse_betting_commission_rate, 2)}%`],
      ["Media rights multiplier", fNum(c.racecourse_media_rights_multiplier, 2)], ["Licence", `${esc(c.racecourse_licence_grade || "—")}${c.racecourse_licence_expires ? ` · until ${fDate(c.racecourse_licence_expires)}` : ""}`],
      ["Tickets sold last month", `VIP ${fNum(c.racecourse_last_month_vip_sold)} · normal ${fNum(c.racecourse_last_month_normal_sold)} · standing ${fNum(c.racecourse_last_month_standing_sold)}`],
      ["For sale", c.racecourse_for_sale ? `Yes · asking ${fMoney(c.racecourse_asking_price)}` : "No"]]))}</div>`;
  if ((f.monthly || []).length) {
    const m = f.monthly;
    html += `<div class="grid cols-2" style="margin-top:16px">${panel("The racecourse's own monthly figures", lineChart([
        { name: "Income", color: "#257de0", points: m.map((x) => [x.date, x.income]) }, { name: "Costs", color: "#f47230", points: m.map((x) => [x.date, x.costs]) }], { yFmt: fMoneyShort, tipFmt: fMoney }), "As the game records them each month")}
      ${panel("Value and cash", lineChart([{ name: "Value", color: "#257de0", points: m.map((x) => [x.date, x.value]) }, { name: "Cash", color: "#00b894", points: m.map((x) => [x.date, x.cash]) }], { yFmt: fMoneyShort, tipFmt: fMoney }), "What the racecourse is worth, and its cash")}</div>`;
  }
  if ((f.sponsors || []).length) html += `<div style="margin-top:16px">${panel("Sponsors", sponsorTable(f.sponsors, [{ h: "Deal", f: (r) => esc(nice(r.type)) }]), "Companies sponsoring this racecourse")}</div>`;
  return html;
}

async function coursePage(id, preloaded) {
  const d = preloaded || await api("course/" + id);
  const c = d.course;
  const tracks = ["outer_oval", "center_oval", "inner_oval"].filter((t) => c[`racecourse_${t}_track_surface`])
    .map((t) => [esc(t.replace("_", " ").replace(/^./, (x) => x.toUpperCase())), `${esc(c[`racecourse_${t}_track_surface`])} · ${fDist(c[`racecourse_${t}_track_distance`])}`]);
  if (c.racecourse_straight_track_material) tracks.push(["Straight", `${esc(c.racecourse_straight_track_material)} · ${fDist(c.racecourse_straight_track_distance)}`]);
  let html = courseHead(d, "overview");
  html += tiles([
    ["Capacity", fNum(c.racecourse_max_attendance)], ["Direction", esc(c.racecourse_direction || "—")],
    ["Track condition", fNum(c.racecourse_condition_of_track, 0) + "%"], ["Facilities", fNum(c.racecourse_condition_of_facilities, 0) + "%"],
    ["Awareness", fNum(c.racecourse_awareness, 0)], ["Built", fDate(c.racecourse_build_date)],
  ]);
  // the business at a glance (16.7.9): the last 12 months, its place among racecourses, and profit month by month
  const f = await api("course_finances/" + id).catch(() => null);
  if (f && f.last12) {
    const l = f.last12, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], ms = f.months12 || [];
    const tickets = (c.racecourse_last_month_vip_sold || 0) + (c.racecourse_last_month_normal_sold || 0) + (c.racecourse_last_month_standing_sold || 0);
    const fill = c.racecourse_last_month_race_days && c.racecourse_max_attendance ? tickets / c.racecourse_last_month_race_days / c.racecourse_max_attendance : null;
    html += `<div class="grid cols-2">${panel("Business, last 12 months", kv([
        ["Income", `${fMoney(l.income)} <span class="stat-note">${placeText((f.rank || {}).income)} of racecourses</span>`],
        ["Expenses", fMoney(l.expenses)],
        ["Profit", `<span class="${l.profit >= 0 ? "up" : "dn"}">${fMoney(l.profit)}</span> <span class="stat-note">${placeText((f.rank || {}).profit)}</span>`],
        ["Meetings", `${fNum(l.meetings)} · ${fNum(l.races)} races`],
        ["Income per meeting", l.meetings ? fMoney(l.income / l.meetings) : "—"],
        ["Crowds last month", `${fNum(tickets)} tickets${fill !== null ? ` · ${Math.round(fill * 100)}% of capacity per meeting` : ""}`],
      ]) + `<div style="margin-top:10px"><a class="btn" href="#/course/${id}/finances">Finances</a></div>`, "Payments the game keeps in detail")}
      ${panel("Profit, month by month", colChart({ labels: ms.map((m) => `${MON[m.month - 1]} ${String(m.year).slice(2)}`), long: ms.map((m) => `${MONTHS_LONG[m.month - 1]} ${m.year}`),
        series: [{ name: "Profit", color: "var(--viz-1)", values: ms.map((m) => m.profit) }], signed: true, height: 200, title: "Profit by month" }), "Last 12 months")}</div><div style="height:16px"></div>`;
  }
  const dayCols = [
    { h: "Date", cls: "nowrap", f: (r) => L.race(r.first_race_id, fDate(r.date)) }, { h: "Meeting", f: (r) => esc(r.name || "") },
    { h: "Races", cls: "num", f: (r) => fNum(r.races) },
    { h: "Top race", f: (r) => (r.top_race_id ? `${grade(r.top_grade)} ${L.race(r.top_race_id, r.top_race_name)}` : '<span class="muted">—</span>') },
    { h: "Weather", f: (r) => esc(r.weather || "") },
  ];
  html += `<div class="grid cols-3">${panel("Tracks", tracks.length ? kv(tracks) : '<div class="empty">No track details.</div>')}
    ${panel("People", kv([["Owner", d.owner ? L.stable(d.owner.id, d.owner.name) : "—"], ["Manager", d.manager ? L.person(d.manager.id, d.manager.name) : "—"]]))}
    ${panel("Tickets", kv([["VIP", fMoney(c.racecourse_vip_ticket_price)], ["Normal", fMoney(c.racecourse_normal_ticket_price)], ["Standing", fMoney(c.racecourse_standing_ticket_price)]]))}</div>
    <div class="grid cols-2" style="margin-top:16px">
    ${panel("Recent meetings", table(dayCols, d.recent_days.slice(0, 20), { empty: "None yet." }), `<a href="#/races?course=${c.racecourse_racecourse_id}">All results here</a>`)}
    ${panel("Upcoming meetings", table(dayCols, d.upcoming_days.slice(0, 20), { empty: "None scheduled." }))}
    ${panel("Feature races", table([
      { h: "Race", f: (r) => `${L.race(r.race_id, r.name)} ${grade(r.race_type)}` }, { h: "Distance", cls: "num", f: (r) => fDist(r.distance) },
    ], d.big_races, { empty: "No group or listed races." }), "", "span-2")}</div>`;
  if ((d.sponsors || []).length) html += `<div style="margin-top:16px">${panel("Sponsors", sponsorTable(d.sponsors, [{ h: "Deal", f: (r) => esc(nice(r.type)) }]), "Companies sponsoring this racecourse")}</div>`;
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
  const list = `<section class="panel list"><input type="search" id="tfilter" placeholder="Search ${TABLES_CACHE.length} tables">
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
  const flt = d.columns.map((c) => `<th><input data-f="${esc(c)}" value="${esc(q["f." + c] || "")}" placeholder="Search"></th>`).join("");
  const body = d.rows.map((r, i) => `<tr data-i="${i}">${r.map((v, j) => `<td class="${v === null ? "null" : ""}">${fieldValue(d.columns[j], v, DATES_ON)}</td>`).join("")}</tr>`).join("");
  const anyFilter = Object.keys(q).some((k) => k.startsWith("f.") && q[k]) || q.q;
  APP._rawData = d;
  const rawExp = `<a class="btn btn-csv" href="/api/export/raw/${encodeURIComponent(name)}?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([k]) => !["page", "size"].includes(k))))}" download data-tip="Download every matching row of this table (all pages, with your filters and sort) as a spreadsheet (CSV) file">${ICON_DL}Export CSV</a>`;
  return settingsTabs("tables") + `<div class="page-head"><div><div class="crumb"><a href="#/tables">All tables</a></div><h1>${esc(name)}</h1>
    <div class="sub">${fNum(d.total)} rows${anyFilter ? " match" : ""} · ${d.columns.length} columns</div></div>
    <div class="filters" style="margin:0"><input type="search" data-q="q" value="${esc(q.q || "")}" placeholder="Search this table">
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
// stables you own (yours, and ones your stables own), not ones you only manage or hold shares in
const ownedStableIds = () => new Set(((STATUS && STATUS.my_stables) || []).filter((s) => s.mine && !/^(Manager|Assistant manager)$/.test(s.role)).map((s) => s.id));
async function pedigreesPage(route) {
  const q = route.q, kind = q.kind || "sires";
  const owned = ownedStableIds();
  const offspring = kind === "damsires" ? "Grand-foals" : "Foals";
  const tablesLink = (r) => kind === "damsires" ? "" : ` <a class="small" href="#/horse-table?${kind === "dams" ? "dam" : "sire"}=${r.id}&status=all" title="All foals in the Horse table">foals ↗</a>`;
  const years = [["", "Any year"]];
  const gy = new Date(GD() * 1000).getUTCFullYear();
  for (let y = gy; y >= gy - 40; y--) years.push([String(y), String(y)]);
  return listPage({
    title: "Pedigrees", noun: KIND_LABEL[kind].toLowerCase(), endpoint: "pedigrees", defaultSort: "earnings", ascDefault: ["name"],
    exportName: "pedigrees", wide: true, intro: KIND_INTRO[kind],
    filters: (q) => viewSeg("kind", q, [["sires", "Sires"], ["dams", "Dams"], ["damsires", "Broodmare sires"]], "sires") +
      searchBox(q, "Search horses") + statusSeg("horse", q, "all") +
      select("osex", q, [["", "Any sex of foal"], ["Male", "Colts only"], ["Female", "Fillies only"]]) +
      select("minrunners", q, [["", "Any runners"], ["1", "1+ runners"], ["5", "5+ runners"], ["10", "10+ runners"], ["25", "25+ runners"], ["50", "50+ runners"], ["100", "100+ runners"]]) +
      rangeBox(`${offspring} foaled`, select("from", q, years), select("to", q, years)) +
      (owned.size ? select("mine", q, [["", "Any stable"], ["1", "Your stables only"]]) : ""),
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
      { h: "Stable", f: (r) => L.stable(r.stable_id, r.stable) + (owned.has(r.stable_id) ? ' <span class="badge good">Yours</span>' : "") },
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
    ascDefault: ["name", "gender", "stable", "sire", "dam", "earn_pct"], exportName: "horse_table", wide: true,
    intro: "Click any column heading to sort. Export CSV downloads every matching horse, not just this page.",
    filters: (q) => searchBox(q, "Search horses") + searchBox(q, "Search stables", "stableq") + statusSeg("horse", q, "alive") +
      select("gender", q, [["", "Any sex"], ["Colt", "Colts"], ["Filly", "Fillies"], ["Stallion", "Stallions"], ["Mare", "Mares"], ["Gelding", "Geldings"]]) +
      select("minstarts", q, [["", "Any starts"], ["1", "Raced"], ["5", "5+ starts"], ["10", "10+ starts"], ["20", "20+ starts"]]) +
      select("stakes", q, [["", "Any class"], ["1", "Stakes winners only"]]) + select("tag", q, tagFilterOpts()) +
      rangeBox("Age", `<input type="number" min="0" data-q="agemin" value="${esc(q.agemin || "")}" placeholder="any" aria-label="Youngest age">`,
        `<input type="number" min="0" data-q="agemax" value="${esc(q.agemax || "")}" placeholder="any" aria-label="Oldest age">`) + chip,
    cols: [
      { h: "Horse", sort: "name", f: (r) => `${horseThumb(r.id)}${L.horse(r.id, r.name)}${horseTagsHtml(r.id, true, r.auto)}` },
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
      { h: "Fans", sort: "fans", cls: "num grp-start", f: (r) => fShortN(r.fans) },
      { h: `<span data-tip="Best world fan ranking it has reached: Fan website (top 100), Supporters' club (top 50), Fan club trips (top 20), Superfans (top 10), No. 1">Fan level</span>`, f: (r) => { const st = fanStep(r.fan_band); if (!st) return '<span class="muted">—</span>'; const a = r.auto || {}, was = fanWas(st[0], a.rank, r.died); return esc(st[1]) + (was ? ` <span class="muted small" data-tip="It reached the top ${st[0]} but isn't there any more">(${was})</span>` : ""); } },
      { h: "Sponsor", sort: "sponsor_pay", f: (r) => (r.sponsor ? `${esc(r.sponsor)} <span class="muted small">${fMoneyShort(r.sponsor_pay)}/mo</span>` : '<span class="muted">—</span>') },
      { h: `<span data-tip="Where its career earnings rank among all horses, as the game works it out">Earnings rank</span>`, sort: "earn_pct", cls: "num", f: (r) => (isNum(r.earn_pct) ? pctTop(r.earn_pct) : '<span class="muted">—</span>') },
      { h: `<span data-tip="How its family's earnings compare with other horses'">Pedigree</span>`, sort: "ped_pct", cls: "num", f: (r) => (isNum(r.ped_pct) ? pctBetter(r.ped_pct) : '<span class="muted">—</span>') },
      { h: "Colour", f: (r) => esc(r.color || "") },
    ],
  }, route);
}

// ------------------------------------------------------------------ v2: Stable table tab
// ------------------------------------------------------------------ stable rankings: league tables like the game's own
// a country's flag from its two-letter code (drawn with the bundled flag font, since Windows has no flag emoji)
const flagOf = (iso2) => (/^[A-Za-z]{2}$/.test(iso2 || "") ? String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");
const SR_MONEY = (k) => (r) => fMoney(r[k]);
const SR_N = (k) => (r) => fNum(r[k]);
const SR_TABS = [
  { k: "earnings", t: "Cash earnings", intro: (y) => `Prize money won by each stable's horses ${y ? "in " + y : "over all time"}, with their record.`, cols: [
    { h: "Prize money", sort: "prize", f: SR_MONEY("prize") }, { h: "Races", sort: "starts", f: SR_N("starts") }, { h: "Wins", sort: "wins", f: SR_N("wins") },
    { h: "Win %", sort: "winpct", f: (r) => (isNum(r.winpct) ? fNum(r.winpct, 0) + "%" : "—") }, { h: "Places", sort: "places", f: SR_N("places"), tip: "Finished 1st, 2nd or 3rd" },
    { h: "Group wins", sort: "group", f: (r) => (r.group ? `${fNum(r.group)} <span class="muted small">${[["G1", r.g1], ["G2", r.g2], ["G3", r.g3]].filter((x) => x[1]).map(([g, n]) => `${n}×${g}`).join(" ")}</span>` : "0") },
    { h: "Listed wins", sort: "listed", f: SR_N("listed") }] },
  { k: "times", t: "Times", intro: (y) => `Course records: the fastest winning time at each course, track and distance. <b>Held now</b> counts records nobody has beaten since; <b>Set</b> counts every record run ${y ? "in " + y : "over all time"}, including ones since broken.`, cols: [
    { h: "Records held", sort: "held", f: SR_N("held") }, { h: "Courses", sort: "courses", f: SR_N("courses"), tip: "Different racecourses where they hold a record" },
    { h: "Records set", sort: "set_count", f: SR_N("set_count") }, { h: "Latest record", sort: "last_set", f: (r) => (r.last_set ? fDate(r.last_set) : "—"), date: true }] },
  { k: "staff", t: "Staff", intro: () => "Everyone working for each stable now, by job, and what they're paid a year.", cols: [
    { h: "Staff", sort: "staff", f: SR_N("staff") }, { h: "Jockeys", sort: "jockeys", f: SR_N("jockeys") }, { h: "Trainers", sort: "trainers", f: SR_N("trainers"), tip: "Trainers and head trainers" },
    { h: "Managers", sort: "managers", f: SR_N("managers"), tip: "Managers and assistant managers" }, { h: "Stablehands", sort: "stablehands", f: SR_N("stablehands") },
    { h: "Scouts", sort: "scouts", f: SR_N("scouts") }, { h: "Wages a year", sort: "wages", f: SR_MONEY("wages") }] },
  { k: "prestige", t: "Prestige", intro: () => "Prestige now, and how each stable has moved up or down the prestige table since the year began.", cols: [
    { h: "Prestige", sort: "prestige", f: (r) => fNum(r.prestige, 0) },
    { h: "Since Jan 1", sort: "move", f: (r) => (!isNum(r.move) ? "—" : r.move > 0 ? `<span class="up">▲ ${fNum(r.move)}</span>` : r.move < 0 ? `<span class="down">▼ ${fNum(-r.move)}</span>` : `<span class="muted">–</span>`), tip: "Places gained or lost in the prestige table since the start of the year" },
    { h: "Rank on Jan 1", sort: "start_rank", f: SR_N("start_rank"), asc: true }, { h: "Gained this year", sort: "this_year", f: (r) => fNum(r.this_year, 0) },
    { h: "Fame", sort: "fame", f: (r) => fNum(r.fame, 0) }, { h: "Experience", sort: "experience", f: (r) => fNum(r.experience, 0) },
    { h: "Legacy", sort: "legacy", f: (r) => fNum(r.legacy, 0) }, { h: "Level", sort: "level", f: SR_N("level") }] },
  { k: "horses", t: "Horses", intro: () => "Horses each stable has now, by age at today's game date.", cols: [
    { h: "Horses", sort: "horses", f: SR_N("horses") }, { h: "Foals", sort: "foals", f: SR_N("foals"), tip: "Under a year old" }, { h: "Yearlings", sort: "yearlings", f: SR_N("yearlings") },
    { h: "2yo", sort: "two_yo", f: SR_N("two_yo") }, { h: "3yo+", sort: "older", f: SR_N("older") }, { h: "Mares in foal", sort: "in_foal", f: SR_N("in_foal") },
    { h: "At stud", sort: "at_stud", f: SR_N("at_stud") }, { h: "Avg rating", sort: "avg_rating", f: (r) => fNum(r.avg_rating, 0) },
    { h: "Top rating", sort: "top_rating", f: (r) => fNum(r.top_rating, 0) }, { h: "Horses' value", sort: "horses_value", f: SR_MONEY("horses_value") }] },
  { k: "traders", t: "Traders", intro: (y) => `Horses bought and sold ${y ? "in " + y : "over all time"}, at auction and privately, ranked by profit (sales less purchases).`, cols: [
    { h: "Profit", sort: "profit", f: (r) => `<span class="${(r.profit || 0) < 0 ? "down" : ""}">${fMoney(r.profit)}</span>` }, { h: "Sold", sort: "sold", f: SR_N("sold") },
    { h: "Sales", sort: "sales", f: SR_MONEY("sales") }, { h: "Bought", sort: "bought", f: SR_N("bought") }, { h: "Spent", sort: "spent", f: SR_MONEY("spent") }] },
  { k: "breeders", t: "Breeders", intro: () => "Every foal each stable has bred, and how they've done on the track (whoever owns them now).", cols: [
    { h: "Their earnings", sort: "earnings", f: SR_MONEY("earnings"), tip: "Career prize money of every horse the stable bred" }, { h: "Foals bred", sort: "foals", f: SR_N("foals") },
    { h: "Runners", sort: "runners", f: SR_N("runners") }, { h: "Winners", sort: "winners", f: SR_N("winners") },
    { h: "Stakes winners", sort: "stakes_winners", f: SR_N("stakes_winners") }, { h: "G1 winners", sort: "g1_winners", f: SR_N("g1_winners") }] },
  { k: "value", t: "Value", intro: () => "What each stable is worth: its market value (or what it owns less what it owes, if it has none), with horses, property (racecourses and auction houses), cash and loans from its latest monthly figures.", cols: [
    { h: "Value", sort: "value", f: (r) => `<span class="sr-val">${fMoney(r.value)}</span>` }, { h: "Horses", sort: "horses", f: SR_MONEY("horses") },
    { h: "Property", sort: "property", f: SR_MONEY("property") }, { h: "Cash", sort: "cash", f: (r) => `<span class="${(r.cash || 0) < 0 ? "down" : "sr-val"}">${fMoney(r.cash)}</span>` },
    { h: "Loans", sort: "loans", f: SR_MONEY("loans") }, { h: "Net worth", sort: "net_worth", f: SR_MONEY("net_worth"), tip: "What it owns less what it owes" }] },
];
const SR_YEAR_TABS = ["earnings", "times", "traders"];
async function stableRankingsPage(route) {
  const q = route.q, tab = SR_TABS.find((t) => t.k === q.tab) || SR_TABS[SR_TABS.length - 1];
  const d = await api("stable_rankings?" + new URLSearchParams(withSize({ ...q, tab: tab.k })));
  const blank = new Set(d.blank || []);
  const mine = new Set(((STATUS && STATUS.my_stables) || []).map((x) => x.id));
  const tabs = `<div class="sr-tabs" role="tablist">${SR_TABS.map((t) => `<a role="tab" class="${t.k === tab.k ? "on" : ""}" href="${hashFor(["stable-rankings"], { tab: t.k, q: q.q, mine: q.mine })}">${t.t}</a>`).join("")}</div>`;
  const years = SR_YEAR_TABS.includes(tab.k) ? select("year", { year: q.year !== undefined ? q.year : String(d.year || "all") }, yearOptions(d.years, "all"), "Which year") : "";
  const cols = [
    { h: "#", sort: "rank", cls: "num sr-rank", f: (r) => fNum(r.rank) },
    { h: "Stable", sort: "name", cls: "nowrap", f: (r) => `${L.stable(r.id, r.name)}${mine.has(r.id) ? ' <span class="badge good">You</span>' : ""}` },
    { h: "Owner", sort: "owner", f: (r) => (r.owner_id ? L.person(r.owner_id, r.owner) : "—") },
    ...tab.cols.filter((c) => !blank.has(c.sort)).map((c) => ({ h: c.tip ? `<span data-tip="${esc(c.tip)}">${c.h}</span>` : c.h, sort: c.sort, cls: c.date ? "nowrap" : "num", f: c.f })),
    { h: "Country", sort: "country", f: (r) => (r.country ? `<span class="flag" title="${esc(r.country)}">${flagOf(r.iso2)}</span> ${esc(r.country)}` : "—") },
  ];
  const yr = SR_YEAR_TABS.includes(tab.k) ? d.year : null;
  return `<div class="page-head"><div><h1>Stable rankings</h1><div class="sub">${esc(tab.t)} · ${fNum(d.total)} stables${yr ? " · " + yr : SR_YEAR_TABS.includes(tab.k) ? " · all time" : ""}</div></div></div>
    <section class="panel">${tabs}<div class="filters">${searchBox(q, "Search stables or owners")}${seg("mine", q, [["1", "Your stables"], ["", "All stables"]], "")}${years}</div>
    <div class="note-line">${tab.intro(yr)} Click a heading to sort; the rank stays by ${esc(tab.cols[0].h.toLowerCase())}.</div>
    ${table(cols, d.rows, { sort: q.sort || "rank", dir: q.dir || (["rank", "name", "owner", "country", "start_rank"].includes(q.sort || "rank") ? "asc" : "desc"),
      ascCols: ["rank", "name", "owner", "country", "start_rank"], rowClass: (r) => (mine.has(r.id) ? "me" : ""), empty: q.mine ? "None of your stables are open." : "No stables match.", tcls: "sr-table" })}
    ${pager(d)}</section>`;
}

async function stableTablePage(route) {
  let countries = [];
  return listPage({
    title: "Stable table", noun: "stables", endpoint: "stable_table", defaultSort: "prestige", ascDefault: ["name", "owner", "country"],
    exportName: "stable_table", wide: true, rankCol: true,
    intro: "Race figures cover every result recorded under each stable. Cash and net worth are from each stable's latest monthly report.",
    filters: (q, data) => searchBox(q, "Search stables") + statusSeg("stable", q, "active") +
      select("country", q, [["", "Any country"]].concat((data.countries || countries).map((c) => [c, c]))) +
      select("minhorses", q, [["", "Any size"], ["1", "1+ horses"], ["5", "5+ horses"], ["10", "10+ horses"], ["25", "25+ horses"], ["50", "50+ horses"]]),
    cols: [
      { h: "Stable", sort: "name", cls: "nowrap", f: (r) => `${L.stable(r.id, r.name)}${r.liquidated ? ' <span class="badge dead">Closed</span>' : ""}${r.id === (STATUS.player_stable || {}).id ? ' <span class="badge good">Yours</span>' : ""}` },
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
      `<a href="#/${r.type}/${r.id}${r.note ? "/fans" : ""}"${r.note ? ' class="sr-note"' : ""}><span>${esc(r.name)}</span><span class="kind">${r.note ? "" : (r.type === "course" ? "racecourse" : r.type)}${r.extra ? (r.note ? "" : " · ") + esc(r.extra) : ""}</span></a>`).join("")
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
function openLoad(resume) {
  if ($("#load-ov")) return;
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
      <div class="row"><input type="text" id="load-path" value="${esc(last || "")}" placeholder="${pathHint("database.db")}"><button class="btn primary" id="load-path-btn">Load</button></div>
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
        if (decision === "cancel" && resume === true) { ov.remove(); return; }   // asked after an automatic load: nothing else to do here
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
  if (resume === true) { busy(true); setP(0, "Your save needs a decision"); poll(); }
}
window.openLoad = openLoad;
$("#load-btn").addEventListener("click", () => openLoad());

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
    else working("Installed. Close HRM Viewer and open it again to finish.");
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
let LOAD_ASKED = null;   // the automatic load whose question was already shown (closing it doesn't bring it back)
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
    // an automatic load found a different player or save: show the question
    if (a.job === "confirm" && a.job_auto && !$("#load-ov") && LOAD_ASKED !== a.job_started) { LOAD_ASKED = a.job_started; openLoad(true); }
  }
  const fast = a && (a.state === "updating" || a.state === "waiting" || a.running);
  AUTO_TIMER = setTimeout(autoPoll, soon || fast ? 2500 : 10000);
}
document.addEventListener("click", (e) => { if (e.target.closest("#auto-ind")) location.hash = "#/settings?s=save"; });

// ------------------------------------------------------------------ export any table to CSV
function tableToCsv(tbl) {
  const clean = (el) => (el.offsetParent !== null ? el.innerText : el.textContent).replace(/[▲▼▸▾⤓]/g, "").replace(/\s*\n\s*(of \d)/g, " $1").replace(/\s*\n\s*/g, " · ").replace(/\s+/g, " ").trim();
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const hr = tbl.tHead.rows;
  let head = [...hr[hr.length - 1].cells].map(clean);
  if (hr.length > 1) {     // group headings: "Jockey Wins", "Trainer Wins", ...
    const grp = [];
    for (const c of hr[0].cells) for (let i = 0; i < (c.colSpan || 1); i++) grp.push(c.textContent.trim());
    head = head.map((h, i) => (grp[i] && h ? `${grp[i]} ${h}` : h));
  }
  const keep = head.map((h) => h !== "");
  const lines = [head.filter((_, i) => keep[i]).map(q).join(",")];
  // every visible body (tables like Month by month keep one body per year and show one at a time)
  const trs = [...tbl.tBodies].filter((tb) => !tb.hidden).flatMap((tb) => [...tb.rows]);
  for (const tr of trs) {
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
      tool.innerHTML = `<span class="tf"><input type="search" class="tbl-filter" placeholder="Search this table" aria-label="Search this table"><span class="tf-n muted small"></span></span>`;
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
// sortable column headings can be reached with Tab and sorted with Enter or Space
function markSortable(root) {
  for (const tbl of root.querySelectorAll("table.data:not([data-kb])")) {
    tbl.dataset.kb = "1";
    if (!tbl.tHead || !tbl.tHead.rows.length) continue;
    const row = tbl.tHead.rows[tbl.tHead.rows.length - 1];
    for (const th of row.cells) {
      const server = th.hasAttribute("data-sort"), client = !tbl.classList.contains("nosort") && th.colSpan === 1 && th.textContent.trim();
      if (!server && !client) continue;
      th.tabIndex = 0;
      if (th.classList.contains("sorted")) th.setAttribute("aria-sort", /▲/.test(th.textContent) ? "ascending" : "descending");
    }
  }
}
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("table.data > thead th[tabindex]")) { e.preventDefault(); e.target.click(); }
});
new MutationObserver(() => { addCsvButtons(APP); markSortable(APP); }).observe(APP, { childList: true, subtree: true });
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
  const tabs = `<div class="filters">${viewSeg("view", q, [["years", "Year by year"], ["winners", "Most awards"]], "years")}
    ${view === "years" ? select("group", q, [["all", "Any award"]].concat(d.groups.map((g) => [g.key, g.title]))) : ""}
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
  // charts pick their line colours for the mode when drawn, so redraw any on screen
  $$(".chartbox").forEach((b) => { if (CHARTS[b.id]) b.innerHTML = chartInner(b.id); });
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
    <a href="#/tables" class="${on === "tables" ? "on" : ""}">All tables</a><a href="#/shortcuts" class="${on === "shortcuts" ? "on" : ""}">Shortcuts</a><a href="#/tags" class="${on === "tags" ? "on" : ""}">Tags</a><a href="#/versions" class="${on === "versions" ? "on" : ""}">Versions &amp; changes</a></div>`;
}
// Settings → General, laid out again in 16.7.11: one column of sections with a menu beside it to jump between them,
// short descriptions (the longer explanations are behind "More about this"), and each section says where it's kept
const SET_SECTIONS = [["stable", "Your stable"], ["look", "Look"], ["pages", "Pages & tables"], ["season", "Racing season"],
  ["save", "Your save file"], ["storage", "Stored data"], ["app", "HRM Viewer app"]];
const setRow = (title, help, control, more) => `<div class="set-row"><div class="set-txt"><div class="set-t">${title}</div><div class="set-h">${help}</div>${more
  ? `<details class="set-more"><summary>More about this</summary><div class="set-h">${more}</div></details>` : ""}</div><div class="set-c">${control}</div></div>`;
const setSection = (k, title, about, where, body) => `<section class="panel set-sec" id="set-${k}"><div class="set-sec-head"><div><h2>${title}</h2><div class="set-about">${about}</div></div>
  <span class="set-where" data-tip="${where === "browser" ? "Kept in this browser on this computer" : "Kept by the viewer, whichever browser or window you use"}">${where === "browser" ? "This browser" : "Whole viewer"}</span></div>${body}</section>`;
function settingsPage() {
  const ms = (STATUS && STATUS.my_stables) || [], cur = myStableId();
  const a = (STATUS && STATUS.app) || {};
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></label>`;
  const row = setRow;
  const cr = chartDefaultRange();
  const nav = `<nav class="set-nav" aria-label="Settings sections">${SET_SECTIONS.map(([k, t]) => `<a href="#/settings?s=${k}" data-set-jump="${k}">${t}</a>`).join("")}</nav>`;
  const secs = [];
  secs.push(setSection("stable", "Your stable", "Which of your stables the left menu opens.", "browser", ms.length ? [
    row("Main stable", "Opened by “Your stables” and “Your horses” in the left menu.",
      `<select id="set-stable">${ms.map((x) => `<option value="${x.id}" ${String(x.id) === String(cur) ? "selected" : ""}>${esc(x.name)} — ${esc(x.role)}</option>`).join("")}</select>`),
    `<div class="set-h set-foot">${ms.length} stable${ms.length === 1 ? "" : "s"} you manage, own or hold shares in. Use ◀ ▶ at the top of their pages to move between them.</div>`,
  ].join("") : '<div class="empty">No stables found for your player in this database.</div>'));
  secs.push(setSection("look", "Look", "Light or dark, text size, font and colours.", "browser", [
    row("Appearance", "Light, dark, or the same as Windows.",
      `<div class="theme-pick">${[["light", "Light"], ["dark", "Dark"], ["auto", "Match Windows"]].map(([k, t]) => `<button data-theme="${k}" class="${themeMode() === k ? "on" : ""}">${t}</button>`).join("")}</div>`),
    row("Text size", "Makes all text bigger or smaller, from 8px to 20px.",
      `<div class="tsize"><button id="ts-down" aria-label="Smaller text">A−</button><span class="val" id="ts-val"></span><button id="ts-up" aria-label="Larger text">A+</button><button id="ts-reset" class="reset">Reset</button></div>`),
    row("Font", "The typeface used everywhere. Each one is shown in its own style.", `<div id="font-dd" class="dd"></div>`),
    row("Font colour", "The colour of the main text. Dark mode uses a lighter version of it.", `<div id="ink-dd" class="dd"></div>`),
    `<div class="set-row set-colours"><div class="set-txt"><div class="set-t">Colours</div><div class="set-h">Pick a colour theme, or your own colours. Light and dark mode each keep their own.</div></div>
      <details class="set-fold"><summary class="btn">Change colours</summary><div id="colour-box" class="colour-box"></div></details></div>`,
  ].join("")));
  secs.push(setSection("pages", "Pages & tables", "How menus, tables, charts and hover cards behave.", "browser", [
    row("Side menu", "Full, icons only, or hidden. The ☰ button at the top left does the same.",
      `<select id="set-side"><option value="full">Full</option><option value="mini">Icons only</option><option value="hidden">Hidden</option></select>`),
    row("Rows per page", "How many rows long tables show at once. You can also change it under any table.",
      `<select id="set-rows"><option value="">Standard (50, or 100 for All tables)</option>${PAGE_SIZES.map((n) => `<option value="${n}" ${prefPageSize() === n ? "selected" : ""}>${fNum(n)}</option>`).join("")}</select>`),
    row("Charts open showing", "The time range charts start on. Each chart still has its own range buttons.",
      `<select id="set-range"><option value="all" ${cr === "all" ? "selected" : ""}>All of the history</option>
        <optgroup label="Years">${RANGES.filter((r) => r[0].endsWith("y")).map((r) => `<option value="${r[0]}" ${r[0] === cr ? "selected" : ""}>Last ${r[1]}</option>`).join("")}</optgroup>
        <optgroup label="Months">${RANGES.filter((r) => r[0].endsWith("m")).map((r) => `<option value="${r[0]}" ${r[0] === cr ? "selected" : ""}>Last ${r[1]}</option>`).join("")}</optgroup></select>`),
    row("Hover cards", "A quick summary when you point at a horse, person, stable, race or racecourse.", sw("set-cards", HOVER_CARDS)),
    row("Pedigree gender colours", "Dams in orange and sires in teal in the long family-tree lists.", sw("set-pedcol", ANC_COLOURS)),
  ].join("")));
  secs.push(setSection("season", "Racing season", "When your season starts. Jockey season and Concepts use it.", "browser", [
    row("Season starts on", "Choose 1 January for calendar years. Seasons that cross the new year show like 2018/19.",
      (() => { const [m, d] = seasonStart().split("-").map(Number); return `<span class="season-pick"><select id="set-season-d" aria-label="Day">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i + 1 === d ? "selected" : ""}>${i + 1}</option>`).join("")}</select>
        <select id="set-season-m" aria-label="Month">${MONTHS_LONG.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? "selected" : ""}>${n}</option>`).join("")}</select></span>`; })()),
    row("Race series keep their own season", "On: each series in Concepts runs from its first race to its last. Off: series follow your season.",
      sw("set-season-series", seriesOwnSeason()), "Handy when a series doesn't fit your season, like a Northern Hemisphere series that runs April to October."),
  ].join("")));
  secs.push(setSection("save", "Your save file", "The game save you're looking at, and keeping it up to date as you play.", "viewer", [
    row("Open database", `<b>${esc((STATUS && STATUS.db && STATUS.db.name) || "—")}</b>${STATUS && STATUS.meta && STATUS.meta.game_date ? ` · game date ${fDate(STATUS.meta.game_date)}` : ""}`,
      `<a class="btn" href="#/databases">Manage databases</a>`),
    row("Load a newer save", "Bring in a newer database.db yourself, or load one as a new database.", `<button class="btn" onclick="openLoad()">Load database</button>`),
    `<h3 class="set-sub">Follow the game as you play</h3><div id="auto-box"><div class="muted">Loading…</div></div>`,
  ].join("")));
  secs.push(setSection("storage", "Stored data", "Ways to make the viewer's copy of your save take less space. They all start off.", "viewer", `<div id="compact-box">${compactBox()}</div>`));
  secs.push(setSection("app", "HRM Viewer app", "Your version, new versions, the Quick Guide, and resetting settings.", "viewer", [
    row("Version", `HRM Viewer <b>${esc(a.version || "")}</b>`, `<a class="btn" href="#/versions">Versions &amp; changes</a>`),
    row("New versions", "New versions of HRM Viewer come from GitHub. The viewer checks for them, offers to install them, and can go back to an earlier one. (This is separate from loading your save.)", `<div id="gh-box" class="gh-box"><span class="muted small">Checking…</span></div>`),
    row("Install from a file", "Install an HRM-Viewer-update zip you've downloaded. Your data isn't touched.", `<button class="btn" data-open-update>Install an update</button>`),
    STATUS && STATUS.desktop && STATUS.platform === "mac"
      ? row("Desktop app", "You're using the HRM Viewer app. Keep it in Applications and drag it to the Dock to open it like any other app.", "", "Your data is kept in Library/Application Support/HRM Viewer, so it stays when you replace the app with a newer one.")
      : STATUS && STATUS.desktop && STATUS.platform === "linux"
      ? row("Desktop app", "You're using the HRM Viewer app. Add it to your applications menu to open it like any other program.", `<button class="btn" id="set-shortcut">Add to menu</button>`)
      : STATUS && STATUS.desktop
      ? row("Desktop app", "You're using the HRM Viewer app. Add it to your desktop and Start menu to open it like any other program.", `<button class="btn" id="set-shortcut">Add shortcuts</button>`)
      : STATUS && STATUS.has_exe
        ? row("Desktop app", "HRM Viewer can open in its own window instead of the browser: close this, then double-click <b>HRM Viewer.exe</b> in the viewer's folder.", "")
        : "",
    STATUS && STATUS.desktop && STATUS.platform === "linux" && !STATUS.windowed
      ? row("Stop the viewer", `HRM Viewer is running in your browser because it couldn't open its own window${STATUS.window_problem ? `: <b>${esc(STATUS.window_problem)}</b>` : ""}. Closing the browser tab leaves it running; stop it here when you're done.`, `<button class="btn" id="set-stop">Stop the viewer</button>`,
        "To get its own window it needs WebKitGTK (the package is usually called <code>libwebkit2gtk-4.1</code> or <code>webkit2gtk-4.1</code>; version 4.0 works too).")
      : "",
    row("Quick Guide", "How to use the main features, as a PDF. It's updated with every version.",
      `<span style="display:inline-flex;gap:8px"><button class="btn" data-guide>Open the guide</button><a class="btn" href="/quick-guide.pdf" download="HRM Viewer - Quick Guide.pdf">Download PDF</a></span>`),
    row("Reset settings", "Puts the settings kept in this browser (look, pages &amp; tables, racing season, main stable) back to how they started.", `<button class="btn" id="set-reset">Reset settings</button>`,
      "Your data, favourites and shortcuts aren't touched, and nor are the save file, stored data and new-version settings."),
  ].join("")));
  return settingsTabs("settings") + `<div class="page-head"><div><h1>Settings</h1><div class="sub">Changes are saved as soon as you make them.</div></div></div>
    <div class="set-layout">${nav}<div class="set-main">${secs.join("")}</div></div>`;
}
// ------------------------------------------------------------------ Settings → Stored data: compacting (16.7)
const fSize = (b) => (isNum(b) && b > 0 ? (b >= 1000 * (1 << 20) ? (b / (1 << 30)).toFixed(2) + " GB" : Math.round(b / (1 << 20)) + " MB") : "—");
function compactBox() {
  const c = (STATUS && STATUS.compact) || {}, m = (STATUS && STATUS.meta) || {}, last = m.compact;
  const sw = (id, on, dis) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${dis ? "disabled" : ""}><span></span></label>`;
  const row = setRow;
  return [
    row("Compact stored data", `Drops the parts of each save the viewer never shows, so the stored copy is smaller. Loading takes a little longer. <b>What's dropped can't be brought back.</b>`,
      sw("set-compact", c.on),
      `Each time a save is loaded it drops the game's rating history and race replays, its <i>Yearly Summary</i> story entries and their hidden data, and other people's horses' raw race positions once their sectional times are worked out (the sectionals are kept). It also rebuilds the biggest tables without a duplicate copy of their ID index. Older records the game has since deleted only exist in your stored copy, which is why what's dropped can't come back.`),
    row("Also thin other horses' charts", `Other people's horses keep one chart point per quarter instead of every one. Needs Compact stored data on.`,
      sw("set-compact-thin", c.thin, !c.on),
      `Applies to stat and value history. Your stables' horses, horses you've ridden, bred or traded, their parents and your family are never thinned.`),
    c.disk_available ? row("Compress on disk", `Windows keeps the stored copy compressed on your drive, so it takes about half the space. Nothing is removed.${STATUS && STATUS.compressing ? " <b>Compressing now…</b>" : ""}`,
      sw("set-compact-disk", c.disk),
      `The same as ticking <i>Compress contents to save disk space</i> on the folder; it works on NTFS drives (most Windows drives). Each load compresses the new copy before it's used, so loading takes a little longer (about 10 seconds per GB) and you can keep using the viewer meanwhile. Switching it on compresses what's stored now, and pages are slow for those few seconds.`) : "",
    row("Size", `${STATUS && STATUS.db_size ? `The stored data is <b>${fSize(STATUS.db_size)}</b>${STATUS.db_disk && STATUS.db_disk < STATUS.db_size * 0.97 ? `, taking <b>${fSize(STATUS.db_disk)}</b> on disk` : ""}.` : "No data stored yet."}${last ? ` Last compacted ${fDate(last.at)}: ${fSize(last.before)} → ${fSize(last.after)}.` : ""}
      Compacting happens on the next load, or now with <b>Compact now</b>.`,
      `<button class="btn" id="compact-run" ${c.on && STATUS && STATUS.db_size ? "" : "disabled"}>Compact now</button>`,
      "Compact now needs free disk space about the size of the stored data while it runs."),
  ].join("") + `<div id="compact-msg" class="small"></div>`;
}
function wireCompact() {
  const box = $("#compact-box");
  if (!box) return;
  const set = async (body) => {
    const r = await fetch("/api/compact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (STATUS) STATUS.compact = await r.json();
    box.innerHTML = compactBox(); wireCompact();
  };
  $("#set-compact").onchange = (e) => set({ on: e.target.checked });
  $("#set-compact-thin").onchange = (e) => set({ thin: e.target.checked });
  if ($("#set-compact-disk")) $("#set-compact-disk").onchange = (e) => {
    set({ disk: e.target.checked });
    // Windows works on the file in the background: show the new size on disk once it has had a moment
    setTimeout(async () => { try { STATUS = await (await fetch("/api/status")).json(); const b = $("#compact-box"); if (b) { b.innerHTML = compactBox(); wireCompact(); } } catch (err) { /* next visit */ } }, 20000);
  };
  $("#compact-run").onclick = async () => {
    const r = await fetch("/api/compact/run", { method: "POST" });
    const j = await r.json();
    if (!r.ok) { $("#compact-msg").innerHTML = `<div class="err">${esc(j.error || "Couldn't start.")}</div>`; return; }
    openLoad(true);
  };
}
// how long the last load took, step by step (16.7.2)
const fSecs = (x) => (!isNum(x) ? "—" : x < 60 ? `${x < 10 ? x.toFixed(1) : Math.round(x)} s` : `${Math.floor(x / 60)} min ${Math.round(x % 60)} s`);
function lastLoadHtml(l, compressing) {
  if (!l || !isNum(l.took)) return "";
  const kind = l.mode === "compact" ? "Last Compact now" : "Last update";
  const steps = (l.steps || []).filter((x) => x[1] >= 0.5 && !/^(Starting|Saving|Loaded)$/.test(x[0]));
  const comp = l.compress && isNum(l.compress_took) ? ` (${fSecs(l.compress_took)} of it compressing on disk)` : "";
  // the sizes at the end (16.7.6): the save file that was loaded, and the stored copy it made (and its space on disk if compressed)
  const sizes = [isNum(l.save_size) ? `save file ${fSize(l.save_size)}` : "",
    isNum(l.size) ? `stored data ${fSize(l.size)}${isNum(l.disk_size) && l.disk_size < l.size * 0.97 ? ` (${fSize(l.disk_size)} on disk)` : ""}` : ""].filter(Boolean).join(" · ");
  return `<br>${kind}: ${new Date(l.at * 1000).toLocaleString("en-NZ")} · <b>took ${fSecs(l.took)}</b>${comp}${sizes ? ` · ${sizes}` : ""}
    ${steps.length ? `<details class="small"><summary>Time per step</summary>${steps.map(([n, t]) => `${esc(n)}: ${fSecs(t)}`).join("<br>")}</details>` : ""}`;
}
async function drawAutoBox() {
  const box = $("#auto-box");
  if (!box) return;
  const a = await (await fetch("/api/auto")).json();
  if (!box.isConnected) return;   // you've moved on to another page meanwhile
  const st = a.settings || {};
  const opt = (v, list) => list.map(([x, t]) => `<option value="${x}" ${+v === x ? "selected" : ""}>${t}</option>`).join("");
  const stateTxt = { off: "Off", current: "Up to date", waiting: "Change seen", updating: "Updating…", skipped: "Not loaded", error: "Problem", nofile: "No file to watch" }[a.state] || "";
  box.innerHTML = setRow("Load new saves automatically", "When the game saves, the viewer loads the new save by itself. Only for this same save, never an older file or a different career.",
      `<label class="switch"><input type="checkbox" id="auto-on" ${st.enabled ? "checked" : ""}><span></span></label>`,
      "It watches the <b>database.db</b> this database was loaded from, waits until the game has finished writing it, then loads it the normal way (newest wins, history kept).") +
    `<div class="set-row set-wide"><div class="set-txt" style="flex:1"><div class="set-t">Save file to follow</div><div class="set-h">${a.path ? `<code>${esc(a.path)}</code>${a.exists ? (a.file_mtime ? ` · last changed ${new Date(a.file_mtime * 1000).toLocaleString("en-NZ")}` : "") : ' · <b class="bad-t">not found</b>'}` : "None yet. Enter the path to the game's database.db below."}</div>
        <div class="row-f"><input type="text" id="auto-path" value="${esc(a.path || "")}" placeholder="${pathHint("database.db")}" style="flex:1;min-width:280px">
          <button class="btn primary" id="auto-path-go">Follow this file</button><button class="btn" id="auto-check" ${a.path && a.exists ? "" : "disabled"}>Check now</button></div>
        <div class="set-h">The full path to the game's <code>database.db</code>, or the folder it's in. In File Explorer, hold Shift, right-click the file and choose “Copy as path”.</div>
        <div id="auto-path-msg"></div></div></div>` +
    setRow("Wait after the file changes", "So a save that's still being written isn't loaded half-way.",
      `<select id="auto-quiet">${opt(st.quiet, [[15, "15 seconds"], [30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"]])}</select>`) +
    setRow("At most one update every", "Spaces updates out if the game saves very often.",
      `<select id="auto-gap">${opt(st.min_gap, [[60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"]])}</select>`) +
    setRow("Status", `<span class="auto-pill ${esc(a.state)}">${stateTxt}</span> ${esc(a.message || "")}
      ${a.last_result && a.last_result.ok ? `<br>Last automatic update: ${new Date(a.last_result.at * 1000).toLocaleString("en-NZ")} · game date ${fDate(a.last_result.game_date)}` : ""}
      ${lastLoadHtml(a.last_load, a.compressing)}`, "");
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
    setTimeout(async () => { await drawAutoBox(); const m = $("#auto-path-msg"); if (m) m.innerHTML = '<div class="ok-t">✓ Now following that file.</div>'; }, 700);
  };
}
settingsPage.after = (route) => {
  // the menu beside the sections: jump to one, and light up the one you're reading
  const jump = (k, smooth) => { const el = $("#set-" + k); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 110, behavior: smooth ? "smooth" : "auto" }); };
  $$("[data-set-jump]", APP).forEach((l) => l.addEventListener("click", (e) => { e.preventDefault(); jump(l.dataset.setJump, true); }));
  const navLinks = $$("[data-set-jump]", APP);
  const mark = () => {
    if (!navLinks.length || !navLinks[0].isConnected) return window.removeEventListener("scroll", mark);
    let on = SET_SECTIONS[0][0];
    for (const [k] of SET_SECTIONS) { const el = $("#set-" + k); if (el && el.getBoundingClientRect().top < 160) on = k; }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) on = SET_SECTIONS[SET_SECTIONS.length - 1][0];
    navLinks.forEach((l) => l.classList.toggle("on", l.dataset.setJump === on));
  };
  window.addEventListener("scroll", mark, { passive: true }); mark();
  if (route && route.q && route.q.s) setTimeout(() => jump(route.q.s), 60);
  drawGithubBox();
  drawColours();
  setTableSize(getTableSize());
  drawFontDropdowns();
  $$("[data-theme]", APP).forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme); $$("[data-theme]", APP).forEach((x) => x.classList.toggle("on", x === b)); drawFontDropdowns(); }));
  drawAutoBox();
  wireCompact();
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* this session only */ } };
  $("#set-cards").onchange = (e) => { HOVER_CARDS = e.target.checked; save("hrm.hoverCards", HOVER_CARDS ? "1" : "0"); hideCard(); };
  $("#set-pedcol").onchange = (e) => { ANC_COLOURS = e.target.checked; save("hrm.ancColours", ANC_COLOURS ? "1" : "0"); };
  $("#set-range").onchange = (e) => save("hrm.chartRange", e.target.value);
  const saveSeason = () => save("hrm.season", String($("#set-season-m").value).padStart(2, "0") + "-" + String($("#set-season-d").value).padStart(2, "0"));
  $("#set-season-m").onchange = saveSeason;
  $("#set-season-d").onchange = saveSeason;
  $("#set-season-series").onchange = (e) => save("hrm.seasonSeries", e.target.checked ? "1" : "0");
  $("#set-side").value = sideMenuMode();
  $("#set-rows").onchange = (e) => { if (e.target.value) save("hrm.pageSize", e.target.value); else { try { localStorage.removeItem("hrm.pageSize"); } catch (er) { /* none */ } } };
  $("#set-side").onchange = (e) => setSideMenu(e.target.value);
  const st = $("#set-stable");
  if (st) st.onchange = () => { setMyStable(st.value); renderSidebar(); };
  const stopBtn = $("#set-stop");
  if (stopBtn) stopBtn.onclick = async () => {
    await fetch("/api/quit", { method: "POST" }).catch(() => {});
    APP.innerHTML = `<div class="welcome"><h1>HRM Viewer has stopped</h1><p>You can close this tab. Open HRM Viewer again to carry on.</p></div>`;
  };
  const sc = $("#set-shortcut");
  if (sc) sc.onclick = async () => {
    const label = sc.textContent;
    sc.disabled = true; sc.textContent = "Adding…";
    const r = await fetch("/api/desktop/shortcut", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    sc.textContent = r.ok ? "✓ Added" : label; sc.disabled = r.ok;
    if (!r.ok) sc.insertAdjacentHTML("afterend", `<div class="err" style="margin-top:6px">${esc(j.error || "Couldn't add the shortcuts.")}</div>`);
  };
  $("#set-reset").onclick = () => {
    try { Object.keys(localStorage).filter((k) => k.startsWith("hrm.") && !k.startsWith("hrm.favs:") && k !== "hrm.keys").forEach((k) => localStorage.removeItem(k)); } catch (e) { /* nothing stored */ }
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
      <button class="btn sm primary" id="mig-go">Move it into the new structure</button><span id="mig-msg" class="small"></span></div>`, "", "hl-panel");
    html += `<div style="height:16px"></div>`;
  }
  const rows = d.list.map((x) => `<tr class="${x.active ? "me" : ""}">
      <td><b class="dbname" data-id="${x.id}">${esc(x.name)}</b> ${x.active ? '<span class="badge good">Open now</span>' : ""}${x.legacy ? ' <span class="badge">Old layout</span>' : ""}
        ${x.loaded ? "" : '<span class="badge">Empty</span>'}</td>
      <td>${esc(x.player || "—")}${(x.players || []).filter((p) => p !== x.player).length ? `<div class="muted small">before: ${(x.players || []).filter((p) => p !== x.player).map(esc).join(", ")}</div>` : ""}</td><td class="nowrap">${x.game_date ? fDate(x.game_date) : "—"}</td>
      <td class="num">${mb(x.size)}</td><td class="nowrap">${x.loaded_at ? fDate(x.loaded_at) : "—"}</td><td class="num">${fNum(x.loads)}</td>
      <td class="nowrap db-acts">${x.active ? "" : `<button class="btn sm primary" data-dbopen="${x.id}">Open</button>`}
        ${x.legacy ? "" : `<button class="btn sm" data-dbrename="${x.id}">Rename</button>`}
        ${x.active ? "" : `<button class="btn sm danger" data-dbdel="${x.id}">Delete</button>`}</td></tr>`).join("");
  html += panel("Your databases", `<div class="tbl-wrap"><table class="data"><thead><tr><th>Name</th><th>Player</th><th>Game date</th><th class="num">Size</th>
      <th>Last loaded</th><th class="num">Loads</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div id="db-msg" class="small" style="margin-top:8px"></div>`,
    `Stored in <code>${esc(d.folder)}${d.folder.includes("\\") ? "\\" : "/"}databases</code>`);
  html += `<div class="grid cols-2" style="margin-top:16px">
    ${panel("Add a new database", `<p class="muted">Load a game save as a separate database, e.g. another career. Your other databases aren't touched.</p>
      <p><button class="btn sm primary" onclick="openLoad(); setTimeout(() => { const r = document.querySelector('input[name=load-into][value=new]'); if (r) { r.checked = true; document.getElementById('load-newname').focus(); } }, 50)">Load a save as a new database</button></p>`)}
    ${panel("Bring in databases from another HRM Viewer folder", `<p class="muted">If you kept an older copy of the viewer (for example a folder you unzipped before), you can bring its stored data in here as a separate database.</p>
      <div class="row-f"><input type="text" id="imp-path" placeholder="${pathHint("Downloads/HRM Viewer", true)}" style="flex:1;min-width:260px"></div>
      <div class="row-f"><label>Name <input type="text" id="imp-name" placeholder="optional — uses the player's name" style="width:240px"></label>
        <label><input type="checkbox" id="imp-move"> Move instead of copy (frees the space in the old folder)</label></div>
      <div class="row-f"><button class="btn sm primary" id="imp-go">Bring it in</button><span id="imp-msg" class="small"></span></div>
      <p class="help">Paste the path of the other viewer's folder (the one with HRM Viewer.exe), its <code>data</code> folder, or a <code>current.db</code> file. A game <code>database.db</code> works too — it's loaded as a new database.</p>`)}</div>`;
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
    try {
      const favs = (() => { try { return localStorage.getItem("hrm.favs:" + dbKeyId()); } catch (e) { return null; } })();
      await dbPost("migrate", { name: $("#mig-name").value.trim() }); await afterDbChange(false);
      if (favs && dbKeyId() !== "_legacy") { try { if (!localStorage.getItem("hrm.favs:" + dbKeyId())) localStorage.setItem("hrm.favs:" + dbKeyId(), favs); } catch (e) { /* not kept */ } renderSidebar(); favSync(); }
    }
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
  if (STATUS && STATUS.loaded) await loadNotes(); else NOTES = { tags: [], items: {} };
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
  setTimeout(offerLinuxMenu, 2500);
})();


// ------------------------------------------------------------------ Mac and Linux
// an example path in the style of this computer (for the "type a path" boxes)
function pathHint(tail, dir) {
  const p = (STATUS && STATUS.platform) || "windows";
  if (p === "mac") return dir ? "/Users/you/" + tail : "/Users/you/…/" + tail;
  if (p === "linux") return dir ? "/home/you/" + tail : "/home/you/…/" + tail;
  return dir ? "C:\\Users\\you\\" + tail.replace(/\//g, "\\") : "C:\\Users\\you\\...\\" + tail;
}
// a short message in the corner, with an optional button
function toast(html, action, ms = 6000) {
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${html}</span>`;
  if (action) { const b = document.createElement("button"); b.className = "btn sm"; b.textContent = action[0]; b.onclick = () => { action[1](); t.remove(); }; t.appendChild(b); }
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 600);
  return t;
}
// In the app's own window on Mac and Linux the web view can't download files or open new windows by itself,
// so the viewer does it: downloads go to your Downloads folder, outside links open in your browser.
const nativeWindow = () => !!(STATUS && STATUS.windowed);
async function nativeSave(a) {
  const t = toast("Saving…");
  try {
    const r = await fetch(a.href);
    if (!r.ok) throw new Error("the file couldn't be made (" + r.status + ")");
    let name = a.getAttribute("download");
    if (!name) {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get("Content-Disposition") || "");
      name = m ? decodeURIComponent(m[1]) : decodeURIComponent((a.pathname || "").split("/").pop() || "download");
    }
    const res = await (await fetch("/api/desktop/save?name=" + encodeURIComponent(name), { method: "POST", body: await r.blob() })).json();
    t.remove();
    if (res.error) throw new Error(res.error);
    const shown = res.path.split(/[\\/]/).pop();
    toast(`Saved to Downloads: <b>${esc(shown)}</b>`, [STATUS.platform === "mac" ? "Show in Finder" : "Show in folder",
      () => fetch("/api/desktop/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: res.path }) })]);
  } catch (err) {
    t.remove();
    toast(`Couldn't save the file: ${esc(err.message)}`);
  }
}
document.addEventListener("click", (e) => {
  if (!nativeWindow() || e.defaultPrevented) return;
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  if (a.hasAttribute("download")) { e.preventDefault(); e.stopPropagation(); nativeSave(a); return; }
  const outside = /^https?:/i.test(a.href) && new URL(a.href).origin !== location.origin;
  if (outside) {
    e.preventDefault(); e.stopPropagation();
    fetch("/api/desktop/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: a.href }) });
  }
}, true);
// Linux: offer once to add HRM Viewer to the applications menu (the Windows app asks the same about shortcuts)
function offerLinuxMenu() {
  if (!STATUS || !STATUS.desktop || STATUS.platform !== "linux") return;
  try { if (localStorage.getItem("hrm.menuAsked")) return; localStorage.setItem("hrm.menuAsked", "1"); } catch (e) { return; }
  toast("Add HRM Viewer to your applications menu, so you can open it like any other program?", ["Add to menu", async () => {
    const r = await fetch("/api/desktop/shortcut", { method: "POST" });
    toast(r.ok ? "Added. HRM Viewer is in your applications menu." : "Couldn't add it. You can try again in Settings.");
  }], 20000);
}
