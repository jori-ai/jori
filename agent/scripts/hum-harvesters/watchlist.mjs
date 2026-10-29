#!/usr/bin/env node
// Watchlist harvester (v2, 2026-10-04) — reads watch_titles / watch_seasons /
// watch_feedback directly (lib/watch-db.mjs). Three branches, first wins:
//
//   F) Finale-day — a season in progress is projected to finish TODAY
//      (lib/watching-projection.js). Question-framed, 3 picks from the
//      same ranking next-show uses (ready seasons first, then best-fit new).
//   R) Rate it — a season (or movie/doc) finished in the last 14 days with no
//      verdict yet. One-tap "how was it?" → `watchlist rate`. This is how the
//      recommendations learn. Re-asked at most twice, 3+ days apart.
//   T) In theaters (2026-10-11: the hum may recommend films showing nearby) — a film in
//      theaters now (the movie database, watch_catalog in_theaters) that the taste model
//      gives ≥ 80% for the together audience, best first, never one already surfaced; with a showtimes
//      link (Google localises it to wherever the phone is). Daytime, at most every 3 days,
//      only when presence puts them in the home region (the in-theaters list is that region's).
//   V) Weekly review — once a week, early evening: titles discovery added on
//      its own since the last review. "Any of these not for you?" → each no
//      becomes `watchlist reject` (a rejected row + not_interested verdict),
//      so silent auto-adds stop being invisible. v1's never-reviewed auto-adds
//      (source legacy:screen-harvester / legacy:monthly-scan / …) drain through
//      the same review, 10 a week, newest first.
//
// The v1 approval branch (require_approval) and "tonight pick" from the stale
// `suggested` shelf are gone: the approval gate was retired 2026-08-08 and the
// shelf was folded into the queue by the v2 migration.
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emit, emitNull, stampRun } from "./_common.mjs";
import { loadAll, patchSeason, patchTitle, todayEt, watchedThrough, rest } from "../../../lib/watch-db.mjs";
import { currentPresence, countryFromPresence } from "../../../lib/watch-where.mjs";
import { recommend } from "../../../lib/watch-rank.mjs";
import { PARTNER, listLabel, whoFor, siteName } from "../../../lib/watch-config.mjs";
import { HOME_REGION } from "../../../lib/watch-where.mjs";

const require = createRequire(import.meta.url);
const { situation: sit } = await readStdinJson();
const cache = readCache("watchlist") || {};
const today = todayEt();
const hour = sit?.time?.local_hour;
const DAY = 86400000;
const nowIso = () => new Date().toISOString();

const link = (t) => (t.imdb_id ? `https://www.imdb.com/title/${t.imdb_id}/` : null);
const audienceWord = (a) => (a === "solo" ? "your solo list" : a === PARTNER ? listLabel(PARTNER) : "the together list");

const { titles, feedback, prefs } = await loadAll();
const rated = new Set(feedback.map((f) => `${f.title_id}:${f.season_n ?? ""}`));
const ratedTitle = new Set(feedback.map((f) => f.title_id));

// ---------------------------------------------------------------------------
async function finaleDay() {
  const { projectFinaleDate } = require("../../../lib/watching-projection.js");
  for (const t of titles) {
    const s = (t.seasons || []).find((x) => x.status === "watching");
    if (!s || !s.episodes_total) continue;
    const remaining = s.episodes_total - s.episodes_watched;
    if (remaining <= 0) continue;
    let proj;
    try {
      proj = await projectFinaleDate({ last_watched_date: s.last_watched_date || s.started_at, started_at: s.started_at, episodes_remaining: remaining });
    } catch { continue; }
    if (proj.days_between_now_and_finale !== 0) continue;
    const key = `watchlist-finale-day:${t.id}:${s.n}:${proj.projected_finale_date}`;
    if (cache.last_finale_day_key === key) return { reason: `finale-day already surfaced for ${t.name}` };

    const r = recommend({ titles, feedback, prefs, audience: t.audience, kind: "show", today });
    const picks = [...r.ready, ...r.fresh].filter((p) => p.id !== t.id).slice(0, 3);
    if (!picks.length) return { reason: `finale today for ${t.name} but nothing to suggest` };
    writeCache("watchlist", { ...cache, last_finale_day_key: key });

    const body = picks.map((p) => {
      const head = p.season ? `**${p.name}** S${p.season.n} — new season, fully out` : `**${p.name}** (⭐${p.imdb_rating ?? "?"}${p.platform ? `, ${p.platform}` : ""})${p.because ? ` — you loved ${p.because}` : ""}`;
      const blurb = (p.description || "").replace(/\s+/g, " ").slice(0, 200);
      return [head, blurb, link(p)].filter(Boolean).join("\n");
    }).join("\n\n");
    return {
      finding: {
        topic: "watchlist-finale-day",
        signal: `Watching the finale of ${t.name} tonight? If so, a few options for what's next:\n\n${body}\n\nAnd once it's done, tell me how it was.`,
        urgency: 0.65,
        freshness_min: 0,
        dedup_key: key,
        supporting_data: {
          evidence_as_of: "live",
          finishing: `${t.name} S${s.n}`,
          picks: picks.map((p) => ({ name: p.name, season: p.season?.n ?? null, imdb: link(p) })),
          route: `On "finished": watchlist episode-watched "${t.name}" --count ${remaining}  ·  To start a pick: watchlist mark-watching "<name>"`,
        },
      },
    };
  }
  return { reason: "no season projected to finish today" };
}

// ---------------------------------------------------------------------------
async function rateAsk() {
  const recent = (d) => d && Date.parse(today) - Date.parse(d) <= 14 * DAY;
  const askable = (requestedAt, asks) => !requestedAt || (asks < 2 && Date.now() - Date.parse(requestedAt) >= 3 * DAY);
  const cands = [];
  for (const t of titles) {
    if (t.status === "rejected") continue;
    if (t.kind === "show") {
      for (const s of t.seasons || []) {
        if (s.status !== "watched" || !recent(s.finished_at) || rated.has(`${t.id}:${s.n}`)) continue;
        if (s.feedback_requested_at && s.feedback_asks === 0) continue; // historical / bulk-marked, never ask
        if (!askable(s.feedback_requested_at, s.feedback_asks)) continue;
        cands.push({ t, s, at: s.finished_at });
      }
    } else if (t.status === "watched" && !ratedTitle.has(t.id) && !t.feedback_requested_at && recent(t.updated_at?.slice(0, 10))) {
      cands.push({ t, s: null, at: t.updated_at.slice(0, 10) });
    }
  }
  if (!cands.length) return { reason: "nothing finished recently without a verdict" };
  cands.sort((a, b) => b.at.localeCompare(a.at));
  const { t, s } = cands[0];
  const what = s ? `${t.name}${(t.seasons || []).length > 1 ? ` season ${s.n}` : ""}` : t.name;
  if (s) await patchSeason(s.id, { feedback_requested_at: nowIso(), feedback_asks: (s.feedback_asks || 0) + 1 });
  else await patchTitle(t.id, { feedback_requested_at: nowIso() });

  const seasonFlag = s ? ` --season ${s.n}` : "";
  return {
    finding: {
      topic: "watchlist-rate",
      signal: `You finished ${what} — how was it? Loved it, liked it, meh, or not for ${t.audience === "together" ? "you two" : "you"}? It steers what I pick next for ${audienceWord(t.audience)}.`,
      urgency: 0.4,
      freshness_min: 0,
      dedup_key: `watch-rate:${t.id}:${s?.n ?? 0}`,
      supporting_data: {
        evidence_as_of: "live",
        title: t.name,
        season: s?.n ?? null,
        audience: t.audience,
        route: `watchlist rate "${t.name}" <loved|liked|meh|disliked|dropped>${seasonFlag} --source hum-rate [--note "<their words>"]`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
const THEATER_MIN_P = 0.8, THEATER_EVERY_DAYS = 3;
async function theaterPick() {
  const last = cache.last_theater_ts ? Date.parse(cache.last_theater_ts) : 0;
  if (Date.now() - last < THEATER_EVERY_DAYS * DAY) return { reason: "theater pick not due" };
  if (!(hour >= 11 && hour <= 19)) return { reason: `theater pick waits for daytime (hour=${hour})` };
  let country = null;
  try { country = countryFromPresence(await currentPresence()); } catch {}
  if (country && country !== HOME_REGION) return { reason: `abroad (${country}) — the in-theaters list is ${HOME_REGION}` };
  const seenBefore = new Set(cache.theater_surfaced || []);
  const rows = await rest(`watch_catalog?select=id,tmdb_id,imdb_id,title,year,genres,overview,model_p,imdb_rating,vote_count&kind=eq.movie&in_theaters=eq.true&not_for_us=eq.false&or=(seen.is.null,seen.eq.false)&model_p=gte.${THEATER_MIN_P}&vote_count=gte.50&year=gte.${parseInt(today.slice(0, 4), 10) - 10}&order=model_p.desc&limit=10`); // no anniversary re-releases
  const f = rows.find((r) => !seenBefore.has(r.tmdb_id));
  if (!f) return { reason: `nothing in theaters at ≥ ${THEATER_MIN_P * 100}% not already surfaced` };
  writeCache("watchlist", { ...cache, last_theater_ts: nowIso(), theater_surfaced: [...seenBefore, f.tmdb_id].slice(-200) });
  const pct = Math.min(99, Math.round(f.model_p * 100));
  const showtimes = `https://www.google.com/search?q=${encodeURIComponent(`${f.title} showtimes`)}`;
  const about = (f.overview || "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0]; // lang-regex-ok: first sentence of a TMDB synopsis for display, decides nothing
  return {
    finding: {
      topic: "watchlist-theater",
      signal: `${f.title} is in theaters now, and it looks like exactly ${whoFor("together")}'s kind of film (${pct}% match${f.imdb_rating ? `, IMDb ${f.imdb_rating}` : ""}). ${about} Showtimes nearby: ${showtimes}`,
      urgency: 0.45,
      freshness_min: 0,
      dedup_key: `watch-theater:${f.tmdb_id}`,
      supporting_data: {
        evidence_as_of: "live",
        title: f.title, tmdb_id: f.tmdb_id, model_p: f.model_p, imdb: f.imdb_id ? `https://www.imdb.com/title/${f.imdb_id}/` : null,
        showtimes,
        route: `Seen it / not interested → mark it on ${siteName()} (Watch now tab). Want it on the list → watchlist add "${f.title}" --type movie --audience together${f.imdb_id ? ` --imdb-id ${f.imdb_id}` : ""} --source hum-theater · Not interested → watchlist reject "${f.title}"`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
async function weeklyReview() {
  const last = cache.last_veto_ts ? Date.parse(cache.last_veto_ts) : 0;
  if (Date.now() - last < 7 * DAY) return { reason: "weekly review not due" };
  if (!(hour >= 17 && hour <= 21)) return { reason: `weekly review due, waiting for early evening (hour=${hour})` };
  const auto = titles.filter((t) => t.status === "queued" && t.source && t.source !== "manual"
    && !t.vetoed_listed_at && !ratedTitle.has(t.id))
    .sort((a, b) => b.added_at.localeCompare(a.added_at))
    .slice(0, 10);
  if (!auto.length) { writeCache("watchlist", { ...cache, last_veto_ts: nowIso() }); return { reason: "nothing auto-added since last review" }; }
  for (const t of auto) await patchTitle(t.id, { vetoed_listed_at: nowIso() });
  writeCache("watchlist", { ...cache, last_veto_ts: nowIso() });

  const lines = auto.map((t) => {
    const where = t.kind === "show" ? audienceWord(t.audience) : t.kind === "movie" ? "movies" : "docs";
    const about = (t.description || "").replace(/\s+/g, " ").slice(0, 180);
    return `**${t.name}** (⭐${t.imdb_rating ?? "?"}${t.platform ? `, ${t.platform}` : ""}) → ${where}${t.source_reason ? ` — ${t.source_reason}` : ""}\n${about}\n${link(t) || ""}`.replace(/\n+/g, "\n").trim();
  });
  return {
    finding: {
      topic: "watchlist-review",
      signal: `I added ${auto.length} title${auto.length === 1 ? "" : "s"} to the list this week. Anything here you'd rather skip, or on the wrong list? The rest stay queued.\n\n${lines.join("\n\n")}`,
      urgency: 0.35,
      freshness_min: 0,
      dedup_key: `watch-veto:${today}`,
      supporting_data: {
        evidence_as_of: "live",
        titles: auto.map((t) => ({ name: t.name, audience: t.audience, kind: t.kind })),
        route: `For each one declined: watchlist reject "<name>" --source hum-veto  ·  Wrong list: watchlist set-audience "<name>" <solo|together|${PARTNER}>  ·  Silence = keep`,
      },
    },
  };
}

try {
  const reasons = [];
  for (const branch of [finaleDay, rateAsk, theaterPick, weeklyReview]) {
    const r = await branch();
    if (r.finding) { stampRun("watchlist", true); emit(r.finding); process.exit(0); }
    reasons.push(r.reason);
  }
  stampRun("watchlist", false);
  emitNull(reasons.join("; "));
} catch (e) {
  emitNull(`watchlist failed: ${e.message}`);
}
