// meeting-reminder.test.mjs — the T-15 reminder before a recurring meeting's call
// (lib/meeting-reminder.mjs, bin/meeting-remind): the local time with the home
// zone in brackets, the agenda ranked and folded, a checklist, and a post-call
// crontab cleanup that never installs a crontab it did not read in full.
// Sandbox HOME: fake jori-send-curl + crontab, notes in a throwaway git repo,
// a synthetic meeting in a throwaway local config dir.
//
// Run: node --test tests/meeting-reminder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { callTimeLabel as label, composePre as pre, composeReminder as compose } from "../lib/meeting-reminder.mjs";

const HOME_TZ = "America/New_York";
const callTimeLabel = (at, tz) => label(at, tz, HOME_TZ);
const composePre = (o) => pre({ name: "Sam", home: HOME_TZ, ...o });
const composeReminder = (o) => compose({ name: "Sam", kind: "meeting_agenda:coach", home: HOME_TZ, ...o });

const BIN = fileURLToPath(new URL("../bin/meeting-remind", import.meta.url));
const DEAL = "**Acme deal — TOP PRIORITY for Monday (Sep 28) call.** Follow up on progress (discussed Sep 22).";

test("the local time first, ET in brackets, DST from Intl on each side", () => {
  const at = (iso, tz) => callTimeLabel(new Date(iso), tz);
  assert.equal(at("2026-10-20T20:00:00Z", "Asia/Jerusalem"), "11:00pm your time (4pm ET)");
  assert.equal(at("2026-10-27T20:00:00Z", "Asia/Jerusalem"), "10:00pm your time (4pm ET)"); // Israel off DST Oct 25, the US on Nov 1
  assert.equal(at("2026-11-03T21:00:00Z", "Asia/Jerusalem"), "11:00pm your time (4pm ET)");
  assert.equal(at("2026-10-20T20:00:00Z", "America/New_York"), "4:00pm");
  assert.equal(at("2026-10-20T20:00:00Z", "Not/AZone"), "4:00pm");
});

test("agenda: short labels when the model left one, else the item without its markdown bold", () => {
  const notes = `## To Discuss (Upcoming)\n- [ ] A long item about the CFO offer\n- [ ] ${DEAL}\n`;
  const out = composePre({ hhmm: "16:00", state: { time: "16:00", epoch_start: 1792526400 }, notesText: notes, tz: "America/New_York",
    now: new Date("2026-10-20T19:45:00Z"), dates: null, labels: { "A long item about the CFO offer": "CFO offer: decide by Fri" } });
  assert.equal(out, `📞 Sam in 15 min · 4:00pm\n\n- CFO offer: decide by Fri\n- ${DEAL.split("**").join("")}`);
});

test("agenda: recent items as written, the first 3 when nothing is recent, everything when git can't say", () => {
  const notes = `## To Discuss (Upcoming)\n${["A", "B", "C", "D", DEAL].map((t) => `- [ ] ${t}`).join("\n")}\n- [x] done\n\n## Discussed\n- E\n`;
  const now = new Date("2026-10-20T19:45:00Z"), old = new Date("2026-04-13T12:00:00Z"), compose = (dates) =>
    composePre({ hhmm: "16:00", state: { time: "16:00", epoch_start: 1792526400 }, notesText: notes, tz: "America/New_York", now, dates }).split("\n\n").slice(1);
  const D = DEAL.split("**").join("");
  assert.deepEqual(compose(new Map([2, 3, 4, 5, 6].map((l) => [l, l === 6 ? now : old]))), [`- ${D}\n<!-- more: +4 more -->\n- A\n- B\n- C\n- D`]);
  assert.deepEqual(compose(new Map([2, 3, 4, 5, 6].map((l) => [l, old]))), ["Nothing new this month. Top 3:", `- A\n- B\n- C\n<!-- more: +2 more -->\n- D\n- ${D}`]);
  assert.deepEqual(compose(null), [`- A\n- B\n- C\n- D\n- ${D}`]);
});

test("agenda ranked by the last call's priority: recent unranked on top, old unranked last, at most 6", () => {
  const texts = ["A", "B", "C", "D", "E", "F", "G", "New from chat"];
  const notes = `## To Discuss (Upcoming)\n${texts.map((t) => `- [ ] ${t}`).join("\n")}\n`;
  const now = new Date("2026-10-20T19:45:00Z"), old = new Date("2026-04-13T12:00:00Z");
  const dates = new Map(texts.map((t, i) => [i + 2, t === "New from chat" ? now : old]));
  const out = composePre({ hhmm: "16:00", state: { time: "16:00", epoch_start: 1792526400 }, notesText: notes, tz: "America/New_York",
    now, dates, labels: { G: "G short" }, order: ["G", "C", "F", "A", "B"] });
  assert.deepEqual(out.split("\n\n").slice(1), ["- New from chat\n- G short\n- C\n- F\n- A\n- B\n<!-- more: +2 more -->\n- D\n- E"]);
});

function sandbox({ cron = "", mode = "" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-remind-")), repo = path.join(home, "install");
  const data = path.join(repo, "data"), notesFile = path.join(data, "coach-notes.md");
  const local = path.join(home, "local"); fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "instance.json"), JSON.stringify({ owner_name: "Ann", tz: HOME_TZ }));
  fs.writeFileSync(path.join(local, "config", "meetings.json"), JSON.stringify({ meetings: [{ id: "coach", name: "Sam",
    notes_file: "data/coach-notes.md", state_file: "data/coach-state.json", log_name: "coach-reminder", cron_tag: "# COACH_MEETING_REMINDER" }] }));
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin/jori-send-curl"), `#!/bin/bash\ncat >> "${home}/sent.txt"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, "crontab.txt"), cron); // fake crontab: -l lists crontab.txt (or fails / hangs), - installs
  fs.writeFileSync(path.join(home, "crontab"), `#!/bin/bash\necho "$@" >> "${home}/crontab-calls.txt"\nif [ "$1" != -l ]; then cat > "${home}/crontab.installed"; exit; fi\n${
    { fail: "exit 1", hang: "exec sleep 5" }[mode] || ""}\ncat "${home}/crontab.txt"\n`, { mode: 0o755 });
  const git = (date, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const notes = (...agenda) => fs.writeFileSync(notesFile, `# Sam Meeting Notes\n\n## Running Context\n- Not an agenda line.\n\n## To Discuss (Upcoming)\n${agenda.map((a) => `- [ ] ${a}`).join("\n")}\n\n## Discussed\n\n### 2026-10-09\n- Customer ordering website.\n`);
  const old = "Threats discussion (carried from Apr 13)", fresh = "Customer ordering website — follow up (discussed Oct 9).";
  git("", "init", "-q"); notes(old); git("2026-04-13T12:00:00Z", "add", "."); git("2026-04-13T12:00:00Z", "commit", "-qm", "april");
  notes(old, DEAL); git("2026-10-10T12:00:00Z", "commit", "-qam", "october");
  notes(old, DEAL, fresh); // uncommitted = written today
  fs.writeFileSync(path.join(data, "coach-state.json"), JSON.stringify({ date: "2026-10-20", time: "16:00", timezone: "America/New_York",
    epoch_start: 1792526400, status: "scheduled", pre_reminder_sent: false, post_reminder_sent: false }));
  const run = (...args) => spawnSync("bash", [BIN, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, JORI_HOME: repo, JORI_LOCAL_DIR: local, MEETING_ID: "coach", PATH: `${home}:${process.env.PATH}`, MEETING_CRONTAB_TIMEOUT: "1" } });
  const read = (f) => (fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), "utf8") : "");
  return { run, read, home, state: () => JSON.parse(fs.readFileSync(path.join(data, "coach-state.json"), "utf8")), fresh };
}

test("pre, abroad: the local time with ET in brackets, recent items first, the rest behind the fold", () => {
  const sb = sandbox();
  const r = sb.run("pre", "16:00", "--tz", "Asia/Jerusalem", "--now", "2026-10-20T19:45:00Z");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sb.read("sent.txt"), ["📞 Sam in 15 min · 11:00pm your time (4pm ET)", "",
    `- ${DEAL.split("**").join("")}`, `- ${sb.fresh}`, "<!-- more: +1 more -->", "- Threats discussion (carried from Apr 13)"].join("\n"));
  assert.equal(sb.state().pre_reminder_sent, true);
});

test("--dry-run in the home zone prints just the local time; sends, writes and unschedules nothing", () => {
  const sb = sandbox();
  const pre = sb.run("pre", "16:00", "--dry-run", "--tz", "America/New_York", "--now", "2026-10-20T19:45:00Z");
  assert.ok(pre.stdout.startsWith("📞 Sam in 15 min · 4:00pm\n"), pre.stdout + pre.stderr);
  assert.match(sb.run("post", "16:00", "--dry-run").stdout, /Anything to remember from the call/);
  assert.deepEqual([sb.read("sent.txt"), sb.read("crontab-calls.txt"), sb.state().pre_reminder_sent, sb.state().post_reminder_sent], ["", "", false, false]);
});

const TAGGED = '45 15 20 10 * remind pre "16:00" # COACH_MEETING_REMINDER\n0 17 20 10 * remind post "16:00" # COACH_MEETING_REMINDER\n';
test("post cleanup: a failed, hung, empty or tagless crontab read installs nothing", () => {
  for (const [mode, cron] of [["fail", `0 1 * * * a\n${TAGGED}`], ["hang", `0 1 * * * a\n${TAGGED}`], ["", ""], ["", "0 1 * * * a\n"]]) {
    const sb = sandbox({ mode, cron }), r = sb.run("post", "16:00");
    assert.deepEqual([sb.read("crontab-calls.txt"), fs.existsSync(path.join(sb.home, "crontab.installed"))], ["-l\n", false], `${mode} ${cron} ${r.stderr}`);
    assert.match(sb.read("sent.txt") + sb.read("install/data/logs/coach-reminder.log"), /Anything to remember[^]*cleanup skipped/);
  }
});
test("post cleanup: a good read removes exactly the tagged lines", () => {
  const sb = sandbox({ cron: `0 1 * * * a\n${TAGGED}\n5 2 * * * b # keep\n` });
  assert.equal(sb.run("post", "16:00").status, 0);
  assert.equal(sb.read("crontab.installed"), "0 1 * * * a\n\n5 2 * * * b # keep\n");
});

test("checklist: the same agenda as boxes, same order, folded where the list folds, each item's line as ref", async () => {
  const texts = ["A", "B", "C", "D", "E", "F", "G", "**H bold**"];
  const notes = `## To Discuss (Upcoming)\n${texts.map((t) => `- [ ] ${t}`).join("\n")}\n- [x] ticked\n`;
  const r = composeReminder({ hhmm: "16:00", state: { time: "16:00", epoch_start: 1792526400 }, notesText: notes, tz: "America/New_York",
    now: new Date("2026-10-20T19:45:00Z"), dates: null, labels: { A: "Same", B: "Same" }, order: ["**H bold**", "A", "B"] });
  assert.equal(r.checklist.title, "📞 Sam in 15 min · 4:00pm");
  assert.equal(r.checklist.fold, 6);
  assert.deepEqual(r.checklist.items.map((i) => i.label), ["C", "D", "E", "F", "G", "H bold", "A", "B"]); // unranked + undated = recent, on top; shared label → full wording
  assert.deepEqual(r.checklist.items.map((i) => i.ref), ["C", "D", "E", "F", "G", "**H bold**", "A", "B"]);
  assert.equal(composeReminder({ notesText: "## To Discuss (Upcoming)\n", tz: "America/New_York" }).checklist, null);
});

test("the checklist carries the meeting's own kind; no meeting configured: nothing sent, exit 0", () => {
  const r = composeReminder({ hhmm: "16:00", state: { time: "16:00", epoch_start: 1792526400 }, notesText: "## To Discuss (Upcoming)\n- [ ] A\n",
    tz: HOME_TZ, now: new Date("2026-10-20T19:45:00Z"), dates: null });
  assert.equal(r.checklist.kind, "meeting_agenda:coach");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-off-"));
  const off = spawnSync("bash", [BIN, "pre", "16:00"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: empty, MEETING_ID: "" } });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /no recurring meeting configured/);
  assert.equal(off.stdout, "");
});
