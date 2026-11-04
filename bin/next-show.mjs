#!/usr/bin/env node
// next-show — "what should I / we watch next?"
//
// Ranking lives in lib/watch-rank.mjs:
//   1. watching   — a season in progress
//   2. ready      — the next season of a show already watched, fully dropped in
//                   the last year (freshest finale first — the 2026-09-02
//                   rule: these outrank any new show). Older next seasons are
//                   listed under "new" as pick-up-where-you-left-off.
//   3. still dropping — next season premiered, finale not aired yet
//   4. new        — not started, first season fully dropped; scored on taste fit
//                   (learned from watch_feedback, per audience) + IMDb rating + recency
//
// Usage:
//   next-show                               together + solo shows
//   next-show --category together|solo|my_shows|<partner_id>
//   next-show --category movies             movies + documentaries
//   next-show --format text|json|html|phone (phone: {message_file, summary, message} JSON for chat-agent)
//   next-show --format phone --brief   the recommendation only: the top pick with its poster and
//                                      why, then 2–3 runners-up with a one-line description each
//                                      (2026-10-11: a poster for the top pick, descriptions
//                                      for the others)

import { loadAll, todayEt, audienceFrom, languageName } from "../lib/watch-db.mjs";
import { recommend, foreign } from "../lib/watch-rank.mjs";
import { writeReplyFile } from "../lib/reply-file.mjs";
import { cardLines, postersFor, posterUrl, linksLine } from "../lib/watch-chat-card.mjs";
import { hasTmdb } from "../lib/watch-db.mjs";
import { PARTNER, PARTNER_NAME } from "../lib/watch-config.mjs";
import { regionsToShow, whereToWatch, shortAvailability, mediaOf, countryName } from "../lib/watch-where.mjs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const catArg = arg("category");
const fmt = arg("format") || "text";
const today = todayEt();

const sections = (() => {
  if (!catArg) return [{ key: "together", audience: "together", kind: "show" }, { key: "solo", audience: "solo", kind: "show" }];
  if (["movies", "movie", "documentaries", "films"].includes(catArg)) return [{ key: "movies", audience: null, kind: "movie" }];
  const a = audienceFrom(catArg);
  if (!a) { console.error(`unknown --category ${catArg}`); process.exit(1); }
  return [{ key: a, audience: a, kind: "show" }];
})();

const LABEL = { together: `Together (with ${PARTNER_NAME})`, solo: "Solo", [PARTNER]: PARTNER_NAME, movies: "Movies & docs" };

const { titles, feedback, prefs } = await loadAll();
const results = {};
for (const s of sections) results[s.key] = recommend({ titles, feedback, prefs, audience: s.audience, kind: s.kind, today });

// Abroad → say where each shown title plays in the LOCAL country too
// (2026-10-06: the home-region `platform` tag is no answer abroad). One TMDB call
// per title, 7-day cache, failures just leave the home tag on its own.
const { local } = hasTmdb() ? await regionsToShow() : { local: null };
if (local) {
  const shown = new Set();
  for (const r of Object.values(results)) for (const t of [...r.watching, ...r.ready, ...r.fresh.slice(0, 15)]) if (t.tmdb_id) shown.add(t);
  await Promise.all([...shown].map(async (t) => {
    try {
      const w = await whereToWatch({ media: mediaOf(t), id: t.tmdb_id }, [local]);
      t.platform_local = shortAvailability(w.regions[local]) || "not available";
    } catch { /* keep the US tag alone */ }
  }));
}
/** Platform text for a title: the US tag, plus the local country when abroad. */
const plat = (t) => [t.platform, t.platform_local && `in ${countryName(local)}: ${t.platform_local}`].filter(Boolean).join("; ");

// ---------------------------------------------------------------------------

const yr = (t) => (t.year_end && t.year_end !== t.year_start ? `${t.year_start}–${t.year_end}` : t.year_start ? `${t.year_start}` : "?");
const desc = (t, n = 180) => (t.description || "").replace(/\s+/g, " ").slice(0, n);
// One-line "what is it" for every title shown (2026-10-04: a short blurb on each
// show says what it's about). Cut at a word boundary.
function blurb(t, n = 170) {
  const d = (t.description || "").replace(/\s+/g, " ").trim();
  if (d.length <= n) return d;
  const cut = d.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s-]+$/, "") + "…";
}
const link = (t) => (t.imdb_id ? `https://www.imdb.com/title/${t.imdb_id}/` : null);
const lang = (t) => (foreign(t) ? `, ${languageName(t.original_language)}` : "");

function whyNew(t) {
  if (t.continuation) return `pick up where you left off — you've seen S1${t.watched_through > 1 ? `–${t.watched_through}` : ""}`;
  const tags = (t.liked_tags || []).join(" + ");
  if (t.because && tags) return `${tags}, like ${t.because}`;
  if (t.because) return `you loved ${t.because}`;
  if (tags) return `your kind of ${tags}`;
  return null;
}

let posters = new Map();
const BRIEF = process.argv.includes("--brief");

/** The recommendation itself: top pick (poster, why, links), then runners-up (one line each). */
function briefSection(key, r) {
  const cands = [...r.ready, ...r.fresh];
  if (!cands.length) return { body: `Nothing queued for ${LABEL[key]}.`, summary: "nothing queued" };
  const [pick, ...rest] = cands;
  const why = (t) => (r.ready.includes(t) ? `your show, and every episode of season ${t.season.n} is out` : whyNew(t) || "the best fit on the list");
  const name = (t) => `${t.name}${t.season && (r.ready.includes(t) || t.continuation) ? ` S${t.season.n}` : ""}`;
  const L = [`## 🎯 My pick: ${name(pick)}`, ""];
  const img = posterUrl(posters.get(pick.id));
  if (img) L.push(img, "");
  L.push(`> **Why:** ${why(pick)[0].toUpperCase()}${why(pick).slice(1)}${plat(pick) ? ` · on ${plat(pick)}` : ""} · ⭐${pick.imdb_rating ?? "?"}${r.watching.length ? ` — start it after you finish ${r.watching[0].name}` : ""}.`, "");
  if (blurb(pick)) L.push(blurb(pick), "");
  L.push(linksLine({ imdb_id: pick.imdb_id, name: pick.name }), "");
  const others = rest.slice(0, 3);
  if (others.length) {
    L.push("**Also great next:**", "");
    for (const t of others) {
      L.push(`**${name(t)}** (⭐${t.imdb_rating ?? "?"}${plat(t) ? `, ${plat(t)}` : ""}) — ${blurb(t, 150)}`);
      L.push(linksLine({ imdb_id: t.imdb_id, name: t.name }), "");
    }
  }
  return { body: L.join("\n").trim(), summary: `My pick: ${name(pick)}` };
}

function phoneSection(key, r) {
  if (BRIEF) return briefSection(key, r);
  const L = [];
  // Poster + inline links on every title (watch-chat-card.mjs): every title comes with
  // images and links (2026-10-11).
  const push = (head, t) => { L.push(...cardLines({ poster_path: posters.get(t.id), headline: head, blurb: blurb(t), imdb_id: t.imdb_id, name: t.name })); L.push(""); };

  if (r.watching.length) {
    L.push("**▶ Currently watching**", "");
    for (const t of r.watching) {
      const s = t.season;
      push(`**${t.name}**${s ? ` S${s.n} — ${s.episodes_watched}/${s.episodes_total ?? "?"} eps` : ""}${plat(t) ? ` · ${plat(t)}` : ""}`, t);
    }
  }
  if (r.ready.length) {
    L.push("**★ New season ready** (shows you've watched, every episode out)", "");
    for (const t of r.ready) {
      const s = t.season;
      push(`**${t.name}** S${s.n} (⭐${t.imdb_rating ?? "?"}${plat(t) ? `, ${plat(t)}` : ""}) — ${s.episodes_total ?? "?"} eps${s.finale_date ? `, finale ${s.finale_date}` : ""}; you've seen S1${t.watched_through > 1 ? `–${t.watched_through}` : ""}`, t);
    }
  }
  const freshShown = r.fresh.slice(0, Math.max(3, 6 - r.ready.length));
  if (freshShown.length) {
    L.push(`**${r.ready.length ? "New to start" : "Top picks"}**`, "");
    for (const t of freshShown) {
      const why = whyNew(t);
      if (t.continuation) { push(`**${t.name}** S${t.season.n} (⭐${t.imdb_rating ?? "?"}${plat(t) ? `, ${plat(t)}` : ""}${lang(t)}) — ${why}`, t); continue; }
      push(`**${t.name}** (⭐${t.imdb_rating ?? "?"}, ${yr(t)}${plat(t) ? `, ${plat(t)}` : ""}${lang(t)})${why ? ` — ${why}` : ""}`, t);
    }
  }
  if (r.soon.length) {
    L.push("**○ Still dropping** (not recommending until the finale airs)", "");
    for (const t of r.soon) {
      const s = t.season;
      L.push(`**${t.name}** S${s.n}${s.finale_date ? ` — finale ${s.finale_date}` : " — finale date TBA"}`);
      if (blurb(t)) L.push(blurb(t));
    }
    L.push("");
  }

  const pick = r.ready[0] || freshShown[0];
  if (!r.watching.length && !pick) L.push(`Nothing queued for ${LABEL[key]}.`);
  else if (pick) {
    // Its own section at the end — a rule, a heading, the poster, the reason in a quote block —
    // so the answer to "what should we watch?" stands out (2026-10-11: the pick at the end
    // is highlighted).
    const label = r.ready[0] ? `your show, and every episode of season ${pick.season.n} is out` : whyNew(pick) || "the best fit on the list";
    const img = posterUrl(posters.get(pick.id));
    L.push("---", "", `## 🎯 My pick: ${pick.name}${r.ready[0] ? ` S${pick.season.n}` : ""}`, "");
    if (img) L.push(img, "");
    L.push(`> **Why:** ${label[0].toUpperCase()}${label.slice(1)}${plat(pick) ? ` · on ${plat(pick)}` : ""}${r.watching.length ? ` — start it after you finish ${r.watching[0].name}` : ""}.`);
  }
  return {
    body: L.join("\n").trim(),
    summary: [r.watching.length && `${r.watching.length} watching`, `${r.ready.length} ready`, r.soon.length && `${r.soon.length} dropping`, `${r.fresh.length} new`].filter(Boolean).join(" / "),
  };
}

function textSection(key, r) {
  const L = [`\n${"=".repeat(60)}`, LABEL[key].toUpperCase(), "=".repeat(60)];
  const sub = (t) => { const b = blurb(t, 140); if (b) L.push(`        ${b}`); };
  if (r.watching.length) { L.push("\n▶ WATCHING:"); for (const t of r.watching) { L.push(`  ${t.name}${t.season ? ` S${t.season.n} ${t.season.episodes_watched}/${t.season.episodes_total ?? "?"}` : ""}`); sub(t); } }
  if (r.ready.length) { L.push("\n★ READY:"); for (const t of r.ready) { L.push(`  ${t.name} S${t.season.n} — finale ${t.season.finale_date || "?"} — ⭐${t.imdb_rating ?? "?"}`); sub(t); } }
  if (r.soon.length) { L.push("\n○ STILL DROPPING:"); for (const t of r.soon) { L.push(`  ${t.name} S${t.season.n} — finale ${t.season.finale_date || "TBA"}`); sub(t); } }
  if (r.fresh.length) {
    L.push("\n⊕ NEW (score = rating + taste fit + recency):");
    for (const t of r.fresh.slice(0, 15)) { L.push(`  ${t.score.toFixed(2)}  ${t.name}${t.continuation ? ` S${t.season.n}` : ""} — ⭐${t.imdb_rating ?? "?"} — ${yr(t)}${plat(t) ? ` — ${plat(t)}` : ""}${lang(t)}${whyNew(t) ? ` — ${whyNew(t)}` : ""}`); sub(t); }
    if (r.fresh.length > 15) L.push(`  ... and ${r.fresh.length - 15} more`);
  }
  return L.join("\n");
}

function htmlSection(key, r) {
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const P = [`<h2>${esc(LABEL[key])}</h2>`];
  if (r.ready.length) {
    P.push("<h3>★ New season ready</h3><ul>");
    for (const t of r.ready) P.push(`<li><strong>${esc(t.name)}</strong> S${t.season.n} — ⭐${esc(t.imdb_rating ?? "?")}${plat(t) ? ` — ${esc(plat(t))}` : ""}<br><small>finale ${esc(t.season.finale_date || "?")} · ${esc(blurb(t, 200))}</small></li>`);
    P.push("</ul>");
  }
  if (r.fresh.length) {
    P.push("<h3>⊕ New to start</h3><ul>");
    for (const t of r.fresh.slice(0, 8)) P.push(`<li><strong>${esc(t.name)}</strong> — ⭐${esc(t.imdb_rating ?? "?")} — ${yr(t)}${plat(t) ? ` — ${esc(plat(t))}` : ""}${t.description ? `<br><small>${esc(blurb(t, 200))}</small>` : ""}</li>`);
    P.push("</ul>");
  }
  return P.join("");
}

if (fmt === "json") {
  const slim = (t) => ({ id: t.id, name: t.name, audience: t.audience, kind: t.kind, imdb_id: t.imdb_id, imdb_rating: t.imdb_rating, platform: t.platform, platform_local: t.platform_local ? { region: local, where: t.platform_local } : undefined, year_start: t.year_start, season: t.season ? { n: t.season.n, finale_date: t.season.finale_date, episodes_total: t.season.episodes_total, episodes_watched: t.season.episodes_watched } : undefined, score: t.score, because: t.because, description: t.description });
  const out = {};
  for (const [k, r] of Object.entries(results)) out[k] = { watching: r.watching.map(slim), ready: r.ready.map(slim), soon: r.soon.map(slim), fresh: r.fresh.map(slim) };
  console.log(JSON.stringify(out, null, 2));
} else if (fmt === "phone") {
  const all = Object.values(results).flatMap((r) => [...r.watching, ...r.ready, ...r.fresh]);
  posters = await postersFor(all.map((t) => t.id)).catch(() => new Map());
  const blocks = [], sums = [];
  for (const [k, r] of Object.entries(results)) {
    const p = phoneSection(k, r);
    blocks.push((sections.length > 1 ? `## ${LABEL[k]}\n\n` : "") + p.body);
    sums.push(`${k}: ${p.summary}`);
  }
  const message = blocks.join("\n\n");
  // message_file lets chat-agent send this without retyping it (reply-file.mjs).
  let messageFile = null;
  try { messageFile = writeReplyFile(message); } catch {}
  console.log(JSON.stringify({ message_file: messageFile, summary: sums.join(" · "), message }, null, 2));
} else if (fmt === "html") {
  console.log(`<div style="font-family:system-ui,sans-serif">${Object.entries(results).map(([k, r]) => htmlSection(k, r)).join("")}</div>`);
} else {
  for (const [k, r] of Object.entries(results)) console.log(textSection(k, r));
}
