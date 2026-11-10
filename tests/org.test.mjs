// org: which role owns a job, and how its emails and pings are signed (lib/org.cjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const org = require("../lib/org.cjs");

const O = {
  ceo: "the user",
  roles: [
    { id: "cos", title: "Chief of Staff", name: "Ada", chief_of_staff: true, jobs: ["hum", "hum-*", "projects"], intents: ["hum"] },
    { id: "cfo", title: "CFO", name: "Ben", jobs: ["finance-review", "portfolio-*"], intents: ["bank-alert"] },
    { id: "hist", title: "Historian", name: "Cy", jobs: ["wiki-*", "hum-consolidate", "daily-summary", "daily-summary-*"] },
    { id: "it", title: "IT", name: "Di", jobs: ["wiki-db-snapshot"] },
    { id: "eng", title: "Software Engineer", name: "Ed", jobs: ["daily-summary-fix"] },
  ],
};

test("roleFor: exact beats prefix, longer prefix beats shorter, wrapper prefixes are ignored", () => {
  assert.equal(org.roleFor({ job: "finance-review" }, O).id, "cfo");
  assert.equal(org.roleFor({ job: "portfolio-monitor" }, O).id, "cfo");
  assert.equal(org.roleFor({ job: "hum-consolidate" }, O).id, "hist", "an exact name beats hum-*");
  assert.equal(org.roleFor({ job: "wiki-db-snapshot" }, O).id, "it", "an exact name beats wiki-*");
  assert.equal(org.roleFor({ job: "daily-summary-fix" }, O).id, "eng");
  assert.equal(org.roleFor({ job: "daily-summary-review" }, O).id, "hist");
  assert.equal(org.roleFor({ job: "trigger-hum" }, O).id, "cos");
  assert.equal(org.roleFor({ job: "ai.claude.projects" }, O).id, "cos");
  assert.equal(org.roleFor({ intent: "bank-alert" }, O).id, "cfo");
  assert.equal(org.roleFor({ job: "nobody-owns-this" }, O), null);
});

test("signing: emails carry name and title, pings the name; the chief of staff's pings stay plain; never twice", () => {
  assert.equal(org.signSubject("Weekly review", { job: "finance-review" }, O), "Ben (CFO): Weekly review");
  assert.equal(org.signSubject("Ben (CFO): Weekly review", { job: "finance-review" }, O), "Ben (CFO): Weekly review");
  assert.equal(org.signPing("Cash is fine", { intent: "bank-alert" }, O), "Ben: Cash is fine");
  assert.equal(org.signPing("Ben: Cash is fine", { intent: "bank-alert" }, O), "Ben: Cash is fine");
  assert.equal(org.signPing("A thought", { intent: "hum" }, O), "A thought");
  assert.equal(org.signSubject("Your projects this week", { job: "projects" }, O), "Ada (Chief of Staff): Your projects this week");
  assert.equal(org.signPing("x", { job: "unknown" }, O), "x");
  assert.equal(org.signSubject("x", {}, { roles: [] }), "x");
});

test("chart assigns every job and lists the unowned", () => {
  const c = org.chart(O, ["finance-review", "hum", "trigger-hum-daily", "mystery"]);
  assert.deepEqual(c.roles.find((r) => r.id === "cfo").jobs, ["finance-review"]);
  assert.deepEqual(c.roles.find((r) => r.id === "cos").jobs, ["hum", "trigger-hum-daily"]);
  assert.deepEqual(c.unassigned, ["mystery"]);
});
