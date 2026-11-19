// What reaches the judge, and what happens to its rewrite (system/speak-gate.md
// § Research, § Nightly audit, § The rewrite check): bin/speak-gate.mjs puts
// data/speak-gate-lessons.json and the newest records into the judge's prompt,
// runs end to end on the shared research lib (lib/speak-gate-agent.mjs), and
// sends the original when the rewrite check finds a claim nothing shows or
// cannot run. The judge, the check's model, gog and the sent-mail log are
// stand-ins; the database is unreachable (empty keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function judgeRewrite(judgeOut, checkOut, extraEnv = {}) {
  const judge = stub(judgeOut), check = stub(checkOut);
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify({ message: "The contractor has not answered about the deck.", kind: "proactive", as_of: AS_OF }),
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

test("a rewrite that adds a claim nothing shows is withdrawn: the original is sent and the claim is logged", () => {
  const { out } = judgeRewrite(REWRITE, JSON.stringify({ added: ["nothing is waiting on them"], contradicted: [] }));
  assert.equal(out.verdict, "send");
  assert.equal(out.message, undefined);
  assert.equal(out.rewrite_added_claim, true);
  assert.deepEqual(out.rewrite_claims, ["nothing is waiting on them"]);
  assert.equal(out.checks.rewrite_check.added_claim, true);
  assert.match(out.checks.rewrite_check.withdrawn, /You replied to the contractor/);
  assert.equal(out.checks.true, "the sent-mail records show a reply at 11:10", "the judge's own checks are kept");
  assert.match(out.reason, /^Rewrite withdrawn, sent as written/);
});

test("Haiku off schema climbs to Sonnet, whose contradiction withdraws the rewrite", () => {
  const { out, check } = judgeRewrite(REWRITE, (model) => (model === MODELS.haiku ? "I think it is fine." : JSON.stringify({ added: [], contradicted: ["replied at 11:10 (the log shows 11:10 is a different thread)"] })));
  assert.equal(out.verdict, "send");
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
