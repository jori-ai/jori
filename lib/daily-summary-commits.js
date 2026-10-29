"use strict";
// daily-summary-commits — the day's jori commits are what the user worked on,
// and the daily summary lists them in plain language under the stop where the
// user was working, by time of day, not in a separate section (no work happens
// while walking).
//
// Until then a commit reached the email only if the narrator picked it as a
// stop's one-line aside, and then as its raw subject line. Same split as the
// closed tasks and the location spine: CODE owns which commits there were, when,
// and which stop each belongs to; a MODEL owns the words (Rule #0b). The
// narrator writes `prose.commits`:
//
//   [{ "shas": ["<sha>", "<sha>"], "text": "You got the points tracker refreshing ..." }]
//
// Which stop: the one the user was at when it landed. A commit that lands while
// moving belongs to the stop just left (no work happens while walking: that is
// a session started there finishing), one before the first stop to the first.
// One line may cover several commits; it sits at the stop and time of the
// earliest. A commit no line covers still ships, under its own subject, so
// nothing the day did can drop out (the review flags it). A line that names no
// commit of the day is dropped: it cannot describe work that did not happen.
//
// Two more rules:
//
//   * A diary is in time order, so a commit never sits under a header that
//     starts AFTER it. One that landed before the day's first stop (a 1am
//     session, overnight fixes at 4am) gets a section of its own ahead of
//     the first stop, split by the Watch's night: "Before you went to sleep",
//     "While you slept", "Before your first stop" (stopFor returns null for
//     it; `pre` names the group).
//   * What Jori works on by itself is described very briefly, and what it
//     does as a matter of routine, daily, is not mentioned at all. Which
//     commits are Jori's own is structural (the tag the landing code puts on
//     them, AUTONOMOUS_TAGS); which of those are routine is arithmetic (a tag
//     that turned up on most of the last seven days, routineTags). Routine ones
//     stay in the day JSON flagged `omitted: "routine"` and never print; the
//     narrator is told which commits are autonomous and writes them in as few
//     words as it can.
//
// Pure. The git read itself is daily-summary-harvest.js gitFacts().

const { tzAtMs, tzAbbr } = require("./geo-timezone.js");

// Parts of the day, by local hour. "Late night" is the small hours that still
// belong to the day (00:00-04:59), listed first because they came first.
const PARTS = [
  { key: "night", label: "Late night", from: 0 },
  { key: "morning", label: "Morning", from: 5 },
  { key: "afternoon", label: "Afternoon", from: 12 },
  { key: "evening", label: "Evening", from: 17 },
];

function partOf(hhmm) {
  const h = parseInt(String(hhmm || "").slice(0, 2), 10);
  if (!Number.isFinite(h)) return null;
  let p = PARTS[0];
  for (const x of PARTS) if (h >= x.from) p = x;
  return p.key;
}

// The tag the code that lands a change puts at the front of its subject when
// Jori made it without the user: self-improve-auto-apply writes "[auto-impl]",
// the Face-ID landing writes "self-improve:". Machine-written structure, not
// the user's language, so a prefix test is the right tool (Rule #0b).
const AUTONOMOUS_TAGS = ["[auto-impl]", "self-improve:"];
// "Daily" = the tag appeared on at least this many of the previous LOOKBACK days.
const ROUTINE_LOOKBACK_DAYS = 7;
const ROUTINE_MIN_DAYS = 4;

// Sections ahead of the first stop, in the order the night runs.
const PRE_GROUPS = [
  { key: "before_sleep", label: "Before you went to sleep" },
  { key: "asleep", label: "While you slept" },
  { key: "before_stop", label: "Before your first stop" },
];

function autonomousTag(subject) {
  const s = String(subject || "");
  return AUTONOMOUS_TAGS.find((t) => s.startsWith(t)) || null;
}

// A merge whose subject is git's own default ("Merge branch 'worktree-agent-…'")
// says nothing of its own: the branch's commits are already in the day's
// `git log`, each under its own subject. Uncovered, six of them shipped on
// 2026-10-22 as "You pulled six pieces of background Jori work together",
// and the review flagged it as narration on every pass. Left out
// (`omitted: "merge"`), like routine work. A merge someone described ("Merge
// the phone sign-in page …") is kept.
function bareMerge(subject) {
  // lang-regex-ok: git's own default merge subject, machine-written structure
  return /^Merge (?:remote-tracking )?branch '[^']+'(?: of \S+)?(?: into \S+)?$/.test(String(subject || "").trim());
}

/**
 * The autonomous tags that are routine: on at least ROUTINE_MIN_DAYS of the
 * previous days. `prior` is [{date, tags: [tag...]}] (harvest priorCommitTags);
 * null/undefined (the read failed) -> none, so the work is shown rather than
 * hidden on a guess.
 */
function routineTags(prior) {
  if (!Array.isArray(prior)) return new Set();
  const days = new Map();
  for (const d of prior) for (const t of new Set((d && d.tags) || [])) days.set(t, (days.get(t) || 0) + 1);
  return new Set([...days].filter(([, n]) => n >= ROUTINE_MIN_DAYS).map(([t]) => t));
}

function localHhmm(ms, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(ms));
}

function visitsOf(stops) {
  return (stops || []).filter((s) => !s.is_movement && Number.isFinite(s.start_ts_ms))
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
}

// The stop a commit belongs to: the one he was at, else the last one he left.
// Visits only (a movement row is not a place he worked). One that landed before
// the first visit belongs to no stop (null): it goes in a section ahead of it
// (`pre`), never under a header that starts later than the commit did.
function stopFor(stops, ms) {
  let at = null;
  for (const s of visitsOf(stops)) if (s.start_ts_ms <= ms) at = s;
  return at ? at.id : null;
}

/**
 * The harvest's commits, stamped with the local clock of where he was when each
 * landed (the stop's zone on a zone-crossing day, else the day's zone), the
 * part of the day, and the stop it belongs to (stopFor). Chronological.
 *
 *   placeStops  the stops the report shows (render's isMainStop); a commit is
 *               placed only on one of those. Defaults to all of `stops`.
 *   opts.night  the Watch's night ({onset_at, wake_at}, ISO): splits the hours
 *               before the first stop into before-sleep / asleep / after waking.
 *   opts.routineTags  Set from routineTags(): autonomous commits wearing one are
 *               stamped `omitted: "routine"`.
 *
 * Each commit also carries `pre` (PRE_GROUPS key, or null when it landed at or
 * after the first stop, or the day has no stop), `autonomous` and `tag`.
 */
function dayCommits(commits, stops, tz, placeStops = stops, opts = {}) {
  const firstMs = (visitsOf(placeStops)[0] || {}).start_ts_ms;
  const night = opts.night || null;
  const onset = night ? Date.parse(night.onset_at) : NaN;
  const woke = night ? Date.parse(night.wake_at) : NaN;
  const routine = opts.routineTags || new Set();
  const preOf = (ms) => {
    if (!Number.isFinite(firstMs) || ms >= firstMs) return null;
    if (Number.isFinite(onset) && Number.isFinite(woke)) {
      if (ms < onset) return "before_sleep";
      if (ms < woke) return "asleep";
    }
    return "before_stop";
  };
  const out = [];
  for (const c of commits || []) {
    const ms = Number.isFinite(c.ms) ? c.ms : Date.parse(c.at);
    if (!Number.isFinite(ms) || !c.sha) continue;
    const ctz = tzAtMs(stops || [], ms, tz) || tz;
    const at = localHhmm(ms, ctz);
    const tag = autonomousTag(c.subject);
    out.push({ sha: c.sha, at: new Date(ms).toISOString(), ts: ms, local: at, tz: ctz,
      tz_abbr: tzAbbr(ctz, ms), part: partOf(at), stop_id: stopFor(placeStops, ms), pre: preOf(ms),
      subject: String(c.subject || ""), autonomous: !!tag, tag,
      ...(bareMerge(c.subject) ? { omitted: "merge" } : tag && routine.has(tag) ? { omitted: "routine" } : {}) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Place commits against the stops a renderer shows: `stop_id` from stopFor and,
 * for one before the first stop, its `pre` group (kept from dayCommits, else
 * "before_stop"). A day with no stop keeps `pre: null`: its commits are listed
 * by part of the day. Pure.
 */
function placeCommits(commits, stops) {
  const hasVisit = visitsOf(stops).length > 0;
  return (commits || []).map((c) => {
    const stop_id = stopFor(stops, c.ts);
    return { ...c, stop_id, pre: stop_id || !hasVisit ? null : (c.pre || "before_stop") };
  });
}

// Short and long shas name the same commit.
function shaMatch(a, b) {
  a = String(a || "").toLowerCase(); b = String(b || "").toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * The lines to print, chronological (and grouped by part of the day, for a
 * day with no stops to hang them on).
 *   commits  dayCommits() output (placeCommits() first when rendering)
 *   written  prose.commits ([{shas, text}]) — may be absent
 * Commits stamped `omitted` are neither printed nor counted as uncovered.
 * -> { parts: [{key, label, lines: [{time, tz_abbr, stop_id, pre, text, shas, plain}]}],
 *      lines: the same lines flat, chronological, uncovered: [sha] }
 * `plain: false` marks a fallback line (the commit's own subject).
 */
function commitLines(commits, written) {
  const list = visibleCommits(commits);
  const covered = new Set();
  const lines = [];
  for (const w of Array.isArray(written) ? written : []) {
    const text = String((w && w.text) || "").trim();
    if (!text) continue;
    const mine = list.filter((c) => (w.shas || []).some((s) => shaMatch(s, c.sha)) && !covered.has(c.sha));
    if (!mine.length) continue;
    for (const c of mine) covered.add(c.sha);
    lines.push({ first: mine[0], text, shas: mine.map((c) => c.sha), plain: true });
  }
  const uncovered = list.filter((c) => !covered.has(c.sha));
  for (const c of uncovered) lines.push({ first: c, text: c.subject, shas: [c.sha], plain: false });
  lines.sort((a, b) => a.first.ts - b.first.ts);
  const parts = PARTS.map((p) => ({ key: p.key, label: p.label, lines: [] }));
  for (const l of lines) {
    const p = parts.find((x) => x.key === l.first.part) || parts[1];
    p.lines.push({ time: l.first.local, tz_abbr: l.first.tz_abbr, stop_id: l.first.stop_id || null,
      pre: l.first.pre || null, text: l.text, shas: l.shas, plain: l.plain });
  }
  const kept = parts.filter((p) => p.lines.length);
  return { parts: kept, lines: kept.flatMap((p) => p.lines), uncovered: uncovered.map((c) => c.sha) };
}

// What the report can show: everything code did not leave out.
function visibleCommits(commits) {
  return (commits || []).filter((c) => !c.omitted);
}

module.exports = { dayCommits, placeCommits, commitLines, visibleCommits, routineTags, autonomousTag, bareMerge, stopFor, partOf, shaMatch,
  PARTS, PRE_GROUPS, AUTONOMOUS_TAGS, ROUTINE_LOOKBACK_DAYS, ROUTINE_MIN_DAYS };
