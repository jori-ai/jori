// daily-summary-fix.test.mjs — the fix loop's state CLI (bin/daily-summary-fix).
//
// the user, 2026-10-17: the reviewer catches; a second process root-causes, fixes,
// regenerates until the reviewer confirms; it asks the user in chat when only the user can
// decide; and the email ends with what the review caught and how it was fixed.
// The CLI is the plumbing for that: queueing a run, asking once, recording what
// was done, and the closing section, which must never claim a fix that did not
// happen.
//
// Run: node --test tests/daily-summary-fix.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "daily-summary-fix");
const D = "2099-01-02";

// `quiet`: the user's quiet hours, written where the CLI reads its instance config. Without
// it the sandbox has no config at all (never the real one), so nothing is held.
function sandbox({ quiet = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsfix-"));
  const local = path.join(dir, "local");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  if (quiet) fs.writeFileSync(path.join(local, "config", "daily-summary-fix.json"), JSON.stringify({ quiet_hours: quiet }));
  const sent = path.join(dir, "sent.log");
  const sender = path.join(dir, "send");
  // Logs every send; like jori-send-curl, writes {"suppressed":true} to --capture-id
  // when the outbound check holds a message back (here: one marked "[held]"). A
  // message marked "[fail]" fails (exit 1) without being sent.
  fs.writeFileSync(sender, `#!/bin/sh
case "$*" in *"[fail]"*) echo "$*" >> ${dir}/failed.log; exit 1 ;; esac
printf '%s\\n---\\n' "$*" >> ${sent}
cap=""; prev=""
for a in "$@"; do [ "$prev" = "--capture-id" ] && cap="$a"; prev="$a"; done
case "$*" in *"[held]"*) [ -n "$cap" ] && printf '{"suppressed":true,"reason":"test"}\\n' > "$cap" ;; *) [ -n "$cap" ] && printf 'row-1\\n' > "$cap" ;; esac
`, { mode: 0o755 });
  // DS_FIX_LAST_USER_MSG: when the user last wrote in chat ("" = not since), never Supabase.
  const env = { ...process.env, DS_FIX_DIR: path.join(dir, "state"), DS_FIX_SEND_BIN: sender, DS_FIX_TMP: dir, JORI_ROOT: dir, JORI_LOCAL_DIR: local, DS_FIX_LAST_USER_MSG: "" };
  delete env.DS_FIX_NOW; delete env.DS_FIX_TZ;
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, timeout: 30000 });
  // `at(iso, tz)` runs the CLI with its clock and the user's timezone pinned.
  const at = (iso, tz = "Asia/Jerusalem", extra = {}) => (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...env, DS_FIX_NOW: iso, DS_FIX_TZ: tz, ...extra }, timeout: 30000 });
  const state = (d = D) => JSON.parse(fs.readFileSync(path.join(dir, "state", `${d}.json`), "utf8"));
  const sends = () => (fs.existsSync(sent) ? fs.readFileSync(sent, "utf8").split("\n---\n").filter(Boolean) : []);
  const queued = (d) => fs.existsSync(path.join(dir, "state", "queue", d));
  const unqueue = (d) => fs.rmSync(path.join(dir, "state", "queue", d), { force: true });
  // The user's phone's night, where the CLI reads it (<JORI_ROOT>/tools/data); times are
  // minutes relative to the real clock, which is what the shared reader compares with.
  const sleep = ({ upMinAgo = null, inBed = false, writtenMinAgo = 1 } = {}) => {
    const ago = (m) => new Date(Date.now() - m * 60e3).toISOString();
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "sleep-night-state.json"), JSON.stringify({
      night_of: "2026-10-26", tz: "Asia/Jerusalem", phone_down_at: ago(500), in_bed_now: inBed,
      phone_up_at: upMinAgo === null ? null : ago(upMinAgo), written_at: ago(writtenMinAgo) }));
  };
  return { dir, run, at, state, sends, queued, unqueue, sleep, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("request queues the day for launchd and records why; an answer is kept verbatim", () => {
  const s = sandbox();
  try {
    assert.equal(s.run("request", D, "--reason", "review not confirmed: 3 issues").status, 0);
    assert.ok(fs.existsSync(path.join(s.dir, "state", "queue", D)), "a QueueDirectories marker");
    assert.equal(s.state().status, "queued");
    s.run("request", D, "--answer", "Yes, Sam was there too", "--no-kick");
    assert.equal(s.state().answers[0].text, "Yes, Sam was there too");
  } finally { s.done(); }
});

test("ask sends one plain question to chat, once, and caps the day at five", () => {
  const s = sandbox();
  try {
    assert.equal(s.run("ask", D, "--question", "Was Sam with you at Nana's?").status, 0);
    assert.equal(s.run("ask", D, "--question", "Was Sam with you at Nana's?").status, 0);
    assert.equal(s.sends().length, 1, "the same open question is not asked twice");
    // lang-regex-ok: asserts the argv our own CLI built, not anything the user wrote
    assert.match(s.sends()[0], /--channel chat --intent daily-summary-fix --evidence-as-of live 📝 Fixing your Friday, January 2 summary: Was Sam with you at Nana's\?/);
    assert.equal(s.state().status, "awaiting_user");
    for (const q of ["q2", "q3", "q4", "q5"]) s.run("ask", D, "--question", q);
    const r = s.run("ask", D, "--question", "q6");
    assert.equal(r.status, 3, "a sixth question is refused");
    assert.equal(s.sends().length, 5);
  } finally { s.done(); }
});

// the user, 2026-10-20: "Good guesses - but these questions should come before the
// summary is sent, not after." Monday Oct 19 in Jerusalem time: three questions at
// 04:42, the email at 04:55 (the fixer sent because it was waiting), the user's answers at 07:56.
const MON = "2026-10-19";

test("the first question opens the answer window (11am his time) and says so; the email is held until every question is answered", () => {
  const s = sandbox();
  try {
    assert.equal(s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you and Noa at the match at Teddy Stadium?").status, 0);
    s.at("2026-10-20T01:42:44Z")("ask", MON, "--question", "Was Sam with you all day?");
    s.at("2026-10-20T01:42:48Z")("ask", MON, "--question", "Were the 1:33 and 3:08 stops just the car at Karta?");
    const st = s.state(MON);
    assert.equal(st.hold.until, "2026-10-20T08:00:00.000Z", "11:00 in Jerusalem (UTC+3) the morning after");
    assert.deepEqual(st.questions.map((q) => q.n), [1, 2, 3]);
    const [first, second] = s.sends();
    assert.ok(first.endsWith("(I'm holding the summary until you answer, or until 11am at the latest.)"), first);
    assert.ok(!first.includes("--no-push"), "the first question buzzes his phone");
    assert.ok(second.startsWith("--no-push ") && !second.includes("holding"), "the rest of the burst land quietly, said once");

    // 04:55: the moment Monday's email went out. Now the gate holds it.
    const g = s.at("2026-10-20T01:55:24Z")("gate", MON);
    assert.equal(g.status, 3);
    const v = JSON.parse(g.stdout);
    assert.equal(v.reason, "waiting_on_answers");
    assert.equal(v.open.length, 3);
    assert.equal(v.hold_until_local, "11am");

    // The user answers two at 07:56; the third still holds it.
    s.at("2026-10-20T04:57:10Z")("answered", MON, "1", "2");
    assert.equal(s.at("2026-10-20T04:58:00Z")("gate", MON).status, 3);
    const last = s.at("2026-10-20T04:58:30Z")("answered", MON, "3");
    assert.equal(JSON.parse(last.stdout).reason, "no_open_questions");
    assert.equal(s.at("2026-10-20T04:59:00Z")("gate", MON).status, 0, "every question answered: send");
    assert.equal(s.at("2026-10-20T05:00:00Z")("answered", MON, "4").status, 64, "no such question");
  } finally { s.done(); }
});

test("the window closing sends the best version: the gate opens, and the sweep starts the fixer once", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    assert.equal(s.at("2026-10-20T07:52:00Z")("sweep").stdout.trim(), "re-queued 0", "10:52 his time: still waiting");
    assert.equal(s.queued(MON), false);
    assert.equal(s.at("2026-10-20T08:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    assert.equal(s.queued(MON), true);
    assert.match(s.state(MON).requests.at(-1).reason, /answer window closed at 11am/); // lang-regex-ok: our own request reason
    assert.equal(s.state(MON).status, "queued");
    const g = s.at("2026-10-20T08:55:00Z")("gate", MON);
    assert.equal(g.status, 0);
    assert.equal(JSON.parse(g.stdout).reason, "window_closed");
    assert.equal(JSON.parse(g.stdout).open.length, 1, "what is still open is listed");
    assert.equal(s.at("2026-10-20T09:52:00Z")("sweep").stdout.trim(), "re-queued 0", "queued once, not every hour");
    s.unqueue(MON);
    s.at("2026-10-20T10:00:00Z")("mark-sent", MON);
    assert.equal(s.at("2026-10-20T13:52:00Z")("sweep").stdout.trim(), "re-queued 0", "sent: nothing more to start");
  } finally { s.done(); }
});

test("a deadline run that died is retried, and three failures give up loudly", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T08:52:00Z")("sweep");
    s.unqueue(MON); // the run started, then died without sending
    assert.equal(s.at("2026-10-20T09:52:00Z")("sweep").stdout.trim(), "re-queued 0", "it may still be running");
    assert.equal(s.at("2026-10-20T11:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    s.unqueue(MON);
    assert.equal(s.at("2026-10-20T14:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    s.unqueue(MON);
    const before = s.sends().length;
    s.at("2026-10-20T17:52:00Z")("sweep");
    assert.equal(s.state(MON).status, "gave_up");
    assert.equal(s.sends().length, before + 1);
    assert.match(s.sends().at(-1), /--channel system --skip-precheck .*still unsent after 3 fix runs/);
  } finally { s.done(); }
});

test("a queued day whose run is still coming is left alone at the deadline", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T07:30:00Z")("request", MON, "--answer", "yes we were"); // the chat agent, with his reply
    assert.equal(s.at("2026-10-20T08:52:00Z")("sweep").stdout.trim(), "re-queued 0", "its marker is waiting");
    s.unqueue(MON);
    assert.equal(s.at("2026-10-20T08:53:00Z")("sweep").stdout.trim(), "re-queued 0", "started under 2.5h ago: maybe still running");
    assert.equal(s.at("2026-10-20T10:52:00Z")("sweep").stdout.trim(), "re-queued 1", "it died: the deadline still sends");
  } finally { s.done(); }
});

test("a late question waits three hours, not until tomorrow; one asked near midnight waits until 11am", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T19:00:00Z", "America/New_York")("ask", "2026-10-18", "--question", "Was that the Wegmans?");
    assert.equal(s.state("2026-10-18").hold.until, "2026-10-20T22:00:00.000Z", "3pm question, 6pm deadline");
    assert.ok(s.sends()[0].endsWith("or until 6pm at the latest.)"));
    s.at("2026-10-21T03:00:00Z", "America/New_York")("ask", "2026-10-20", "--question", "Was that the Wegmans?");
    assert.equal(s.state("2026-10-20").hold.label, "11am tomorrow");
  } finally { s.done(); }
});

test("a question that comes up after the send says so and holds only the correction; old questions do not", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T08:10:00Z")("mark-sent", MON);
    assert.equal(s.at("2026-10-20T08:11:00Z")("gate", MON).status, 0, "the unanswered pre-send question had its window");
    s.at("2026-10-20T09:00:00Z")("ask", MON, "--question", "Did you stop at Mahane Yehuda on the way back?");
    assert.ok(s.sends().at(-1).endsWith("(This one only came up after I'd sent the summary.)"));
    const g = s.at("2026-10-20T09:05:00Z")("gate", MON);
    assert.equal(g.status, 3);
    assert.deepEqual(JSON.parse(g.stdout).open.map((q) => q.n), [2]);
    assert.equal(s.at("2026-10-20T12:01:00Z")("gate", MON).status, 0, "three hours later the correction may go");
    assert.equal(s.at("2026-10-20T12:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    s.unqueue(MON);
    assert.equal(s.at("2026-10-20T15:52:00Z")("sweep").stdout.trim(), "re-queued 0", "a correction window starts the fixer once");
  } finally { s.done(); }
});

test("a question the outbound check held back is not asked and holds nothing; the next one carries the notice", () => {
  const s = sandbox();
  try {
    const r = s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Was the 1:36 stop the car park? [held]");
    assert.equal(r.status, 5);
    let st = s.state(MON);
    assert.equal(st.questions.length, 0);
    assert.equal(st.hold, undefined, "no window for a question he never saw");
    assert.equal(st.log.length, 0, "not a defect: the email's closing section does not list it");
    assert.equal(st.held_back.length, 1);
    assert.equal(s.at("2026-10-20T01:43:00Z")("gate", MON).status, 0);
    s.at("2026-10-20T01:43:10Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    st = s.state(MON);
    assert.equal(st.questions[0].n, 1);
    assert.ok(s.sends().at(-1).endsWith("or until 11am at the latest.)"));
  } finally { s.done(); }
});

test("a fix run that ended without sending or asking is run again, then gives up loudly", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:11:14Z")("request", MON, "--reason", "review not confirmed: 6 high");
    s.unqueue(MON); // the run started, then hit its cap
    assert.equal(s.at("2026-10-20T02:52:00Z")("sweep").stdout.trim(), "re-queued 0", "may still be running");
    assert.equal(s.at("2026-10-20T03:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    assert.match(s.state(MON).requests.at(-1).reason, /ended without sending/); // lang-regex-ok: our own request reason
    s.unqueue(MON);
    s.at("2026-10-20T06:52:00Z")("sweep"); s.unqueue(MON);
    s.at("2026-10-20T09:52:00Z")("sweep"); s.unqueue(MON);
    s.at("2026-10-20T12:52:00Z")("sweep");
    assert.equal(s.state(MON).status, "gave_up");
    assert.match(s.sends().at(-1), /--channel system .*still unsent after 3 fix runs that ended without sending it/);
    s.at("2026-10-20T01:00:00Z")("request", "2026-09-30", "--answer", "that was the Wegmans");
    s.unqueue("2026-09-30");
    assert.equal(s.at("2026-10-20T05:52:00Z")("sweep").stdout.trim(), "re-queued 0", "an old day he corrected is not chased");
  } finally { s.done(); }
});

test("a question asked after the window closed says the summary is going out now", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T08:55:00Z")("ask", MON, "--question", "Did you stop at Mahane Yehuda?");
    assert.ok(s.sends().at(-1).endsWith("(Your summary is going out now; I'll correct it if your answer changes anything.)"));
    assert.equal(s.at("2026-10-20T08:56:00Z")("gate", MON).status, 0, "the window is not reopened");
  } finally { s.done(); }
});

test("sending with questions open keeps the day waiting on him; gate --peek only reads", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T08:52:00Z")("sweep");
    assert.equal(s.state(MON).status, "queued");
    assert.equal(s.at("2026-10-20T09:00:00Z")("mark-sent", MON).status, 0);
    assert.equal(s.state(MON).status, "awaiting_user", "a late answer is still picked up");
    s.at("2026-10-20T09:10:00Z")("request", MON, "--answer", "yes");
    s.at("2026-10-20T09:20:00Z")("ask", MON, "--question", "Was Sam there too?");
    s.at("2026-10-20T09:21:00Z")("request", MON, "--answer", "yes she was");
    const p = s.at("2026-10-20T09:22:00Z")("gate", MON, "--peek");
    assert.equal(p.status, 3);
    assert.equal(s.state(MON).status, "queued", "peek changed nothing");
  } finally { s.done(); }
});

test("release ends the wait at his word and queues a run", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    assert.equal(s.at("2026-10-20T05:00:00Z")("gate", MON).status, 3);
    assert.equal(s.at("2026-10-20T05:01:00Z")("release", MON).status, 0);
    assert.equal(s.queued(MON), true);
    assert.equal(s.state(MON).status, "queued");
    assert.equal(s.at("2026-10-20T05:02:00Z")("gate", MON).status, 0);
  } finally { s.done(); }
});

test("the closing section drops 'waiting on your answer' once he has answered", () => {
  const s = sandbox();
  try {
    s.at("2026-10-20T01:42:38Z")("ask", MON, "--question", "Were you at Teddy Stadium?");
    s.at("2026-10-20T01:42:44Z")("ask", MON, "--question", "Was Sam with you all day?");
    s.at("2026-10-20T05:00:00Z")("answered", MON, "1");
    fs.writeFileSync(path.join(s.dir, `ds-review-${MON}.json`), JSON.stringify({ findings: [] }));
    const html = s.run("section", MON).stdout;
    assert.doesNotMatch(html, /Teddy Stadium/);
    assert.match(html, /• Was Sam with you all day\?<br><span[^>]*>asked you in chat \(waiting on your answer\)/); // lang-regex-ok: HTML our own CLI rendered
  } finally { s.done(); }
});

test("the closing section lists fixes from the log and what the FINAL review still flags, in plain words", () => {
  const s = sandbox();
  try {
    s.run("log", D, "--finding", "Your time at the flat was split into four stops", "--action", "merged the back-to-back stays in the day builder", "--outcome", "code-landed", "--commit", "abc123");
    s.run("log", D, "--finding", "Dinner at Falafel Example was shown as Café Example", "--action", "named the evening stop with your words", "--outcome", "data-corrected");
    fs.writeFileSync(path.join(s.dir, `ds-review-${D}.json`), JSON.stringify({ independent_review: "ok", repairs: [], findings: [
      { severity: "high", headline: "August had no companions listed", detail: "s-3 header companions empty while ..." },
      { severity: "low", headline: "polish", detail: "x" },
      { severity: "medium", review_hole: true, detail: "the opus review did not run" },
    ] }));
    const html = s.run("section", D).stdout;
    assert.match(html, /What the review caught/);
    assert.match(html, /✓ Your time at the flat was split into four stops<br><span[^>]*>merged the back-to-back stays in the day builder \(fixed in the code, and the day was rebuilt\)/);
    assert.match(html, /✓ Dinner at Falafel Example was shown as Café Example/);
    assert.match(html, /• August had no companions listed<br><span[^>]*>still open/);
    assert.doesNotMatch(html, /polish|s-3 header|did not run/, "no low items, no internal detail, no review hole as a defect");
  } finally { s.done(); }
});

test("section --into inserts once before </body>, replaces itself on re-run, and a clean day inserts nothing", () => {
  const s = sandbox();
  try {
    const html = path.join(s.dir, "report.html");
    fs.writeFileSync(html, "<html><body><h1>Day</h1></body></html>");
    fs.writeFileSync(path.join(s.dir, `ds-review-${D}.json`), JSON.stringify({ findings: [] }));
    s.run("section", D, "--into", html);
    assert.equal(fs.readFileSync(html, "utf8"), "<html><body><h1>Day</h1></body></html>", "clean day: no section");
    s.run("log", D, "--finding", "A closed task was listed twice", "--action", "removed the duplicate", "--outcome", "fixed");
    s.run("section", D, "--into", html);
    s.run("section", D, "--into", html);
    const doc = fs.readFileSync(html, "utf8");
    assert.equal(doc.split("What the review caught").length - 1, 1, "inserted once, replaced on re-run");
    assert.ok(doc.indexOf("What the review caught") < doc.indexOf("</body>"));
  } finally { s.done(); }
});

test("gave_up files the unresolved findings to the system channel; confirmed files nothing", () => {
  const s = sandbox();
  try {
    s.run("log", D, "--finding", "The evening stop's companions are missing", "--action", "no evidence in his messages", "--outcome", "unresolved");
    s.run("done", D, "--status", "confirmed");
    assert.equal(s.sends().length, 0);
    s.run("done", D, "--status", "gave_up");
    assert.equal(s.sends().length, 1);
    assert.match(s.sends()[0], /--channel system --skip-precheck --intent daily-summary-fix ⚠️ daily-summary-fix: 1 defect/);
  } finally { s.done(); }
});

// Regression guard for the system-channel alert "⚠️ daily-summary-fix: N defect(s) in
// the <date> report it could not fix — the spine or prep needs work." The log is
// append-only and the playbook logs a fix waiting on a Face-ID card as `unresolved`,
// so a card signed before the close, or a finding a later entry fixed, was still
// paged as "could not fix". The fixer names what is truly still open with --still-open.
const ALERT = "defect(s) in the 2099-01-02 report it could not fix";
function threeUnresolved(s) {
  s.run("log", D, "--finding", "The lunch stop was split in two", "--action", "a Face-ID card for the merge rule", "--outcome", "unresolved");
  s.run("log", D, "--finding", "The evening stop's companions are missing", "--action", "no evidence in the records", "--outcome", "unresolved");
  s.run("log", D, "--finding", "A closed task was listed twice", "--action", "first attempt failed", "--outcome", "unresolved");
  s.run("log", D, "--finding", "A closed task was listed twice", "--action", "removed the duplicate on the second try", "--outcome", "fixed");
}

test(`gave_up --still-open pages only the named entries (alert: "${ALERT}")`, () => {
  const s = sandbox();
  try {
    threeUnresolved(s);
    assert.equal(s.run("log", D, "--finding", "x", "--action", "y", "--outcome", "fixed").stdout.trim(), "logged (log index 4)", "log prints the index --still-open takes");
    const r = s.run("done", D, "--status", "gave_up", "--still-open", "1", "--note", "only the companions are still open");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.sends().length, 1);
    const page = s.sends()[0];
    assert.ok(page.includes(`⚠️ daily-summary-fix: 1 ${ALERT}`), page);
    assert.ok(page.includes("The evening stop's companions are missing"));
    assert.ok(!page.includes("split in two") && !page.includes("listed twice"), "the card and the later fix are not paged");
    assert.equal(s.state().status, "gave_up");
    assert.deepEqual(s.state().still_open, [1]);
  } finally { s.done(); }
});

test("gave_up --still-open with an explicitly empty list pages nothing", () => {
  for (const empty of ["none", ""]) {
    const s = sandbox();
    try {
      threeUnresolved(s);
      const r = s.run("done", D, "--status", "gave_up", "--still-open", empty);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(s.sends().length, 0, `--still-open ${JSON.stringify(empty)} sends nothing`);
      assert.equal(s.state().status, "gave_up");
      assert.deepEqual(s.state().still_open, []);
    } finally { s.done(); }
  }
});

test("gave_up --still-open with an index the log does not have is refused: nothing sent, nothing closed", () => {
  for (const bad of ["9", "1,9", "one", "-1", "1,,2"]) {
    const s = sandbox();
    try {
      threeUnresolved(s);
      const r = s.run("done", D, "--status", "gave_up", "--still-open", bad);
      assert.equal(r.status, 64, `--still-open ${bad} is a usage error`);
      assert.match(r.stderr, /--still-open/); // lang-regex-ok: our own CLI's usage error
      assert.equal(s.sends().length, 0);
      assert.notEqual(s.state().status, "gave_up", "the day is not marked done");
      assert.equal(s.state().closed_at, undefined);
    } finally { s.done(); }
  }
  const s = sandbox();
  try {
    threeUnresolved(s);
    assert.equal(s.run("done", D, "--status", "gave_up", "--still-open").status, 64, "a flag with no value is refused");
    assert.equal(s.sends().length, 0);
  } finally { s.done(); }
});

test(`gave_up without --still-open still pages every unresolved entry (alert: "${ALERT}")`, () => {
  const s = sandbox();
  try {
    threeUnresolved(s);
    assert.equal(s.run("done", D, "--status", "gave_up").status, 0);
    assert.equal(s.sends().length, 1);
    const page = s.sends()[0];
    assert.ok(page.includes(`⚠️ daily-summary-fix: 3 ${ALERT}`), page);
    for (const f of ["split in two", "companions are missing", "listed twice"]) assert.ok(page.includes(f), f);
    assert.equal(s.state().still_open, undefined);
  } finally { s.done(); }
});

test("mark-sent records first sends and corrections; bad arguments are refused", () => {
  const s = sandbox();
  try {
    s.run("mark-sent", D); s.run("mark-sent", D, "--corrected");
    assert.deepEqual(s.state().sends.map((x) => x.corrected), [false, true]);
    assert.equal(s.run("log", D, "--finding", "x", "--action", "y", "--outcome", "maybe").status, 64);
    assert.equal(s.run("request", "friday").status, 64);
  } finally { s.done(); }
});

// The closing section is built from the append-only fix log. A finding logged
// `unresolved` and fixed by a later run, or a question whose answer a later entry
// applied, used to read "not fixed yet" / "waiting on your answer" beside the
// entry that settled it; and the 15-item cap kept the oldest entries.
test("section --settled leaves out entries a later entry settled; unlisted open ones stay", () => {
  const s = sandbox();
  try {
    s.run("log", D, "--finding", "The header's miles walked didn't match the walks", "--action", "left for a code fix", "--outcome", "unresolved");
    s.run("log", D, "--finding", "A pause was hidden inside the walk home", "--action", "asked you in chat", "--outcome", "asked");
    s.run("log", D, "--finding", "The header's miles walked didn't match the walks listed under it", "--action", "the header now sums the listed walks", "--outcome", "code-landed", "--commit", "abc123");
    s.run("log", D, "--finding", "The walk home read as 20 minutes for 0.1 miles", "--action", "used your answer", "--outcome", "data-corrected");
    s.run("log", D, "--finding", "The overnight stay was named after the café next door", "--action", "left for the system review", "--outcome", "unresolved");
    fs.writeFileSync(path.join(s.dir, `ds-review-${D}.json`), JSON.stringify({ findings: [] }));
    const html = s.run("section", D, "--settled", "0,1").stdout;
    assert.doesNotMatch(html, /didn't match the walks<br>/, "the settled unresolved entry is gone"); // lang-regex-ok: HTML our own CLI rendered
    assert.doesNotMatch(html, /A pause was hidden/, "the settled question is gone"); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /✓ The header's miles walked didn't match the walks listed under it/); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /• The overnight stay was named after the café next door<br><span[^>]*>left for the system review \(not fixed yet\)/); // lang-regex-ok: HTML our own CLI rendered
    const again = s.run("section", D).stdout;
    assert.doesNotMatch(again, /A pause was hidden/, "a later render without --settled keeps the fixer's list (the send step renders again)"); // lang-regex-ok: HTML our own CLI rendered
    assert.deepEqual(s.state().settled, [0, 1]);
    s.run("section", D, "--settled", "none");
    assert.match(s.run("section", D).stdout, /• The header's miles walked didn't match the walks<br>/, "with an empty list every entry shows as logged"); // lang-regex-ok: HTML our own CLI rendered
  } finally { s.done(); }
});

test("section --settled refuses an index the log does not have, and only drops unresolved/asked entries", () => {
  const s = sandbox();
  try {
    s.run("log", D, "--finding", "Dinner was shown as the café", "--action", "named it with your words", "--outcome", "data-corrected");
    const bad = s.run("section", D, "--settled", "4");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /--settled: no log entry 4/); // lang-regex-ok: our own CLI's error text
    assert.match(s.run("section", D, "--settled", "0").stdout, /✓ Dinner was shown as the café/, "a done entry is never hidden by --settled"); // lang-regex-ok: HTML our own CLI rendered
  } finally { s.done(); }
});

test("over the 15-item cap the section keeps every open item and the newest fixes, and says how many it left out", () => {
  const s = sandbox();
  try {
    for (let i = 1; i <= 18; i++) s.run("log", D, "--finding", `fixed item ${String(i).padStart(2, "0")}`, "--action", "done", "--outcome", "data-corrected");
    s.run("log", D, "--finding", "still open item A", "--action", "left for the system review", "--outcome", "unresolved");
    s.run("log", D, "--finding", "still open item B", "--action", "left for the system review", "--outcome", "unresolved");
    fs.writeFileSync(path.join(s.dir, `ds-review-${D}.json`), JSON.stringify({ findings: [] }));
    const html = s.run("section", D).stdout;
    const lis = html.split("<li").length - 1;
    assert.equal(lis, 16, "15 items plus the 'and N earlier' line");
    assert.match(html, /still open item A/); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /still open item B/); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /fixed item 18/, "the newest fix is kept"); // lang-regex-ok: HTML our own CLI rendered
    assert.doesNotMatch(html, /fixed item 0[1-5]</, "the five oldest fixes are the ones dropped"); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /fixed item 06/); // lang-regex-ok: HTML our own CLI rendered
    assert.match(html, /…and 5 earlier fixes not listed here/); // lang-regex-ok: HTML our own CLI rendered
  } finally { s.done(); }
});

// the user, 2026-10-21, after a question about the day before reached the user at 4:37am:
// "Why wait until 4:37am to ask this?" ... "Create an improvement to ask in time."
// The summary is built in the user's small hours and asked as soon as it was written; from
// Oct 22 to Oct 27 eight more questions reached the user between 4 and 5am, Jerusalem time.
// A question composed in the user's quiet hours is held. The hourly sweep (cron) only marks
// it due once the user is up; the launchd runner sends it (`release-held`), because from
// cron the outbound check's model step cannot sign in and it would go out unchecked.
// The email waits for it. Monday Oct 26's two came at 04:19 on Tuesday (Jerusalem is
// UTC+2 after Oct 25).
const OCT26 = "2026-10-26";
const QUIET = { start: "01:00", end: "09:00", awake_from: "07:00" };
const releaseQueued = (s) => fs.existsSync(path.join(s.dir, "state", "queue", "release-held"));

test("a question composed at 4:19am his time is held; the cron sweep never sends it; launchd asks it once he is up, and the email waits", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    const r = s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "held (question 1): inside his quiet hours; asked once he is up, 9am at the latest; the email waits until 12pm or his answers");
    s.at("2026-10-27T02:19:29Z")("ask", OCT26, "--question", "Was the 6:10 stop just the car?");
    assert.equal(s.sends().length, 0, "nothing reaches him at 4:19am");
    let st = s.state(OCT26);
    assert.deepEqual(st.questions.map((q) => q.held_until), ["2026-10-27T07:00:00.000Z", "2026-10-27T07:00:00.000Z"], "9am in Jerusalem");
    assert.equal(st.status, "awaiting_user");
    assert.equal(st.hold.until, "2026-10-27T10:00:00.000Z", "a provisional window so the email waits");
    assert.equal(st.log[0].action, "saved to ask you once you're up, not overnight");

    // "Where's my summary?" (the chat agent's peek): held, and not a question the user owes an answer to.
    const g = s.at("2026-10-27T02:30:00Z")("gate", OCT26, "--peek");
    assert.equal(g.status, 3);
    const v = JSON.parse(g.stdout);
    assert.equal(v.reason, "waiting_to_ask");
    assert.deepEqual(v.open, [], "nothing he has been asked");
    assert.deepEqual(v.held_not_asked.map((q) => [q.n, q.status, q.held_until]), [[1, "held, not yet asked", "2026-10-27T07:00:00.000Z"], [2, "held, not yet asked", "2026-10-27T07:00:00.000Z"]]);

    // Through the night and the early morning: nothing sent, queued, chased or given up.
    for (const t of ["2026-10-27T02:52:00Z", "2026-10-27T03:52:00Z", "2026-10-27T04:52:00Z", "2026-10-27T05:52:00Z", "2026-10-27T06:52:00Z"]) {
      assert.equal(s.at(t)("sweep").stdout.trim(), "re-queued 0", t);
    }
    assert.equal(releaseQueued(s), false);
    assert.equal(s.queued(OCT26), false);
    assert.equal(s.state(OCT26).status, "awaiting_user");

    // 9:52, the first sweep after 9am (cron): marks the day due and wakes launchd. It sends nothing.
    const sw = s.at("2026-10-27T07:52:02Z")("sweep");
    assert.equal(sw.stdout.trim(), "held questions: 1 day(s) due to ask (queued for launchd), 0 dropped\nre-queued 0");
    assert.equal(s.sends().length, 0, "the cron sweep never sends a question");
    assert.equal(releaseQueued(s), true);
    assert.equal(s.state(OCT26).release_due_at, "2026-10-27T07:52:02.000Z");

    // The launchd runner, 38 seconds later: both go; the first buzzes and says how long the email waits.
    const rel = s.at("2026-10-27T07:52:40Z")("release-held");
    assert.equal(rel.status, 0, rel.stderr);
    assert.equal(rel.stdout.trim().split("\n").at(-1), "released 2, dropped 0");
    const [first, second] = s.sends();
    assert.ok(first.includes("--evidence-as-of 2026-10-27T02:19:18.000Z 📝 Fixing your Monday, October 26 summary: Was Sam with you at dinner? (I'm holding the summary until you answer, or until 12:52pm at the latest.)"), first);
    assert.ok(!first.includes("--no-push"), "the first buzzes his phone");
    assert.ok(second.startsWith("--no-push ") && second.endsWith("📝 Fixing your Monday, October 26 summary: Was the 6:10 stop just the car?"), second);
    st = s.state(OCT26);
    assert.equal(st.hold.until, "2026-10-27T10:52:00.000Z", "three hours, from the minute of the sweep that marked it due");
    assert.equal(st.hold.label, "12:52pm");
    assert.deepEqual(st.questions.map((q) => q.sent_at), ["2026-10-27T07:52:40.000Z", "2026-10-27T07:52:40.000Z"]);
    assert.equal(st.log[0].action, "asked you in chat");
    assert.equal(st.release_due_at, undefined);
    const peek = JSON.parse(s.at("2026-10-27T08:00:00Z")("gate", OCT26, "--peek").stdout);
    assert.equal(peek.reason, "waiting_on_answers");
    assert.deepEqual(peek.open.map((q) => q.n), [1, 2]);
    assert.deepEqual(peek.held_not_asked, []);

    // The window ends on a sweep tick, so the 12:52 sweep starts the fixer (not the 1:52 one).
    assert.equal(s.at("2026-10-27T08:52:00Z")("sweep").stdout.trim(), "re-queued 0", "inside his window");
    assert.equal(s.at("2026-10-27T10:52:00Z")("sweep").stdout.trim(), "re-queued 1");
    const closed = s.at("2026-10-27T10:52:30Z")("gate", OCT26);
    assert.equal(closed.status, 0);
    assert.equal(JSON.parse(closed.stdout).reason, "window_closed");
    assert.equal(s.sends().length, 2, "asked once");
  } finally { s.done(); }
});

test("a question composed at 10am his time goes at once", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    const r = s.at("2026-10-27T08:00:00Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    assert.equal(r.stdout.trim(), "asked (question 1); the email waits until 1pm or his answers");
    assert.equal(s.sends().length, 1);
    assert.ok(s.sends()[0].includes("--evidence-as-of live 📝 Fixing your Monday, October 26 summary: Was Sam with you at dinner? (I'm holding the summary until you answer, or until 1pm at the latest.)"), s.sends()[0]);
    assert.equal(s.state(OCT26).questions[0].held_until, undefined);
  } finally { s.done(); }
});

test("his quiet hours are read in his current zone, so they follow him when he travels", () => {
  // 02:19 UTC is 4:19am in Jerusalem and 10:19pm the evening before in home;
  // 08:19 UTC is 10:19am in Jerusalem and 4:19am in home (EDT).
  for (const [tz, iso, heldUntil] of [
    ["Asia/Jerusalem", "2026-10-27T02:19:00Z", "2026-10-27T07:00:00.000Z"],
    ["America/New_York", "2026-10-27T02:19:00Z", undefined],
    ["Asia/Jerusalem", "2026-10-27T08:19:00Z", undefined],
    ["America/New_York", "2026-10-27T08:19:00Z", "2026-10-27T13:00:00.000Z"],
  ]) {
    const s = sandbox({ quiet: QUIET });
    try {
      assert.equal(s.at(iso, tz)("ask", OCT26, "--question", "Was Sam with you at dinner?").status, 0);
      assert.equal(s.sends().length, heldUntil ? 0 : 1, `${tz} at ${iso}`);
      assert.equal(s.state(OCT26).questions[0].held_until, heldUntil, `${tz} at ${iso}`);
    } finally { s.done(); }
  }
  // The sweep reads the user's zone when it runs: in home 12:52 UTC is 8:52am (still quiet), 13:52 is 9:52am.
  const s = sandbox({ quiet: QUIET });
  try {
    const ny = (iso) => s.at(iso, "America/New_York");
    ny("2026-10-27T08:19:00Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    assert.equal(ny("2026-10-27T12:52:00Z")("sweep").stdout.trim(), "re-queued 0");
    assert.match(ny("2026-10-27T13:52:00Z")("sweep").stdout, /1 day\(s\) due to ask/); // lang-regex-ok: our own CLI's output
    ny("2026-10-27T13:52:30Z")("release-held");
    assert.equal(s.sends().length, 1);
    assert.ok(s.sends()[0].endsWith("or until 12:52pm at the latest.)"), s.sends()[0]);
  } finally { s.done(); }
});

test("he is up when his phone says so (the sleep-night reading hum uses), else when he has written in chat; never before 7am", () => {
  for (const [why, phone, lastMsg, sweepAt, due] of [
    ["phone locked since bed", { inBed: true }, "", "2026-10-27T05:52:00Z", false],
    ["the night's first unlock 20 minutes ago", { upMinAgo: 20 }, "", "2026-10-27T05:52:00Z", true],
    ["the phone is up, but it is 6:52am", { upMinAgo: 20 }, "", "2026-10-27T04:52:00Z", false],
    ["no fresh phone reading; he wrote at 7:26am", { upMinAgo: 20, writtenMinAgo: 30 }, "2026-10-27T05:26:00Z", "2026-10-27T05:52:00Z", true],
    ["no fresh phone reading; he last wrote at 6:30am", { writtenMinAgo: 30 }, "2026-10-27T04:30:00Z", "2026-10-27T05:52:00Z", false],
    ["no phone reading at all; he wrote at 7:26am", null, "2026-10-27T05:26:00Z", "2026-10-27T05:52:00Z", true],
  ]) {
    const s = sandbox({ quiet: QUIET });
    try {
      s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
      if (phone) s.sleep(phone);
      s.at(sweepAt, "Asia/Jerusalem", { DS_FIX_LAST_USER_MSG: lastMsg })("sweep");
      assert.equal(releaseQueued(s), due, why);
      assert.equal(Boolean(s.state(OCT26).release_due_at), due, why);
      assert.equal(s.sends().length, 0, `${why}: the sweep sends nothing either way`);
    } finally { s.done(); }
  }
  // Once the user is up, a new question goes straight away; a 7:52 release keeps the 11am window.
  const s = sandbox({ quiet: QUIET });
  try {
    s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    s.sleep({ upMinAgo: 20 });
    s.at("2026-10-27T05:52:01Z")("sweep");
    s.at("2026-10-27T05:52:20Z")("release-held");
    assert.ok(s.sends()[0].endsWith("(I'm holding the summary until you answer, or until 11am at the latest.)"), s.sends()[0]);
    s.at("2026-10-27T05:55:00Z")("ask", OCT26, "--question", "Did you walk home?");
    assert.equal(s.sends().length, 2);
    assert.ok(s.sends()[1].startsWith("--no-push ") && s.sends()[1].endsWith("summary: Did you walk home?"), s.sends()[1]);
  } finally { s.done(); }
});

test("a held question he already answered, or whose day closed, is never sent", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    s.at("2026-10-27T02:19:29Z")("ask", OCT26, "--question", "Did you walk home?");
    s.at("2026-10-27T04:50:00Z")("answered", OCT26, "1"); // he brought it up himself; the fixer read it
    assert.equal(s.at("2026-10-27T07:52:00Z")("sweep").stdout.trim(), "held questions: 1 day(s) due to ask (queued for launchd), 1 dropped\nre-queued 0");
    s.at("2026-10-27T07:52:30Z")("release-held");
    assert.equal(s.sends().length, 1);
    assert.ok(s.sends()[0].includes("summary: Did you walk home? (I'm holding the summary"), s.sends()[0]);
    assert.equal(s.state(OCT26).questions[0].dropped_why, "he answered it");
    s.at("2026-10-28T02:10:00Z")("ask", "2026-10-27", "--question", "Was that the bakery?");
    s.at("2026-10-28T03:00:00Z")("done", "2026-10-27", "--status", "confirmed");
    s.at("2026-10-28T07:52:00Z")("sweep");
    s.at("2026-10-28T07:52:30Z")("release-held");
    assert.equal(s.sends().length, 1);
    assert.equal(s.state("2026-10-27").questions[0].dropped_why, "the day was closed");
  } finally { s.done(); }
});

test("a held question the outbound check holds back at release is dropped, and the day, with nothing left open, is sent", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was the 1:36 stop the car park? [held]");
    assert.equal(s.at("2026-10-27T02:25:00Z")("gate", OCT26).status, 3);
    s.at("2026-10-27T07:52:00Z")("sweep");
    const rel = s.at("2026-10-27T07:52:30Z")("release-held");
    assert.equal(rel.stdout.trim().split("\n").at(-1), "released 0, dropped 1");
    const st = s.state(OCT26);
    assert.equal(st.questions[0].dropped_why, "the outbound check held it back");
    assert.equal(st.held_back.length, 1);
    assert.equal(st.status, "queued");
    assert.equal(s.queued(OCT26), true, "the fixer is started to send it");
    assert.equal(s.at("2026-10-27T07:53:00Z")("gate", OCT26).status, 0);
    fs.writeFileSync(path.join(s.dir, `ds-review-${OCT26}.json`), JSON.stringify({ findings: [] }));
    assert.ok(!s.run("section", OCT26).stdout.includes("car park"), "not listed as waiting on him");
  } finally { s.done(); }
});

test("release-held saves after each send: an answer that lands mid-batch is kept, and a failed send is logged and retried", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    // The first send "lands the user's answer" while the batch is still going (the sender stub
    // runs the chat agent's `request --answer` itself); the second send fails.
    const stub = path.join(s.dir, "send");
    fs.writeFileSync(stub, fs.readFileSync(stub, "utf8").replace("#!/bin/sh\n",
      `#!/bin/sh\ncase "$*" in *"[answer-now]"*) "${process.execPath}" "${BIN}" request ${OCT26} --answer "yes, she was" --no-kick >/dev/null ;; esac\n`));
    s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner? [answer-now]");
    s.at("2026-10-27T02:19:20Z")("ask", OCT26, "--question", "Did you walk home? [fail]");
    s.at("2026-10-27T02:19:22Z")("ask", OCT26, "--question", "Was the 6:10 stop just the car?");
    s.at("2026-10-27T07:52:00Z")("sweep");
    const rel = s.at("2026-10-27T07:52:30Z")("release-held");
    assert.equal(rel.status, 1);
    assert.ok(rel.stderr.includes(`release-held ${OCT26} question 2: send failed (exit 1)`), rel.stderr);
    let st = s.state(OCT26);
    assert.deepEqual(st.answers.map((a) => a.text), ["yes, she was"], "his answer, saved mid-batch, is not overwritten");
    assert.equal(st.questions[0].sent_at, "2026-10-27T07:52:30.000Z", "what went out is saved");
    assert.equal(st.questions[1].sent_at, undefined);
    assert.equal(st.questions[2].sent_at, undefined, "the rest wait");
    assert.equal(st.release_error.n, 2);
    assert.equal(st.hold.until, "2026-10-27T10:52:00.000Z", "the window opened with the first question");
    // The next sweep marks the day due again.
    fs.rmSync(path.join(s.dir, "state", "queue"), { recursive: true, force: true });
    s.at("2026-10-27T08:52:00Z")("sweep");
    assert.equal(releaseQueued(s), true);
    assert.equal(s.state(OCT26).release_due_at, "2026-10-27T08:52:00.000Z");
  } finally { s.done(); }
});

test("after the send, a question composed overnight is held too, and holds the correction from when it reaches him", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    s.at("2026-10-26T15:00:00Z")("mark-sent", "2026-10-25");
    s.at("2026-10-27T02:19:18Z")("ask", "2026-10-25", "--question", "Was the bakery stop on Sunday Lehamim?");
    assert.equal(s.sends().length, 0);
    assert.equal(s.at("2026-10-27T03:00:00Z")("gate", "2026-10-25").status, 3, "the correction waits for it");
    s.at("2026-10-27T07:52:00Z")("sweep");
    s.at("2026-10-27T07:52:30Z")("release-held");
    assert.equal(s.sends().length, 1);
    assert.ok(s.sends()[0].endsWith("(This one only came up after I'd sent the summary.)"), s.sends()[0]);
    assert.equal(s.state("2026-10-25").correction_hold.until, "2026-10-27T10:52:00.000Z");
  } finally { s.done(); }
});

test("'just send it' while a question is held: the email goes now, and the question follows once he is up, saying so", () => {
  const s = sandbox({ quiet: QUIET });
  try {
    s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
    s.at("2026-10-27T04:30:00Z")("release", OCT26); // 6:30am: he asked for it
    assert.equal(s.at("2026-10-27T04:31:00Z")("gate", OCT26).status, 0);
    s.unqueue(OCT26);
    s.at("2026-10-27T04:40:00Z")("mark-sent", OCT26);
    // The user wrote before 7am and the question has not reached the user: nothing is chased.
    assert.equal(s.at("2026-10-27T05:52:00Z", "Asia/Jerusalem", { DS_FIX_LAST_USER_MSG: "2026-10-27T04:35:00Z" })("sweep").stdout.trim(), "re-queued 0");
    assert.equal(s.queued(OCT26), false);
    s.at("2026-10-27T07:52:00Z")("sweep");
    s.at("2026-10-27T07:52:30Z")("release-held");
    assert.equal(s.sends().length, 1);
    assert.ok(s.sends()[0].endsWith("summary: Was Sam with you at dinner? (Your summary already went out; I'll correct it if your answer changes anything.)"), s.sends()[0]);
    assert.equal(s.state(OCT26).hold.until, "2026-10-27T04:30:00.000Z", "his word closed the window; it is not reopened");
  } finally { s.done(); }
});

test("no quiet hours configured (or a malformed block): nothing is held", () => {
  for (const quiet of [null, { start: "1am", end: "9am" }]) {
    const s = sandbox({ quiet });
    try {
      s.at("2026-10-27T02:19:18Z")("ask", OCT26, "--question", "Was Sam with you at dinner?");
      assert.equal(s.sends().length, 1, JSON.stringify(quiet));
    } finally { s.done(); }
  }
});

// The launchd runner: the only place a held question is sent, and only after the
// same Max sign-in check the fork runner makes. Run on a copy of the trigger with a
// stub `claude` (auth status only), a stub sender, and a stub fork runner that must
// never start for a release.
const TRIGGER = path.resolve(import.meta.dirname, "..", "agent", "scripts", "trigger-daily-summary-fix.sh");
const GUARD = path.resolve(import.meta.dirname, "..", "agent", "scripts", "lib", "max-auth-guard.sh");

test("the launchd runner sends held questions only after the Max sign-in check, and starts no fixer for a release", () => {
  for (const signedIn of [true, false]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsfix-trigger-"));
    try {
      const root = path.join(home, "Dev", "jori");
      const scripts = path.join(home, "scripts");
      fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
      fs.copyFileSync(TRIGGER, path.join(scripts, "trigger-daily-summary-fix.sh"));
      fs.copyFileSync(GUARD, path.join(scripts, "lib", "max-auth-guard.sh"));
      fs.copyFileSync(path.join(path.dirname(GUARD), "root.sh"), path.join(scripts, "lib", "root.sh"));
      fs.writeFileSync(path.join(scripts, "lib", "run-ephemeral-opus.sh"), `#!/bin/sh\necho "$*" >> ${home}/fork.log\n`, { mode: 0o755 });
      fs.mkdirSync(path.join(root, "bin"), { recursive: true });
      fs.symlinkSync(BIN, path.join(root, "bin", "daily-summary-fix"));
      const status = signedIn ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" } : { loggedIn: false, authMethod: "none" };
      fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      fs.writeFileSync(path.join(home, ".local", "bin", "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 });
      fs.mkdirSync(path.join(home, "local", "config"), { recursive: true });
      fs.writeFileSync(path.join(home, "local", "config", "daily-summary-fix.json"), JSON.stringify({ quiet_hours: QUIET }));
      const sent = path.join(home, "sent.log");
      fs.writeFileSync(path.join(home, "send"), `#!/bin/sh\nprintf '%s\\n---\\n' "$*" >> ${sent}\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: home, JORI_ROOT: root, JORI_LOCAL_DIR: path.join(home, "local"), DS_FIX_SEND_BIN: path.join(home, "send"), DS_FIX_TZ: "Asia/Jerusalem", DS_FIX_LAST_USER_MSG: "" };
      delete env.DS_FIX_DIR; delete env.CLAUDE_BIN;
      const cli = (iso, ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...env, DS_FIX_NOW: iso } });
      const sends = () => (fs.existsSync(sent) ? fs.readFileSync(sent, "utf8").split("\n---\n").filter(Boolean) : []);
      const queue = path.join(root, "data", "daily-summary-fix", "queue");

      cli("2026-10-27T02:19:18Z", "ask", OCT26, "--question", "Was Sam with you at dinner?");
      cli("2026-10-27T07:52:02Z", "sweep");
      assert.equal(sends().length, 0, "the cron sweep sends nothing");
      assert.ok(fs.existsSync(path.join(queue, "release-held")));

      const r = spawnSync("/bin/bash", [path.join(scripts, "trigger-daily-summary-fix.sh")], { encoding: "utf8", env: { ...env, DS_FIX_NOW: "2026-10-27T07:52:40Z" }, timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!fs.existsSync(path.join(queue, "release-held")), "the marker is consumed either way, so launchd does not loop");
      assert.ok(!fs.existsSync(path.join(home, "fork.log")), "a release starts no fixer run");
      const st = JSON.parse(fs.readFileSync(path.join(root, "data", "daily-summary-fix", `${OCT26}.json`), "utf8"));
      const log = fs.readFileSync(path.join(root, "agent", "logs", "daily-summary-fix.log"), "utf8");
      if (signedIn) {
        assert.equal(sends().length, 1, "sent from the launchd runner");
        assert.equal(st.questions[0].sent_at, "2026-10-27T07:52:40.000Z");
        assert.ok(log.includes("released 1, dropped 0"), log);
      } else {
        assert.equal(sends().length, 0, "signed out: nothing goes out unchecked");
        assert.equal(st.questions[0].sent_at, undefined);
        assert.ok(st.release_due_at, "still due: the next sweep queues it again");
        assert.ok(log.includes("release-held: not run, the Max sign-in check failed (loggedIn=false"), log);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
