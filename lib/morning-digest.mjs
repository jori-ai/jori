// morning-digest.mjs — the pure halves of bin/morning-digest-run:
// timezone-correct calendar filtering, task bucketing, shaping the overnight
// emails for the pick call, and the fixed HTML template. Kept here so they are
// tested (tests/morning-digest.test.mjs) without running the job. There
// is deliberately no HUM section (a user requirement) — do not add one back.
// OVERNIGHT EMAIL recounts the emails themselves in plain words; it never
// shows how the agent filed them (also a user requirement).

import { createRequire } from "node:module";
import { escapeHtml, ogCards } from "./digest-deliver.mjs";
import { htmlToText } from "./gmail-read.mjs";

const require = createRequire(import.meta.url);
const { agentAddresses } = require("./instance.cjs");

/** Every address the agent sends from (agent_email plus agent_email_aliases). */
export const agentSenders = () => agentAddresses();

export function ymdIn(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function shift(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/**
 * Today's events in `tz`. Fetches a 3-day window and filters by the LOCAL date
 * of each instant, so neither gog's range resolution nor the calendar's
 * account-level default timezone can shift what counts as "today".
 */
export function calendarToday(items, tz, today) {
  const out = [];
  for (const ev of items || []) {
    if (ev.status === "cancelled") continue;
    if (ev.start?.date) {
      const s = ev.start.date, e = ev.end?.date || shift(s, 1);
      if (s <= today && today < e) out.push({ time: "All day", title: ev.summary || "(no title)", sort: "00:00" });
      continue;
    }
    if (!ev.start?.dateTime) continue;
    const at = new Date(ev.start.dateTime);
    if (ymdIn(tz, at) !== today) continue;
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
    const sort = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
    out.push({ time, title: ev.summary || "(no title)", sort });
  }
  return out.sort((a, b) => a.sort.localeCompare(b.sort)).map(({ time, title }) => ({ time, title }));
}

/** Tasks bucketed by due date (overdue / today / tomorrow). */
export function bucketTasks(items, today) {
  const b = { overdue: [], today: [], tomorrow: [] };
  for (const t of items || []) {
    if (t.status === "completed" || !t.due) continue;
    const due = String(t.due).slice(0, 10);
    if (due < today) b.overdue.push(t.title);
    else if (due === today) b.today.push(t.title);
    else if (due === shift(today, 1)) b.tomorrow.push(t.title);
  }
  return b;
}

// ─── overnight email (the emails themselves, not the triage log) ──────────

const ENTITIES = { nbsp: " ", shy: "", zwnj: "", zwj: "", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026" };
const codePoint = (n) => { try { return String.fromCodePoint(n); } catch { return " "; } };

/** A plain-text excerpt of a gog-decoded body: HTML flattened, links and invisible padding dropped. */
export function mailText(body, max = 1200) {
  const s = String(body || "");
  const flat = s.trimStart().startsWith("<") ? htmlToText(s) : s;
  return flat
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16))) // lang-regex-ok: HTML numeric entities
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d))) // lang-regex-ok: HTML numeric entities
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m) // lang-regex-ok: HTML named entities
    .replace(/https?:\/\/\S+/g, " ") // lang-regex-ok: URL removal, tracking links would eat the excerpt
    .replace(/\[\s*\]|\(\s*\)|<\s*>/g, " ") // lang-regex-ok: empty brackets a removed link leaves behind
    .replace(/[\u034f\u00ad\u200b-\u200d\u2060\ufeff]/g, "") // lang-regex-ok: invisible preheader padding characters
    .replace(/\s+/g, " ").trim().slice(0, max); // lang-regex-ok: whitespace normalization
}

/** gog --timezone UTC prints "YYYY-MM-DD HH:MM"; pin it to UTC. */
function gogUtcMs(date) {
  const s = String(date || "").trim();
  return Date.parse(s.includes("T") || s.endsWith("Z") ? s : `${s.replace(" ", "T")}Z`);
}

/**
 * The agent's earlier sorting, as a clue for the pick call. Never rendered.
 * Triage marks a P2 with a star and no priority label (there is no `p2`
 * label), so "worth a look" is starred-without-`p1`.
 */
function hintOf(labels) {
  const has = (l) => labels.includes(l);
  const category = labels.find((l) => l.startsWith("CATEGORY_"));
  return {
    flagged: has("p1") ? "urgent" : has("STARRED") ? "worth a look" : has("p1-resolved") ? "was urgent, since handled" : has("p3") ? "routine" : null,
    starred: has("STARRED"),
    category: category ? category.slice("CATEGORY_".length).toLowerCase() : null,
  };
}

/**
 * The overnight emails, shaped for the pick call: who sent it, the subject,
 * when it landed (in the user's timezone, converted here), a plain-text
 * excerpt and the inbox's own hints, oldest first. The agent's own mail is
 * left out: its reports are not news to the user.
 */
export function overnightRows(rows, tz, { maxChars = 1200, own = agentSenders() } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const labels = r.labels || [];
    if (labels.includes("jori-out") || own.some((a) => String(r.from || "").toLowerCase().includes(a))) continue;
    const ms = gogUtcMs(r.date);
    out.push({
      from: r.from || "", subject: r.subject || "",
      received: Number.isFinite(ms) ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms)) : null,
      hint: hintOf(labels),
      text: mailText(r.body, maxChars),
      ms: Number.isFinite(ms) ? ms : 0,
    });
  }
  return out.sort((a, b) => a.ms - b.ms).map(({ ms, ...m }) => m);
}

/** The structured output now and then leaves a stray "}" on the end of a sentence. */
export function tidy(t) {
  const s = String(t || "").trim();
  return s.endsWith("}") && !s.includes("{") ? s.slice(0, -1).trimEnd() : s;
}

/** "Dana Levi <dana@example.com>" → "Dana Levi"; a bare address stays as it is. */
export function senderName(from) {
  const s = String(from || "").trim();
  const i = s.indexOf("<");
  const name = (i > 0 ? s.slice(0, i) : s).trim();
  return (name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name) || s;
}

// ─── render (fixed template) ──────────────────────────────────────────────

export function render(packet, picks) {
  const F = "font-family:-apple-system,Segoe UI,Arial,sans-serif";
  const h2 = (t) => `<h2 style="${F};font-size:15px;margin:20px 0 6px 0">${escapeHtml(t)}</h2>`;
  const list = (rows) => rows.length ? `<ul style="${F};font-size:14px;margin:0 0 0 18px;padding:0">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>` : "";
  const p = (t) => `<p style="${F};font-size:14px;margin:4px 0">${t}</p>`;
  const out = [`<div style="${F};max-width:640px">`, `<h1 style="${F};font-size:18px;margin:0 0 10px 0">Morning Brief - ${escapeHtml(longDay(packet.today))}</h1>`];

  out.push(h2("CALENDAR"));
  out.push(packet.calendar == null ? p("Calendar unavailable this morning.")
    : packet.calendar.length ? list(packet.calendar.map((e) => `${escapeHtml(e.time)} ${escapeHtml(e.title)}`)) : p("No events today"));

  out.push(h2("TASKS"));
  const t = packet.tasks;
  if (!t) out.push(p("Tasks unavailable this morning."));
  else if (!t.overdue.length && !t.today.length && !t.tomorrow.length) out.push(p("Nothing due today or tomorrow."));
  else for (const [label, rows] of [["Overdue", t.overdue], ["Due today", t.today], ["Due tomorrow", t.tomorrow]]) {
    if (rows.length) out.push(p(`${label}:`), list(rows.map(escapeHtml)));
  }

  // Who wrote, what it says, what it means for the user (a user requirement:
  // simply recount and summarize the important emails that arrived overnight).
  // No priorities, labels, counts, ids or pipeline detail, in any branch.
  out.push(h2("OVERNIGHT EMAIL"));
  const mail = packet.overnight_mail;
  const o = picks.overnight;
  if (mail == null) out.push(p("I couldn't reach your inbox this morning, so there's no overnight email roundup today."));
  else if (!mail.length) out.push(p("Nothing new came in overnight."));
  else if (!o) {
    // The write-up failed: name who wrote the ones flagged earlier, nothing more.
    const flagged = mail.filter((m) => m.hint?.flagged === "urgent" || m.hint?.flagged === "worth a look");
    if (flagged.length) out.push(p("I couldn't write up last night's email this morning. These are the ones that looked important:"), list(flagged.map((m) => `<b>${escapeHtml(senderName(m.from))}</b>: ${escapeHtml(m.subject)}`)));
    else out.push(p("I couldn't write up last night's email this morning; everything that came in is waiting in your inbox."));
  } else {
    const items = (o.items || []).map((e) => ({ who: tidy(e?.who), summary: tidy(e?.summary) })).filter((e) => e.summary);
    for (const e of items) out.push(p(`${e.who ? `<b>${escapeHtml(e.who)}</b> — ` : ""}${escapeHtml(e.summary)}`));
    const rest = tidy(o.rest);
    if (rest) out.push(p(escapeHtml(rest)));
    if (!items.length && !rest) out.push(p("Nothing in last night's email needs you."));
  }

  out.push(h2("NEWS"));
  // Sections come from the headline feed's own output, in its order
  // (news-headlines decides which sections exist).
  const labels = { world: "World", business: "Business", local: `Local (${packet.city})` };
  const label = (sec) => labels[sec] || sec.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  for (const sec of newsSections(packet)) {
    const items = (picks.news?.[sec] || []).map((i) => packet.news[sec]?.[i]).filter(Boolean).slice(0, 3);
    out.push(`<h3 style="${F};font-size:14px;margin:12px 0 4px 0">${escapeHtml(label(sec))}</h3>`);
    out.push(items.length ? list(items.map((it) => `${it.url ? `<a href="${escapeHtml(it.url)}">${escapeHtml(it.title)}</a>` : escapeHtml(it.title)}${it.summary ? ` — ${escapeHtml(firstSentence(it.summary))}` : ""}`)) : p("No headlines available"));
  }

  out.push(h2(`WEATHER (${packet.city})`));
  out.push(p(packet.weather ? escapeHtml(packet.weather).replace(/\n/g, "<br>") : "Weather unavailable")); // lang-regex-ok: newline → <br> for HTML layout of a CLI's output

  out.push(h2("EVENTS & FESTIVALS"));
  const evs = (picks.events || []).map((x) => ({ ...packet.events.find((e) => e.id === x.id), why: x.why })).filter((e) => e.title).slice(0, 4);
  if (!evs.length) out.push(p(packet.events_tracked ? "Nothing on today's venue calendars worth flagging." : `No venue calendars tracked for ${escapeHtml(packet.city)} yet.`));
  const cards = ogCards(evs.map((e) => e.url).filter(Boolean));
  let ci = 0;
  for (const e of evs) {
    out.push(`<div style="${F};font-size:14px;margin:10px 0 2px 0"><b>${escapeHtml(e.title)}</b> — ${escapeHtml(e.venue || "")}${e.time ? `, ${escapeHtml(e.time)}` : ""}. ${escapeHtml(e.why)}</div>`);
    if (e.url) out.push(cards[ci++] || "");
  }

  out.push("</div>");
  return out.join("\n");
}

/** The news sections in the packet, in feed order; the usual four when the feed returned none. */
export function newsSections(packet) {
  const keys = Object.keys(packet?.news || {});
  return keys.length ? keys : ["world", "business", "local"];
}

export function firstSentence(s) { const i = s.indexOf(". "); return (i > 40 ? s.slice(0, i + 1) : s).slice(0, 220); }
export function longDay(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); }

