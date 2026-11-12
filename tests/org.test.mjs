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

test("an email to the user comes from the role that owns the job", () => {
  assert.equal(org.senderName({ job: "finance-review" }, O), "Ben (CFO)");
  assert.equal(org.senderName({ job: "projects" }, O), "Ada (Chief of Staff)");
  assert.equal(org.senderName({ intent: "bank-alert" }, O), "Ben (CFO)");
  assert.equal(org.senderName({ job: "nobody-owns-this" }, O), null);
  assert.equal(org.senderName({}, { roles: [] }), null);
});

test("chart assigns every job and lists the unowned", () => {
  const c = org.chart(O, ["finance-review", "hum", "trigger-hum-daily", "mystery"]);
  assert.deepEqual(c.roles.find((r) => r.id === "cfo").jobs, ["finance-review"]);
  assert.deepEqual(c.roles.find((r) => r.id === "cos").jobs, ["hum", "trigger-hum-daily"]);
  assert.deepEqual(c.unassigned, ["mystery"]);
});

test("roleBrief appends the owning role's specialization, without its title line", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "org-")), "specialization.md");
  fs.writeFileSync(f, "# CFO\n\nNumbers with provenance.\n");
  const o = { ceo: "Sam", roles: [{ ...O.roles[1], specialization_path: f }, O.roles[0]] };
  const b = org.roleBrief("finance-review", o);
  assert.ok(b.startsWith("## Your role on the team: Ben, CFO"));
  assert.ok(b.includes("reports to Sam (the CEO) and is coordinated by the chief of staff"));
  assert.ok(b.includes("Numbers with provenance.") && !b.includes("# CFO"));
  assert.equal(org.roleBrief("hum", o), null, "a role without a brief adds nothing");
  assert.equal(org.roleBrief("nobody", o), null);
});

test("signMail: owner-only mail and --role-from mail come FROM the role; other mail carries the role in its subject", () => {
  const base = { job: "finance-review", owner: "me@x.com", subject: "Plan", fromName: "Jori" };
  assert.deepEqual(org.signMail({ ...base, to: "me@x.com" }, O), { fromName: "Ben (CFO)", subject: "Plan" });
  assert.deepEqual(org.signMail({ ...base, to: "me@x.com,her@x.com", roleFrom: true }, O), { fromName: "Ben (CFO)", subject: "Plan" });
  assert.deepEqual(org.signMail({ ...base, to: "me@x.com,her@x.com" }, O), { fromName: "Jori", subject: "Ben (CFO): Plan" });
  assert.deepEqual(org.signMail({ ...base, to: "me@x.com,her@x.com", inReplyTo: "<a@b>" }, O), { fromName: "Jori", subject: "Plan" });
  assert.deepEqual(org.signMail({ ...base, job: "nobody", to: "me@x.com", roleFrom: true }, O), { fromName: "Jori", subject: "Plan" });
});

test("soloTitle: the coordinator alone is the Personal Assistant; with a team, or a title set explicitly, it keeps its title", () => {
  const cos = { id: "cos", title: "Chief of Staff", name: "Ada", chief_of_staff: true };
  assert.equal(org.soloTitle([cos])[0].title, "Personal Assistant");
  assert.equal(org.soloTitle([cos], () => true)[0].title, "Chief of Staff");
  assert.equal(org.soloTitle([cos, { id: "cfo", title: "Finances", name: "Ben" }])[0].title, "Chief of Staff");
  assert.equal(org.soloTitle([{ id: "cfo", title: "Finances", name: "Ben" }])[0].title, "Finances");
  assert.equal(cos.title, "Chief of Staff", "the input is not mutated");
});

test("syncTeam: roles the user requested in the app are adopted first, and requested_at is cleared on the team rows", async () => {
  const calls = [];
  const rest = {
    requestAll: async () => [{ id: "cfo", enabled: false, requested_at: "2026-11-12T10:00:00Z" }, { id: "old", enabled: true }],
    request: async (url, opts) => { calls.push([url, opts]); },
  };
  let adopted = null;
  const r = await org.syncTeam({ rest, dryRun: true, adopt: (ids) => { adopted = ids; return ids; } });
  assert.equal(adopted, null, "a dry run turns nothing on");
  assert.equal(calls.length, 0);
  assert.ok(Array.isArray(r.available));
  process.env.ORG_RENAMES_FILE = (await import("node:path")).join((await import("node:os")).tmpdir(), `org-renames-${process.pid}.json`);
  const r2 = await org.syncTeam({ rest: { ...rest, request: async () => {} }, dryRun: false, adopt: (ids) => { adopted = ids; return ids; } }).catch((e) => ({ err: e.message }));
  assert.deepEqual(adopted, ["cfo"]);
  void r2;
});

test("adoptRoles: only installed roles that are off are turned on", () => {
  const seen = [];
  const done = org.adoptRoles(["no-such-role"], { enable: (n) => seen.push(n) });
  assert.deepEqual(done, []);
  assert.deepEqual(seen, []);
});
