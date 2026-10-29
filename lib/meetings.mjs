// meetings.mjs — the user's recurring meetings, as configuration.
//
// A recurring meeting is a standing call with one counterpart (a cofounder, a
// coach, a manager): it sits on the calendar as a recurring series, usually
// runs in the user's own Zoom room, and keeps a running notes file with a
// "To Discuss" agenda. The kernel's meeting module (lib/meeting-*.mjs,
// bin/meeting-*) does the same things for every meeting configured here:
//
//   - finds the day's instance on the calendar and keeps a state file with the
//     next call ahead (bin/meeting-calendar-check → bin/meeting-update);
//   - schedules the reminders around it as tagged crontab lines (T-40 prep,
//     T-15 agenda, T+60..T+240 post-call; bin/meeting-remind);
//   - after the call, folds Zoom's summary or transcript into the notes
//     (bin/meeting-notes-from-zoom) and sends the post-call message;
//   - puts each call that took place on the daily summary's timeline
//     (lib/meeting-call.mjs), Zoom first, the calendar second;
//   - is a soft block for planners: an overlap with it is a note, not a
//     conflict (isMeetingEvent).
//
// agent/local/config/meetings.json:
//   {"meetings": [{
//      "id": "<slug>",                       required; names the files below
//      "name": "<the counterpart's first name, as messages show it>",
//      "calendar_match": ["<a word in the event's title or an attendee's name / mailbox>"],
//      "zoom": {"room_id": "<the user's Zoom meeting id>",
//               "participant": {"emails": ["..."], "names": ["<Zoom display names>"]}},
//      "notes_file": "data/meetings/<id>/notes.md",   relative to the installation
//      "state_file": "data/meetings/<id>/state.json",
//      "topics_context": "<optional: what the two share, for bin/message-digest topics>",
//      ...the other keys of DEFAULTS below, all optional
//   }]}
// No file, or an empty list: the module is off. Every entry point says so and
// exits 0; nothing errors on a fresh install.

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");
const { installRoot, installTools } = require("./root.cjs");

const DEFAULTS = (id) => ({
  name: id,
  calendar_match: null,           // null → [name]
  zoom: { room_id: null, participant: { emails: [], names: [] } },
  notes_file: `data/meetings/${id}/notes.md`,
  state_file: `data/meetings/${id}/state.json`,
  labels_file: `data/meetings/${id}/agenda-labels.json`,
  applied_file: `data/meetings/${id}/notes-zoom.json`,
  topics_file: `data/meetings/${id}/message-topics.json`,
  backups_dir: "data/backups",
  backup_prefix: `meeting-${id}-notes`,
  log_name: `meeting-${id}`,
  tmp_prefix: `meeting-${id}`,    // /tmp/<prefix>-calls-<date>.json, /tmp/<prefix>-call-talk-<date>.json
  cron_tag: `# MEETING_REMINDER_${id.toUpperCase().split("-").join("_")}`,
  reminder_bin: "bin/meeting-remind",
  reading_site: "meeting-call-held",   // the Jev question site (data/jev-questions/<site>.json), when there is one
  checklist_kind: `meeting_agenda:${id}`,
  notes_agent: "ai.claude.meeting-notes-zoom",
  topics_agent: null,             // a launchd agent that writes topics_file before the call (T-40), or none
  default_tz: null,               // the zone the series is set in; null → the installation's tz
});

/** An installation path: absolute as given, else under the installation. */
export function installPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(installRoot(), p);
}

/** Every configured meeting, resolved (absolute paths, defaults filled). [] when none. */
export function meetings({ config = null } = {}) {
  const cfg = config || localConfig("meetings", { meetings: [] });
  const list = Array.isArray(cfg.meetings) ? cfg.meetings : [];
  return list.filter((m) => m && typeof m.id === "string" && m.id.trim()).map((m) => resolve(m));
}

function resolve(raw) {
  const id = raw.id.trim();
  const d = DEFAULTS(id);
  const m = { ...d, ...raw, id };
  const zoom = { ...d.zoom, ...(raw.zoom || {}) };
  zoom.participant = { emails: [], names: [], ...((raw.zoom && raw.zoom.participant) || {}) };
  zoom.participant.emails = zoom.participant.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  zoom.participant.names = zoom.participant.names.map((n) => String(n)).filter(Boolean);
  m.zoom = zoom;
  m.room_id = zoom.room_id ? String(zoom.room_id).split(" ").join("") : null;
  m.calendar_match = (Array.isArray(raw.calendar_match) && raw.calendar_match.length ? raw.calendar_match : [m.name])
    .map((t) => String(t).toLowerCase()).filter(Boolean);
  m.tz = m.default_tz || instance().tz;
  m.paths = {
    notes: installPath(m.notes_file), state: installPath(m.state_file), labels: installPath(m.labels_file),
    applied: installPath(m.applied_file), topics: installPath(m.topics_file), backups: installPath(m.backups_dir),
    reminder_bin: installPath(m.reminder_bin), log: installPath(`data/logs/${m.log_name}.log`),
  };
  return m;
}

/**
 * One meeting: by id, else $MEETING_ID, else the first configured. null when
 * none is configured (or the id is unknown).
 */
export function meeting(id = null, opts = {}) {
  const all = meetings(opts);
  const want = id || process.env.MEETING_ID || null;
  if (!want) return all[0] || null;
  return all.find((m) => m.id === want) || null;
}

/** The meeting a stored state / env override points at: the env file overrides win (tests, one-off runs). */
export function statePath(m) { return process.env.MEETING_STATE_FILE || m.paths.state; }
export function notesPath(m) { return process.env.MEETING_NOTES_FILE || m.paths.notes; }
export function backupsDir(m) { return process.env.MEETING_BACKUPS_DIR || m.paths.backups; }

/** The series id stored in the meeting's state file, or null. */
export function knownSeriesId(m) {
  if (!m) return null;
  try { return JSON.parse(fs.readFileSync(statePath(m), "utf8")).calendar_event_id || null; } catch { return null; }
}

/** The kernel's own bin directory (the generic entry points live there). */
export const KERNEL_BIN = installTools("bin");

const shq = (v) => `'${String(v == null ? "" : v).split("'").join("'\\''")}'`;

/**
 * The shell's view of one meeting, for the bash entry points:
 *   eval "$(node lib/meetings.mjs env [<id>])"
 * prints MEETING_OK=0 (and nothing else) when the meeting is not configured.
 */
export function shellEnv(m) {
  if (!m) return "MEETING_OK=0\n";
  const vars = {
    MEETING_OK: 1, MEETING_ID: m.id, MEETING_NAME: m.name, MEETING_TZ: m.tz,
    MEETING_STATE: statePath(m), MEETING_NOTES: notesPath(m), MEETING_LABELS: m.paths.labels,
    MEETING_TOPICS: m.paths.topics, MEETING_CRON_TAG: m.cron_tag, MEETING_REMINDER_BIN: m.paths.reminder_bin,
    // The generic reminder needs to be told which meeting; a dedicated reminder script knows.
    MEETING_REMINDER_ARGS: m.reminder_bin === "bin/meeting-remind" ? `--meeting ${m.id}` : "",
    MEETING_NOTES_AGENT: m.notes_agent || "", MEETING_TOPICS_AGENT: m.topics_agent || "",
    MEETING_LOG: m.paths.log, MEETING_CHECKLIST_KIND: m.checklist_kind,
  };
  return Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n";
}

// CLI: node lib/meetings.mjs env [<id>] | list
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === "env") process.stdout.write(shellEnv(meeting(id || null)));
  else if (cmd === "list") process.stdout.write(meetings().map((m) => m.id).join("\n") + (meetings().length ? "\n" : ""));
  else { process.stderr.write("usage: meetings.mjs env [<id>] | list\n"); process.exit(2); }
}

export const _internal = { DEFAULTS, resolve };
