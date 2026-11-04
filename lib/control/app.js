// control/app.js — the control room's page script (served at /control/app.js).
// Renders every section from /control/api/state; every change POSTs one
// action to /control/api/action and offers Undo (history.revert) in the toast.
(() => {
"use strict";
const root = document.getElementById("control");
const TOKEN = root.dataset.token;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DAYN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let STATE = null;
let TZ = "UTC";

// ── data ────────────────────────────────────────────────────────────────
async function load() {
  const res = await fetch("/control/api/state", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  STATE = await res.json();
  TZ = STATE.tz || "UTC";
  if (Array.isArray(STATE.areas) && STATE.areas.length) AREAS = STATE.areas;
  prepare();
}
async function act(action, args, { quiet = false } = {}) {
  const res = await fetch("/control/api/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-control-token": TOKEN },
    body: JSON.stringify({ action, args }),
  });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || out.error) { toast(out.error || "That change failed.", { bad: true }); throw new Error(out.error); }
  const e = out.entry || {};
  if (!quiet) toast(e.unchanged ? "Nothing changed." : `${e.what || "Saved"}.`, { undo: e.undo ? e.id : null });
  await load().catch(() => {});
  render();
  return e;
}

// ── time in the host's zone ─────────────────────────────────────────────
function wallNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute));
}
const fmtTime = (h, m) => { const ap = h < 12 ? "AM" : "PM"; const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, "0")} ${ap}` : `${hh} ${ap}`; };
function fmtWall(d, now) {
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 864e5);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 ? DAYN[d.getUTCDay()] : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day} ${fmtTime(d.getUTCHours(), d.getUTCMinutes())}`;
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
const dur = (ms) => ms >= 60000 ? `${Math.round(ms / 6e4)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;

// ── cron model ──────────────────────────────────────────────────────────
function field(s, lo, hi) {
  const set = new Set();
  for (const part of String(s).split(",")) {
    let [r, st] = part.split("/"); st = +st || 1; let a = lo, b = hi;
    if (r !== "*") { if (r.includes("-")) [a, b] = r.split("-").map(Number); else { a = +r; b = st > 1 ? hi : a; } }
    for (let v = a; v <= b; v += st) set.add(v === 7 && hi === 6 ? 0 : v);
  }
  return set;
}
function matcher(s) {
  if (typeof s === "string") {
    const [mi, ho, dm, mo, dw] = s.split(/\s+/);
    const M = field(mi, 0, 59), H = field(ho, 0, 23), DM = field(dm, 1, 31), MO = field(mo, 1, 12), DW = field(dw, 0, 6);
    const rdm = dm !== "*", rdw = dw !== "*";
    return (d) => M.has(d.getUTCMinutes()) && H.has(d.getUTCHours()) && MO.has(d.getUTCMonth() + 1) &&
      (rdm && rdw ? DM.has(d.getUTCDate()) || DW.has(d.getUTCDay()) : DM.has(d.getUTCDate()) && DW.has(d.getUTCDay()));
  }
  if (s && s.calendar) return (d) => s.calendar.some((e) => (e.Minute ?? 0) === d.getUTCMinutes() && (e.Hour == null || e.Hour === d.getUTCHours()) && (e.Weekday == null || e.Weekday % 7 === d.getUTCDay()) && (e.Day == null || e.Day === d.getUTCDate()));
  if (s && s.every) { const n = Math.max(1, Math.round(s.every / 60)); return (d) => (d.getUTCHours() * 60 + d.getUTCMinutes()) % n === 0; }
  return null;
}
const ord = (n) => n + ({ 1: "st", 2: "nd", 3: "rd", 21: "st", 22: "nd", 23: "rd", 31: "st" }[n] || "th");
function cadence(s) {
  if (s && s.service) return { text: "Always on", cls: "service" };
  if (s && s.onDemand) return { text: "When triggered", cls: "ondemand" };
  if (s && s.every) { const m = Math.round(s.every / 60); return { text: m >= 60 ? `Every ${+(m / 60).toFixed(1)} h` : `Every ${m} min`, cls: "frequent" }; }
  if (s && s.calendar) {
    const c = s.calendar, t = [...new Set(c.map((e) => fmtTime(e.Hour ?? 0, e.Minute ?? 0)))];
    if (c.some((e) => e.Day != null)) return { text: `Monthly on the ${ord(c[0].Day)} at ${t[0]}`, cls: "monthly" };
    const wd = [...new Set(c.filter((e) => e.Weekday != null).map((e) => DAYN[e.Weekday % 7]))];
    if (wd.length) return { text: `${wd.join(", ")} at ${t.join(", ")}`, cls: wd.length >= 5 ? "daily" : "weekly" };
    if (c.every((e) => e.Hour == null)) return { text: "Hourly", cls: "frequent" };
    return { text: `Daily at ${t.join(", ")}`, cls: "daily" };
  }
  const [mi, ho, dm, mo, dw] = String(s).split(/\s+/);
  if (mo && mo !== "*") {
    const names = [...field(mo, 1, 12)].map((m) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }));
    const rest = cadence([mi, ho, dm, "*", dw].join(" "));
    return { text: `${rest.text.replace(/^Monthly on/, "On")}, ${names.join(" and ")} only`, cls: "yearly" };
  }
  const M = [...field(mi, 0, 59)], H = [...field(ho, 0, 23)];
  if (mi.startsWith("*/") && ho === "*") return { text: `Every ${mi.slice(2)} min`, cls: "frequent" };
  if (ho === "*" && dm === "*" && dw === "*") return { text: M.length === 1 ? `Hourly at :${String(M[0]).padStart(2, "0")}` : `${M.length} times an hour`, cls: "frequent" };
  if (ho.startsWith("*/")) return { text: `Every ${ho.slice(2)} h`, cls: "frequent" };
  const times = H.length * M.length <= 5 ? H.flatMap((h) => M.map((m) => fmtTime(h, m))).join(", ") : `${H.length * M.length} times a day`;
  const at = (t) => (H.length * M.length <= 5 ? `at ${t}` : t);
  if (dm !== "*" && dw === "*") return { text: `Monthly on the ${ord(+dm)} ${at(times)}`, cls: "monthly" };
  if (dw !== "*") {
    const ds = [...field(dw, 0, 6)].sort();
    const dt = ds.length === 5 && !ds.includes(0) && !ds.includes(6) ? "Weekdays" : ds.length === 1 ? `${DAYN[ds[0]]}s` : ds.map((x) => DAYN[x]).join(", ");
    return { text: `${dt} ${at(times)}`, cls: ds.length >= 5 ? "daily" : "weekly" };
  }
  return { text: H.length * M.length <= 5 ? `Daily at ${times}` : times[0].toUpperCase() + times.slice(1), cls: "daily" };
}
// Areas group jobs and settings by name keywords: control.json `areas`
// (served in the state), else these generic ones.
const DEFAULT_AREAS = [
  ["Hum", ["hum"]], ["Location", ["location", "live-day", "segment", "stop", "findme", "day-"]], ["Marketing", ["mkt", "marketing", "ads", "aso"]],
  ["Events and venues", ["venue", "concert", "festival", "comedy", "ticket", "event"]],
  ["Money", ["portfolio", "finance", "plaid", "broker", "bank", "invoice", "expenses", "receipt", "quote", "investment"]],
  ["Self-improvement", ["dream", "improvement", "nightly", "system-issue", "cost", "skill", "self-improve", "jev"]],
  ["Watchlist and TV", ["watchlist", "tmdb", "movie", "episode"]],
  ["Memory and summaries", ["photos", "memory", "daily-summary", "weekly-summary", "monthly-summary", "context", "wiki", "embed", "reclassification", "chat-consolidate"]],
  ["Mail and messages", ["email", "gmail", "newsletter", "message", "mail", "call-log", "apns"]],
  ["People and meetings", ["birthday", "people", "occasion", "meeting"]],
  ["Travel and dining", ["flight", "trip", "travel", "cruise", "resy", "dining", "walk", "routine"]],
  ["Home", ["home", "spa", "lock"]],
  ["System upkeep", ["rotate", "sync", "jori", "chrome", "watchdog", "heartbeat", "cron", "resilience", "session", "stale", "kernel", "renew"]],
];
let AREAS = DEFAULT_AREAS;
function area(name) {
  const n = name.replace(/^trigger-/, "");
  for (const [a, keys] of AREAS) if (keys.some((k) => n.startsWith(k) || n.includes(`-${k}`))) return a;
  return "Other";
}
function nice(name) { const s = name.replace(/^trigger-/, "").replace(/-/g, " "); return s[0].toUpperCase() + s.slice(1); }

let JOBS = [];
function prepare() {
  const now = wallNow();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const jobs = STATE.schedule?.jobs || [];
  JOBS = jobs.map((j) => {
    const m = (() => { try { return matcher(j.schedule); } catch { return null; } })();
    const runs = j.runs || [];
    const recent = runs.slice(-10);
    const fails = recent.filter((r) => r.exit !== 0).length;
    const state = j.paused ? "paused" : recent.length && fails >= Math.max(1, Math.ceil(recent.length / 2)) ? "failing" : "ok";
    const today = [];
    if (m) for (let i = 0; i < 1440; i++) if (m(new Date(base + i * 6e4))) today.push(i);
    let next = null;
    if (m && !j.paused) { let d = new Date(now.getTime() + 6e4); for (let i = 0; i < 60 * 24 * 32; i++, d = new Date(d.getTime() + 6e4)) if (m(d)) { next = d; break; } }
    return { ...j, nice: nice(j.name), cad: cadence(j.schedule), state, fails, recent, today, next, area: area(j.name) };
  });
}

// ── toast ───────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, { bad = false, undo = null } = {}) {
  let t = $(".toast"); if (t) t.remove();
  t = document.createElement("div");
  t.className = `toast${bad ? " bad" : ""}`;
  t.setAttribute("role", "status");
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">Undo</button>` : ""}`;
  document.body.appendChild(t);
  if (undo) t.querySelector("button").onclick = () => { t.remove(); act("history.revert", { id: undo }); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), undo ? 12000 : 5000);
}

// ── views ───────────────────────────────────────────────────────────────
const V = {};
const head = (title, dek) => `<header class="ctl-head"><h1>${esc(title)}</h1>${dek ? `<p>${dek}</p>` : ""}</header>`;
const err = (part) => part && part.error ? `<div class="note bad">Could not read this: ${esc(part.error)}</div>` : "";

V.today = () => {
  const now = wallNow();
  const failing = JOBS.filter((j) => j.state === "failing");
  const paused = JOBS.filter((j) => j.paused);
  const notLoaded = JOBS.filter((j) => j.paused === "UNLOADED" && j.schedule && !j.schedule.onDemand);
  const upcoming = JOBS.filter((j) => j.next && j.cad.cls !== "frequent").sort((a, b) => a.next - b.next).slice(0, 8);
  const ag = STATE.agents?.agents || [];
  const down = ag.filter((a) => !a.health?.ok);
  const watches = Array.isArray(STATE.watches) ? STATE.watches : [];
  return `${head(`Today on ${STATE.host || "the host"}`, `Every recurring job on one line of the day, in ${esc(TZ.replace(/_/g, " "))} time. Anything that needs you is listed under it.`)}
  ${err(STATE.schedule)}${STATE.schedule?.cronError ? `<div class="note bad">The crontab could not be read: ${esc(STATE.schedule.cronError)}</div>` : ""}
  <div class="stats">
    <div class="stat"><b>${JOBS.filter((j) => !j.paused).length}</b><span>jobs scheduled</span></div>
    <div class="stat ${failing.length ? "bad" : ""}"><b>${failing.length}</b><span>failing lately</span></div>
    <div class="stat"><b>${paused.length}</b><span>paused</span></div>
    <div class="stat"><b>${watches.filter((w) => w.status === "active").length}</b><span>watches listening</span></div>
    <div class="stat ${down.length ? "bad" : ""}"><b>${ag.length - down.length} of ${ag.length}</b><span>agents running</span></div>
  </div>
  ${dayStrip(now)}
  <div class="cols">
    <section><h2>Needs attention</h2><div class="list">
      ${down.map((a) => `<div class="row"><div><a class="t" href="#agents">${esc(a.name)} agent</a><div class="s">Not answering: ${esc(a.health?.error || "unknown")}</div></div><span class="chip bad">Down</span></div>`).join("")}
      ${failing.map((j) => `<div class="row"><div><button class="linkish t" data-open="${esc(j.id)}">${esc(j.nice)}</button><div class="s">Failed ${j.fails} of its last ${j.recent.length} runs. Last run ${ago(j.recent.at(-1).start)}, exit ${j.recent.at(-1).exit}.${(STATE.jobRepairs?.pending || []).some((p) => p.label === j.label) ? " A repair is queued." : ""}</div></div><span class="chip bad">Failing</span></div>`).join("")}
      ${notLoaded.map((j) => `<div class="row"><div><button class="linkish t" data-open="${esc(j.id)}">${esc(j.nice)}</button><div class="s">Has a schedule but is not loaded into launchd, so it never runs.</div></div><span class="chip warn">Not loaded</span></div>`).join("")}
      ${!down.length && !failing.length && !notLoaded.length ? `<p class="dim">Nothing needs you.</p>` : ""}
    </div></section>
    <section><h2>Coming up</h2><div class="list">${upcoming.map((j) => `<div class="row"><div><button class="linkish t" data-open="${esc(j.id)}">${esc(j.nice)}</button><div class="s">${esc(j.cad.text)}</div></div><span class="chip">${fmtWall(j.next, now)}</span></div>`).join("")}</div></section>
  </div>`;
};

function dayStrip(now) {
  const pct = (m) => `${(m / 1440 * 100).toFixed(3)}%`;
  const frequent = JOBS.filter((j) => j.today.length > 24 && !j.paused);
  const placed = JOBS.filter((j) => j.today.length && j.today.length <= 24).sort((a, b) => a.today[0] - b.today[0]);
  const buckets = {}; let dots = ""; let maxStack = 0;
  for (const j of placed) for (const m of j.today) {
    const b = Math.floor(m / 20); const k = (buckets[b] = (buckets[b] || 0) + 1); maxStack = Math.max(maxStack, k);
    const cls = j.paused ? "paused" : j.state === "failing" ? "fail" : "";
    const label = `${fmtTime(Math.floor(m / 60), m % 60)}, ${j.nice}${j.paused ? " (paused)" : j.state === "failing" ? " (failing)" : ""}`;
    dots += `<button class="fire ${cls}" style="left:${pct(m)};bottom:${22 + k * 12}px" data-open="${esc(j.id)}" data-tip="${esc(label)}" aria-label="${esc(label)}"></button>`;
  }
  const height = Math.max(150, 60 + maxStack * 12);
  let hrs = "", ticks = "";
  for (let h = 0; h < 24; h += 3) hrs += `<span class="hr" style="left:${pct(h * 60)}">${h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}</span>`;
  for (let h = 0; h < 24; h++) ticks += `<span class="tick" style="left:${pct(h * 60)}"></span>`;
  const q = STATE.channels?.quietHours || { awake_from: 8, awake_to: 22 };
  const nowM = now.getUTCHours() * 60 + now.getUTCMinutes();
  return `<section class="strip" aria-label="Today's schedule">
    <div class="strip-head"><h2>${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</h2>
      <div class="legend"><span><i style="background:var(--ink)"></i>Scheduled</span><span><i style="background:var(--danger)"></i>Failing</span><span><i style="box-shadow:inset 0 0 0 1.5px var(--ink-3)"></i>Paused</span><span><i style="background:var(--night);border:1px solid var(--rule)"></i>Asleep, ${fmtTime(q.awake_to % 24, 0)} to ${fmtTime(q.awake_from, 0)}</span></div></div>
    <div class="strip-scroll"><div class="day" style="height:${height}px">
      <span class="night" style="left:0;width:${pct(q.awake_from * 60)}"></span><span class="night" style="left:${pct(q.awake_to * 60)};right:0"></span>
      <span class="lane" style="top:0">${frequent.length} jobs run all day, every few minutes</span><span class="rhythm" style="top:20px"></span>
      ${ticks}${hrs}${dots}
      <span class="now" style="left:${pct(nowM)}"><span>Now, ${fmtTime(now.getUTCHours(), now.getUTCMinutes())}</span></span>
    </div></div></section>`;
}

const filt = { q: "", state: "all", cad: "all", group: "area" };
V.schedule = () => {
  const fams = [...new Set(JOBS.map((j) => j.paused).filter((p) => p && /PAUSE$/.test(p) && p !== "PAUSED"))];
  const cron = JOBS.filter((j) => j.source === "cron").length;
  return `${head("Schedule", `All ${JOBS.length} recurring jobs: ${cron} in the crontab and ${JOBS.length - cron} launchd agents. Open one to change when it runs, pause it, run it now, or choose the model it runs on.`)}
  ${err(STATE.schedule)}
  <div class="filters">
    <input type="search" id="ctl-q" placeholder="Find a job" value="${esc(filt.q)}" aria-label="Find a job">
    <div class="seg" role="group" aria-label="Health">${[["all", "All"], ["failing", "Failing"], ["paused", "Paused"], ["ok", "Healthy"]].map(([k, l]) => `<button data-f="state" data-v="${k}" aria-pressed="${filt.state === k}">${l}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="How often">${[["all", "Any"], ["frequent", "All day"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["ondemand", "On demand"]].map(([k, l]) => `<button data-f="cad" data-v="${k}" aria-pressed="${filt.cad === k}">${l}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="Group">${[["area", "By area"], ["time", "By next run"]].map(([k, l]) => `<button data-f="group" data-v="${k}" aria-pressed="${filt.group === k}">${l}</button>`).join("")}</div>
  </div>
  ${fams.map((f) => { const n = JOBS.filter((j) => j.paused === f).length; return `<div class="note actions" style="justify-content:space-between"><span>${n} jobs are paused together as the <code>${esc(f)}</code> family.</span><button class="btn" data-act="family.resume" data-args='${esc(JSON.stringify({ family: f }))}'>Resume all ${n}</button></div>`; }).join("")}
  <div class="tablewrap" id="ctl-tbl">${scheduleTable()}</div>`;
};
function pluginOf(j) {
  for (const p of STATE.plugins?.plugins || []) if (p.schedules.some((x) => x.label === j.label) || p.launchd.includes(j.label)) return p.name;
  return null;
}
function scheduleTable() {
  const now = wallNow();
  const q = filt.q.toLowerCase();
  const rows = JOBS.filter((j) => (!q || j.name.toLowerCase().includes(q) || j.nice.toLowerCase().includes(q) || j.area.toLowerCase().includes(q))
    && (filt.state === "all" || j.state === filt.state)
    && (filt.cad === "all" || j.cad.cls === filt.cad || (filt.cad === "ondemand" && (j.cad.cls === "ondemand" || j.cad.cls === "service"))));
  const tr = (j) => {
    const last = j.recent.at(-1);
    const health = j.state === "failing" ? `<span class="chip bad">Failing ${j.fails} of ${j.recent.length}</span>` : j.paused === "UNLOADED" ? `<span class="chip warn">Not loaded</span>` : j.paused ? `<span class="chip">Paused</span>` : last ? `<span class="chip ok">OK</span>` : "";
    return `<tr data-open="${esc(j.id)}" class="${j.paused ? "is-paused" : ""}" tabindex="0">
      <td class="name">${esc(j.nice)}<small>${j.source === "cron" ? "crontab" : "launchd"}${pluginOf(j) ? `, plugin <a href="#plugins">${esc(pluginOf(j))}</a>` : ""}</small></td>
      <td>${esc(j.cad.text)}</td>
      <td>${j.next ? fmtWall(j.next, now) : `<span class="dim">${j.paused ? "Paused" : "—"}</span>`}</td>
      <td>${last ? `${ago(last.start)} <span class="dim">${dur(last.ms || 0)}</span>` : `<span class="dim">Not logged</span>`}</td>
      <td>${health}</td>
      <td>${j.route ? `<span class="chip acc">${esc(j.route.target || "")} ${esc(j.route.model || "")}</span>` : ""} ${j.importance ? `<span class="chip">${esc(j.importance)}</span>` : ""}</td></tr>`;
  };
  let body = "";
  if (filt.group === "area") {
    const g = {}; rows.forEach((j) => (g[j.area] ||= []).push(j));
    for (const k of Object.keys(g).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b))) {
      body += `<tr class="group-row"><td colspan="6">${esc(k)} (${g[k].length})</td></tr>` + g[k].sort((a, b) => (a.next || Infinity) - (b.next || Infinity)).map(tr).join("");
    }
  } else body = rows.sort((a, b) => (a.next || Infinity) - (b.next || Infinity)).map(tr).join("");
  return `<table><thead><tr><th>Job</th><th>Runs</th><th>Next</th><th>Last run</th><th>Health</th><th>Runs on</th></tr></thead><tbody>${body || `<tr><td colspan="6" class="dim">No jobs match. Clear the search or choose All.</td></tr>`}</tbody></table>`;
}

V.watches = () => {
  const W = Array.isArray(STATE.watches) ? STATE.watches : [];
  const kinds = { anchor: "Around a trip or event", event: "When something happens", at: "At a set time" };
  const order = { active: 0, paused: 1, done: 2, retired: 3 };
  return `${head("Watches", "Standing instructions you gave in your own words: remind me when, tell me if. Each has a memory page with every time it fired.")}
  ${err(STATE.watches)}
  <div class="tablewrap"><table><thead><tr><th>Watch</th><th>Fires</th><th>Status</th><th></th></tr></thead><tbody>
  ${W.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).map((w) => `<tr><td class="name" style="max-width:520px">${esc(w.title)}<small><a href="/p/watch_${esc(w.id.replace(/-/g, "_"))}">${esc(w.id)}</a></small></td><td>${esc(kinds[w.kind] || w.kind)}${w.when ? `, ${esc(w.when)}` : ""}</td>
    <td>${w.status === "active" ? `<span class="chip ok">Listening</span>` : w.status === "paused" ? `<span class="chip warn">Paused</span>` : `<span class="chip">${esc(w.status)}</span>`}</td>
    <td>${w.status === "active" ? `<button class="btn" data-act="watch.pause" data-args='${esc(JSON.stringify({ id: w.id }))}'>Pause</button>` : w.status === "paused" ? `<button class="btn" data-act="watch.resume" data-args='${esc(JSON.stringify({ id: w.id }))}'>Resume</button>` : ""}</td></tr>`).join("")}
  </tbody></table></div>`;
};

V.agents = () => {
  const A = STATE.agents || {};
  const pins = A.pins && !A.pins.error ? A.pins : {};
  return `${head("Agents and models", "The resident sessions that do the work, and the model ids every job resolves to.")}
  ${err(A)}
  <div class="agents">${(A.agents || []).map((a) => { const h = a.health || {}; const ctx = h.contextTokens || 0; return `<div class="panel agent"><h3>${esc(nice(a.name))}</h3>
    <dl class="kv" style="margin-top:10px"><dt>Model</dt><dd><code>${esc(h.model || a.model)}</code></dd>
    ${h.ok ? `<dt>Turns</dt><dd>${h.turns ?? 0} of ${h.maxSessionTurns ?? a.maxSessionTurns ?? "?"}</dd><dt>Queue</dt><dd>${h.queueDepth ?? 0} waiting</dd>${h.costUsd ? `<dt>Session spend</dt><dd>$${h.costUsd.toFixed(2)}</dd>` : ""}` : ""}
    <dt>Status</dt><dd>${h.ok ? `<span class="chip ok">Running</span>` : `<span class="chip bad">Not answering</span> <span class="dim small">${esc(h.error || "")}</span>`}</dd></dl>
    ${h.ok && ctx ? `<div class="meter"><i class="${ctx > 140000 ? "hot" : ""}" style="width:${Math.min(100, ctx / 200000 * 100)}%"></i></div><div class="dim small">${Math.round(ctx / 1000)}k context</div>` : ""}
    <div class="actions" style="margin-top:12px"><button class="btn" data-confirm="Restart the ${esc(a.name)} session? It finishes its current turn first and keeps its conversation." data-act="agent.restart" data-args='${esc(JSON.stringify({ name: a.name }))}'>Restart</button></div></div>`; }).join("")}</div>
  <section class="panel"><h2>Model pins</h2><p class="dim small" style="margin-top:0">From <code>agent/config/models.env</code>. Short-lived jobs pick a change up on their next run; the resident sessions need a restart.</p>
    <form class="formgrid" data-form="models">${Object.entries(pins).map(([k, v]) => `<div class="field"><label for="pin-${esc(k)}">${esc(nice(k.replace(/^JORI_MODEL_/, "").toLowerCase()))} tier</label><input id="pin-${esc(k)}" name="${esc(k)}" value="${esc(v)}" class="mono"></div>`).join("")}
    <div class="field" style="align-content:end"><button class="btn primary" type="submit">Save model pins</button></div></form></section>
  ${jevSection()}`;
};

function jevSection() {
  const J = STATE.jev || {};
  if (J.error) return `<section class="panel"><h2>Jev, the decision model</h2>${err(J)}</section>`;
  const status = !J.on ? `<span class="chip warn">Off</span>` : J.breakerUntil ? `<span class="chip bad">Paused after errors until ${esc(new Date(J.breakerUntil).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }))}</span>` : `<span class="chip ok">On</span>`;
  const b = J.budget || {};
  return `<section class="panel"><h2>Jev, the decision model</h2>
    <p class="dim small" style="margin-top:0">A separate model from TypeSafe that answers fixed-choice questions (which label, yes or no, how urgent) with a calibrated probability, at about $0.00001 a decision. At each site below, Jev answers first; when it is less sure than the site's threshold, or off, the site's fallback (a rule or Claude) decides instead. Details: <code>docs/jev.md</code>.</p>
    <div class="actions" style="margin-bottom:12px">${status} ${J.keySet ? `<span class="chip ok">Key set</span>` : `<span class="chip bad">TYPESAFE_API_KEY not set</span>`}
      ${J.on ? `<button class="btn" data-confirm="Turn Jev off? Every site falls back to its rule or Claude until you turn it on." data-act="jev.off" data-args="{}">Turn off</button>` : `<button class="btn primary" data-act="jev.on" data-args="{}">Turn on</button>`}</div>
    <dl class="kv"><dt>Endpoint</dt><dd><code>${esc(J.endpoint)}</code> <code>${esc(J.model)}</code></dd>
      <dt>Last 7 days</dt><dd>${J.calls7d} decisions, $${(J.cost7d || 0).toFixed(4)}</dd>
      <dt>Budget</dt><dd>${esc(J.budgetLine || "")}</dd></dl>
    <form class="formgrid" data-form="jev" style="margin-top:14px">
      <div class="field"><label for="jev-thr">Default threshold</label><input id="jev-thr" name="default_threshold" type="number" min="0.5" max="1" step="0.01" value="${esc(J.defaultThreshold ?? "")}"><span class="help">How sure Jev must be for its answer to count.</span></div>
      <div class="field"><label for="jev-priv">Private content</label><select id="jev-priv" name="privacy_exclusions"><option value="false" ${!J.privacyExclusions ? "selected" : ""}>Jev may see everything</option><option value="true" ${J.privacyExclusions ? "selected" : ""}>Keep health and money off Jev</option></select></div>
      <div class="field"><label for="jev-usd">Budget, dollars</label><input id="jev-usd" name="budget_usd" type="number" min="0" step="1" value="${esc(b.usd ?? "")}"><span class="help">Prepaid TypeSafe balance; raise it after a top-up.</span></div>
      <div class="field"><label for="jev-since">Counted since</label><input id="jev-since" name="budget_since" type="date" value="${esc(b.since || "")}"></div>
      <div class="field" style="align-content:end"><button class="btn primary" type="submit">Save Jev settings</button></div>
    </form>
    <h2 style="margin-top:18px">Sites</h2>
    <div class="tablewrap"><table style="min-width:720px"><thead><tr><th>Site</th><th>On</th><th>Threshold</th><th>Last 7 days</th><th>Jev decided</th><th>Avg confidence</th></tr></thead><tbody>
    ${(J.sites || []).map((x) => `<tr><td class="name">${esc(nice(x.site))}<small title="${esc(x.about)}">${esc(x.about.slice(0, 90))}${x.about.length > 90 ? "…" : ""}</small></td>
      <td><select aria-label="Jev at ${esc(x.site)}" data-jev-site="${esc(x.site)}" data-jev-field="enabled"><option value="true" ${x.enabled ? "selected" : ""}>On</option><option value="false" ${!x.enabled ? "selected" : ""}>Off</option></select></td>
      <td><input aria-label="Threshold at ${esc(x.site)}" data-jev-site="${esc(x.site)}" data-jev-field="threshold" type="number" min="0.5" max="1" step="0.01" value="${esc(x.threshold ?? "")}" style="width:80px;font:inherit;padding:4px 8px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);color:var(--ink)"></td>
      <td>${x.calls7d}${x.errors7d ? ` <span class="chip bad">${x.errors7d} errors</span>` : ""}</td>
      <td>${x.calls7d ? `${Math.round(x.viaJev7d / x.calls7d * 100)}%` : `<span class="dim">—</span>`}</td>
      <td>${x.avgConfidence ?? `<span class="dim">—</span>`}</td></tr>`).join("")}
    </tbody></table></div></section>`;
}

V.budget = () => {
  const b = STATE.budget?.brake || {};
  const jobs = b.jobs || {};
  return `${head("Budget", "Jori runs on your Claude subscription allowance. When the week is on pace to run out before it resets, optional work waits and important work moves to a cheaper model.")}
  ${err(STATE.budget)}
  <section class="panel"><h2>The brake</h2><dl class="kv">${Object.entries(b).filter(([k, v]) => k !== "jobs" && typeof v !== "object").map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
  <p class="small dim">Change the threshold and the rest in <button class="linkish" data-cfg="allowance-brake">allowance-brake settings</button>.</p></section>
  <section><h2>What waits, and what keeps going</h2><div class="tablewrap"><table style="min-width:560px"><thead><tr><th>Work</th><th>When the budget is tight</th><th></th></tr></thead><tbody>
  ${Object.entries(jobs).map(([name, j]) => `<tr><td class="name">${esc(j.label || nice(name))}<small>${esc(name)}</small></td>
    <td><select aria-label="Importance of ${esc(name)}" data-importance="${esc(name)}">${["essential", "important", "optional"].map((x) => `<option ${j.importance === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
    <td class="dim small">${j.importance === "essential" ? "Always runs" : j.importance === "important" ? `Runs on ${esc(j.cheaper?.model || "a cheaper model")}` : "Waits until the reset"}</td></tr>`).join("")}
  </tbody></table></div></section>`;
};

V.channels = () => {
  const C = STATE.channels || {};
  const q = C.quietHours || {};
  return `${head("Channels", "Where Jori hears from you and how it reaches you.")}
  ${err(C)}
  <div class="list">${(C.channels || []).map((c) => `<div class="row"><div><div class="t">${esc(c.name)}</div><div class="s">${c.port ? `Port ${c.port}. ` : ""}${esc(c.detail || c.error || "")} ${(c.config || []).map((n) => `<button class="linkish small" data-cfg="${esc(n)}">${esc(n)}</button>`).join(", ")}</div></div>
    ${c.up === true ? `<span class="chip ok">Up</span>` : c.up === false ? `<span class="chip bad">Down</span>` : `<span class="chip">Not probed</span>`}</div>`).join("")}</div>
  <section class="panel"><h2>Awake hours</h2><p class="dim small" style="margin-top:0">Non-urgent pings wait outside these hours.${hardChip("awake")}</p>
    <form class="formgrid" data-form="quiet"><div class="field"><label for="q-from">Awake from</label><select id="q-from" name="awake_from">${hours(q.awake_from)}</select></div>
    <div class="field"><label for="q-to">Until</label><select id="q-to" name="awake_to">${hours(q.awake_to, 1)}</select></div>
    <div class="field" style="align-content:end"><button class="btn primary" type="submit">Save awake hours</button></div></form></section>`;
};
const hours = (sel, off = 0) => Array.from({ length: 24 }, (_, i) => i + off).map((h) => `<option value="${h}" ${h === sel ? "selected" : ""}>${fmtTime(h % 24, 0)}</option>`).join("");

V.features = () => {
  const list = Array.isArray(STATE.configs) ? STATE.configs : [];
  const g = {}; list.forEach((c) => (g[area(c.name)] ||= []).push(c));
  return `${head("Feature settings", `${list.length} settings files, one per feature. Each opens as a form built from the file, with the file's notes as help. The raw JSON is one click away.`)}
  ${err(STATE.configs)}
  <div class="filters"><input type="search" id="ctl-cq" placeholder="Find a setting" aria-label="Find a setting"></div>
  ${Object.keys(g).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b)).map((k) => `<section data-cgroup><h2>${esc(k)}</h2><div class="cfggrid">${g[k].map((c) => `<button class="cfg" data-cfg="${esc(c.name)}"><b>${esc(c.name.replace(/-/g, " "))}</b><p>${esc(c.error || c.about || `${c.keys} settings`)}</p></button>`).join("")}</div></section>`).join("")}`;
};

function hardChip(key) {
  const f = (STATE.hardcoded?.findings || []).find((x) => x.key === key);
  return f && f.count ? ` <span class="chip warn" title="${esc((f.files || []).slice(0, 3).join(", "))}">Also hardcoded in ${f.count} place${f.count > 1 ? "s" : ""}</span>` : "";
}
const IDENTITY = [
  ["The assistant", [["assistant_name", "Name", "Used in messages, notification titles, email sender names, prompts and pages."], ["sender_name", "Email sender name"], ["assistant_aliases", "Earlier names it still answers to", "Comma-separated."]]],
  ["Who it works for", [["owner_name", "Owner"], ["owner_id", "Owner id", "Stored data embeds this; change with care."], ["owner_email", "Owner's email", "Also who may use this control room."], ["partner_name", "Partner it also acts for"], ["home_city", "Home city"], ["tz", "Home time zone", "Schedules on the host run in this zone."]]],
  ["Addresses", [["agent_email", "Sends mail as"], ["agent_email_aliases", "Also counts as its own address", "Comma-separated."], ["domain", "Domain"]]],
  ["Accounts it runs under", [["supabase_project", "Supabase project"], ["gcp_project", "Google Cloud project"], ["github_owner", "GitHub owner"], ["approval_domain", "Approval signing context", "Changing this breaks approval links already sent."], ["attachments_bucket", "Attachments bucket"]]],
  ["The machine", [["host", "Host name"], ["host_label", "Called in a sentence"], ["host_title", "Called at the start of a sentence"]]],
];
V.identity = () => {
  const I = STATE.identity || {};
  const val = (k) => k.endsWith("_aliases") ? (k === "assistant_aliases" ? I.aliases : (I.file?.[k] || [])).join(", ") : (I.file?.[k] ?? "");
  const resolved = (k) => I.resolved?.[k];
  return `${head("Identity and addresses", "What the assistant is called, who it works for, and the addresses and accounts it uses. Mail, approvals, notifications and prompts read these.")}
  ${err(I)}
  <form data-form="identity" style="display:grid;gap:18px">
  ${IDENTITY.map(([title, fields]) => `<section class="panel"><h2>${esc(title)}</h2><div class="formgrid">${fields.map(([k, label, help]) => `<div class="field"><label for="id-${k}">${esc(label)}${(I.envOverrides || []).includes(k) ? ` <span class="chip warn">Set by an environment variable</span>` : ""}${hardChip(k)}</label>
    <input id="id-${k}" name="${k}" value="${esc(val(k))}" placeholder="${esc(!val(k) && resolved(k) ? resolved(k) : "")}">${help ? `<span class="help">${esc(help)}</span>` : ""}</div>`).join("")}</div></section>`).join("")}
  <div class="actions"><button class="btn primary" type="submit">Save identity</button><span class="dim small">Saved to <code>agent/local/instance.json</code>. Processes that cache it pick it up on restart.</span></div></form>`;
};

V.services = () => {
  const S = STATE.services || {};
  const g = {}; (S.services || []).forEach((s) => (g[s.group] ||= []).push(s));
  return `${head("Services and keys", `The ${(S.services || []).length} outside services Jori can use, and which of their keys are set on the host. Key values never leave the host: rotate a key in 1Password, then update <code>.env</code> on the host.`)}
  ${err(S)}
  ${Object.keys(g).map((k) => `<section><h2>${esc(k)}</h2><div class="list">${g[k].map((s) => `<div class="row"><div><div class="t">${esc(s.name)}</div><div class="s">${esc(s.does)}. ${(s.keys || []).map((x) => `<code>${esc(x)}</code>`).join(" ")} ${(s.config || []).map((n) => `<button class="linkish small" data-cfg="${esc(n)}">${esc(n)} settings</button>`).join(" ")}</div></div>
    ${s.keys.length ? `<span class="chip ok">${s.keys.length} key${s.keys.length > 1 ? "s" : ""} set</span>` : (s.env || []).length ? `<span class="chip">Not set up</span>` : `<span class="chip">No key needed</span>`}</div>`).join("")}</div></section>`).join("")}
  ${(S.unclaimed || []).length ? `<section><h2>Keys no service claims</h2><p class="dim small">Add these to a service in <code>service-catalog</code> settings, or remove them from <code>.env</code>.</p><p>${S.unclaimed.map((k) => `<code>${esc(k)}</code>`).join(" ")}</p></section>` : ""}`;
};

V.machine = () => {
  const M = STATE.machine || {};
  const P = M.ports || {};
  return `${head("The machine", `${esc(M.host_title || "The host")} runs everything from <code>${esc(M.install || "")}</code>. Ports are listed so a move to another machine is a form, not a search through code.`)}
  ${err(M)}
  <section><h2>Ports</h2><p class="dim small" style="margin-top:0">Restart the process that listens on a port after changing it. Identity and host names are on <a href="#identity">Identity</a>.</p>
  <div class="tablewrap"><table style="min-width:560px"><thead><tr><th>What listens</th><th>Port</th><th></th></tr></thead><tbody>
  ${Object.entries(P).map(([name, p]) => `<tr><td>${esc(p.label)}<br><span class="dim small mono">${esc(name)}</span></td><td><input aria-label="Port for ${esc(p.label)}" data-port="${esc(name)}" value="${p.port}" inputmode="numeric" style="width:90px;font:inherit;padding:4px 8px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);color:var(--ink)">${p.port !== p.default ? ` <span class="chip warn">default ${p.default}</span>` : ""}</td><td>${hardChip(`port:${p.port}`)}</td></tr>`).join("")}
  </tbody></table></div></section>
  <section><h2>Background services</h2><div class="list">${(Array.isArray(M.processes) ? M.processes : []).map((p) => `<div class="row"><div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.does)} <code>${esc(p.label || "")}</code></div></div><span class="chip ${p.expected ? "ok" : ""}">${p.expected ? "Always on" : "On schedule"}</span></div>`).join("")}</div></section>`;
};

V.hardcoded = () => {
  const H = STATE.hardcoded || {};
  const F = (H.findings || []).filter((f) => f.count);
  const total = F.reduce((a, f) => a + f.count, 0);
  return `${head("Not configurable yet", "Values written straight into the code instead of read from a setting. Each one is moving to the setting named here; until then, changing the setting does not reach these places.")}
  <p class="dim">${H.scannedAt ? `${total} places in ${F.length} groups, from the scan ${ago(H.scannedAt)}.` : "No scan yet."} The scan runs every hour on the host. <button class="btn" data-act="scan.run">Scan now</button></p>
  <div class="tablewrap"><table style="min-width:720px"><thead><tr><th>Value</th><th>Should come from</th><th>Places</th><th>Where</th></tr></thead><tbody>
  ${F.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.setting)}</td><td>${f.count}</td><td class="small">${(f.files || []).slice(0, 4).map((x) => `<code>${esc(x)}</code>`).join("<br>")}${f.files && f.files.length > 4 ? `<br><span class="dim">and ${f.files.length - 4} more</span>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="dim">Nothing hardcoded was found.</td></tr>`}
  </tbody></table></div>`;
};

V.plugins = () => {
  const PL = STATE.plugins || {};
  if (PL.error) return `${head("Plugins", "")}${err(PL)}`;
  const list = PL.plugins || [];
  const card = (p) => {
    const status = p.errors.length ? `<span class="chip bad">Broken</span>` : p.enabled ? `<span class="chip ok">On</span>` : `<span class="chip">Off</span>`;
    const parts = [
      p.schedules.length ? `${p.schedules.length} schedule${p.schedules.length > 1 ? "s" : ""}: ${p.schedules.map((x) => `<code>${esc(x.label)}</code> <span class="dim">${esc(cadence(x.cron).text)}</span>`).join(", ")}` : "",
      p.jobs.length ? `Jobs: ${p.jobs.map((x) => `<code>${esc(x)}</code>`).join(", ")}` : "",
      p.launchd.length ? `launchd: ${p.launchd.map((x) => `<code>${esc(x)}</code>`).join(", ")}` : "",
      p.bins.length ? `Commands: ${p.bins.map((x) => `<code>${esc(x)}</code>`).join(", ")}` : "",
      p.config ? `Settings: <button class="linkish" data-cfg="${esc(p.config)}">${esc(p.config)}</button>` : "",
    ].filter(Boolean);
    const action = p.errors.length ? "" : p.enabled
      ? `<button class="btn" data-confirm="Turn off ${esc(p.title)}? Its schedules stop; its settings and data stay." data-act="plugin.disable" data-args='${esc(JSON.stringify({ name: p.name }))}'>Turn off</button>`
      : `<button class="btn primary" data-act="plugin.enable" data-args='${esc(JSON.stringify({ name: p.name }))}' ${p.missing.length ? "disabled" : ""}>Turn on</button>`;
    return `<div class="panel" style="display:grid;gap:8px">
      <div class="actions" style="justify-content:space-between"><div><b style="font-size:1.05rem">${esc(p.title)}</b> <span class="dim small mono">${esc(p.name)} ${esc(p.version)}</span></div><div class="actions">${status}${action}</div></div>
      <div class="dim small">${esc(p.description)}</div>
      ${parts.length ? `<div class="small">${parts.join("<br>")}</div>` : ""}
      ${p.missing.length ? `<div class="note bad">Needs ${esc(p.missing.join(", "))} before it can run.</div>` : ""}
      ${p.errors.length ? `<div class="note bad">${esc(p.errors.join("; "))}</div>` : ""}
      <div class="dim small mono">${esc(p.dir)} (${p.scope === "local" ? "this installation's own" : "published with Jori"})</div>
    </div>`;
  };
  const loose = PL.notPluginYet || [];
  return `${head("Plugins", "Each feature as a module you can turn on, turn off, install or remove. Turning one off stops its schedules and hides its jobs; its settings and data stay. From a terminal: <code>jori plugin list|enable|disable|install|remove</code>.")}
  <div class="actions"><button class="btn" data-act="plugin.sync" data-args="{}">Sync schedules with plugins</button><span class="dim small">${list.filter((p) => p.enabled).length} of ${list.length} on</span></div>
  ${list.length ? list.map(card).join("") : `<p class="dim">No plugins installed yet.</p>`}
  <section><h2>Not a plugin yet</h2><p class="dim small" style="margin-top:0">${loose.length} scheduled jobs still live in the core. They move into plugins one feature at a time (<code>system/plugins.md</code> § Migration).</p>
  <div class="small">${loose.map((l) => `<code>${esc(l)}</code>`).join(" ")}</div></section>`;
};

V.setup = () => {
  const S = STATE.setup || {};
  if (S.error) return `${head("Setup", "")}${err(S)}`;
  const label = { ok: ["ok", "Ready"], missing: ["bad", "Missing"], warn: ["warn", "Needs a look"], optional: ["", "Not set up"] };
  const g = {}; (S.items || []).forEach((i) => (g[i.group] ||= []).push(i));
  const c = S.counts || {};
  const order = { missing: 0, warn: 1, ok: 2, optional: 3 };
  return `${head("Setup", "Everything this installation needs, and whether it has it. Required items first; an outside service that is not set up is fine if you do not use it.")}
  <div class="stats">
    <div class="stat ${c.missing ? "bad" : ""}"><b>${c.missing || 0}</b><span>missing</span></div>
    <div class="stat"><b>${c.warn || 0}</b><span>need a look</span></div>
    <div class="stat"><b>${c.ok || 0}</b><span>ready</span></div>
    <div class="stat"><b>${c.optional || 0}</b><span>optional, not set up</span></div>
  </div>
  ${Object.keys(g).map((k) => `<section><h2>${esc(k)}</h2><div class="list">${g[k].slice().sort((a, b) => order[a.status] - order[b.status]).map((i) => `<div class="row"><div><div class="t">${i.fix && i.fix.startsWith("#") ? `<a href="${esc(i.fix)}">${esc(i.name)}</a>` : esc(i.name)}</div><div class="s">${esc(i.detail || "")}</div></div><span class="chip ${label[i.status][0]}">${label[i.status][1]}</span></div>`).join("")}</div></section>`).join("")}
  <p class="dim small">A new installation starts with <code>jori init</code>, which asks who you are and writes the first settings; this page shows what is left after that.</p>`;
};

V.history = () => {
  const H = Array.isArray(STATE.history) ? STATE.history : [];
  return `${head("Change history", "Every change made here, newest first, with a way to put it back.")}
  <div class="list">${H.map((e) => `<div class="row"><div><div class="t">${esc(e.what)}</div><div class="s">${new Date(e.ts).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. ${esc(e.who)}. <code>${esc(e.target || "")}</code></div></div>${e.undo ? `<button class="btn" data-act="history.revert" data-args='${esc(JSON.stringify({ id: e.id }))}'>Put back</button>` : ""}</div>`).join("") || `<p class="dim">No changes yet. Changes made on these pages show up here.</p>`}</div>`;
};

// What the failing-job watch and its repair job know about this job.
function repairNote(j) {
  const inc = (STATE.jobFailures || {})[j.label || j.name];
  const R = STATE.jobRepairs || {};
  const pend = (R.pending || []).find((p) => p.label === (j.label || j.name));
  const last = (R.history || []).filter((h) => h.label === (j.label || j.name)).at(-1);
  if (!inc && !pend && !last) return "";
  const outcome = { repaired: "fixed it", needs_owner: "found it needs you", transient: "found it ran fine again", failed: "could not fix it" };
  return `<section><h2>Repair</h2>
    ${inc ? `<div class="note bad">Failing since ${esc(new Date(inc.since).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${inc.error ? `: <code>${esc(inc.error)}</code>` : ""}</div>` : ""}
    ${pend ? `<div class="dim small">A repair is ${pend.status === "claimed" ? "working on it now" : "queued"}.</div>` : ""}
    ${last ? `<div class="dim small">Last repair ${esc(ago(last.done_at))} ${esc(outcome[last.outcome] || last.outcome)}${last.owner_action ? `: ${esc(last.owner_action)}` : last.note ? `: ${esc(last.note)}` : ""}${last.commit ? ` (<code>${esc(last.commit.slice(0, 7))}</code>)` : ""}.</div>` : ""}
  </section>`;
}

// ── drawers ─────────────────────────────────────────────────────────────
function closeDrawer() { const d = $("#ctl-drawer"); if (d) d.remove(); }
function drawer(label, html) {
  closeDrawer();
  const d = document.createElement("div");
  d.id = "ctl-drawer";
  d.innerHTML = `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</aside>`;
  document.body.appendChild(d);
  $("[data-close].btn", d)?.focus();
  return d;
}

function openJob(id) {
  const j = JOBS.find((x) => x.id === id);
  if (!j) return;
  const now = wallNow();
  const isCron = j.source === "cron";
  const parts = isCron ? j.schedule.split(/\s+/) : null;
  const H = isCron ? [...field(parts[1], 0, 23)][0] : (j.schedule.calendar?.[0]?.Hour ?? 9);
  const M = isCron ? [...field(parts[0], 0, 59)][0] : (j.schedule.calendar?.[0]?.Minute ?? 0);
  const dows = isCron && parts[4] !== "*" ? [...field(parts[4], 0, 6)] : (j.schedule.calendar || []).filter((e) => e.Weekday != null).map((e) => e.Weekday % 7);
  const preset = isCron ? (parts[0].startsWith("*/") ? "every" : parts[4] !== "*" ? "weekly" : parts[2] !== "*" ? "monthly" : parts[1] === "*" ? "hourly" : "daily")
    : j.schedule.every ? "every" : j.schedule.calendar ? (dows.length ? "weekly" : j.schedule.calendar.some((e) => e.Day != null) ? "monthly" : "daily") : "none";
  const every = isCron && parts[0].startsWith("*/") ? +parts[0].slice(2) : j.schedule.every ? Math.round(j.schedule.every / 60) : 15;
  const canSchedule = isCron ? !!j.tag : !!j.file && !j.schedule.service;
  const pausedFamily = j.paused && !["PAUSED", "UNLOADED"].includes(j.paused);
  const last = j.recent.at(-1);
  const d = drawer(j.nice, `
    <div class="actions" style="justify-content:space-between;align-items:start"><div><h3>${esc(j.nice)}</h3><div class="dim small" style="margin-top:4px">${esc(j.area)}, ${isCron ? "in the crontab" : "a launchd agent"}</div></div><button class="btn" data-close>Close</button></div>
    <div class="actions">
      <button class="btn primary" data-confirm="Run ${esc(j.nice)} now?" data-act="job.run" data-args='${esc(JSON.stringify({ id }))}' ${j.paused === "UNLOADED" ? "disabled" : ""}>Run now</button>
      ${pausedFamily ? `<span class="dim small">Paused with the ${esc(j.paused)} family; resume it from the Schedule page.</span>`
        : j.paused ? `<button class="btn" data-act="job.resume" data-args='${esc(JSON.stringify({ id }))}'>${j.paused === "UNLOADED" ? "Load and resume" : "Resume"}</button>`
        : `<button class="btn" data-act="job.pause" data-args='${esc(JSON.stringify({ id }))}'>Pause</button>`}
    </div>
    <section><h2>Health</h2>
      ${j.recent.length ? `<div class="runs" aria-label="Last ${j.recent.length} runs">${j.recent.map((r) => `<i class="${r.exit !== 0 ? "f" : ""}" title="${esc(new Date(r.start).toLocaleString())}: exit ${r.exit}"></i>`).join("")}</div>
        <div class="dim small">${j.recent.length} recent runs, ${j.fails} failed. Last ${ago(last.start)}, took ${dur(last.ms || 0)}, exit ${last.exit}.</div>` : `<div class="dim small">No runs logged. Only jobs started through <code>cron-run</code> are logged.</div>`}
    </section>
    ${repairNote(j)}
    <section><h2>When it runs</h2>
      ${canSchedule ? `<div class="formgrid">
        <div class="field"><label for="sc-preset">Repeat</label><select id="sc-preset">${[["every", "Every few minutes"], ...(isCron ? [["hourly", "Every hour"]] : []), ["daily", "Every day"], ["weekly", "On certain days"], ["monthly", "Once a month"], ...(isCron ? [["custom", "Custom (cron)"]] : [])].map(([k, l]) => `<option value="${k}" ${k === preset ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field" data-show="daily weekly monthly hourly"><label for="sc-at">At</label><input id="sc-at" type="time" value="${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}"></div>
        <div class="field" data-show="every"><label for="sc-every">Every how many minutes</label><input id="sc-every" type="number" min="1" max="720" value="${every}"></div>
        <div class="field" data-show="monthly"><label for="sc-dom">Day of the month</label><input id="sc-dom" type="number" min="1" max="28" value="${isCron && parts[2] !== "*" ? parseInt(parts[2], 10) : (j.schedule.calendar?.[0]?.Day ?? 1)}"></div>
        ${isCron ? `<div class="field" data-show="custom"><label for="sc-cron">Cron line</label><input id="sc-cron" class="mono" value="${esc(j.schedule)}"></div>` : ""}
      </div>
      <div data-show="weekly"><div class="flabel" style="margin-bottom:4px">Days</div><div class="days">${DAYN.map((n, i) => `<button type="button" aria-pressed="${dows.includes(i)}" data-dow="${i}">${n}</button>`).join("")}</div></div>
      <div class="dim small">Now: ${esc(j.cad.text)}${j.next ? `. Next run ${fmtWall(j.next, now)}` : ""}. Times are ${esc(TZ.replace(/_/g, " "))}.</div>
      <div id="sc-diff"></div>
      <div class="actions"><button class="btn primary" id="sc-save" disabled>Save schedule</button></div>`
      : `<div class="dim small">${esc(j.cad.text)}. ${isCron ? "This line has no --label, so it cannot be edited here safely." : "Started by another process, not by a clock."}</div>`}
    </section>
    <section><h2>How it runs</h2>
      <div class="formgrid">
        <div class="field"><label for="rt-target">Agent</label><select id="rt-target">${["", "ops", "ops-light", "ops-haiku"].map((t) => `<option value="${t}" ${(j.route?.target || "") === t ? "selected" : ""}>${t || "(not routed)"}</option>`).join("")}</select></div>
        <div class="field"><label for="rt-model">Model</label><select id="rt-model">${["", "opus", "sonnet", "haiku"].map((t) => `<option value="${t}" ${(j.route?.model || "") === t ? "selected" : ""}>${t || "(default)"}</option>`).join("")}</select></div>
        <div class="field"><label for="rt-effort">Effort</label><select id="rt-effort">${["", "low", "medium", "high", "xhigh"].map((t) => `<option value="${t}" ${(j.route?.effort || "") === t ? "selected" : ""}>${t || "(default)"}</option>`).join("")}</select></div>
        <div class="field"><label for="rt-imp">When the budget is tight</label><select id="rt-imp">${["", "essential", "important", "optional"].map((t) => `<option value="${t}" ${(j.importance || "") === t ? "selected" : ""}>${t || "(not braked)"}</option>`).join("")}</select></div>
      </div>
      <div class="actions"><button class="btn" id="rt-save">Save how it runs</button><span class="dim small">Routing applies to jobs the agents dispatch by name.</span></div>
    </section>
    <section><h2>Details</h2><dl class="kv"><dt>Command</dt><dd><code>${esc(j.command)}</code></dd><dt>Label</dt><dd><code>${esc(j.label || j.name)}</code></dd>${j.file ? `<dt>Plist</dt><dd><code>${esc(j.file)}</code></dd>` : ""}${j.paused ? `<dt>Paused</dt><dd><code>${esc(j.paused)}</code></dd>` : ""}</dl></section>`);

  if (canSchedule) {
    const pick = () => {
      const p = $("#sc-preset", d).value;
      d.querySelectorAll("[data-show]").forEach((el) => { el.hidden = !el.dataset.show.split(" ").includes(p); });
      const [hh, mm] = ($("#sc-at", d).value || "0:0").split(":").map(Number);
      const ds = [...d.querySelectorAll("[data-dow]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => +b.dataset.dow).sort();
      const ev = Math.max(1, Math.min(720, +$("#sc-every", d).value || 15));
      const dom = Math.max(1, Math.min(28, +$("#sc-dom", d).value || 1));
      if (isCron) {
        let c = j.schedule;
        if (p === "every") c = ev < 60 ? `*/${ev} * * * *` : `0 */${Math.round(ev / 60)} * * *`;
        else if (p === "hourly") c = `${mm} * * * *`;
        else if (p === "daily") c = `${mm} ${hh} * * *`;
        else if (p === "weekly") c = `${mm} ${hh} * * ${ds.join(",") || "*"}`;
        else if (p === "monthly") c = `${mm} ${hh} ${dom} * *`;
        else c = $("#sc-cron", d).value.trim();
        const changed = c !== j.schedule;
        $("#sc-diff", d).innerHTML = changed ? `<div class="flabel" style="margin-bottom:4px">${esc(cadence(c).text)}. The crontab line becomes:</div><div class="diff"><div class="minus">- ${esc(j.schedule)}  …--label ${esc(j.label)}</div><div class="plus">+ ${esc(c)}  …--label ${esc(j.label)}</div></div>` : "";
        $("#sc-save", d).disabled = !changed;
        return { cron: c };
      }
      let launchd;
      if (p === "every") launchd = { every: ev * 60 };
      else if (p === "weekly") launchd = { calendar: (ds.length ? ds : [1]).map((w) => ({ Weekday: w, Hour: hh, Minute: mm })) };
      else if (p === "monthly") launchd = { calendar: [{ Day: dom, Hour: hh, Minute: mm }] };
      else launchd = { calendar: [{ Hour: hh, Minute: mm }] };
      const changed = JSON.stringify(launchd) !== JSON.stringify(j.schedule.every ? { every: j.schedule.every } : { calendar: j.schedule.calendar });
      $("#sc-diff", d).innerHTML = changed ? `<div class="note">${esc(cadence(launchd).text)}. The plist is rewritten and the agent reloaded.</div>` : "";
      $("#sc-save", d).disabled = !changed;
      return { launchd };
    };
    d.addEventListener("input", pick); d.addEventListener("change", pick);
    d.querySelectorAll("[data-dow]").forEach((b) => b.addEventListener("click", () => { b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); if ($("#sc-preset", d).value !== "weekly") $("#sc-preset", d).value = "weekly"; pick(); }));
    pick();
    $("#sc-save", d).onclick = async () => { const v = pick(); await act("job.schedule", { id, ...v }).catch(() => {}); openJob(id); };
  }
  $("#rt-save", d).onclick = async () => {
    const name = j.name;
    const target = $("#rt-target", d).value, model = $("#rt-model", d).value, effort = $("#rt-effort", d).value, imp = $("#rt-imp", d).value;
    if (target || model || effort) await act("job.route", { name, target, model, effort }).catch(() => {});
    if (imp && imp !== j.importance) await act("job.importance", { name, importance: imp }).catch(() => {});
    openJob(id);
  };
}

async function openCfg(name) {
  const d = drawer(name, `<p class="dim">Reading ${esc(name)}…</p>`);
  let cfg;
  try {
    const res = await fetch(`/control/api/config?name=${encodeURIComponent(name)}`);
    cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error);
  } catch (e) { $(".drawer", d).innerHTML = `<div class="note bad">${esc(e.message || "Could not read it.")}</div><button class="btn" data-close>Close</button>`; return; }
  let obj = {};
  try { obj = JSON.parse(cfg.text); } catch {}
  const notes = Object.entries(obj).filter(([k]) => k.startsWith("_")).map(([k, v]) => `<p class="small dim" style="margin:0">${esc(Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : JSON.stringify(v))}</p>`).join("");
  const fieldFor = ([k, v], i) => {
    const id = `cf-${i}`;
    const lab = `<label for="${id}">${esc(k.replace(/_/g, " "))}</label>`;
    if (typeof v === "boolean") return `<div class="field">${lab}<select id="${id}" data-key="${esc(k)}" data-type="boolean"><option value="true" ${v ? "selected" : ""}>On</option><option value="false" ${!v ? "selected" : ""}>Off</option></select></div>`;
    if (typeof v === "number") return `<div class="field">${lab}<input id="${id}" data-key="${esc(k)}" data-type="number" type="number" step="any" value="${v}"></div>`;
    if (typeof v === "string") return `<div class="field">${lab}<input id="${id}" data-key="${esc(k)}" data-type="string" value="${esc(v)}"></div>`;
    return `<div class="field wide">${lab}<textarea id="${id}" data-key="${esc(k)}" data-type="json" rows="${Math.min(14, JSON.stringify(v, null, 2).split("\n").length)}">${esc(JSON.stringify(v, null, 2))}</textarea></div>`;
  };
  const cfgTitle = name.replace(/-/g, " "); // lang-regex-ok: a settings file name to words, not the user's language
  $(".drawer", d).innerHTML = `
    <div class="actions" style="justify-content:space-between;align-items:start"><div><h3>${esc(cfgTitle)}</h3><div class="dim small mono" style="margin-top:4px">${esc(cfg.file)}</div></div><button class="btn" data-close>Close</button></div>
    ${notes}
    <div class="actions"><div class="seg" role="group" aria-label="Edit as"><button type="button" data-mode="form" aria-pressed="true">Form</button><button type="button" data-mode="json" aria-pressed="false">JSON</button></div></div>
    <form id="cf-form" class="formgrid">${Object.entries(obj).filter(([k]) => !k.startsWith("_")).map(fieldFor).join("") || `<p class="dim">No settings yet. Add them as JSON.</p>`}</form>
    <div class="field" id="cf-jsonwrap" hidden><label for="cf-json">The whole file</label><textarea id="cf-json" rows="24">${esc(cfg.text)}</textarea></div>
    <div class="actions"><button class="btn primary" id="cf-save">Save settings</button><span class="dim small">The previous copy is kept, and the change can be put back from Change history.</span></div>`;
  let mode = "form";
  d.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => {
    mode = b.dataset.mode;
    d.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("#cf-form", d).hidden = mode !== "form"; $("#cf-jsonwrap", d).hidden = mode !== "json";
  });
  $("#cf-save", d).onclick = async () => {
    let text;
    if (mode === "json") text = $("#cf-json", d).value;
    else {
      const out = { ...obj };
      for (const el of d.querySelectorAll("[data-key]")) {
        const k = el.dataset.key, t = el.dataset.type;
        try {
          out[k] = t === "boolean" ? el.value === "true" : t === "number" ? Number(el.value) : t === "json" ? JSON.parse(el.value) : el.value;
        } catch (e) { toast(`${k}: that is not valid JSON (${e.message}).`, { bad: true }); return; }
      }
      text = JSON.stringify(out, null, 2) + "\n";
    }
    try { await act("config.save", { name, text }); openCfg(name); } catch {}
  };
}

// ── shell ───────────────────────────────────────────────────────────────
const SECTIONS = [
  ["Overview", [["today", "Today"], ["setup", "Setup"]]],
  ["What runs when", [["schedule", "Schedule"], ["watches", "Watches"]]],
  ["How it works", [["plugins", "Plugins"], ["agents", "Agents and models"], ["budget", "Budget"], ["channels", "Channels"], ["features", "Feature settings"]]],
  ["Who and where", [["identity", "Identity and addresses"], ["services", "Services and keys"], ["machine", "The machine"]]],
  ["Keeping it right", [["hardcoded", "Not configurable yet"], ["history", "Change history"]]],
];
function counts() {
  const failing = JOBS.filter((j) => j.state === "failing").length;
  const hard = (STATE.hardcoded?.findings || []).filter((f) => f.count).length;
  return {
    today: failing ? [failing, true] : null,
    setup: STATE.setup?.counts?.missing ? [STATE.setup.counts.missing, true] : null, schedule: [JOBS.length], watches: [(Array.isArray(STATE.watches) ? STATE.watches : []).filter((w) => w.status === "active").length],
    features: [(Array.isArray(STATE.configs) ? STATE.configs : []).length],
    plugins: STATE.plugins?.plugins ? [STATE.plugins.plugins.filter((p) => p.enabled).length] : null, services: [(STATE.services?.services || []).length], hardcoded: hard ? [hard, true] : null,
  };
}
function current() { const h = location.hash.slice(1); return V[h] ? h : "today"; }
function render() {
  const r = current();
  const c = counts();
  const scrollY = window.scrollY;
  root.className = "ctl";
  root.innerHTML = `<aside class="ctl-side">${SECTIONS.map(([g, items]) => `<div><h4>${esc(g)}</h4><nav aria-label="${esc(g)}">${items.map(([k, l]) => `<a href="#${k}" ${k === r ? 'aria-current="page"' : ""}>${esc(l)}${c[k] ? ` <span class="n${c[k][1] ? " alert" : ""}">${c[k][0]}</span>` : ""}</a>`).join("")}</nav></div>`).join("")}</aside>
    <div class="ctl-main">${V[r]()}</div>`;
  window.scrollTo(0, scrollY);
}

// ── events ──────────────────────────────────────────────────────────────
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-open],[data-close],[data-act],[data-f],[data-cfg]");
  if (!t) return;
  if (t.dataset.open) { e.preventDefault(); openJob(t.dataset.open); return; }
  if (t.hasAttribute("data-close")) { closeDrawer(); return; }
  if (t.dataset.cfg) { e.preventDefault(); openCfg(t.dataset.cfg); return; }
  if (t.dataset.f) {
    filt[t.dataset.f] = t.dataset.v;
    t.parentNode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === t));
    $("#ctl-tbl").innerHTML = scheduleTable();
    return;
  }
  if (t.dataset.act) {
    if (t.dataset.confirm && t.dataset.armed !== "1") {
      t.dataset.armed = "1"; const was = t.textContent; t.textContent = "Click again to confirm";
      setTimeout(() => { if (t.isConnected) { t.dataset.armed = ""; t.textContent = was; } }, 4000);
      return;
    }
    t.disabled = true;
    const inDrawer = t.closest(".drawer");
    const args = JSON.parse(t.dataset.args || "{}");
    try { await act(t.dataset.act, args); } catch {}
    if (inDrawer && args.id && JOBS.some((j) => j.id === args.id)) openJob(args.id); else if (inDrawer) closeDrawer();
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f).entries());
  try {
    if (f.dataset.form === "identity") await act("instance.save", { values: data });
    else if (f.dataset.form === "quiet") await act("quiet.save", data);
    else if (f.dataset.form === "jev") await act("jev.save", data);
    else if (f.dataset.form === "models") {
      const pins = STATE.agents?.pins || {};
      for (const [key, value] of Object.entries(data)) if (pins[key] !== value) await act("models.save", { key, value: value.trim() });
    }
  } catch {}
});
document.addEventListener("change", (e) => {
  const imp = e.target.closest("[data-importance]");
  if (imp) act("job.importance", { name: imp.dataset.importance, importance: imp.value }).catch(() => {});
  const js = e.target.closest("[data-jev-site]");
  if (js) act("jev.save", { site: js.dataset.jevSite, [js.dataset.jevField]: js.value }).catch(() => {});
  const port = e.target.closest("[data-port]");
  if (port) act("ports.save", { name: port.dataset.port, port: port.value }).catch(() => {});
});
document.addEventListener("input", (e) => {
  if (e.target.id === "ctl-q") { filt.q = e.target.value; $("#ctl-tbl").innerHTML = scheduleTable(); }
  if (e.target.id === "ctl-cq") {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll(".cfg[data-cfg]").forEach((b) => { b.hidden = !b.dataset.cfg.includes(q) && !b.textContent.toLowerCase().includes(q); });
    document.querySelectorAll("[data-cgroup]").forEach((s) => { s.hidden = !s.querySelector(".cfg:not([hidden])"); });
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
  if (e.key === "Enter" && e.target.matches("tr[data-open]")) openJob(e.target.dataset.open);
});
const tip = document.createElement("div"); tip.className = "ctl-tip"; tip.hidden = true; document.body.appendChild(tip);
document.addEventListener("pointerover", (e) => {
  const f = e.target.closest(".fire");
  if (!f) { tip.hidden = true; return; }
  tip.textContent = f.dataset.tip; tip.hidden = false;
  const r = f.getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - 290, Math.max(8, r.left - 20))}px`; tip.style.top = `${r.top - 34}px`;
});
window.addEventListener("hashchange", () => { closeDrawer(); render(); window.scrollTo(0, 0); });

load().then(render).catch((e) => {
  root.innerHTML = `<div class="note bad">The control room could not read the host's state: ${esc(e.message)}. Reload to try again.</div>`;
});
})();
