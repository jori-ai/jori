// car-rental: billing days and aggregator links. Run: node --test plugins/car-rental/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(DIR, "bin", "car-rental");
const { billingDays, links, DEFAULTS } = createRequire(import.meta.url)(BIN);

test("a rental is billed in 24-hour periods from pickup, with a grace before the next day", () => {
  const r = billingDays("2027-03-05T21:00", "2027-03-15T09:00", 29);
  assert.equal(r.billing_days, 10);
  assert.equal(r.return_by_for_same_price, "2027-03-15T21:00");
  assert.equal(billingDays("2027-04-01T10:00", "2027-04-02T10:20", 29).billing_days, 1);
  assert.equal(billingDays("2027-04-01T10:00", "2027-04-02T10:45", 29).billing_days, 2);
  assert.equal(billingDays("2027-04-01T10:00", "2027-04-01T12:00", 29).billing_days, 1);
  assert.throws(() => billingDays("2027-04-02T10:00", "2027-04-01T10:00", 29));
  assert.throws(() => billingDays("Dec 4", "2027-04-01T10:00", 29));
});

test("links carry the dates, times, companies and classes in each site's own filter values", () => {
  const l = links({ iata: "den", pickup: "2027-03-05T21:00", ret: "2027-03-15T09:00", companies: ["Hertz", "National", "Turo"], classes: ["compact", "suv"], driverAge: 40 });
  const cr = new URL(l["carrentals.com"]).searchParams; // kernel-guard-ok: a public comparison site
  assert.equal(cr.get("locn"), "DEN");
  assert.equal(cr.get("loc2"), null);
  assert.equal(cr.get("date1"), "03/05/2027");
  assert.equal(cr.get("time1"), "0900PM");
  assert.equal(cr.get("time2"), "0900AM");
  assert.deepEqual(cr.getAll("selVen"), ["hertz", "national car rental"]);
  assert.deepEqual(cr.getAll("selCC"), ["compact", "suv"]);
  assert.deepEqual(l.unmapped_companies, ["turo"]);
  const rc = new URL(l["rentalcars.com"]).searchParams;
  assert.equal(rc.get("puHour"), "21");
  assert.equal(rc.get("doDay"), "15");
  assert.deepEqual(rc.getAll("filterCriteria_carCategory"), ["small", "suvs"]);
  assert.ok(rc.getAll("filterCriteria_supplier").includes("Hertz"));
  const oneWay = links({ iata: "DEN", returnIata: "cos", pickup: "2027-03-05T09:00", ret: "2027-03-06T09:00", companies: [], classes: [], driverAge: 40 });
  assert.equal(new URL(oneWay["carrentals.com"]).searchParams.get("loc2"), "COS"); // kernel-guard-ok: a public comparison site
  assert.equal(new URL(oneWay["rentalcars.com"]).searchParams.get("dropLocationIata"), "COS");
});

test("the command reads local settings over the defaults", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "car-rental-"));
  fs.mkdirSync(path.join(local, "config"));
  fs.writeFileSync(path.join(local, "config", "car-rental.json"), JSON.stringify({ companies: ["Sixt"], grace_minutes: 59 }));
  const env = { ...process.env, JORI_LOCAL_DIR: local };
  const s = spawnSync(process.execPath, [BIN, "settings"], { encoding: "utf8", env });
  assert.equal(s.status, 0, s.stderr);
  const cfg = JSON.parse(s.stdout);
  assert.deepEqual(cfg.companies, ["Sixt"]);
  assert.equal(cfg.preferences_page, DEFAULTS.preferences_page);
  const r = spawnSync(process.execPath, [BIN, "links", "--iata", "DEN", "--pickup", "2027-04-01T10:00", "--return", "2027-04-02T10:45"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.billing_days, 1);
  assert.deepEqual(new URL(out.links["carrentals.com"]).searchParams.getAll("selVen"), ["sixt"]); // kernel-guard-ok: a public comparison site
  assert.equal(spawnSync(process.execPath, [BIN, "nope"], { encoding: "utf8", env }).status, 2);
});
