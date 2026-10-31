"use strict";
// daily-summary-tasks — the day's CLOSED Google Tasks, as a DETERMINISTIC spine
// fact: the day's summary includes a list of the tasks closed that day, because
// remembering when a task was done matters to the user.
//
// This used to be step 2.5 of the playbook — an agent-run `gog tasks` harvest
// whose output was only ever "anchored to a stop" as prose. That made a closed
// task the one kind of fact the narrator could silently drop: no slot in the
// skeleton meant no place it was required to appear, and nothing in the stored
// day JSON meant it was unrecoverable afterwards. Same reasoning as the location
// spine and the photos: if it must always appear, CODE emits it.
//
// Why the day JSON and not just the email: `daily-summary-build publish` stores
// the settled JSON on `daily_summaries`, so the completion log survives even a
// `gog tasks clear` (which permanently drops completed tasks from Google's own
// list) and the wiki + future recall render from the same rows.
//
// Read-only. Never marks, edits, or clears anything in Google Tasks.

const { spawnSync } = require("child_process");
const { loadEnv } = require("./load-env.js");
const { tzAtMs, tzAbbr } = require("./geo-timezone.js");
const { parseMarker } = require("./p1-task.js");

// `gog` reads its OAuth token from the FILE keyring backend, which needs
// GOG_KEYRING_PASSWORD and has no TTY to prompt for it. Cron
// children get it injected by `cron-run`, but daily-summary also runs as a
// forked `claude -p` under `job-run`, whose env is whatever the supervisor had —
// so load it here rather than depend on the launcher. Never overrides an
// inherited value.
loadEnv();

const fs = require("fs");
const { instance } = require("./instance.cjs");

// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
// The tasks account: JORI_CAL_ACCOUNT, else the owner's address (instance owner_email).
const DEFAULT_ACCOUNT = process.env.JORI_CAL_ACCOUNT || instance().owner_email;

// ---- local-time helpers -----------------------------------------------------
// Google returns `completed` as a UTC RFC3339 instant. Rather than compute the
// day's UTC offset (which DST and travel both move), format the instant INTO the
// day's display timezone and compare date strings — the same instant, asked the
// only question that matters: did it land on this local day?
function localParts(iso, tz) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(d);
  return { date, hhmm, ts: d.getTime() };
}

// ---- pure selection (unit-testable without the network) ---------------------
// lists = [{ title, tasks: [<raw google task>, ...] }]
function selectCompletedTasks(lists, date, tz) {
  const out = [];
  for (const list of lists || []) {
    for (const t of list.tasks || []) {
      if (!t || t.status !== "completed" || !t.completed) continue;
      const at = localParts(t.completed, tz);
      if (!at || at.date !== date) continue;
      out.push({
        id: t.id || null,
        title: String(t.title || "").trim() || "(untitled task)",
        list: list.title || null,
        // Local wall-clock of the completion, in the day's own timezone — the
        // answer to "when did I do this?" without a mental UTC conversion.
        completed_at: at.hhmm,
        completed_ts: at.ts,
        completed_utc: t.completed,
        // A task closed long after (or before) its due date is the interesting
        // case, so keep the due date rather than only the moment of closing.
        due: t.due ? String(t.due).slice(0, 10) : null,
        notes: t.notes ? String(t.notes).slice(0, 300) : null,
        // read before the notes are cut: p1-task's marker sits at their end
        p1_thread: (parseMarker(t.notes) || {}).threadId || null,
        parent: t.parent || null,
        url: t.webViewLink || null,
      });
    }
  }
  // Chronological: the day reads forward, like every other section.
  out.sort((a, b) => a.completed_ts - b.completed_ts);
  return oneLinePerP1Thread(out);
}

// Two tasks for ONE P1 thread under one title, closed together, are one to-do
// listed once (a "Check new mail at the mailbox" listed twice: two emails on
// one thread, closed 2 s apart). The thread comes from
// the marker p1-task stamps into the notes, our own string; tasks without one are
// never merged, and a later closing of the same thread keeps its own line.
const SAME_CLOSING_MS = 10 * 60_000;
function oneLinePerP1Thread(tasks) {
  const seen = new Map();
  const out = [];
  for (const t of tasks) {
    const key = t.p1_thread ? `${t.p1_thread}|${t.title}` : null;
    const first = key && seen.get(key);
    if (first && Math.abs(t.completed_ts - first.completed_ts) <= SAME_CLOSING_MS) {
      (first.also_ids ||= []).push(t.id);
      continue;
    }
    if (key) seen.set(key, t);
    out.push(t);
  }
  return out;
}

// ---- the gog calls ----------------------------------------------------------
function gogJson(args, timeout = 20000) {
  const r = spawnSync(GOG, [...args, "--json", "--no-input"], {
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `gog exited ${r.status}`).trim().slice(0, 300));
  try { return JSON.parse(r.stdout); }
  catch (e) { throw new Error(`gog returned non-JSON: ${e.message}`); }
}

function isoDayOffset(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19) + "Z";
}

// Fetch every list's completions for the local day. Returns
// { tasks: [...], error: <string|null> } — an error is REPORTED, never
// swallowed into an empty list: "no tasks closed" and "I couldn't read Google
// Tasks" are different days, and the renderer prints them differently.
function fetchCompletedTasks(date, tz, opts = {}) {
  const account = opts.account || DEFAULT_ACCOUNT;
  // ±1 day in UTC around the local day covers every real timezone offset
  // (max ±14h); selectCompletedTasks() then trims to the exact local day.
  const min = isoDayOffset(date, -1);
  const max = isoDayOffset(date, 2);
  try {
    const lists = (gogJson(["tasks", "lists", "-a", account]).tasklists || [])
      .map(l => ({ id: l.id, title: l.title }));
    if (!lists.length) return { tasks: [], error: null };
    const withTasks = lists.map(l => ({
      title: l.title,
      tasks: gogJson([
        "tasks", "list", l.id, "-a", account,
        "--show-completed", "--show-hidden", "--all", "--max", "100",
        "--completed-min", min, "--completed-max", max,
      ]).tasks || [],
    }));
    return { tasks: selectCompletedTasks(withTasks, date, tz), error: null };
  } catch (e) {
    return { tasks: [], error: (e && e.message) || String(e) };
  }
}

// On a day that crossed zones (resolved.tzs.length > 1), each completion is
// re-stated in the zone of the stop the user was at when closing it, labelled —
// the same rule as the stop times (the local time at each location, when the
// user was there). Which tasks belong to the day is still
// settled in the day's own zone by selectCompletedTasks; only the clock moves.
function localizeTasksToStops(tasks, stops, fallbackTz) {
  return (tasks || []).map((t) => {
    if (!Number.isFinite(t.completed_ts)) return t;
    const tz = tzAtMs(stops, t.completed_ts, fallbackTz) || fallbackTz;
    const at = localParts(t.completed_utc || new Date(t.completed_ts).toISOString(), tz);
    return at ? { ...t, completed_at: at.hhmm, tz, tz_abbr: tzAbbr(tz, t.completed_ts) } : t;
  });
}

module.exports = { fetchCompletedTasks, selectCompletedTasks, localizeTasksToStops, _internal: { localParts, isoDayOffset, oneLinePerP1Thread } };
