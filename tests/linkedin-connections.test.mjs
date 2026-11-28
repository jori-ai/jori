// linkedin-connections.test.mjs — a LinkedIn data export loads into the local
// connections table, and a lookup finds people by name or company with a tie
// that reflects messages, recommendations and endorsements (not the connection).
//
// Run: node --test tests/linkedin-connections.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "li-"));
process.env.LINKEDIN_DB = path.join(tmp, "li.db");
const require = createRequire(import.meta.url);
const li = require("../lib/linkedin-connections.js");

const exp = path.join(tmp, "export");
fs.mkdirSync(exp);
fs.writeFileSync(path.join(exp, "Connections.csv"), [
  "Notes:",
  '"Some preamble, with a comma"',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Ana,Pérez,https://www.linkedin.com/in/ana-perez,,Acme Corp,\"CTO, Platform\",03 Feb 2015",
  "Bo,Lee,https://www.linkedin.com/in/bolee,bo@example.com,Beta Labs,Engineer,18 Nov 2026",
  "Cy,Stone,https://www.linkedin.com/in/cystone,,Acme Corp,Sales,01 Jan 2020",
].join("\n"));
fs.writeFileSync(path.join(exp, "messages.csv"), [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER,ATTACHMENTS",
  'c1,,Me,https://www.linkedin.com/in/owner,Ana,https://www.linkedin.com/in/ana-perez,2016-01-02 10:00:00 UTC,,"hi,\nmultiline",INBOX,',
  "c1,,Ana,https://www.linkedin.com/in/ana-perez,Me,https://www.linkedin.com/in/owner,2016-01-03 10:00:00 UTC,,hello,INBOX,",
  "c2,,Bo,https://www.linkedin.com/in/bolee,Me,https://www.linkedin.com/in/owner,2026-11-19 10:00:00 UTC,,pitch,INBOX,",
].join("\n"));
fs.writeFileSync(path.join(exp, "Recommendations_Received.csv"),
  "First Name,Last Name,Company,Job Title,Text,Creation Date,Status\nAna,Pérez,Acme,CTO,great,\"01/01/17, 10:00 AM\",VISIBLE\n");

test("import counts connections and matches the signals", () => {
  const s = li.importExport(exp);
  assert.equal(s.connections, 3);
  assert.equal(s.messages, 3);
  assert.equal(s.recommendations, 1);
});

test("name search is accent- and prefix-tolerant, with a tie", () => {
  const [a] = li.find("ana perez");
  assert.equal(a.full_name, "Ana Pérez");
  assert.equal(a.position, "CTO, Platform");
  assert.equal(a.connected_on, "2015-02-03");
  assert.equal(a.msgs_sent, 1);
  assert.equal(a.msgs_received, 1);
  assert.equal(a.tie, "strong");
  assert.equal(li.find("pere")[0].full_name, "Ana Pérez");
});

test("company filter ranks people the owner knows first", () => {
  const rows = li.find("", { company: "acme" });
  assert.deepEqual(rows.map((r) => r.full_name), ["Ana Pérez", "Cy Stone"]);
  assert.equal(rows[1].tie, "connection only");
});

test("one inbound message is a weak tie; get by URL works", () => {
  const b = li.get("https://www.linkedin.com/in/bolee/");
  assert.equal(b.tie, "weak");
  assert.equal(b.email, "bo@example.com");
});

test("re-import replaces the snapshot", () => {
  li.importExport(exp);
  assert.equal(li.stats().connections, 3);
  li.close();
});
