// Guards for the email-triage determinism pieces: supervisor-kept
// dispatch counters, the reclassify-flap annotation, the triage-rules slicer,
// the enriched dispatch text and the jori@ single-handler ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "triage-intake-"));
process.env.TRIAGE_DECISIONS_DB = path.join(TMP, "td.db");

const { recordAttempt, recentAttempts, reclassifyMessageId, isPhantom, markPhantom } = await import("../lib/dispatch-attempts.mjs");
const { annotateReclassify, Dispatcher } = await import("../agent/supervisor/dispatcher.mjs");
const { parse, core, index, section } = await import("../lib/triage-rules.mjs");
const { mergeSectionedMarkdown, readOptional } = await import("../agent/supervisor/dispatch-preamble.mjs");
const { buildTriageDispatch, inboundAlreadyHandled, recordInboundHandled, normalizeRfcMessageId } = await import("../agent/supervisor/gmail-source.mjs");

test("dispatch-attempts counts per kind inside the window and marks phantoms", () => {
  const file = path.join(TMP, "track.json");
  const now = Date.parse("2026-10-04T12:00:00Z");
  recordAttempt("19f0aaaabbbbcc", "triage", { file, now: now - 40 * 60e3 });
  recordAttempt("19f0aaaabbbbcc", "triage", { file, now: now - 5 * 60e3 });
  const n = recordAttempt("19f0aaaabbbbcc", "reclassify", { file, now });
  assert.equal(n, 1);
  assert.equal(recentAttempts("19f0aaaabbbbcc", "triage", { file, now }), 1, "the 40-min-old one is outside the window");
  assert.equal(recentAttempts("19f0aaaabbbbcc", null, { file, now }), 2);
  markPhantom("19f0aaaabbbbcc", "test", { file });
  assert.equal(isPhantom("19f0aaaabbbbcc", { file }), true);
});

test("reclassifyMessageId only accepts a Gmail id shape", () => {
  assert.equal(reclassifyMessageId("RECLASSIFY: 19f0aaaabbbbcc"), "19f0aaaabbbbcc");
  assert.equal(reclassifyMessageId("RECLASSIFY: 19e8abc"), null);
  assert.equal(reclassifyMessageId("hello"), null);
});

test("the dispatcher annotates the 3rd RECLASSIFY of one message", () => {
  let n = 0;
  const rec = () => ++n;
  const c1 = annotateReclassify("RECLASSIFY: 19f0aaaabbbbcc", { recordAttempt: rec });
  const c2 = annotateReclassify("RECLASSIFY: 19f0aaaabbbbcc", { recordAttempt: rec });
  const c3 = annotateReclassify("RECLASSIFY: 19f0aaaabbbbcc", { recordAttempt: rec });
  assert.equal(c1, "RECLASSIFY: 19f0aaaabbbbcc");
  assert.equal(c2, "RECLASSIFY: 19f0aaaabbbbcc");
  assert.match(c3, /\[supervisor\] FLAP: this messageId has had 3 RECLASSIFY/);
});

test("an annotated RECLASSIFY still coalesces with its raw duplicate", () => {
  process.env.RECLASSIFY_TRACKING_FILE = path.join(TMP, "dispatcher-track.json");
  const session = { send() {}, on() {}, removeListener() {} };
  const d = new Dispatcher(session);
  d._drain = () => {};
  d.persist = () => {};
  const ids = [1, 2, 3].map(() => d.dispatch("RECLASSIFY: 19f0ddddeeeeff", "webhook"));
  assert.equal(new Set(ids).size, 1, "all three coalesce onto the first queued item");
  delete process.env.RECLASSIFY_TRACKING_FILE;
});

test("triage-rules slices the file along its own headings", () => {
  const doc = parse("# T\nintro\n### Step 5: Act\nP3 = label\n### Shipping & Delivery (x)\nship rule\n### Tools reference\ntools");
  assert.match(core(doc), /Step 5: Act[\s\S]*Tools reference/);
  assert.doesNotMatch(core(doc), /ship rule/);
  assert.equal(index(doc), "- shipping-delivery — Shipping & Delivery (x)");
  assert.match(section("shipping-delivery", doc), /ship rule/);
  assert.equal(section("nope", doc), null);
});

test("the real ruleset: core is a fraction of the file, every category has a unique slug", () => {
  // What the agent actually reads: the kernel ruleset merged with this
  // instance's local companion (the supervisor's TRIAGE_RULES_FILE).
  const kernel = fs.readFileSync(new URL("../agent/ops-agent/email-triage-rules.md", import.meta.url), "utf8");
  const local = readOptional(fileURLToPath(new URL("../agent/local/email-triage-rules.md", import.meta.url)));
  const md = mergeSectionedMarkdown(kernel, local);
  const doc = parse(md);
  assert.ok(core(doc).length < md.length * 0.45, "core must be well under half the file");
  const slugs = doc.sections.filter((s) => !s.core).map((s) => s.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(core(doc).includes("### Step 5: Act"));
});

test("buildTriageDispatch carries what intake already knows", () => {
  const t = buildTriageDispatch({
    messageId: "19f0", from: "A <a@b.com>", to: "user@example.com", subject: "Hi", date: "Sat, 3 Oct 2026 14:05:00 -0400",
    stamps: ["reply-to-me-p1"], jev: { label: "personal", priority: "P1" }, history: "3 agent-decided", body: "hello there",
  }, "- slug — Title");
  assert.match(t, /MessageId: 19f0/);
  assert.match(t, /ALREADY applied/);
  assert.match(t, /--evidence-as-of 2026-10-03T18:05:00.000Z/);
  assert.match(t, /<<<BODY\nhello there\nBODY>>>/);
  assert.match(t, /triage-rules core/);
  assert.match(t, /- slug — Title/);
  assert.doesNotMatch(t, /read ~\/Dev\/jori\/agent\/ops-agent\/email-triage-rules.md/);
  const nb = buildTriageDispatch({ messageId: "x", from: "a", subject: "s", stamps: [] });
  assert.match(nb, /not prefetched/);
});

test("buildTriageDispatch: command channel carries the threaded-reply contract", () => {
  const t = buildTriageDispatch({
    messageId: "1a1", from: "Pat User <user@example.com>", subject: "Re: Wiki pin audit: 14 up", stamps: ["command-channel"],
    rfcMessageId: "<CAP+x@mail.gmail.com>", rfcReferences: "<orig@example.org>", body: "Let's stop this email.",
  });
  assert.ok(t.includes("REPLY ON THIS THREAD WHEN DONE"));
  assert.match(t, /To: user@example\.com/);
  assert.match(t, /Subject: Re: Wiki pin audit: 14 up\n/);
  assert.ok(t.includes("In-Reply-To: <CAP+x@mail.gmail.com>"));
  assert.match(t, /References: <orig@example.org> <CAP\+x@mail.gmail.com>/);
  const fresh = buildTriageDispatch({ messageId: "1a2", from: "user@example.com", subject: "Do a thing", stamps: ["command-channel"], rfcMessageId: "<n@x>" });
  assert.match(fresh, /Subject: Re: Do a thing/);
  assert.match(fresh, /References: <n@x>/);
  const plain = buildTriageDispatch({ messageId: "1a3", from: "a@b.com", subject: "s", stamps: [], rfcMessageId: "<p@x>" });
  assert.ok(!plain.includes("REPLY ON THIS THREAD"));
});

test("jori@ ledger: normalised Message-ID match in both directions", () => {
  const file = path.join(TMP, "handled.jsonl");
  fs.writeFileSync(file, JSON.stringify({ ts: "x", message_id: "<ABC@mail.gmail.com>", action_taken: "dispatched" }) + "\n");
  assert.equal(inboundAlreadyHandled("abc@mail.gmail.com", file), true);
  assert.equal(inboundAlreadyHandled("<other@x>", file), false);
  recordInboundHandled({ rfcMessageId: "<Other@X>", messageId: "19f", from: "m", subject: "s" }, file);
  assert.equal(inboundAlreadyHandled("other@x", file), true);
  assert.equal(normalizeRfcMessageId(" <A@B> "), "a@b");
  assert.equal(inboundAlreadyHandled("", file), false);
});
