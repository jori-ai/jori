// act-watch.mjs — pure helpers for bin/act-watch: named touring acts (novelty
// and exhibition sports, a touring show) near home, from Ticketmaster
// Discovery attractions plus any schedule-page source a hook module reads.
//
// Everything here is structure, not language: Ticketmaster is JSON, and a
// schedule page is the site's own markup, read by a hook module in
// lib/act-watch/_ext/*.mjs. A parse that returns nothing is reported with a
// `diagnostic`, so a site redesign shows up as a reason rather than a silent 0.
//
// A hook module exports `kinds` ({name: async (src, ctx) → {rows, banner?}}):
//   rows    [{act, act_label, who?, teams[], venue, city, state, date, time,
//             url, tickets?, mechanism?}] — the module applies its own region
//            filter (ctx.inWindow) and returns rows in the window
//   banner  {id, title, text, link_text, url, hook} — one standing notice
//            (a ticket lottery opening); surfaced once per id
// ctx = {today, horizonDays, log, sourceFail(skill, action, error, diagnostic), inWindow, getText}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.join(__dirname, "act-watch", "_ext");

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); // lang-regex-ok: id slug of a machine string

/** Ticketmaster Discovery event JSON → row. */
export function tmRow(ev, act) {
  const v = ev._embedded?.venues?.[0] || {};
  let url = ev.url;
  try { const inner = new URL(ev.url).searchParams.get("u"); if (inner && inner.startsWith("http")) url = inner; } catch {}
  return {
    act: act.act, act_label: act.label, teams: [act.label], venue: v.name || null, city: v.city?.name || null,
    state: v.state?.stateCode || null, date: ev.dates?.start?.localDate || null,
    time: ev.dates?.start?.localTime || null, status: ev.dates?.status?.code || null,
    price_min: ev.priceRanges?.[0]?.min ?? null, url, tm_id: ev.id, title: ev.name,
  };
}

/** Dedup key: one item per act+venue+date (a double-header is one item). */
export const itemId = (r) => `${r.act}|${slug(r.venue)}|${r.date}`;

/** Keep rows in the region and inside [today, today+horizon]. */
export function inWindow(rows, { states = null, today, horizonDays }) {
  const end = new Date(`${today}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + horizonDays);
  const endStr = end.toISOString().slice(0, 10);
  return rows.filter((r) => r.date && r.date >= today && r.date <= endStr && (!states || states.includes(r.state)));
}

/** Merge by itemId; TM rows bring a ticket link, so they win the url/price slots. */
export function mergeRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = itemId(r);
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...r, id: k }); continue; }
    by.set(k, { ...prev, url: prev.url || r.url, price_min: prev.price_min ?? r.price_min, time: prev.time || r.time, status: prev.status || r.status });
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date) || a.act.localeCompare(b.act));
}

export function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "14:00:00" / "19:30" (TM localTime) → "2:00 PM"; a site's own time string passes through. */
export function fmtTime(t) {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(t || "")); // lang-regex-ok: machine HH:MM[:SS] time
  if (!m) return t || null;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
}

/** Consecutive dates at one venue by one act read as one block. */
export function groupRuns(items) {
  const groups = new Map();
  for (const it of items) {
    const k = `${it.act}|${it.venue}|${(it.teams || []).join("/")}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.values()].sort((a, b) => a[0].date.localeCompare(b[0].date));
}

/** Seen match on city+date as well as the full id: two in-region shows in one city on one day don't happen. */
export const cityDate = (city, date) => `${String(city || "").split(",")[0].toLowerCase().replace(/[^a-z0-9]+/g, "")}|${date}`; // lang-regex-ok: city-name normalization for a dedup key

/** How a row's tickets are bought: its own `tickets` line, else Ticketmaster with a price. */
export function ticketsLine(r) {
  if (r.tickets) return r.tickets;
  return `Tickets: Ticketmaster${r.price_min != null ? ` · from $${Math.round(r.price_min)}` : ""}`;
}

/** The phone hook: the banner's, else the first act at its venue. */
export function hookText(groups, banner) {
  const first = groups[0]?.[0];
  if (banner) return `${banner.hook}${first ? `, plus ${first.venue} dates` : ""}, details in email`;
  return `${first.act_label || first.act} at ${first.venue}${groups.length > 1 ? ` and ${groups.length - 1} more` : ""}, details in email`;
}

export function renderEmail({ groups, banner, cards = new Map(), escapeHtml }) {
  const parts = [`<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px">`];
  if (banner) {
    parts.push(`<div style="background:#FFF4C2;border-radius:8px;padding:12px 14px;margin-bottom:16px"><b>${escapeHtml(banner.title)}</b>${banner.text ? ` ${escapeHtml(banner.text)}` : ""}<br><a href="${escapeHtml(banner.url)}">${escapeHtml(banner.link_text || "Details")}</a></div>`);
  }
  for (const g of groups) {
    const f = g[0];
    const dates = g.map((x) => fmtDate(x.date) + (x.time ? `, ${escapeHtml(fmtTime(x.time))}` : "")).join("<br>");
    const who = f.who || f.act_label || f.act;
    parts.push(`<div style="margin:0 0 18px"><div style="font-size:16px;font-weight:600">${escapeHtml(who)}</div>`
      + `<div>${escapeHtml(f.venue)}, ${escapeHtml(f.city)}${f.state ? `, ${escapeHtml(f.state)}` : ""}</div>`
      + `<div style="color:#555">${dates}</div><div style="color:#555">${escapeHtml(ticketsLine(f))}</div>`
      + `${cards.get(f.url) || ""}</div>`);
  }
  parts.push(`</div>`);
  return parts.join("\n");
}

/** Every source kind a hook module in `dir` exports. One broken module is reported and skipped. */
export async function loadKinds({ dir = EXT_DIR, log = (m) => console.error(m) } = {}) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).sort(); } catch { return out; } // lang-regex-ok: module file extension
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      for (const [kind, fn] of Object.entries(mod.kinds || {})) if (typeof fn === "function") out[kind] = fn;
    } catch (e) { log(`act-watch: hook module ${f} failed to load: ${e?.message || e}`); }
  }
  return out;
}
