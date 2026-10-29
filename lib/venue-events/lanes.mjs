// venue-events/lanes.mjs — the venue watch lanes, built from config.
//
// A lane = which store groups it reads, its seen file, which sibling lanes it
// must not double-notify, the taste brief the model ranks against, the output
// sections, and how it delivers. The pipeline itself is watch.mjs; this file
// turns agent/local/config/venue-watch.json `lanes` into lane objects. No lane
// configured: `venue-watch` has nothing to run (off, not broken).
//
// venue-watch.json:
//   profile_file   the user's taste profile (markdown), spliced into a brief
//                  as {{profile}}; also the artist watchlist (### Tier N headings)
//   voice          how every `why` is written, spliced in as {{voice}}
//   lanes_file     a private JSON file with any of these keys (see watchConfig)
//   soft_block     {name, id_file, note} — see watch.mjs calendarGate
//   perks          [{venue, note}] — a standing reminder on every pick at a venue
//   lanes          {<name>: lane config}; per lane:
//     seen_file, groups[], categories[]|null, siblings[], horizon_days,
//     max_candidates, max_picks, model, effort, ride_along_with
//     metro              a fixed metro every pick is gated against (a regional lane)
//     metro_from_event   gate each pick in its own city's metro (a touring watchlist)
//     watchlist          {comedy_group, national_max_tier, national_countries[],
//                         near_states[], near_country, web_search: {tiers[], ask}}
//                        → watchlist / discovery / comedy branches
//     regional           {any_zone_section} → presence pre-gate + theater-run
//                        collapse; outside the near zone only in that section
//     mark_headliner_sources [source keys] → tier-1 headliners there are flagged
//     web_search         {ask, category, max_searches} → ONE capped web-search
//                        call per run adds dated events no feed carries (the
//                        venues and series to look for go in `ask`)
//     system             the brief ({{profile}}, {{voice}})
//     sections           [{key, heading, emoji?}] — the model's section enum
//     deliver            see deliverLane below (`also_to`: more recipients)
//
// Templates: subject / pointer / push / chat header take {date} {n} {s}
// {place} and, for pointers, {who} {at_venue} {city} {city_away} {when} {more} {title}.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { REPO, tmEventsForArtist } from "./fetchers.mjs";
import { slug, makeEvent } from "./normalize.mjs";
import { homeMetro, nearZone, readPrivateFiles } from "./config.mjs";
import { judge, SONNET, isHeadliner, presenceByDate, headlinerMatcher } from "./watch.mjs";
import { sendHtmlEmail, labelDigest, pointerAndPush, ogCards, escapeHtml, inCity, todayET } from "../digest-deliver.mjs";
import { loadEnv } from "../tickets/config.mjs";

const require = createRequire(import.meta.url);
const { localConfig } = require("../instance.cjs");

const DEFAULT_VOICE = "Write each `why` the way a friend who knows the user's taste would say it in one sentence: specific, warm, no hype words, no exclamation marks, no emojis. Never invent facts that are not in the candidate row or the profile.";

/**
 * The watch config: agent/local/config/venue-watch.json, plus — when it names
 * one — a private `lanes_file` (repo-relative JSON with the same keys) whose
 * values fill anything the config leaves out. Lane briefs are full of the
 * user's venues and people; a data file keeps them out of the config the
 * kernel guard derives tokens from. `lanes_file` may be a list: every file's
 * lanes are merged (a later file adds lanes or replaces one by name), and for
 * the other keys the first file that has one wins.
 */
export function watchConfig() {
  const cfg = localConfig("venue-watch", { lanes_file: null });
  const files = readPrivateFiles(cfg.lanes_file, "venue-watch lanes_file");
  const pick = (k, d) => cfg[k] ?? files.map((f) => f[k]).find((v) => v != null) ?? d;
  return {
    profile_file: pick("profile_file", "data/music-profile.md"),
    voice: pick("voice", DEFAULT_VOICE),
    perks: pick("perks", []),
    soft_block: pick("soft_block", null),
    lanes: Object.assign({}, ...files.map((f) => f.lanes || {}), cfg.lanes || {}),
  };
}

function readProfileFrom(file) {
  if (!file) return "";
  try { return fs.readFileSync(path.isAbsolute(file) ? file : path.join(REPO, file), "utf8"); } catch { return ""; }
}

/** `{{key}}` → vars[key] (briefs). */
const fillBrief = (tpl, vars) => String(tpl || "").replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)); // lang-regex-ok: our own template placeholders
/** `{key}` → vars[key] (subjects, pointers). */
export const fill = (tpl, vars) => String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m)); // lang-regex-ok: our own template placeholders

// ─── shared schema + rendering ─────────────────────────────────────────────

function pickSchema(sections) {
  return {
    type: "object", additionalProperties: false, required: ["picks"],
    properties: { picks: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["id", "section", "why"],
      properties: {
        id: { type: "string", description: "candidate id exactly as given (c1, c2, ...)" },
        section: { type: "string", enum: sections },
        why: { type: "string", description: "one warm, specific sentence: why the user would want to know about this one" },
      },
    } } },
  };
}

export function fmtDate(ev) {
  if (!ev.date) return ev.raw_date || "date TBA";
  const d = new Date(`${ev.date}T12:00:00Z`);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (!ev.time) return day;
  const [h, m] = ev.time.split(":").map(Number);
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** A standing reminder for every pick at a configured venue (exact venue name, case-insensitive). */
export function venuePerkNote(ev, perks = watchConfig().perks || []) {
  const v = slug(ev?.venue);
  if (!v) return "";
  return (perks.find((p) => slug(p.venue) === v) || {}).note || "";
}

function itemLine(ev, perks) {
  const tags = [ev.tag && `(${ev.tag})`, ev.doubleCheck && "(worth double-checking availability before you go)"].filter(Boolean).join(" ");
  const perk = venuePerkNote(ev, perks);
  return `<p style="margin:14px 0 4px 0"><b>${escapeHtml(ev.title)}</b><br>${escapeHtml(ev.venue || "")}${ev.city && ev.city !== homeMetro() ? `, ${escapeHtml(ev.city)}` : ""} · ${escapeHtml(fmtDate(ev))} ${escapeHtml(tags)}</p>
<p style="margin:0 0 6px 0">${escapeHtml(ev.pick.why)}${perk ? ` ${escapeHtml(perk)}` : ""}</p>`;
}

/** sections: [{ heading, items }] → full email HTML with og-cards under each item. */
export function renderDigest(title, sections, { perks } = {}) {
  const items = sections.flatMap((s) => s.items);
  const cards = ogCards(items.map((ev) => ev.url).filter(Boolean));
  let ci = 0;
  const parts = [`<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px">`,
    `<h1 style="font-size:18px;margin:0 0 10px 0">${escapeHtml(title)}</h1>`];
  for (const s of sections) {
    if (!s.items.length) continue;
    parts.push(`<h2 style="font-size:15px;margin:22px 0 4px 0">${escapeHtml(s.heading)}</h2>`);
    for (const ev of s.items) {
      parts.push(itemLine(ev, perks));
      if (ev.url) parts.push(cards[ci++] || "");
    }
  }
  parts.push("</div>");
  return parts.join("\n");
}

export function longDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// ─── watchlist behaviour ───────────────────────────────────────────────────

/** Tier 1–5 artist names from the profile's markdown structure (### Tier N headings + bold bullets). */
export function parseWatchlist(md) {
  const out = [];
  let tier = null;
  for (const line of String(md).split("\n")) {
    const h = line.match(/^###\s+Tier\s+(\d)/); // lang-regex-ok: markdown heading structure of our own data file
    if (h) { tier = Number(h[1]); continue; }
    if (line.startsWith("### ") || line.startsWith("## ")) { tier = null; continue; }
    if (!tier) continue;
    const b = line.match(/^\s*-\s+\*\*([^*]+)\*\*(.*)$/); // lang-regex-ok: markdown bullet structure of our own data file
    if (!b) continue;
    if (/deceased/i.test(b[2])) continue; // lang-regex-ok: our own curated profile marks dead artists "deceased, skip"
    for (const name of b[1].split(" / ")) { // "A / B" = two names; "A + B" stays one billing
      const n = name.trim();
      if (n) out.push({ name: n, tier });
    }
  }
  return out;
}

/** Does this artist name appear as a whole name in the event's title/performers? (entity match, model confirms) */
export function namesArtist(ev, name) {
  const want = slug(name);
  if (!want || want.length < 3) return false;
  const hay = [ev.title, ...(ev.performers || [])].map((s) => `-${slug(s)}-`);
  return hay.some((h) => h.includes(`-${want}-`));
}

/** Is a touring date inside the watchlist's radius for an artist of this tier? */
export function inWatchRadius(ev, tier, wl = {}) {
  if (tier <= (wl.national_max_tier ?? 0)) return (wl.national_countries || []).includes(ev.country);
  return (wl.near_states || []).includes(ev.state) && (!wl.near_country || ev.country === wl.near_country);
}

function watchlistExtras(laneCfg, profile) {
  const wl = laneCfg.watchlist || {};
  return async ({ store, today, log }) => {
    const artists = parseWatchlist(profile());
    const out = [];
    // 1. Feed match — every watchlist artist playing a venue we already ingest.
    for (const ev of Object.values(store.events)) {
      if (ev.category !== "music" || (ev.date && ev.date < today)) continue;
      const a = artists.find((x) => namesArtist(ev, x.name));
      if (a) out.push({ ...ev, branch: "watchlist", tier: a.tier, artist: a.name });
    }
    // 2. Ticketmaster per artist — the touring radius (structured, free, no search).
    loadEnv();
    const apiKey = process.env.TICKETMASTER_CONSUMER_KEY || process.env.TICKETMASTER_API_KEY;
    if (apiKey && (wl.national_countries?.length || wl.near_states?.length)) {
      for (const a of artists) {
        try {
          const evs = await tmEventsForArtist(a.name, { apiKey, ref: today });
          for (const ev of evs) if (inWatchRadius(ev, a.tier, wl)) out.push({ ...ev, branch: "watchlist", tier: a.tier, artist: a.name, city: ev.city });
        } catch (e) { log(`  tm ${a.name}: ${e.message}`); }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // 3. Tiers no ticketing API carries — ONE capped web-search call (one search per artist).
    const ws = wl.web_search;
    const names = ws?.tiers?.length ? artists.filter((a) => ws.tiers.includes(a.tier)).map((a) => a.name) : [];
    if (names.length) {
      try {
        const res = await judge({
          model: SONNET, effort: "low", webSearch: true, timeoutMs: 600000,
          system: "You look up announced concert dates. Use at most ONE web search per artist. Report only dates you saw on a page in this session with a specific date, venue and city — never a guess, a past date, or an undated rumour.",
          prompt: `Today is ${today}. ${ws.ask || "For each artist below, find announced upcoming concerts."} Artists: ${names.join("; ")}.`,
          schema: { type: "object", additionalProperties: false, required: ["shows"], properties: { shows: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["artist", "date", "venue", "city", "url"],
            properties: { artist: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, venue: { type: "string" }, city: { type: "string" }, url: { type: "string" } } } } } },
        });
        for (const s of res.shows || []) {
          const tier = (artists.find((a) => a.name === s.artist) || {}).tier || ws.tiers[0];
          const ev = makeEvent({ key: "web-watchlist", category: "music" }, { title: `${s.artist} — ${s.venue}`, date: s.date, venue: s.venue, url: s.url, performers: [s.artist], city: s.city }, today);
          if (ev && ev.date && ev.date >= today) out.push({ ...ev, branch: "watchlist", tier, artist: s.artist });
        }
      } catch (e) { log(`  watchlist web search failed: ${e.message}`); if (e.fatal) throw e; }
    }
    return out;
  };
}

/**
 * A lane's web-search candidates: ONE tool-less-but-WebSearch call per run,
 * for venues and series no feed carries. Only events the model saw on a page
 * with a specific date and venue come back; past and undated ones are dropped
 * in code. Fails soft (no rows) unless the model is not reachable at all.
 */
export function webSearchExtras(name, ws = {}, { run = judge } = {}) {
  const max = ws.max_searches || 6;
  return async ({ today, log = () => {} }) => {
    if (!ws.ask) return [];
    let res;
    try {
      res = await run({
        model: SONNET, effort: "low", webSearch: true, timeoutMs: 600000,
        system: `You look up announced upcoming events. Use at most ${max} web searches in total. Report only events you saw on a page in this session with a specific date and venue — never a guess, an estimated or past date, or an undated rumour. Give the event's own page (or its ticket page) as url.`,
        prompt: `Today is ${today}. ${ws.ask}`,
        schema: { type: "object", additionalProperties: false, required: ["events"], properties: { events: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["title", "date", "time", "venue", "city", "url"],
          properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, or empty when the page gives none" },
            venue: { type: "string" }, city: { type: "string" }, url: { type: "string" } } } } } },
      });
    } catch (e) { log(`  ${name} web search failed: ${e.message}`); if (e.fatal) throw e; return []; }
    const src = { key: `web-${name}`, category: ws.category || "other" };
    return (res?.events || [])
      .map((x) => makeEvent(src, { title: x.title, date: x.date, time: x.time || null, venue: x.venue, url: x.url, city: x.city || null }, today))
      .filter((ev) => ev && ev.date && ev.date >= today);
  };
}

/** Store events become discovery (music) or comedy (only in `comedyGroup`) candidates, unless already a watchlist hit. */
export function assignBranches(pool, { comedyGroup = null } = {}) {
  const watch = new Set(pool.filter((ev) => ev.branch === "watchlist").map((ev) => ev.key));
  return pool
    .filter((ev) => ev.branch === "watchlist" || !watch.has(ev.key))
    .map((ev) => ev.branch ? ev
      : { ...ev, branch: ev.category === "comedy" ? (comedyGroup && (ev.groups || []).includes(comedyGroup) ? "comedy" : null) : "discovery" })
    .filter((ev) => ev.branch);
}

/** A row's metro from its own city: a regional row's gate metro, else its city slug, else home. */
export function eventMetro(ev, home = homeMetro()) {
  return ev.gate_metro || (ev.city && ev.city !== home ? String(ev.city).toLowerCase() : home);
}

// ─── regional behaviour ────────────────────────────────────────────────────

/**
 * A theater run is one candidate, not twenty: performances sharing a title and
 * venue (exact vendor strings — structure, not meaning) collapse to the next
 * one, keyed by the run itself so the following performance is not "new" on
 * the next run.
 */
export function collapseRuns(pool) {
  const runs = new Map();
  const out = [];
  for (const ev of [...pool].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (ev.category !== "theater") { out.push(ev); continue; }
    const k = `run:${slug(ev.title)}|${slug(ev.venue)}`;
    const cur = runs.get(k);
    if (cur) { cur.run_dates += 1; continue; }
    const rep = { ...ev, key: k, run_dates: 1 };
    runs.set(k, rep);
    out.push(rep);
  }
  return out;
}

/**
 * Pre-model gate: drop sold-out rows, and rows dated when the user is not in
 * `metro` unless a tier-1 headliner is on the bill. The months the user is
 * elsewhere cost no model call; watch.mjs still re-gates every pick with `travel in-city`.
 */
export async function regionalPrepare(pool, { metro, presence = presenceByDate, headliner = headlinerMatcher() } = {}) {
  const dates = [...new Set(pool.map((ev) => ev.date).filter(Boolean))];
  const here = await presence(dates, metro);
  const kept = pool.filter((ev) => ev.status !== "sold_out"
    && (!ev.date || here.get(ev.date) !== false || headliner(ev.title, ...(ev.performers || []))));
  return collapseRuns(kept);
}

/** Outside the near zone, only a pick in the lane's any-zone section. */
export function regionalAcceptPick(ev, { anyZoneSection = "worth-the-drive", near = nearZone() } = {}) {
  return ev.zone === near || ev.pick?.section === anyZoneSection;
}

// ─── delivery ──────────────────────────────────────────────────────────────

/** Template vars for a pointer about `lead` (one of `picks`), as seen from `here`. */
export function pointerVars(lead, picks, { here, metroFor, moreNoun = "" } = {}) {
  const n = picks.length;
  return {
    n,
    s: n === 1 ? "" : "s",
    title: lead.title,
    who: lead.artist || lead.performers?.[0] || lead.title,
    at_venue: lead.venue ? ` at ${lead.venue}` : "",
    city: lead.city ? `, ${lead.city}` : "",
    city_away: lead.city && metroFor(lead) !== here ? `, ${lead.city}` : "",
    when: lead.date ? `, ${new Date(`${lead.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "",
    more: n > 1 ? ` + ${n - 1} more${moreNoun ? ` ${moreNoun}` : ""}` : "",
  };
}

/**
 * The phone pointer: who, where and when for one lead show. Lead = the first
 * pick in `leadSections` (else any pick) in the metro the user is in today
 * (`here`), else the first of those, keeping the model's order. A bare list of
 * names said nothing about where or when, and the outbound precheck read it as
 * having no hook.
 */
export function lanePointer(picks, { text, here, metroFor = (p) => eventMetro(p), leadSections = [], moreNoun = "" }) {
  const preferred = leadSections.length ? picks.filter((p) => leadSections.includes(p.pick?.section)) : [];
  const pool = preferred.length ? preferred : picks;
  const lead = pool.find((p) => metroFor(p) === here) || pool[0];
  return fill(text, pointerVars(lead, picks, { here, metroFor, moreNoun }));
}

function placeLabel(picks, labels = {}) {
  for (const p of picks) if (p.gate_metro && labels.by_gate_metro?.[p.gate_metro]) return labels.by_gate_metro[p.gate_metro];
  return labels.default || "";
}

function chatLines(picks, header, { sections = [], showPrice = false } = {}) {
  const emoji = Object.fromEntries(sections.filter((s) => s.emoji).map((s) => [s.key, s.emoji]));
  const lines = [header, ""];
  for (const p of picks) {
    const price = showPrice && p.price_min != null ? ` (~$${Math.round(p.price_min)}/pp)` : "";
    lines.push(`${emoji[p.pick.section] || "•"} ${p.title} — ${p.venue}, ${fmtDate(p)}${price}${p.tag ? ` (${p.tag})` : ""}`, `  ${p.pick.why}`, p.url || "", "");
  }
  return lines.join("\n").trim();
}

/**
 * deliver config:
 *   mode     "email" (a sectioned digest, then an optional phone pointer) or
 *            "chat_when_home" (a chat ping while the user is in the lane's
 *            metro today; `away` otherwise)
 *   subject, label (Gmail-label the digest), place_labels {default, by_gate_metro}
 *   pointer  {when: "here"|"here_or_trip", headliner_check, lead_sections[],
 *             text, push, intent, more_noun}
 *   chat     {header, intent, show_price}
 *   away     {style: "digest"|"plain", subject, heading, label}
 *   also_to  [addresses] every email of the lane also goes to, one send each
 *            (after the user's; one failing is logged and the rest still go)
 */
export function deliverLane(lane, d, { perks, send: base0 = defaultSend } = {}) {
  const send = d.also_to?.length ? { ...base0, email: (m) => {
    base0.email(m);
    for (const to of d.also_to) {
      try { base0.email({ ...m, to }); } catch (e) { console.error(`[${lane.name}] email to an extra recipient failed: ${e?.message || e}`); }
    }
  } } : base0;
  return async (picks, { today }) => {
    const n = picks.length;
    const base = { date: longDate(today), n, s: n === 1 ? "" : "s", place: placeLabel(picks, d.place_labels) };
    const sections = lane.sections.map((s) => ({ heading: s.heading, items: picks.filter((p) => p.pick.section === s.key) }));
    const home = lane.homeMetro;

    if (d.mode === "chat_when_home") {
      // geo-gate-ok: every pick passed travel in-city <lane metro> <date> (+ headliner bypass) in watch.mjs; the channel follows travel in-city <lane metro> <today>.
      if (send.inCity(home, today)) {
        send.chat(chatLines(picks, fill(d.chat?.header, base), { sections: lane.sections, showPrice: d.chat?.show_price }), d.chat?.intent || lane.name);
        return;
      }
      const away = d.away || {};
      const subject = fill(away.subject || d.subject, base);
      if (away.style === "plain") {
        const text = chatLines(picks, fill(d.chat?.header, base), { sections: lane.sections, showPrice: d.chat?.show_price });
        send.email({ subject, html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>` });
      } else {
        send.email({ subject, html: renderDigest(subject, [{ heading: away.heading || lane.sections[0]?.heading || "", items: picks }], { perks }) });
      }
      if (away.label !== false && away.style !== "plain") await send.label(subject);
      return;
    }

    const subject = fill(d.subject, base);
    send.email({ subject, html: renderDigest(subject, sections, { perks }) });
    if (d.label !== false) await send.label(subject);
    const ptr = d.pointer;
    if (!ptr?.text) return;
    // geo-gate-ok: every pick was gated per item (travel in-city <its metro> <date> + headliner bypass) in watch.mjs; the pointer only names what survived, and is skipped unless the user is today in the metro of one of the picks (or, for "here_or_trip", a worth-the-trip pick is in it).
    const metros = [...new Set([home, ...picks.map((p) => lane.metroFor(p))])];
    const here = metros.find((m) => send.inCity(m, today));
    const trip = ptr.when === "here_or_trip"
      && picks.some((p) => p.tag === "worth the trip" || (ptr.headliner_check && send.isHeadliner(p.title, ...(p.performers || []))));
    if (here || trip) {
      send.pointer({
        pointer: lanePointer(picks, { text: ptr.text, here: here || home, metroFor: lane.metroFor, leadSections: ptr.lead_sections || [], moreNoun: ptr.more_noun || "" }),
        push: fill(ptr.push, base), intent: ptr.intent || lane.name, evidenceLive: true,
      });
    }
  };
}

const defaultSend = {
  email: (m) => sendHtmlEmail(m),
  label: (subject) => labelDigest(subject),
  pointer: (m) => pointerAndPush(m),
  chat: (text, intent) => spawnSync(path.join(REPO, "bin/jori-send-curl"), ["--intent", intent, "--evidence-as-of", "live", text], { stdio: "ignore", timeout: 120000 }),
  inCity: (metro, date) => inCity(metro, date),
  isHeadliner: (...names) => isHeadliner(...names),
};

// ─── building lanes from config ────────────────────────────────────────────

/** One lane object (the shape watch.mjs runLane reads) from its config. */
export function buildLane(name, c, cfg = {}, { send, judge: judgeFn } = {}) {
  const judgeOpt = judgeFn ? { run: judgeFn } : {};
  const home = c.metro || homeMetro();
  const profile = () => readProfileFrom(cfg.profile_file);
  const sections = (c.sections || []).map((s) => (typeof s === "string" ? { key: s, heading: s } : s));
  const lane = {
    name,
    seenFile: c.seen_file || `data/${name}-seen.json`,
    groups: c.groups || [],
    categories: c.categories || null,
    siblings: c.siblings || [],
    horizonDays: c.horizon_days || 120,
    maxCandidates: c.max_candidates || 200,
    maxPicks: c.max_picks || 10,
    model: c.model,
    effort: c.effort,
    homeMetro: home,
    sections,
    ...(c.ride_along_with ? { rideAlongWith: c.ride_along_with } : {}),
    system: () => fillBrief(c.system, { profile: profile(), voice: cfg.voice || DEFAULT_VOICE }),
    prompt: (rows, { today }) => `Today is ${today}. Candidates:\n${JSON.stringify(rows)}`,
    schema: pickSchema(sections.map((s) => s.key)),
  };
  if (c.metro) lane.metroFor = () => c.metro;
  else if (c.metro_from_event) lane.metroFor = (ev) => eventMetro(ev);
  else lane.metroFor = () => home;
  const extras = [c.watchlist && watchlistExtras(c, profile), c.web_search && webSearchExtras(name, c.web_search, judgeOpt)].filter(Boolean);
  if (extras.length) {
    lane.extraCandidates = async (ctx) => {
      const out = [];
      for (const f of extras) out.push(...(await f(ctx)));
      return out;
    };
  }
  if (c.watchlist) {
    lane.prepare = async (pool) => assignBranches(pool, { comedyGroup: c.watchlist.comedy_group || null });
  } else if (c.regional) {
    lane.prepare = (pool) => regionalPrepare(pool, { metro: home });
    lane.acceptPick = (ev) => regionalAcceptPick(ev, { anyZoneSection: c.regional.any_zone_section });
  } else if (c.mark_headliner_sources?.length) {
    // These rooms' concerts are other lanes' territory; one survives here only
    // as a tier-1 headliner safety net, and that is a list lookup, so code marks it.
    const srcs = new Set(c.mark_headliner_sources);
    lane.prepare = async (pool) => pool.map((ev) => (srcs.has(ev.source) && isHeadliner(ev.title, ...(ev.performers || [])) ? { ...ev, headliner: true } : ev));
  }
  lane.deliver = deliverLane(lane, c.deliver || {}, { perks: cfg.perks || [], ...(send ? { send } : {}) });
  return lane;
}

/** Every configured lane, by name. */
export function buildLanes(cfg = watchConfig(), opts = {}) {
  return Object.fromEntries(Object.entries(cfg.lanes || {}).map(([name, c]) => [name, buildLane(name, c, cfg, opts)]));
}

export const LANES = buildLanes();

export { todayET };
