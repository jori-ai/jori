// meeting-reminder.mjs — the 15-minute reminder before a recurring meeting's call.
//
// The call time is the user's local time with the home zone in brackets (just
// the local time when the two read the same). The agenda is the notes' open
// To Discuss lines: ranked by the last call's model (`order` in the meeting's
// labels file, written by meeting-notes-update.mjs) when there is a ranking,
// else only the lines git blame dates to the last 30 days (uncommitted =
// today; commit lag only makes a line look newer), or the first 3 when nothing
// is that recent. Items are shown exactly as written, or as their short label
// from that file. A model step that cut expired dates was held back: it could
// delete a real agenda item. At most 6 are shown, as a Markdown list; the rest
// sit behind a "<!-- more: +N more -->" fold the app expands on tap.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { instance } = createRequire(import.meta.url)("./instance.cjs");
const HOME = () => instance().tz;
const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return !!tz; } catch { return false; } };

/** "11:00pm"; compact drops ":00" ("4pm"). */
export function clock(at, tz, { compact = false } = {}) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value.toLowerCase() || "";
  return `${get("hour")}${compact && get("minute") === "00" ? "" : `:${get("minute")}`}${get("dayPeriod")}`;
}

/** "PT" for America/Los_Angeles: the zone as a short generic name. */
export const zoneAbbr = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortGeneric" })
  .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || tz;

/** "11:00pm your time (1pm PT)", or just "4:00pm" when the local clock reads the same as the home zone's. */
export function callTimeLabel(at, tz, home = HOME()) {
  const local = clock(at, validTz(tz) ? tz : home);
  return local === clock(at, home) ? local : `${local} your time (${clock(at, home, { compact: true })} ${zoneAbbr(home)})`;
}

/** The user's current zone, resolved by local-day exactly as cron-tz-sync does. Fail-open to the home zone. */
export function resolveLocalTz(override) {
  let tz = override;
  try { tz ||= JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "bin/local-day"), "--json"],
    { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] })).tz; } catch {}
  return validTz(tz) ? tz : HOME();
}

/** Open bullets under "## To Discuss", with 1-based line numbers. Markdown structure only. */
export function toDiscussItems(notesText) {
  let inSection = false;
  return String(notesText ?? "").split("\n").flatMap((line, i) => {
    if (line.startsWith("## ")) { inSection = line.startsWith("## To Discuss"); return []; }
    const t = line.trim(), text = (t.startsWith("- [ ]") ? t.slice(5) : t.slice(2)).trim();
    return inSection && t.startsWith("- ") && !t.startsWith("- [x]") && !t.startsWith("- [X]") && text ? [{ line: i + 1, text }] : [];
  });
}

/** line number → when git last saw it change (committer time; uncommitted = now). null on any failure. */
export function lineDates(file) {
  try {
    const out = execFileSync("git", ["-C", path.dirname(file), "blame", "--line-porcelain", "--", path.basename(file)],
      { encoding: "utf8", timeout: 15000, maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const dates = new Map();
    let lineNo = null;
    for (const sp of out.split("\n").map((row) => row.split(" "))) {
      if (sp[0].length === 40 && sp.length >= 3 && !sp[0].startsWith("\t")) lineNo = Number(sp[2]); // a porcelain header: <sha> <orig> <final>
      else if (sp[0] === "committer-time" && lineNo) dates.set(lineNo, new Date(Number(sp[1]) * 1000));
    }
    return dates.size ? dates : null;
  } catch { return null; }
}

export const MAX_SHOWN = 6;

/**
 * The reminder as {text, checklist}. `text` is the Markdown copy (what older app builds and the push
 * show); `checklist` (null when there is no agenda) is the same agenda as tappable boxes in the same
 * order, folded after MAX_SHOWN, each item carrying its To Discuss line as `ref` so a tick can find
 * it (lib/choice-reply.mjs → bin/meeting-agenda-check), so the user can mark items that are
 * completed or no longer relevant off the list.
 */
// Topics worth raising from the user's group chats: `chatTopics` ({topic, from}) come from the
// meeting's topics file (written at T-40 by its `topics_agent`, when it has one) for this call
// only, and follow the agenda.
export function chatTopicsBlock(chatTopics = []) {
  const xs = (Array.isArray(chatTopics) ? chatTopics : []).filter((t) => t?.topic);
  return xs.length ? `\n\nFrom the group chats:\n${xs.map((t) => `- ${t.topic}${t.from ? ` (${t.from})` : ""}`).join("\n")}` : "";
}

export function composeReminder(opts = {}) {
  const r = composeAgenda(opts);
  const extra = chatTopicsBlock(opts.chatTopics);
  return extra ? { ...r, text: r.text + extra } : r;
}

function composeAgenda({ hhmm, state, notesText, notesFile, tz, now = new Date(), dates, labels = {}, order = [],
                         name = "Meeting", kind = "meeting_agenda", home = HOME() } = {}) {
  // The state file's start when it is this call; otherwise 15 minutes from now (cron fires at T-15).
  const at = Number.isFinite(state?.epoch_start) && state.time === hhmm ? new Date(state.epoch_start * 1000) : new Date(now.getTime() + 900000);
  const head = `📞 ${name} in 15 min · ${callTimeLabel(at, tz, home)}`;
  if (notesText == null) return { text: `${head}\n\nCouldn't read the ${name} notes, so no agenda.`, checklist: null };
  const items = toDiscussItems(notesText);
  if (!items.length) return { text: `${head}\n\nNothing on the agenda.`, checklist: null };
  const when = dates === undefined ? lineDates(notesFile) : dates, cutoff = now.getTime() - 30 * 86400000;
  const isRecent = (it) => !when || !when.has(it.line) || when.get(it.line).getTime() >= cutoff;
  const ranked = Array.isArray(order) ? order : [];
  let shown, intro = "";
  if (ranked.length) {
    // The last call's model ranked the agenda: most important or urgent first. Recent items it never
    // saw (added from chat since) go on top; old unranked ones at the bottom.
    const key = (it) => (ranked.includes(it.text) ? ranked.indexOf(it.text) : isRecent(it) ? -1 : ranked.length);
    shown = [...items].sort((a, b) => key(a) - key(b) || a.line - b.line);
  } else {
    const recent = items.filter(isRecent);
    shown = recent.length ? recent : items.slice(0, 3);
    if (when && !recent.length) intro = "Nothing new this month. Top 3:";
  }
  // The rest follow a fold marker, in the same order: the app shows the top ones and a tappable
  // "+N more" that expands to all.
  const all = [...shown, ...items.filter((it) => !shown.includes(it))];
  const cut = Math.min(shown.length, MAX_SHOWN), rest = all.slice(cut);
  shown = all.slice(0, cut);
  const short = (t) => (labels && typeof labels[t] === "string" && labels[t]) || t.split("**").join("");
  // "- " not "•": the app renders Markdown, where "•" lines run together into one paragraph.
  const list = (xs) => xs.map((it) => `- ${short(it.text)}`).join("\n");
  const more = rest.length ? `\n<!-- more: +${rest.length} more -->\n${list(rest)}` : "";
  const title = [head, ...(intro ? [intro] : [])].join("\n\n");
  // A tick finds its item by label, so two items sharing a label keep their full wording apart.
  const seen = new Map();
  for (const it of all) seen.set(short(it.text), (seen.get(short(it.text)) || 0) + 1);
  const label = (it) => (seen.get(short(it.text)) > 1 ? it.text.split("**").join("") : short(it.text));
  return {
    text: `${title}\n\n${list(shown) + more}`,
    checklist: { v: 1, kind, title, fold: cut, items: all.map((it) => ({ label: label(it), ref: it.text })) },
  };
}

export const composePre = (opts) => composeReminder(opts).text;

// CLI: node meeting-reminder.mjs pre <HH:MM> --state F --notes F [--labels F] [--topics F] [--name N]
//        [--kind K] [--tz IANA] [--now ISO] [--checklist-out F]
// prints the text; --checklist-out writes the checklist JSON (absent when there is none).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2), opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined),
    read = (f, parse) => { try { return parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const kept = read(opt("--labels"), JSON.parse);
  const state = read(opt("--state"), JSON.parse), topics = read(opt("--topics"), JSON.parse);
  // Only the file written for this call (same epoch_start) counts.
  const chatTopics = topics && state && topics.call_epoch === state.epoch_start ? topics.topics : [];
  const r = composeReminder({ chatTopics, hhmm: argv[1], state, notesText: read(opt("--notes"), String),
    notesFile: opt("--notes"), labels: kept?.labels || {}, order: kept?.order || [], tz: resolveLocalTz(opt("--tz")),
    name: opt("--name") || "Meeting", kind: opt("--kind") || "meeting_agenda",
    now: opt("--now") ? new Date(opt("--now")) : new Date() });
  if (opt("--checklist-out") && r.checklist) fs.writeFileSync(opt("--checklist-out"), JSON.stringify(r.checklist));
  process.stdout.write(r.text + "\n");
}
