// self-improve-landing.test.mjs — pins the schema-v4 landing boundary: what
// lands on its own, what needs the user's Face-ID, and what nothing may touch.
// Source of truth: lib/self-improve-landing.mjs, mirrored in
// data/self-improvement-risk-rubric.md §1.0 and §2.
//
// Run: node --test tests/self-improve-landing.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// A synthetic installation: its own high-blast-radius paths come from
// agent/local/config/self-improve-landing.json (`force_high`). This
// install's real list is pinned in self-improve-landing-local.test.mjs.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "si-landing-"));
fs.mkdirSync(path.join(LOCAL, "config"));
// The sources match repo-relative paths, so they carry the kernel's directory
// (KERNEL_SUBDIR in lib/root.cjs: "tools" here, "" where the kernel is the repo root).
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");
const K = KERNEL_SUBDIR ? `${KERNEL_SUBDIR}\\/` : "";
fs.writeFileSync(path.join(LOCAL, "config", "self-improve-landing.json"), JSON.stringify({
  force_high: [`^${K}bin\\/vault-[^/]*$`, `^${K}agent\\/local\\/jobs\\/high-risk-[^/]*\\.md$`],
}));
process.env.JORI_LOCAL_DIR = LOCAL;
test.after(() => fs.rmSync(LOCAL, { recursive: true, force: true }));
const { changedLines, composeCard, decideLanding: decide, installationRefusals, railsFor, verifyOwnerRequest, isVerifiedOwnerRequest, LOCK_CORE, RECURSION_GUARD, MIN_QUOTE_CHARS, MAX_CHANGED_LINES, MAX_FILES } = await import("../lib/self-improve-landing.mjs");
// Judged as a fresh install: no _ext/self-improve-landing.mjs hook. The hook
// contract is pinned below with synthetic hooks; this install's own hook in
// self-improve-landing-local.test.mjs.
const decideLanding = (p) => decide({ hook: null, ...p });

const safe = { risk: "low", category: "bug-fix", critic: "SAFE" };
const one = (path, content = "x\n", before = "y\n") => ({ files: { [path]: content }, before: { [path]: before } });

test("a small, safe fix in an ordinary file lands on its own", () => {
  const r = decideLanding({ ...one("bin/day-segments"), ...safe });
  assert.equal(r.mode, "auto");
});

test("moderate risk still lands on its own — only high blast radius asks", () => {
  const r = decideLanding({ ...one("agent/scripts/trigger-hum.sh"), ...safe, risk: "moderate" });
  assert.equal(r.mode, "auto");
});

for (const path of [
  "bin/email-send",
  "bin/jori-send-curl",
  "bin/jori-calendar",
  "bin/vault-sync",
  "agent/supervisor/index.mjs",
  "agent/config/agents.json",
  "agent/ops-agent/email-triage-rules.md",
  "data/spam-blocklist.json",
  "lib/claim-freshness.mjs",
  "githooks/pre-commit",
  "bin/lint-no-language-regex",
]) {
  test(`high blast radius needs a card: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /high blast radius/);
  });
}

for (const path of [
  "data/self-improvement-risk-rubric.md",
  "agent/ops-agent/jobs/improvement-plan.md",
  "agent/ops-agent/jobs/nightly-review.md",
  "lib/self-improve-landing.mjs",
  "bin/self-improve-auto-apply",
  "bin/self-improve-request",
  "agent/CLAUDE.md",
  "lib/self-improve-rebase.mjs",
  "lib/self-improve-rebuild.mjs",
  "lib/skill-repair.mjs",
]) {
  test(`the pipeline may not touch its own controls: ${path}`, () => {
    assert.equal(decideLanding({ ...one(path), ...safe }).mode, "refuse");
  });
}

// The instance's local twins (agent/local/) of the guarded rule files:
// its own agent rules (appended to every system prompt beside the CLAUDE.md
// files) and its additions to the guarded playbooks are the same rules, so the
// same rail — and the local triage rules are as high-blast-radius as the kernel
// ruleset they are merged into.
for (const path of [
  "agent/local/shared.md",
  "agent/local/chat.md",
  "agent/local/ops.md",
  "agent/local/jobs/nightly-review.md",
  "agent/local/jobs/self-improvement-executor.md",
  "agent/local/jobs/improvement-plan.md",
  "agent/local/jobs/system-issue-review.md",
  "agent/local/jobs/skill-repair.md",
]) {
  test(`the pipeline may not touch the local twin of its own controls: ${path}`, () => {
    assert.equal(decideLanding({ ...one(path), ...safe }).mode, "refuse");
  });
}

for (const path of [
  "agent/local/email-triage-rules.md",
  "agent/local/jobs/purchase.md",
  "agent/local/jobs/high-risk-job.md",
]) {
  test(`a local twin of a high-blast-radius file needs a card: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /high blast radius/);
  });
}

test("an ordinary local playbook addition is not swept into a rail", () => {
  assert.equal(decideLanding({ ...one("agent/local/jobs/morning-digest.md"), ...safe }).mode, "auto");
});

test("the daily-summary repair loop's local playbook twin is card-only", () => {
  const r = decideLanding({ ...one("agent/local/jobs/daily-summary-fix.md"), ...safe });
  assert.equal(r.mode, "card");
  assert.match(r.reasons.join(" "), /Face-ID card/);
});

// The daily-summary repair loop's own rules (a list self-improve-landing.mjs
// carries) may change on a Face-ID card, still never automatically.
for (const path of [
  "bin/daily-summary-fix",
  "agent/ops-agent/jobs/daily-summary-fix.md",
  "agent/scripts/trigger-daily-summary-fix.sh",
  "tests/daily-summary-fix.test.mjs",
]) {
  test(`the repair loop's own file goes on a card, never lands on its own: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /Face-ID card/);
    // However small and safe the change, and alongside an ordinary file.
    const mixed = decideLanding({ files: { [path]: "x\n", "bin/day-segments": "x\n" }, before: {}, ...safe });
    assert.equal(mixed.mode, "card");
  });
}

test("secrets are refused outright", () => {
  assert.equal(decideLanding({ ...one(".env"), ...safe }).mode, "refuse");
  assert.equal(decideLanding({ ...one("credentials/token.json"), ...safe }).mode, "refuse");
});

test("complex changes need a card: too many files, or too many lines", () => {
  const files = {};
  for (let i = 0; i <= MAX_FILES; i++) files[`lib/f${i}.mjs`] = "a\n";
  assert.equal(decideLanding({ files, before: {}, ...safe }).mode, "card");

  const big = Array.from({ length: MAX_CHANGED_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
  const r = decideLanding({ files: { "lib/big.mjs": big }, before: { "lib/big.mjs": "" }, ...safe });
  assert.equal(r.mode, "card");
  assert.match(r.reasons.join(" "), /changed lines/);
});

test("a new capability, a high label, or a hesitant critic needs a card", () => {
  assert.equal(decideLanding({ ...one("bin/new-thing"), ...safe, category: "new-capability" }).mode, "card");
  assert.equal(decideLanding({ ...one("bin/day-segments"), ...safe, risk: "high" }).mode, "card");
  assert.equal(decideLanding({ ...one("bin/day-segments"), ...safe, critic: "DEFER_TO_OPERATOR: unsure" }).mode, "card");
});

test("two viable approaches are the user's choice, not a draft", () => {
  const r = decideLanding({ ...one("bin/day-segments"), ...safe, architecturalOptions: 2 });
  assert.equal(r.mode, "refuse");
  assert.deepEqual(r.reasons, ["more than one viable approach — the user picks"]);
});

test("the task registry, kernel and local halves, is shared process machinery (never low)", () => {
  for (const p of ["system/tasks.json", "agent/local/tasks.json"]) {
    assert.deepEqual(railsFor([p]).forceModerate, [p]);
  }
});

test("a path outside the installation's force_high list is not swept in", () => {
  assert.equal(decideLanding({ ...one("bin/banking-notes"), ...safe }).mode, "auto");
});

test("changed lines counts additions and removals", () => {
  assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 2);
  assert.equal(changedLines(null, "a\nb"), 2);
  assert.equal(changedLines("a\nb", "a\nb"), 0);
});

test("the card is plain language in the four parts the user asked for", () => {
  const text = composeCard({ problem: "p", impact: "i", fix: "f", sideEffects: "none expected" });
  assert.match(text, /^What's wrong: p\n\nWhy it matters now: i\n\nThe fix: f\n\nSide effects: none expected$/);
  assert.throws(() => composeCard({ problem: "p", impact: "", fix: "f", sideEffects: "s" }), /impact/);
});

// The installation's landing hook (_ext/self-improve-landing.mjs
// `landingRefusals`): whatever it rejects is refused for a redraft — neither a
// card nor a signature lands it — after the kernel's own refusals and before
// the card rails.
const refusing = { landingRefusals: ({ files }) => Object.keys(files).filter((p) => files[p].includes("NOT-HERE")).map((p) => `misplaced content in ${p}`) };

test("a change the installation's hook rejects is refused for a redraft, whatever its rails", () => {
  const r = decide({ ...one("lib/some-module.mjs", "x NOT-HERE\n"), ...safe, hook: refusing });
  assert.equal(r.mode, "refuse");
  assert.equal(r.redraft, true);
  assert.deepEqual(r.reasons, ["misplaced content in lib/some-module.mjs"]);
  // A high-blast-radius path is refused too, not carded: a signature cannot fix the content.
  assert.equal(decide({ ...one("bin/email-send", "NOT-HERE\n"), ...safe, hook: refusing }).mode, "refuse");
});

test("a change the hook accepts goes on to the ordinary rails", () => {
  assert.equal(decide({ ...one("lib/some-module.mjs"), ...safe, hook: refusing }).mode, "auto");
  assert.equal(decide({ ...one("bin/email-send"), ...safe, hook: refusing }).mode, "card");
});

test("the kernel's own refusals come first, and are not marked for a redraft", () => {
  const r = decide({ ...one("agent/CLAUDE.md", "NOT-HERE\n"), ...safe, hook: refusing });
  assert.equal(r.mode, "refuse");
  assert.equal(r.redraft, undefined);
  assert.match(r.reasons[0], /own controls/);
});

test("a hook that throws refuses the change; no hook refuses nothing", () => {
  const broken = { landingRefusals: () => { throw new Error("boom"); } };
  const r = decide({ ...one("lib/some-module.mjs"), ...safe, hook: broken });
  assert.equal(r.mode, "refuse");
  assert.match(r.reasons[0], /landing check failed: boom/);
  assert.deepEqual(installationRefusals({ files: { a: "NOT-HERE" }, hook: null }), []);
  assert.deepEqual(installationRefusals({ files: { a: "NOT-HERE" }, hook: {} }), []);
});

// ── Locked files (rubric schema v6, 2026-11-04) ────────────────────────────
// The owner's choice: a change they ask for in chat may touch a locked file on
// a normal Face-ID card that quotes their words; anything the system proposes
// on its own still cannot; and the lock's own machinery stays absolute even
// with a quote.

const OWNER = { quote: "please make the evening check-in ask at 11pm", message_id: "m-1", message_created_at: "2026-11-03T10:00:00Z", build_request: "20261103-100100-1", via: "chat-build", verified: true };

for (const path of [
  "agent/CLAUDE.md",
  "agent/chat-agent/CLAUDE.md",
  "agent/chat-agent/procedures/hum-replies.md",
  "agent/ops-agent/CLAUDE.md",
  "agent/local/chat.md",
  "agent/local/shared.md",
  "agent/ops-agent/jobs/nightly-review.md",
  "agent/ops-agent/jobs/improvement-plan.md",
  "agent/ops-agent/jobs/system-issue-review.md",
  "agent/ops-agent/jobs/self-improvement-executor.md",
  "agent/local/jobs/improvement-plan.md",
  "bin/build-request",
  "agent/scripts/trigger-chat-build.sh",
]) {
  test(`a locked file goes on a card only for the owner's quoted chat request: ${path}`, () => {
    const alone = decideLanding({ ...one(path), ...safe });
    assert.equal(alone.mode, "refuse");
    assert.equal(alone.ownerCardable, true);
    const asked = decideLanding({ ...one(path), ...safe, owner: OWNER });
    assert.equal(asked.mode, "card");
    assert.match(asked.reasons.join(" "), /owner asked in chat/); // lang-regex-ok: matches the module's own reason text, machine-generated
    // Never on its own, however small and safe, and alongside an ordinary file.
    const mixed = decideLanding({ files: { [path]: "x\n", "bin/day-segments": "x\n" }, before: {}, ...safe, owner: OWNER });
    assert.equal(mixed.mode, "card");
  });
}

for (const path of [
  "data/self-improvement-risk-rubric.md",
  "lib/self-improve-landing.mjs",
  "bin/self-improve-auto-apply",
  "bin/self-improve-request",
  "bin/self-improve-approval-poll",
  "bin/self-improve-feed-log",
  "agent/core/self-improve-unified.mjs",
  "agent/core/app-approval.mjs",
  "lib/self-improve-rebase.mjs",
  "lib/self-improve-rebuild.mjs",
  "tests/self-improve-landing.test.mjs",
  "tests/auto-impl-policy.test.mjs",
  "tests/self-improve-rebase.test.mjs",
  "tests/self-improve-rebuild.test.mjs",
]) {
  test(`the lock's own machinery is refused even with the owner's quote: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe, owner: OWNER });
    assert.equal(r.mode, "refuse");
    assert.equal(r.ownerCardable, undefined);
    assert.match(r.reasons[0], /lock's own machinery/);
    assert.deepEqual(railsFor([path]).lockCore, [path]);
    // Every lock-core path is also recursion-guarded: the core is a subset.
    assert.deepEqual(railsFor([path]).recursion, [path]);
    // ...and it poisons a change that also touches a card-able locked file.
    assert.equal(decideLanding({ files: { [path]: "x\n", "agent/CLAUDE.md": "x\n" }, before: {}, ...safe, owner: OWNER }).mode, "refuse");
  });
}

test("every LOCK_CORE rail is also a RECURSION_GUARD rail", () => {
  const src = new Set(RECURSION_GUARD.map((r) => r.source));
  for (const r of LOCK_CORE) assert.ok(src.has(r.source), `${r.source} is in LOCK_CORE but not RECURSION_GUARD`);
});

test("only a verified owner request opens a locked file — not a bare quote or a pipeline job's claim", () => {
  for (const owner of [
    { quote: OWNER.quote },
    { ...OWNER, verified: false },
    { ...OWNER, via: "improvement-plan" },
    { ...OWNER, quote: "too short" },
    { ...OWNER, message_id: "" },
    { ...OWNER, build_request: "" },
    "please make the evening check-in ask at 11pm",
  ]) {
    assert.equal(isVerifiedOwnerRequest(owner), false, JSON.stringify(owner));
    assert.equal(decideLanding({ ...one("agent/CLAUDE.md"), ...safe, owner }).mode, "refuse");
  }
  assert.equal(isVerifiedOwnerRequest(OWNER), true);
});

test("a quoted locked-file change still goes through the installation's content check", () => {
  const r = decide({ ...one("agent/CLAUDE.md", "NOT-HERE\n"), ...safe, owner: OWNER, hook: refusing });
  assert.equal(r.mode, "refuse");
  assert.equal(r.redraft, true);
});

test("secrets stay refused, quote or not", () => {
  assert.equal(decideLanding({ ...one(".env"), ...safe, owner: OWNER }).mode, "refuse");
});

// verifyOwnerRequest: the structural checks, with the queue and the messages
// table faked.
const REQ = { id: "20261103-100100-1", source: "chat", requested_at: "2026-11-03T10:01:00Z", spec: "…" };
const MSG = { id: "m-1", role: "user", content: "Yes — please make the evening check-in ask at 11pm, while the day is fresh.", created_at: "2026-11-03T10:00:00Z" };
const deps = (over = {}) => ({
  quote: OWNER.quote,
  buildRequestId: REQ.id,
  readBuildRequest: async (id) => (id === REQ.id ? REQ : null),
  getMessage: async (id) => (id === MSG.id ? MSG : null),
  findUserMessages: async () => [MSG],
  getApproval: async () => null,
  ...over,
});

test("verify: the owner's exact words in their own message, from their chat build", async () => {
  const v = await verifyOwnerRequest(deps({ messageId: "m-1" }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.owner, { quote: OWNER.quote, message_id: "m-1", message_created_at: MSG.created_at, build_request: REQ.id, via: "chat-build", verified: true });
  assert.equal(isVerifiedOwnerRequest(v.owner), true);
  // Without a message id the newest message holding the quote is used.
  const found = await verifyOwnerRequest(deps());
  assert.equal(found.ok, true);
  assert.equal(found.owner.message_id, "m-1");
});

test("verify: not from a chat build — no request id, an unknown one, or a pipeline source", async () => {
  assert.equal((await verifyOwnerRequest(deps({ buildRequestId: null }))).ok, false);
  assert.equal((await verifyOwnerRequest(deps({ buildRequestId: "nope" }))).ok, false);
  const fromJob = await verifyOwnerRequest(deps({ readBuildRequest: async () => ({ ...REQ, source: "improvement-plan" }) }));
  assert.equal(fromJob.ok, false);
  assert.match(fromJob.reasons[0], /not the owner's chat/); // lang-regex-ok: matches the module's own reason text, machine-generated
});

test("verify: the quote must be the owner's words exactly, in a user-role row, written before the request", async () => {
  // Not word for word (case, a fixed typo, a paraphrase).
  for (const quote of ["Please make the evening check-in ask at 11pm", "please make the evening check in ask at 11pm"]) {
    assert.equal((await verifyOwnerRequest(deps({ quote, messageId: "m-1" }))).ok, false, quote);
    assert.equal((await verifyOwnerRequest(deps({ quote }))).ok, false, quote);
  }
  // Too short to prove anything.
  assert.ok("11pm please".length < MIN_QUOTE_CHARS);
  assert.equal((await verifyOwnerRequest(deps({ quote: "11pm please" }))).ok, false);
  // The assistant's own row does not count.
  const own = await verifyOwnerRequest(deps({ messageId: "m-1", getMessage: async () => ({ ...MSG, role: "assistant" }) }));
  assert.equal(own.ok, false);
  assert.equal((await verifyOwnerRequest(deps({ findUserMessages: async () => [{ ...MSG, role: "assistant" }] }))).ok, false);
  // Written after the build was requested.
  const later = await verifyOwnerRequest(deps({ messageId: "m-1", getMessage: async () => ({ ...MSG, created_at: "2026-11-03T11:00:00Z" }) }));
  assert.equal(later.ok, false);
  assert.match(later.reasons[0], /after the build was requested/);
  // A malformed id never reaches a query; an unreadable table refuses.
  assert.equal((await verifyOwnerRequest(deps({ messageId: "1,role.eq.user" }))).ok, false);
  const down = await verifyOwnerRequest(deps({ findUserMessages: async () => { throw new Error("503"); } }));
  assert.equal(down.ok, false);
  assert.match(down.reasons[0], /could not read/);
});

test("verify: a rebuild carries the original card's quote, and only that one", async () => {
  const RB = { id: "20261104-010000-rbabc", source: "approval-rebuild", rebuild_of: "a-1", requested_at: "2026-11-04T01:00:00Z" };
  const base = deps({ quote: null, buildRequestId: RB.id, rebuildOf: "a-1", readBuildRequest: async () => RB, getApproval: async () => ({ id: "a-1", item_json: { owner_request: OWNER } }) });
  const v = await verifyOwnerRequest(base);
  assert.equal(v.ok, true);
  assert.equal(v.owner.quote, OWNER.quote);
  assert.equal(v.owner.build_request, RB.id);
  assert.equal((await verifyOwnerRequest({ ...base, quote: "a different quote, long enough" })).ok, false);
  assert.equal((await verifyOwnerRequest({ ...base, rebuildOf: "a-2" })).ok, false);
  assert.equal((await verifyOwnerRequest({ ...base, getApproval: async () => ({ id: "a-1", item_json: {} }) })).ok, false);
});

// The CLI refuses before filing anything (exit 66). Offline, as in
// self-improve-request-nul-byte.test.mjs: every case here stops before a query.
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const BIN = new URL("../bin/self-improve-request", import.meta.url).pathname;
  const env = { ...process.env, SUPABASE_URL: "http://127.0.0.1:1", CLAIM_FRESHNESS_CLAUDE_BIN: "/nonexistent/claude" };
  delete env.JORI_CHAT_BUILD_REQUEST;
  const run = async (files, extra = [], envOver = {}) => {
    const f = path.join(LOCAL, `files-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ files }));
    try {
      await exec(BIN, ["--type", "code-fix", "--summary", "locked-file self-test", "--problem", "t", "--impact", "t", "--fix", "t", "--side-effects", "none", "--files-json", f, ...extra], { timeout: 20000, env: { ...env, ...envOver } });
      return { code: 0, stderr: "" };
    } catch (e) {
      return { code: e.code, stderr: String(e.stderr || "") };
    }
  };

  test("cli: a locked file without the owner's quote is refused, nothing filed", async () => {
    const r = await run({ "agent/CLAUDE.md": "x\n" });
    assert.equal(r.code, 66);
    assert.match(r.stderr, /--owner-quote/);
  });

  test("cli: a quote outside a chat build is refused", async () => {
    const r = await run({ "agent/CLAUDE.md": "x\n" }, ["--owner-quote", OWNER.quote]);
    assert.equal(r.code, 66);
    assert.match(r.stderr, /not started from a chat request/); // lang-regex-ok: matches the module's own reason text, machine-generated
    const fake = await run({ "agent/CLAUDE.md": "x\n" }, ["--owner-quote", OWNER.quote], { JORI_CHAT_BUILD_REQUEST: "20000101-000000-0" });
    assert.equal(fake.code, 66);
    assert.match(fake.stderr, /no build request/);
  });

  test("cli: the lock's own machinery and secrets are refused, quote or not", async () => {
    const core = await run({ "lib/self-improve-landing.mjs": "x\n" }, ["--owner-quote", OWNER.quote]);
    assert.equal(core.code, 66);
    assert.match(core.stderr, /lock's own machinery/);
    const secret = await run({ ".env": "X=1\n" });
    assert.equal(secret.code, 66);
    assert.match(secret.stderr, /forbidden/);
  });
}
