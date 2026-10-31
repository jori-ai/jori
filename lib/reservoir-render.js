"use strict";
// Shared reservoir renderers. Both views — the travel site fragment
// (renderReservoirHtml) and the mini wiki page (renderReservoirWiki) — are pure
// functions of ONE reservoir object, so whatever the single source of truth
// (Supabase trip_reservoirs.structured) holds is exactly what both surfaces
// show. Keeping them here (not duplicated in each tool) is what makes the wiki a
// true mirror of the same data the site renders.

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Site HTML fragment (styled for phones; injected into the travel site) ────────
function nameLink(name, uri) {
  const n = esc(name);
  return uri ? `<a href="${esc(uri)}" target="_blank" rel="noopener">${n}</a>` : n;
}
function rating(r) { return r ? `<span class="res-rating">★ ${esc(r)}</span>` : ""; }
function addr(a) { return a ? `<div class="res-addr">📍 ${esc(a)}</div>` : ""; }
function why(w) { return w ? `<div class="res-why">${esc(w)}</div>` : ""; }
function dog(ok) { return ok ? `<span class="res-badge res-dog">🐾 dog-friendly</span>` : ""; }

function item(bucket, it) {
  let head = "", extra = "";
  if (bucket === "food_specialties") {
    // Dish vs table — see the same split in apps/itin/components/EntryBody.tsx.
    // A table is headlined by the restaurant; a dish by the food.
    const isTable = it.kind === "table" || !it.dish;
    head = isTable
      ? `<div class="res-name">${nameLink(it.best_place, it.mapsUri)} ${rating(it.rating)}</div>`
      : `<div class="res-name">${esc(it.dish)}</div>`;
    const at = isTable
      ? (it.known_for ? `<div class="res-sub">known for ${esc(it.known_for)}</div>` : "")
      : (it.best_place ? `<div class="res-sub">best at ${nameLink(it.best_place, it.mapsUri)} ${rating(it.rating)}</div>` : "");
    const detour = it.iconic_detour ? `<span class="res-badge res-detour">worth a detour</span>` : "";
    extra = at + (detour ? `<div>${detour}</div>` : "");
  } else if (bucket === "time_sensitive") {
    head = `<div class="res-name">${nameLink(it.name, it.mapsUri)} ${rating(it.rating)}</div>`;
    const when = [it.date, Array.isArray(it.days) ? it.days.join("/") : it.days, it.hours].filter(Boolean).map(esc).join(" · ");
    if (when) extra += `<div class="res-when">📅 ${when}</div>`;
    if (it.source_url) extra += `<div class="res-src"><a href="${esc(it.source_url)}" target="_blank" rel="noopener">source ↗</a></div>`;
  } else if (bucket === "unique_experiences") {
    head = `<div class="res-name">${nameLink(it.name, it.mapsUri)} ${rating(it.rating)}</div>`;
    if (it.window) extra += `<div class="res-when">🕐 ${esc(it.window)}</div>`;
  } else {
    const star = bucket === "must_see" ? `<span class="res-star">★</span> ` : "";
    head = `<div class="res-name">${star}${nameLink(it.name, it.mapsUri)} ${rating(it.rating)} ${dog(it.dog_ok)}</div>`;
    if (it.food_hook) extra += `<div class="res-hook">🍴 ${esc(it.food_hook)}</div>`;
  }
  // Places the user has already been to are struck through, never dropped — a
  // place already seen is still part of the trip's record, and a wrong mark has to
  // stay visible enough to correct. `done_date`/`done_source` come from
  // the reservoir mark-done sweep; the tooltip carries the evidence so a surprising
  // strike can be traced without opening the JSON.
  // The interactive Done/Skip pills live only on the React site (they need a
  // server action). This wiki/email mirror is static, so it just reflects the
  // resulting state: a "been" badge for done, a "skipped" badge for skipped.
  const isDone = it.state === "done";
  const isSkipped = it.state === "skipped";
  const badge = isDone
    ? `<span class="res-badge res-donebadge" title="${esc(it.done_evidence || "")}">✓ been${it.done_date ? ` ${esc(it.done_date)}` : ""}</span>`
    : isSkipped
    ? `<span class="res-badge res-skipbadge" title="${esc(it.skip_reason || "")}">✕ skipped</span>`
    : "";
  const photo = it.photo_url
    ? `<img class="res-photo" src="${esc(it.photo_url)}" alt="" loading="lazy"/>`
    : "";
  const stateClass = isDone ? " res-done" : isSkipped ? " res-skipped" : "";
  // The SAME `seq` the site's list and map pins use (assigned by
  // lib/reservoir-cluster.js), so a number means one thing everywhere.
  const seq = it.seq ? `<span class="res-seq">${it.seq}</span>` : "";
  const cl = it.cluster
    ? `<span class="res-cluster">◍ ${esc(it.cluster.label)} · ${it.cluster.mode === "walk" ? "walk" : `drive ${it.cluster.km_from_center}km`}</span>`
    : "";
  return `<li class="res-item${stateClass}">${seq}${photo}${head}${badge}${why(it.why)}${extra}${cl}${addr(it.address)}</li>`;
}

const SECTIONS = [
  ["must_see", "Must-see"],
  ["optional", "Local gems"],
  ["food_specialties", "Food specialties"],
  ["unique_experiences", "Unique experiences"],
  ["time_sensitive", "Time-sensitive events"],
];

const STYLE = `<style>
.res{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;max-width:760px;margin:0 auto}
.res h1{font-size:1.5rem;margin:.2rem 0 .1rem}
.res .res-range{opacity:.6;font-size:.85rem;margin-bottom:1rem}
.res .res-dontmiss{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 1.2rem}
.res .res-pill{border:1px solid currentColor;border-radius:999px;padding:.2rem .7rem;font-size:.82rem;opacity:.9}
.res h2{font-size:1.05rem;margin:1.4rem 0 .5rem;padding-bottom:.25rem;border-bottom:1px solid rgba(128,128,128,.3)}
.res ul{list-style:none;padding:0;margin:0}
.res .res-item{padding:.7rem 0;border-bottom:1px solid rgba(128,128,128,.15)}
.res .res-photo{display:block;width:100%;max-height:220px;object-fit:cover;border-radius:8px;margin-bottom:.5rem}
.res .res-name{font-weight:600;font-size:1rem}
.res .res-name a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.res .res-sub{font-size:.92rem;margin-top:.15rem}
.res .res-sub a{color:inherit}
.res .res-why{opacity:.85;font-size:.92rem;margin-top:.2rem}
.res .res-hook{font-size:.88rem;margin-top:.2rem;opacity:.9}
.res .res-when{font-size:.86rem;margin-top:.2rem;opacity:.9}
.res .res-src{font-size:.82rem;margin-top:.15rem}
.res .res-addr{opacity:.6;font-size:.82rem;margin-top:.2rem}
.res .res-rating{font-size:.82rem;opacity:.8;font-weight:400;margin-left:.2rem}
.res .res-badge{display:inline-block;font-size:.72rem;padding:.05rem .45rem;border-radius:4px;border:1px solid rgba(128,128,128,.4);margin-left:.35rem;opacity:.85;vertical-align:middle}
/* Already been: struck through and dimmed, but still legible and still linked —
   it stays part of the guide rather than disappearing from it. */
.res .res-item.res-done .res-name,.res .res-item.res-skipped .res-name{text-decoration:line-through;text-decoration-thickness:1px}
.res .res-item.res-done,.res .res-item.res-skipped{opacity:.5}
.res .res-donebadge{border-color:rgba(40,160,90,.6);color:#28a05a;opacity:1}
.res .res-skipbadge{border-color:rgba(209,69,59,.6);color:#d1453b;opacity:1}
.res .res-seq{display:inline-flex;align-items:center;justify-content:center;min-width:1.35rem;height:1.35rem;padding:0 .3rem;border-radius:999px;background:#1a1a1a;color:#fff;font-size:.72rem;font-weight:600;margin-bottom:.3rem}
.res .res-star{color:#f0b429}
.res .res-cluster{display:inline-block;margin-top:.3rem;font-size:.76rem;opacity:.75;border:1px solid rgba(128,128,128,.35);border-radius:999px;padding:.05rem .5rem}
</style>`;

function renderReservoirHtml(r) {
  const buckets = r.buckets || {};
  const dm = Array.isArray(r.dont_miss) ? r.dont_miss.filter(Boolean) : [];
  const rangeTxt = r.date_range && (r.date_range.start || r.date_range.end || r.date_range.from || r.date_range.to)
    ? `${esc(r.date_range.start || r.date_range.from || "")}${(r.date_range.end || r.date_range.to) ? " – " + esc(r.date_range.end || r.date_range.to) : ""}`
    : "";
  const parts = [STYLE, `<div class="res">`, `<h1>${esc(r.label || r.area)}</h1>`];
  if (rangeTxt) parts.push(`<div class="res-range">${rangeTxt}</div>`);
  if (dm.length) {
    // dont_miss is an array of entry IDs (regenerated by pass 3), so resolve
    // each to its display name — rendering the raw id shows "ms_chateau_des_ducs".
    const nameById = new Map();
    for (const arr of Object.values(buckets)) {
      for (const e of Array.isArray(arr) ? arr : []) {
        if (e && e.id) nameById.set(e.id, e.name || e.dish || e.best_place || e.id);
      }
    }
    parts.push(`<div class="res-dontmiss">` +
      dm.map((id) => `<span class="res-pill">✦ ${esc(nameById.get(id) || id)}</span>`).join("") + `</div>`);
  }
  for (const [key, title] of SECTIONS) {
    // Pass 2 keeps duplicates in the data (non-destructive, so a rebuild can
    // still carry their done marks) but they must never render.
    const arr = (Array.isArray(buckets[key]) ? buckets[key] : []).filter((e) => e && e.state !== "duplicate");
    if (!arr.length) continue;
    parts.push(`<h2>${esc(title)} <span style="opacity:.5;font-weight:400">(${arr.length})</span></h2>`);
    parts.push(`<ul>` + arr.map((it) => item(key, it)).join("") + `</ul>`);
  }
  parts.push(`</div>`);
  return parts.join("\n");
}

// ── Wiki page (Markdown, for the mini wiki at :9096) ──────────────────────────
function renderReservoirWiki(reservoir) {
  const B = reservoir.buckets || {};
  const lines = [];
  const w = (s) => lines.push(s);
  w(`---`);
  w(`name: trip_reservoir_${reservoir.area}`);
  w(`description: Trip-planning reservoir (vetted candidate list) for ${reservoir.label}. Phase-1 output of the trip-planning agency; daily itineraries are selected from it.`);
  w(`metadata:`);
  w(`  type: reference`);
  w(`---`);
  w(``);
  w(`# Reservoir — ${reservoir.label}`);
  w(``);
  w(`Built ${reservoir.built_at}. Coordinates ${reservoir.lat},${reservoir.lon}.${reservoir.date_range ? ` Stay ${reservoir.date_range.from}–${reservoir.date_range.to}.` : ""} Daily plans SELECT from this list (see the \`itinerary-planning\` skill). Entries marked done/skipped/felt by the feedback loop. Single source of truth: Supabase \`trip_reservoirs\` — this page mirrors it.`);
  const sect = (title, arr, fmt) => {
    arr = (Array.isArray(arr) ? arr : []).filter((e) => e && e.state !== "duplicate");
    w(``); w(`## ${title} (${arr.length})`); w(``);
    if (!arr.length) { w(`_none verified_`); return; }
    for (const e of arr) w(`- ${e.seq ? `**${e.seq}.** ` : ""}${fmt(e)}${e.cluster ? ` · ◍ ${e.cluster.label} (${e.cluster.mode === "walk" ? "walk" : `drive ${e.cluster.km_from_center}km`})` : ""}${e.state && e.state !== "open" ? ` — _${e.state}${e.skip_reason ? `: ${e.skip_reason}` : ""}${e.felt ? ` (${e.felt})` : ""}_` : ""}`);
  };
  const link = (e) => e.mapsUri ? `[${e.name}](${e.mapsUri})` : `**${e.name}**`;
  sect("Must-see", B.must_see, (e) => `${link(e)} — ${e.why}${e.food_hook ? ` · 🍽 ${e.food_hook}` : ""}${e.dog_ok === false ? " · 🐕🚫" : ""}`);
  sect("Optional / local gems", B.optional, (e) => `${link(e)} — ${e.why}${e.food_hook ? ` · 🍽 ${e.food_hook}` : ""}${e.dog_ok === false ? " · 🐕🚫" : ""}`);
  sect("Regional food specialties (dish → best place) + local tables", B.food_specialties, (e) => {
    const venue = e.mapsUri ? `[${e.best_place}](${e.mapsUri})` : e.best_place;
    const detour = e.iconic_detour ? " ⭐" : "";
    return e.kind === "table" || !e.dish
      ? `**${venue}**${detour}${e.known_for ? ` — known for ${e.known_for}` : ""} — ${e.why}`
      : `**${e.dish}** → ${venue}${detour} — ${e.why}`;
  });
  sect("Unique experiences", B.unique_experiences, (e) => `${link(e)} — ${e.why}${e.window ? ` · ⏳ ${e.window}` : ""}`);
  sect("Time-sensitive events", B.time_sensitive, (e) => `${link(e)} — ${e.why}${e.days ? ` · 📅 ${e.days.join("/")}` : ""}${e.date ? ` · 📅 ${e.date}` : ""}${e.hours ? ` ${e.hours}` : ""}`);
  return lines.join("\n") + "\n";
}

module.exports = { renderReservoirHtml, renderReservoirWiki };
