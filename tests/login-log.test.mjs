// lib/login-log.cjs — causes, observation rows, per-site summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-log-"));
process.env.JORI_LOGIN_LOG = path.join(dir, "log.jsonl");
const L = createRequire(import.meta.url)("../lib/login-log.cjs");

test("classify separates a missing login from an unreachable 1Password", () => {
  assert.equal(L.classify("no_credentials", "site-pass: spawnSync /x/bin/site-pass ETIMEDOUT; dev-pass: spawnSync ETIMEDOUT"), "credential_store_timeout");
  assert.equal(L.classify("no_credentials", "site-pass: OP_LOGINS_SERVICE_ACCOUNT_TOKEN is not set and no secrets broker answers."), "credential_store_token_missing");
  assert.equal(L.classify("no_credentials", "site-pass: no item"), "no_saved_login");
  assert.equal(L.CAUSES.credential_store_timeout.needs_user, false);
  assert.equal(L.CAUSES.no_saved_login.needs_user, true);
});

test("classify maps every site-login status", () => {
  assert.equal(L.classify("bad_credentials"), "password_rejected");
  assert.equal(L.classify("needs_2fa"), "one_time_code");
  assert.equal(L.classify("captcha"), "robot_check");
  assert.equal(L.classify("still_signed_out"), "login_not_sticking");
  assert.equal(L.classify("error", "Chrome on :9222 is not answering"), "chrome_down");
  assert.equal(L.classify("signed_in"), "ok");
  assert.equal(L.classify("weird"), "other");
});

test("record marks observations as not attempts and summarize tracks failing", () => {
  L.record({ site: "awardwallet.com", status: "signed_out", detail: "https://awardwallet.com/login", source: "t" });
  L.record({ site: "awardwallet.com", status: "no_credentials", detail: "ETIMEDOUT", source: "t" });
  L.record({ site: "linkedin.com", status: "still_signed_out", source: "t" });
  const rows = L.read();
  assert.equal(rows[0].attempt, false);
  assert.equal(rows[1].attempt, true);
  let s = Object.fromEntries(L.summarize(rows).map((x) => [x.site, x]));
  assert.equal(s["awardwallet.com"].failing, true);
  assert.equal(s["awardwallet.com"].last.cause, "credential_store_timeout");
  L.record({ site: "awardwallet.com", status: "signed_in", source: "t" });
  s = Object.fromEntries(L.summarize(L.read()).map((x) => [x.site, x]));
  assert.equal(s["awardwallet.com"].failing, false);
  assert.equal(s["linkedin.com"].failing, true);
});

test("old rows without a cause are classified on read", () => {
  fs.appendFileSync(process.env.JORI_LOGIN_LOG, JSON.stringify({ ts: new Date().toISOString(), site: "x.com", port: "9222", status: "captcha", detail: "" }) + "\n");
  const r = L.read().find((x) => x.site === "x.com");
  assert.equal(r.cause, "robot_check");
  assert.equal(r.attempt, true);
});
