// tickets-buy.test.mjs — `tickets buy` is a front door to the Face-ID purchase
// flow, not a checkout of its own.
//
// It once dispatched a `ticket-purchase` job of its own, which drove the user's
// everyday Chrome, refused to sign in, and was approved by a typed YES. The
// requirement since: every purchase goes through the one Face-ID path. These
// pin that the old checkout stays retired.
//
// Run: node --test tests/tickets-buy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "bin/tickets"), "utf8");

test("tickets buy queues the Face-ID purchase job", () => {
  assert.match(SRC, /bin\/purchase-queue/);
  assert.match(SRC, /\["add", req\.text, "--site", req\.site\]/);
});

test("the old ticket-purchase checkout is gone", () => {
  assert.doesNotMatch(SRC, /trigger-ticket-purchase/);
  for (const f of [
    "agent/ops-agent/jobs/ticket-purchase.md",
    "agent/ops-agent/jobs/ticket-purchase-confirm.md",
    "agent/scripts/trigger-ticket-purchase.sh",
    "agent/scripts/trigger-ticket-purchase-confirm.sh",
  ]) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} should stay deleted`);
  const routing = createRequire(import.meta.url)(path.join(ROOT, "lib/registry.cjs")).loadRegistry("job-routing");
  assert.equal(JSON.stringify(routing).includes('"ticket-purchase'), false);
});

const MERCHANTS = path.join(ROOT, "data/purchase-merchants.json");
test("the shop browser signs in to the ticket sites", { skip: !fs.existsSync(MERCHANTS) && "no data/purchase-merchants.json on this install" }, () => {
  const { merchants } = JSON.parse(fs.readFileSync(MERCHANTS, "utf8"));
  const sites = new Set(merchants.map((m) => m.site));
  for (const s of ["ticketmaster.com", "seatgeek.com"]) assert.ok(sites.has(s), s);
});

test("tickets buy carries the user's pick so the second run buys it", () => {
  assert.match(SRC, /pick \? `pick: \$\{pick\}` : null/);
  assert.match(SRC, /pick: flag\("pick"\)/);
});

test("the purchase job searches tickets once with ticket-scan", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "bin/ticket-scan")));
  // The ticket steps are this instance's: the local companion appended at dispatch.
  const local = path.join(ROOT, "agent/local/jobs/purchase.md");
  if (!fs.existsSync(local)) return; // no ticket steps on this install
  const job = ["agent/ops-agent/jobs/purchase.md", "agent/local/jobs/purchase.md"]
    .map((f) => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return ""; } }).join("\n");
  assert.match(job, /ticket-scan scan/);
  assert.match(job, /ticket-scan map/);
});
