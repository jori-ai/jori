// What reaches the judge, and what happens to its rewrite (system/speak-gate.md
// § Research, § Nightly audit, § The rewrite check): bin/speak-gate.mjs puts
// data/speak-gate-lessons.json and the newest records into the judge's prompt,
// runs end to end on the shared research lib (lib/speak-gate-agent.mjs), and
// withdraws a rewrite when the rewrite check finds a claim nothing shows. What
// goes out then: the original with only the wrong part cut out, when a model
// reading the judge's truth note says the original states something false and
// a pure deletion checks clean; a proactive message is held only when the
// model says the wrong part is the whole message; every other case (a plain ok
// note, records contradicting the judge, no clean cut, a check that cannot
// run, a reply, a report) sends the original as written. The judge, the check's model, gog and the sent-mail log are
// stand-ins; the database is unreachable (empty keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_RULE, rewriteCheckPrompt, trimPrompt, parseTrim, isPureDeletion, trimOriginal } from "../lib/speak-gate-agent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "sg-lessons-"));
const { MODELS } = createRequire(import.meta.url)(path.join(ROOT, "lib", "models.cjs"));

function fakeClaude() {
  const bin = path.join(dir, "claude");
  const seen = path.join(dir, "prompt.txt");
  writeFileSync(bin, `#!/bin/sh\ncat > ${JSON.stringify(seen)}\necho 'researched.'\necho '{"verdict":"send","checks":{},"sources":["x"],"reason":"fine"}'\n`);
  chmodSync(bin, 0o755);
  return { bin, seen };
}

function gate(env) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify({ message: "Your package arrives today.", kind: "reply", reply_to_text: "when?", as_of: "2026-11-01T12:00:00Z" }),
    encoding: "utf8", timeout: 120000,
    env: { ...process.env, SPEAK_GATE_NO_LOG: "1", ...env },
  });
}

test("lessons from the audit are in the judge's prompt", () => {
  const { bin, seen } = fakeClaude();
  const lessons = path.join(dir, "lessons.json");
  writeFileSync(lessons, JSON.stringify({ lessons: [{ text: "Check the carrier's tracking before saying a package arrives today.", since: "2026-11-14" }] }));
  const r = gate({ SPEAK_GATE_CLAUDE_BIN: bin, SPEAK_GATE_LESSONS: lessons });
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).verdict, "send");
  const p = readFileSync(seen, "utf8");
  assert.match(p, /LESSONS FROM THE NIGHTLY AUDIT/);
  assert.match(p, /carrier's tracking/);
  assert.match(p, /READ-ONLY TOOLS/);
});

test("no lessons file: no lessons section", () => {
  const { bin, seen } = fakeClaude();
  const r = gate({ SPEAK_GATE_CLAUDE_BIN: bin, SPEAK_GATE_LESSONS: path.join(dir, "missing.json") });
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).verdict, "send");
  assert.doesNotMatch(readFileSync(seen, "utf8"), /LESSONS FROM THE NIGHTLY AUDIT/);
});

// ─── The newest records and the rewrite check ──────────────────────────────

const AS_OF = "2026-11-01T12:00:00Z";
let n = 0;
// A stand-in binary: records its model argument and its stdin, prints `out`
// (or, given a function of the model id, what it returns).
function stub(out) {
  const id = `s${++n}`;
  const bin = path.join(dir, `${id}.sh`), seen = path.join(dir, `${id}.prompt`), models = path.join(dir, `${id}.models`);
  const body = typeof out === "function"
    ? `if [ "$3" = ${JSON.stringify(MODELS.haiku)} ]; then printf '%s\\n' ${JSON.stringify(out(MODELS.haiku))}; else printf '%s\\n' ${JSON.stringify(out(MODELS.sonnet))}; fi`
    : out === null ? "exit 1" : `printf '%s\\n' ${JSON.stringify(out)}`;
  writeFileSync(bin, `#!/bin/sh\necho "$3" >> ${JSON.stringify(models)}\ncat > ${JSON.stringify(seen)}\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, seen, prompt: () => readFileSync(seen, "utf8"), models: () => (existsSync(models) ? readFileSync(models, "utf8").trim().split("\n") : []) };
}

const sentLog = path.join(dir, "email-sent.jsonl");
writeFileSync(sentLog, [
  { ts: "2026-10-30T09:00:00.000Z", from_me: true, to: "old@example.com", subject: "Too old to show", text: "x" },
  { ts: "2026-11-01T11:10:00.000Z", from_me: true, to: "contractor@example.com", subject: "Re: Quote for the deck repair", text: "Yes, go ahead with the second option." },
  { ts: "2026-11-01T11:20:00.000Z", from_me: false, to: "someone@example.com", subject: "Not the user's", text: "x" },
  { ts: "2026-11-01T13:00:00.000Z", from_me: true, to: "later@example.com", subject: "After the instant", text: "x" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const gog = path.join(dir, "gog.sh");
writeFileSync(gog, `#!/bin/sh\ncat <<'J'\n${JSON.stringify([
  { summary: "Planning call", status: "confirmed", start: { dateTime: "2026-11-01T15:00:00Z" }, end: { dateTime: "2026-11-01T15:30:00Z" },
    description: "Bring the signed form.", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.example.com/abc-defg" }] } },
  { summary: "Called off", status: "cancelled", start: { dateTime: "2026-11-01T16:00:00Z" }, end: { dateTime: "2026-11-01T17:00:00Z" } },
])}\nJ\n`);
chmodSync(gog, 0o755);

function judgeRewrite(judgeOut, checkOut, extraEnv = {}, input = {}) {
  const judge = stub(judgeOut), check = typeof checkOut === "object" && checkOut && checkOut.bin ? checkOut : stub(checkOut);
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify({ message: "The contractor has not answered about the deck.", kind: "proactive", as_of: AS_OF, ...input }),
    encoding: "utf8", timeout: 120000,
    env: { ...process.env, SPEAK_GATE_NO_LOG: "1", SPEAK_GATE_NO_LESSONS: "1", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_ANON_KEY: "",
      SPEAK_GATE_CLAUDE_BIN: judge.bin, SPEAK_GATE_CHECK_BIN: check.bin, SPEAK_GATE_GOG_BIN: gog, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false",
      SPEAK_GATE_SENT_LOG: sentLog, ...extraEnv },
  });
  return { out: JSON.parse(r.stdout.trim().split("\n").pop()), judge, check };
}

const REWRITE = JSON.stringify({ verdict: "rewrite", message: "You replied to the contractor at 11:10; nothing is waiting on them.",
  checks: { true: "the sent-mail records show a reply at 11:10", self_resolve: "ok", phrasing: "ok", value: "ok" }, sources: ["sent mail"], reason: "the user already replied" });

test("the newest records reach the judge: mail sent in the 24 h before the instant, the calendar with each event's details", () => {
  const { out, judge } = judgeRewrite(JSON.stringify({ verdict: "send", checks: {}, sources: [], reason: "fine" }), "{}");
  assert.equal(out.verdict, "send");
  const p = judge.prompt();
  assert.match(p, /NEWEST RECORDS/);
  assert.match(p, /Quote for the deck repair/);
  assert.match(p, /second option/);
  for (const absent of ["Too old to show", "Not the user's", "After the instant", "Called off"]) assert.ok(!p.includes(absent), `${absent} must not be shown`);
  assert.match(p, /Planning call/);
  assert.match(p, /Bring the signed form/);
  assert.match(p, /meet\.example\.com\/abc-defg/);
  assert.match(p, /gmail get/, "the judge can open an email's body");
});

test("a rewrite the check passes is delivered, and the check saw the original, the rewrite, the findings and the records", () => {
  const { out, check } = judgeRewrite(REWRITE, JSON.stringify({ added: [], contradicted: [] }));
  assert.equal(out.verdict, "rewrite");
  assert.ok(out.message.includes("replied to the contractor"));
  assert.equal(out.rewrite_added_claim, false);
  assert.equal(out.checks.rewrite_check.added_claim, false);
  assert.equal(typeof out.checks.rewrite_check.ms, "number");
  assert.equal(typeof out.evidence_ms, "number");
  const p = check.prompt();
  for (const want of ["has not answered about the deck", "You replied to the contractor", "the sent-mail records show a reply", "Quote for the deck repair"]) assert.ok(p.includes(want), `check prompt missing ${want}`);
});

test("a rewrite that adds a claim nothing shows is withdrawn: when no rung gives a trim, the original is sent and the claim is logged", () => {
  // The judge's truth note is not a plain ok, so the trim is asked; the
  // check's stand-in answers every prompt with the check schema, so the trim
  // is off schema on both rungs: unsure, the original goes out as written.
  const { out } = judgeRewrite(REWRITE, JSON.stringify({ added: ["nothing is waiting on them"], contradicted: [] }));
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.equal(out.original_trimmed, false);
  assert.equal(out.rewrite_added_claim, true);
  assert.deepEqual(out.rewrite_claims, ["nothing is waiting on them"]);
  assert.equal(out.checks.rewrite_check.added_claim, true);
  assert.ok(out.checks.rewrite_check.withdrawn.includes("You replied to the contractor"));
  assert.ok(out.checks.rewrite_check.trim_failed.startsWith("no clean trim"), out.checks.rewrite_check.trim_failed);
  assert.equal(out.checks.true, "the sent-mail records show a reply at 11:10", "the judge's own checks are kept");
  assert.ok(out.reason.startsWith("Rewrite withdrawn, sent as written"), out.reason);
});

test("Haiku off schema climbs to Sonnet, whose contradiction withdraws the rewrite", () => {
  const { out, check } = judgeRewrite(REWRITE, (model) => (model === MODELS.haiku ? "I think it is fine." : JSON.stringify({ added: [], contradicted: ["replied at 11:10 (the log shows 11:10 is a different thread)"] })));
  assert.equal(out.verdict, "send", "the records contradict the judge's text: sent as written");
  assert.equal(out.checks.rewrite_check.trim_skipped, "the records contradicted the judge's own text");
  assert.equal(out.checks.rewrite_check.tier, "sonnet");
  assert.equal(check.models().at(-1), MODELS.sonnet);
  assert.match(out.rewrite_claims[0], /^contradicted: /);
});

test("a check that cannot run sends the original, not the unchecked rewrite", () => {
  const { out, check } = judgeRewrite(REWRITE, null);
  assert.equal(out.verdict, "send");
  assert.equal(out.rewrite_added_claim, null);
  assert.equal(out.checks.rewrite_check.added_claim, null);
  assert.match(out.reason, /could not run/);
  assert.equal(check.models().at(-1), MODELS.sonnet, "the ladder was climbed before giving up");
});

test("checkRewrite: schema, the time limit, and no 1B first rung", async () => {
  const { checkRewrite, parseCheck } = await import("../lib/speak-gate-agent.mjs");
  assert.equal(parseCheck('{"added":"x","contradicted":[]}'), null);
  assert.equal(parseCheck('{"added":[1],"contradicted":[]}'), null);
  assert.deepEqual(parseCheck('ok\n{"added":[" a "],"contradicted":[]}'), { added: ["a"], contradicted: [] });
  let asked = 0;
  const late = await checkRewrite({ original: "a", rewrite: "b", deadline: Date.now() + 2000, ask: async () => { asked++; return "{}"; } });
  assert.equal(late.ran, false);
  assert.equal(asked, 0, "no rung starts without enough time left");
  const tiers = [];
  process.env.LOCAL_LLM_BACKEND = "ollama";
  try {
    const r = await checkRewrite({ original: "a", rewrite: "b", ask: async (tier) => { tiers.push(tier); return '{"added":[],"contradicted":[]}'; } });
    assert.equal(r.ran, true);
    assert.deepEqual(tiers, ["sonnet"]);
  } finally { delete process.env.LOCAL_LLM_BACKEND; }
});

// ─── The trim: a withdrawn rewrite of an original the judge found wrong ─────
//
// A stand-in model that answers by what it is asked: the trim prompt (it says
// DELETE ONLY), else the first matching marker, else a clean check.
function routed(trimOut, routes = [], fallback = JSON.stringify({ added: [], contradicted: [] })) {
  const id = `r${++n}`;
  const bin = path.join(dir, `${id}.sh`), seen = path.join(dir, `${id}.prompts`);
  // trimOut may be a function of the model id (the rung that is asked).
  const say = (out) => (typeof out === "function"
    ? `if [ "$3" = ${JSON.stringify(MODELS.haiku)} ]; then printf '%s\\n' ${JSON.stringify(out(MODELS.haiku))}; else printf '%s\\n' ${JSON.stringify(out(MODELS.sonnet))}; fi`
    : `printf '%s\\n' ${JSON.stringify(out)}`);
  const branches = [["DELETE ONLY", trimOut], ...routes]
    .map(([mark, out], i) => `${i ? "elif" : "if"} grep -qF ${JSON.stringify(mark)} "$f"; then ${say(out)}`).join("\n");
  writeFileSync(bin, `#!/bin/sh\nf=$(mktemp)\ncat > "$f"\ncat "$f" >> ${JSON.stringify(seen)}\necho '=====' >> ${JSON.stringify(seen)}\n${branches}\nelse printf '%s\\n' ${JSON.stringify(fallback)}\nfi\nrm -f "$f"\n`);
  chmodSync(bin, 0o755);
  return { bin, prompts: () => (existsSync(seen) ? readFileSync(seen, "utf8").split("=====\n").filter(Boolean) : []) };
}

const TWO = "The contractor has not answered about the deck. The planning call is at 3pm today.";
const TWO_REWRITE = JSON.stringify({ verdict: "rewrite", message: "You replied to the contractor at 11:10; nothing is waiting on them. The planning call is at 3pm today.",
  checks: { true: "the sent-mail records show a reply at 11:10, so 'has not answered' is wrong", self_resolve: "ok", phrasing: "ok", value: "ok" }, sources: ["sent mail"], reason: "the user already replied" });
const FLAG_FIRST = ["nothing is waiting on them", JSON.stringify({ added: ["nothing is waiting on them"], contradicted: [] })];
const TRIMMED = "The planning call is at 3pm today.";

test("withdrawn, and the judge found the original wrong: only the wrong part is cut, the cut is checked, and the rest is sent", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: ["The contractor has not answered about the deck."] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.message, TRIMMED);
  assert.equal(out.original_trimmed, true);
  assert.equal(out.rewrite_added_claim, true, "the withdrawn rewrite's claim is still logged");
  assert.deepEqual(out.rewrite_claims, ["nothing is waiting on them"]);
  assert.equal(out.checks.rewrite_check.trimmed, true);
  assert.deepEqual(out.checks.rewrite_check.removed, ["The contractor has not answered about the deck."]);
  assert.ok(out.checks.rewrite_check.withdrawn.includes("nothing is waiting on them"));
  assert.ok(out.reason.startsWith("Rewrite withdrawn; sent without the part the gate found wrong"), out.reason);
  const asked = check.prompts();
  assert.equal(asked.length, 3, "check, trim, check of the trimmed text");
  assert.ok(asked[1].includes("DELETE ONLY") && asked[1].includes("'has not answered' is wrong") && asked[1].includes(TWO), "the trim saw the finding and the original");
  assert.ok(asked[2].includes(`"""${TRIMMED}"""`), "the trimmed text was checked once more");
});

test("a trim that rewords on every rung is not a deletion: the original is sent as written, never held", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: "The planning call is surely at 3pm today.", removed: ["The contractor has not answered about the deck."] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.equal(out.original_trimmed, false);
  assert.ok(out.checks.rewrite_check.trim_failed.includes("not a pure deletion"), out.checks.rewrite_check.trim_failed);
  assert.equal(check.prompts().filter((p) => p.includes("DELETE ONLY")).length, 2, "Haiku, then Sonnet");
  assert.equal(check.prompts().length, 3, "no second check without an accepted cut");
});

test("Haiku rewords, Sonnet cuts cleanly: the clean cut is checked and sent", () => {
  const check = routed((model) => JSON.stringify(model === MODELS.haiku
    ? { original_wrong: true, trimmed: "The planning call is at 3pm today?", removed: [] }
    : { original_wrong: true, trimmed: TRIMMED, removed: ["The contractor has not answered about the deck."] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.message, TRIMMED);
  assert.equal(out.checks.rewrite_check.trim_tier, "sonnet");
});

test("the records contradict the judge's own text: nothing is trimmed, the original is sent as written", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: [] }),
    [["nothing is waiting on them", JSON.stringify({ added: [], contradicted: ["replied at 11:10 (the log shows no reply)"] })]]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "send");
  assert.equal(out.checks.rewrite_check.trim_skipped, "the records contradicted the judge's own text");
  assert.ok(!check.prompts().some((p) => p.includes("DELETE ONLY")), "no trim was asked for");
});

test("a clean cut the second check cannot read is not sent: the original goes as written", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: [] }),
    [FLAG_FIRST, [`"""${TRIMMED}"""`, "I could not decide."]]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.ok(out.checks.rewrite_check.trim_failed.startsWith("the trimmed text could not be checked"), out.checks.rewrite_check.trim_failed);
});

test("the wrong part is the whole message: a proactive message is held, with a neutral reason", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: null, removed: [] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "digest");
  assert.equal(out.original_trimmed, false);
  assert.ok(out.reason.startsWith("Rewrite withdrawn; what the gate found wrong is the whole message ("), out.reason);
  assert.ok(!out.reason.includes("daily summary"), "the live sender may still deliver a never-held intent");
});

test("a trim that deletes a 'not' and flips a sentence is caught by the second check", () => {
  const flipped = "The contractor has answered about the deck.";
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: flipped, removed: ["not", "The planning call is at 3pm today."] }),
    [FLAG_FIRST, ["has answered about the deck", JSON.stringify({ added: ["the contractor has answered"], contradicted: [] })]]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO });
  assert.equal(out.verdict, "send", "a cut the check flags is not sent; the original goes as written");
  assert.ok(out.checks.rewrite_check.trim_failed.includes("the contractor has answered"), out.checks.rewrite_check.trim_failed);
});

test("a reply is never held: with no clean trim it is sent as written, and why is logged", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: null, removed: [] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO, kind: "reply", reply_to_text: "did the contractor answer?" });
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.equal(out.original_trimmed, false);
  assert.ok(out.checks.rewrite_check.trim_failed.includes("whole message"), out.checks.rewrite_check.trim_failed);
  assert.ok(out.reason.startsWith("Rewrite withdrawn, sent as written"), out.reason);
});

test("a reply the judge found wrong is trimmed like a proactive message", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: ["The contractor has not answered about the deck."] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO, kind: "reply", reply_to_text: "anything new?" });
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.message, TRIMMED);
});

test("withdrawn, but the judge found nothing wrong with the original: it is sent as written and nothing is trimmed", () => {
  const okJudge = JSON.stringify({ verdict: "rewrite", message: "You replied to the contractor at 11:10; nothing is waiting on them. The planning call is at 3pm today.",
    checks: { true: "ok: the original's claims check out against the sent-mail log", phrasing: "could be shorter" }, sources: ["sent mail"], reason: "wording" });
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: [] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(okJudge, check, {}, { message: TWO });
  assert.equal(out.verdict, "send");
  assert.equal(out.original_trimmed, undefined);
  assert.ok(out.reason.startsWith("Rewrite withdrawn, sent as written"), out.reason);
  assert.ok(!check.prompts().some((p) => p.includes("DELETE ONLY")), "no trim was asked for");
});

test("a truth note that only confirms the original (not a plain ok) is read by the model: nothing is cut or held", () => {
  const confirming = JSON.stringify({ verdict: "rewrite", message: "You replied to the contractor at 11:10; nothing is waiting on them. The planning call is at 3pm today.",
    checks: { true: "Dates and the planning call match the calendar; the contractor claim is taken from the original", phrasing: "ok" }, sources: ["calendar"], reason: "tighter" });
  const check = routed(JSON.stringify({ original_wrong: false, trimmed: null, removed: [] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(confirming, check, {}, { message: TWO });
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.equal(out.original_trimmed, false);
  assert.ok(out.checks.rewrite_check.trim_skipped.includes("does not say the original is wrong"));
  assert.ok(out.reason.startsWith("Rewrite withdrawn, sent as written"), out.reason);
  assert.equal(check.prompts().length, 2, "check, then the trim's reading of the note; no second check");
});

test("a report email is never trimmed: its fix is only shown in the app, so it is sent as written", () => {
  const check = routed(JSON.stringify({ original_wrong: true, trimmed: TRIMMED, removed: [] }), [FLAG_FIRST]);
  const { out } = judgeRewrite(TWO_REWRITE, check, {}, { message: TWO, kind: "report" });
  assert.equal(out.verdict, "send");
  assert.ok(!check.prompts().some((p) => p.includes("DELETE ONLY")), "no trim was asked for");
});

test("isPureDeletion: tokens removed, none added, changed or moved; edge punctuation may only be dropped; case may differ", () => {
  assert.equal(isPureDeletion(TWO, TRIMMED), true);
  assert.equal(isPureDeletion("Plug 1 is off, plug 2 is on.", "Plug 1 is off"), true, "edge punctuation may be dropped");
  assert.equal(isPureDeletion("Plug 1 is off, plug 2 is on.", "Plug 1 is off."), false, "but not changed: a comma is not a full stop");
  assert.equal(isPureDeletion("Meet at 3pm. Then lunch.", "Meet at 3pm"), true);
  assert.equal(isPureDeletion("Meet at 3pm. Then lunch.", "Meet at 3pm?"), false, "3pm. never becomes 3pm?");
  assert.equal(isPureDeletion("a b c", "a - c"), false, "a stray hyphen is an addition");
  assert.equal(isPureDeletion("a — b c", "a — b"), true, "a dash the original had may stay");
  assert.equal(isPureDeletion("Hello there, friend.", "hello friend"), true);
  assert.equal(isPureDeletion("a b c", "a b c"), false, "nothing removed");
  assert.equal(isPureDeletion("a b c", ""), false, "nothing left");
  assert.equal(isPureDeletion("a b c", "a x"), false, "a word added");
  assert.equal(isPureDeletion("a b c", "c a"), false, "words moved");
  assert.equal(isPureDeletion("It is not late.", "It is late."), true, "a deleted 'not' is a deletion: the second check catches the flip");
  assert.equal(isPureDeletion("It moved -5% today, then rose.", "It moved 5% today."), false, "a minus sign is part of the word");
});

test("parseTrim and the trim prompt", () => {
  assert.deepEqual(parseTrim('{"original_wrong":true,"trimmed":null,"removed":[]}'), { original_wrong: true, trimmed: null, removed: [] });
  assert.deepEqual(parseTrim('{"original_wrong":true,"trimmed":"x"}'), { original_wrong: true, trimmed: "x", removed: [] });
  assert.deepEqual(parseTrim('thinking\n{"original_wrong":true,"trimmed":"  y ","removed":[" a "]}'), { original_wrong: true, trimmed: "y", removed: ["a"] });
  assert.deepEqual(parseTrim('{"original_wrong":true,"trimmed":"   ","removed":[]}'), { original_wrong: true, trimmed: null, removed: [] });
  assert.deepEqual(parseTrim('{"original_wrong":false,"trimmed":"ignored","removed":["z"]}'), { original_wrong: false, trimmed: null, removed: [] }, "a note that is not a falsehood cuts nothing");
  assert.deepEqual(parseTrim('{"original_wrong":false}'), { original_wrong: false, trimmed: null, removed: [] }, "no trim needed when nothing is wrong");
  assert.equal(parseTrim('{"trimmed":"x"}'), null, "original_wrong is required");
  assert.equal(parseTrim('{"original_wrong":"yes","trimmed":"x"}'), null);
  assert.equal(parseTrim('{"original_wrong":true,"trimmed":5}'), null);
  assert.equal(parseTrim('{"original_wrong":true,"removed":[]}'), null);
  assert.equal(parseTrim('{"original_wrong":true,"trimmed":"x","removed":"a"}'), null);
  assert.equal(parseTrim('{"added":[],"contradicted":[]}'), null, "a check answer is not a trim");
  const p = trimPrompt({ original: TWO, finding: "the deck claim is wrong", reason: "replied already" });
  for (const want of ["DELETE ONLY", "the deck claim is wrong", "replied already", TWO, '"original_wrong":false', "could not be checked"]) assert.ok(p.includes(want), `trim prompt missing ${want}`);
  assert.ok(!p.includes("tappable"), "no choices, no choices rule");
  const q = trimPrompt({ original: TWO, finding: "x", choices: ["Yes", "Not now"] });
  assert.ok(q.includes("tappable choices (Yes | Not now)") && q.includes("Keep the question they answer"), "a card's choices keep their question");
});

test("trimOriginal: the time limit and no 1B first rung", async () => {
  let asked = 0;
  const late = await trimOriginal({ original: "a b", finding: "b", deadline: Date.now() + 2000, ask: async () => { asked++; return "{}"; } });
  assert.equal(late.ran, false);
  assert.equal(asked, 0, "no rung starts without enough time left");
  const tiers = [];
  process.env.LOCAL_LLM_BACKEND = "ollama";
  try {
    const r = await trimOriginal({ original: "a b", finding: "b", ask: async (tier) => { tiers.push(tier); return '{"original_wrong":true,"trimmed":"a","removed":["b"]}'; } });
    assert.equal(r.ran, true);
    assert.equal(r.trimmed, "a");
    assert.deepEqual(tiers, ["sonnet"]);
  } finally { delete process.env.LOCAL_LLM_BACKEND; }
  // A cut `accept` rejects climbs; no rung's cut accepted means no trim.
  const seen = [];
  const climbed = await trimOriginal({ original: "a b c", finding: "c", accept: (x) => isPureDeletion("a b c", x),
    ask: async (tier) => { seen.push(tier); return tier === "haiku" ? '{"original_wrong":true,"trimmed":"a x","removed":[]}' : '{"original_wrong":true,"trimmed":"a b","removed":["c"]}'; } });
  assert.equal(climbed.ran, true);
  assert.equal(climbed.trimmed, "a b");
  assert.equal(climbed.tier, "sonnet");
  const none = await trimOriginal({ original: "a b c", finding: "c", accept: () => false, ask: async () => '{"original_wrong":true,"trimmed":"a b","removed":[]}' });
  assert.equal(none.ran, false);
  assert.ok(none.error.includes("not a pure deletion"), none.error);
  // A "not wrong" answer or a whole-message answer is not a cut: accept is not asked.
  const whole = await trimOriginal({ original: "a b c", finding: "c", accept: () => false, ask: async () => '{"original_wrong":true,"trimmed":null,"removed":[]}' });
  assert.equal(whole.ran, true);
  assert.equal(whole.trimmed, null);
});

// ─── Who a message names ───────────────────────────────────────────────────
//
// A calendar ping named a full name and a past introduction for an event titled
// with only a first name; the first name matched a wiki page, and the gate
// checked the facts against the title and that same page. The event's own
// organizer and guests were never shown. Made-up people below, the incident's
// shape: the invite came from a stranger at another firm, the guest is neither
// of the people the wiki knows by that first name.
const ID_EVENT = {
  summary: "Sam / Owner - project", status: "confirmed",
  start: { dateTime: "2026-11-01T17:00:00Z" }, end: { dateTime: "2026-11-01T17:30:00Z" },
  organizer: { email: "pat.lane@otherfirm.example", displayName: "Pat Lane" },
  attendees: [
    { email: "owner@example.org", self: true, responseStatus: "accepted" },
    { email: "sam.guest@mail.example", responseStatus: "needsAction" },
    { email: "room-4@resource.calendar.google.com", resource: true }, // kernel-guard-ok: the calendar service's own room-address domain
    { email: "pat.lane@otherfirm.example", organizer: true },
  ],
};
const idGog = path.join(dir, "gog-identity.sh");
writeFileSync(idGog, `#!/bin/sh\ncat <<'J'\n${JSON.stringify([ID_EVENT, { summary: "Solo block", status: "confirmed", start: { dateTime: "2026-11-01T19:00:00Z" }, end: { dateTime: "2026-11-01T20:00:00Z" } }])}\nJ\n`);
chmodSync(idGog, 0o755);
const ID_PING = "Sam Wells at 5:00, on Zoom. You introduced him to Alex for the search back in May.";
const ID_CORRECTED = "Sam at 5:00, on Zoom.";

function identityGate(judgeOut, checkOut = "{}") {
  const judge = stub(judgeOut), check = stub(checkOut);
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify({ message: ID_PING, intent: "hum:calendar:sam-project", sender: "ops", kind: "proactive", as_of: AS_OF }),
    encoding: "utf8", timeout: 120000,
    env: { ...process.env, SPEAK_GATE_NO_LOG: "1", SPEAK_GATE_NO_LESSONS: "1", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_ANON_KEY: "",
      SPEAK_GATE_CLAUDE_BIN: judge.bin, SPEAK_GATE_CHECK_BIN: check.bin, SPEAK_GATE_GOG_BIN: idGog, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false",
      SPEAK_GATE_SENT_LOG: sentLog },
  });
  return { out: JSON.parse(r.stdout.trim().split("\n").pop()), judge, check };
}

test("the judge is shown the event's organizer and guests, and told a first-name match is not an identity", () => {
  const { judge } = identityGate(JSON.stringify({ verdict: "send", checks: {}, sources: [], reason: "fine" }));
  const p = judge.prompt();
  assert.ok(p.includes(IDENTITY_RULE), "the TRUE check carries the identity rule");
  assert.match(p, /WHO THE MESSAGE NAMES/); // lang-regex-ok: asserts the gate's own prompt heading, not the user's words
  assert.match(p, /first name alone is NOT evidence/);
  assert.match(p, /"Sam \/ Owner - project".*invite from Pat Lane <pat\.lane@otherfirm\.example>; guests: sam\.guest@mail\.example/);
  assert.match(p, /"Solo block".*no organizer or guest other than the owner listed/);
});

test("a name resting on a first-name match is corrected to the bare first name, and the correction is delivered", () => {
  const judgeOut = JSON.stringify({ verdict: "rewrite", message: ID_CORRECTED,
    checks: { true: "the event's invite is from pat.lane@otherfirm.example and its guest is sam.guest@mail.example; nothing ties that guest to the Sam on the wiki page, which matched on the first name only",
      self_resolve: "ok", phrasing: "ok", value: "ok" }, sources: ["calendar event organizer and guests"], reason: "identity rested on a first-name match" });
  const { out, check } = identityGate(judgeOut, JSON.stringify({ added: [], contradicted: [] }));
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.message, ID_CORRECTED);
  assert.doesNotMatch(out.message, /Wells|introduced/);
  assert.match(out.checks.true, /first name only/);
  assert.equal(out.rewrite_added_claim, false);
  assert.match(check.prompt(), /who a person is/, "the rewrite check counts an identity as a claim");
});

test("a rewrite that adds a full name or a relationship nothing shows is withdrawn", () => {
  const judgeOut = JSON.stringify({ verdict: "rewrite", message: "Sam Wells at 5:00, on Zoom.", checks: { true: "ok" }, sources: [], reason: "x" });
  const { out } = identityGate(judgeOut, JSON.stringify({ added: ["Sam Wells (a full name only a first-name match supports)"], contradicted: [] }));
  assert.equal(out.verdict, "send");
  assert.equal(out.rewrite_added_claim, true);
  assert.match(out.reason, /^Rewrite withdrawn/);
});

test("the rewrite check's prompt names an identity as a claim that needs an address, an organizer or the thing's own text", () => {
  const p = rewriteCheckPrompt({ original: ID_PING, rewrite: ID_CORRECTED, findings: {}, records: "" });
  assert.match(p, /who a person is \(a full name, a company, a relationship\)/);
  assert.match(p, /never by a first name that happens to match/);
});
