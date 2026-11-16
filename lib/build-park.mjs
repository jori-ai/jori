// build-park — a chat build that needs one answer from the user stops, keeps its
// session, asks on a card, and the SAME session resumes with the answer.
//
// Before: a build that hit a question only the user could answer built nothing
// and asked in its report; the user's reply started a fresh build that re-read
// everything from scratch. Now (the "deferred tool call" pattern of an
// always-on agent, done with the pieces Jori already has):
//
//   1. ask     the build runs `build-park ask --id <id> --question … --option …`
//              and ends its turn (writes data/build-queue/asks/<id>.json).
//   2. park    after the run, trigger-chat-build.sh sees the ask, and with the
//              run's session id (JORI_FORK_SESSION_OUT) calls `build-park park`:
//              the request moves to parked/<id>.json and a card goes to chat
//              (choices kind "build-park", ref <id>).
//   3. answer  a tap is filed in code (lib/choice-reply.mjs handler
//              "build-park"); a typed reply reaches the chat agent with a hint
//              to run `build-park answer --id <id> --text "<their words>"`.
//              Either way the request goes back to pending/<id>.json carrying
//              `resume: {session_id, question, answer, round}`; launchd
//              (QueueDirectories) starts the trigger.
//   4. resume  the trigger runs the playbook's session again
//              (JORI_FORK_RESUME), with only the answer and a "re-check what
//              moved while you waited" instruction as the new message.
//
// Limits: 3 asks per build (then the build decides conservatively, Critical
// rule 6); a parked build older than PARK_TTL_DAYS resumes as a FRESH build
// (the request plus the question and answer), since its session may be gone
// and the tree has moved; a parked build nobody answers is swept to failed/
// after SWEEP_DAYS. Nothing here reads what the user meant (Rule #0b): a tap is
// our own label, a typed answer is passed on as the user's words.
// Design: docs/chat-build-park.md.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { renderQuestionChoices } from "./decision-queue.mjs";

const require = createRequire(import.meta.url);
const { installRoot, installTools } = require("./root.cjs");

export const MAX_ROUNDS = 3;
export const PARK_TTL_DAYS = 5;
export const SWEEP_DAYS = 30;
export const KIND = "build-park";

export function queueDir(root = installRoot()) {
  return path.join(root, "data", "build-queue");
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, f);
}
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id); // lang-regex-ok: request id syntax

/** Step 1, inside the build: record the question. Throws on bad input. */
export function ask({ id, question, options, recommended = null, context = "" }, { q = queueDir(), now = Date.now() } = {}) {
  if (!validId(id)) throw new Error("--id must be this build's request id ($JORI_CHAT_BUILD_REQUEST)");
  const running = readJson(path.join(q, "running", `${id}.json`));
  if (!running) throw new Error(`no running build ${id}: only the chat build that is running can park`);
  const round = (running.resume?.round || 0) + 1;
  if (round > MAX_ROUNDS) throw new Error(`this build already asked ${MAX_ROUNDS} times: decide conservatively and say so in the report (Critical rule 6)`);
  // Validate exactly as the card will be built, so a bad ask fails in the run, not after it.
  renderQuestionChoices({ question, options, recommended, header: "Build question", now });
  const rec = { id, question: String(question).trim(), options: options.map(String), recommended, context: String(context || "").trim().slice(0, 600), round, asked_at: new Date(now).toISOString() };
  writeJson(path.join(q, "asks", `${id}.json`), rec);
  return rec;
}

/** A few words of the request, the way the user asked for it. */
export function label(request) {
  const s = String(request?.spec || "").replace(/\s+/g, " ").trim(); // lang-regex-ok: whitespace collapsing for display, decides nothing
  return s.length > 70 ? `${s.slice(0, 70)}…` : s || "a request";
}

/** The card for a parked build: { choices, text }. */
export function card(rec, request, { now = Date.now() } = {}) {
  const expiresAt = new Date(now + PARK_TTL_DAYS * 86400e3).toISOString();
  const { choices, text } = renderQuestionChoices({
    question: rec.question, options: rec.options, recommended: rec.recommended,
    header: "Build question", expiresAt, now,
  });
  choices.kind = KIND;
  choices.ref = rec.id;
  const lead = `🛠️ The build you asked for (${label(request)}) needs one answer from you before I go on.${rec.context ? ` ${rec.context}` : ""}`;
  return { choices, text: `${lead}\n\n${text}` };
}

function defaultSend({ choices, text }) {
  const cap = path.join(queueDir(), "asks", `.send-${process.pid}-${Date.now()}`);
  const r = spawnSync(installTools("bin/jori-send-curl"), [
    "--agent", "ops", "--channel", "chat", "--intent", "chat-build-result", "--evidence-as-of", "live",
    "--choices-json", JSON.stringify(choices), "--capture-id", cap, text,
  ], { encoding: "utf8", timeout: 120000 });
  let msgId = null, suppressed = null;
  try {
    const raw = fs.readFileSync(cap, "utf8").trim();
    try { const j = JSON.parse(raw); if (j && typeof j === "object") { suppressed = j.suppressed ? j : null; msgId = j.id || null; } else msgId = String(j); } catch { msgId = raw || null; }
  } catch {}
  try { fs.unlinkSync(cap); } catch {}
  return { ok: r.status === 0 && !suppressed, held: suppressed?.by === "question-hold", msgId, status: r.status };
}

/**
 * Step 2, in the trigger after the run: park the build and send the card.
 * Returns { parked: true, ... } or { parked: false, reason } (the trigger then
 * falls back to the report). A card held by question-hold still parks: the
 * hold re-sends it with the same choices when the user is reading again.
 */
export function park({ id, sessionId }, { q = queueDir(), now = Date.now(), send = defaultSend } = {}) {
  const rec = readJson(path.join(q, "asks", `${id}.json`));
  if (!rec) return { parked: false, reason: "no ask" };
  const request = readJson(path.join(q, "running", `${id}.json`));
  if (!request) return { parked: false, reason: "no running request" };
  if (!sessionId) return { parked: false, reason: "no session id from the run" };
  const c = card(rec, request, { now });
  const sent = send(c);
  if (!sent.ok && !sent.held) return { parked: false, reason: `card not sent (exit ${sent.status})`, question: rec.question };
  const { resume: _prev, ...base } = request;
  writeJson(path.join(q, "parked", `${id}.json`), {
    request: base, session_id: sessionId, question: rec.question, options: rec.options,
    recommended: rec.recommended, context: rec.context, round: rec.round,
    asked_at: rec.asked_at, parked_at: new Date(now).toISOString(),
    card: { prompt_id: c.choices.id, message_id: sent.msgId, held: !!sent.held },
  });
  fs.rmSync(path.join(q, "running", `${id}.json`), { force: true });
  fs.rmSync(path.join(q, "asks", `${id}.json`), { force: true });
  return { parked: true, held: !!sent.held, message_id: sent.msgId };
}

/**
 * Step 3: file the user's answer and put the build back in the queue.
 * `option` is the tapped label (our own string); `text` the user's own words.
 */
export function answer({ id, option = null, text = null }, { q = queueDir(), now = Date.now() } = {}) {
  if (!validId(id)) throw new Error("bad id");
  const f = path.join(q, "parked", `${id}.json`);
  const p = readJson(f);
  if (!p) {
    const queued = ["pending", "held", "running", "done"].some((s) => fs.existsSync(path.join(q, s, `${id}.json`)));
    return { ok: false, already_answered: queued, reason: queued ? "already answered" : "no parked build with that id" };
  }
  const ans = String(option ?? text ?? "").trim();
  if (!ans) throw new Error("give --option or --text");
  if (option != null && !p.options.includes(option)) throw new Error(`"${option}" is not one of the card's options; pass the user's words with --text`);
  const ageDays = (now - Date.parse(p.parked_at || p.asked_at)) / 86400e3;
  const fresh = !(ageDays <= PARK_TTL_DAYS);
  const req = fresh
    ? { ...p.request, spec: `${p.request.spec}\n\nAn earlier run of this build stopped to ask the user: "${p.question}"\nTheir answer: ${ans}`, resumed_fresh: true }
    : { ...p.request, resume: { session_id: p.session_id, question: p.question, answer: ans, answer_kind: option != null ? "option" : "text", round: p.round, asked_at: p.asked_at, answered_at: new Date(now).toISOString() } };
  writeJson(path.join(q, "pending", `${id}.json`), req);
  fs.rmSync(f, { force: true });
  return { ok: true, id, resumed: !fresh, fresh };
}

/** Drop parked builds nobody answered after SWEEP_DAYS (to failed/). */
export function sweep({ q = queueDir(), now = Date.now() } = {}) {
  const dir = path.join(q, "parked");
  const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith(".json")) continue;
    const p = readJson(path.join(dir, name));
    const at = Date.parse(p?.parked_at || p?.asked_at || 0);
    if (p && at && (now - at) / 86400e3 > SWEEP_DAYS) {
      writeJson(path.join(q, "failed", name), { ...p.request, parked_unanswered: p.question });
      fs.rmSync(path.join(dir, name), { force: true });
      out.push(name.replace(/\.json$/, ""));
    }
  }
  return out;
}

/** The new message a resumed build starts with. */
export function resumeTask(id, resume, resultPath) {
  return `The user answered the question you stopped this build (request ${id}) on.
Question: ${resume.question}
Their answer: ${resume.answer}

Time has passed since you asked. Before you change anything, re-check what may have moved: \`git status --porcelain\` against your Step 2 snapshot, the files you planned to touch (others may have committed), and any time-sensitive fact you relied on. Then carry on from where you stopped and finish with the report (Step 6) at ${resultPath}. If you need another answer, park again the same way (at most ${MAX_ROUNDS} questions per build).`;
}
