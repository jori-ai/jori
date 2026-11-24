// linkedin-people.test.mjs — LinkedIn connections and wiki person pages point
// at each other: a profile URL on a page links for certain; a name match is
// only a candidate until the model says it is the same person; no page is
// created for a connection; decisions survive a re-import.
//
// Run: node --test tests/linkedin-people.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "li-people-"));
fs.mkdirSync(path.join(tmp, "memory"));
process.env.LINKEDIN_DB = path.join(tmp, "li.db");
process.env.MEMORY_INDEX_DIR = path.join(tmp, "memory");
process.env.MEMORY_INDEX_DB = path.join(tmp, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "0";

const require = createRequire(import.meta.url);
const ws = require("../lib/wiki-store.js");
const li = require("../lib/linkedin-connections.js");
const lp = require("../lib/linkedin-people.js");

const exp = path.join(tmp, "export");
fs.mkdirSync(exp);
fs.writeFileSync(path.join(exp, "Connections.csv"), [
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Ana,Pérez,https://www.linkedin.com/in/ana-perez,ana@example.com,Acme Corp,CTO,03 Feb 2015",
  "Tom,Hale,https://www.linkedin.com/in/tomhale,,Beta Labs,Engineer,18 Nov 2020",
  "Tom,Hale,https://www.linkedin.com/in/tom-hale-2,,Gamma,Sales,01 Jan 2019",
  "Zed,Quinn,https://www.linkedin.com/in/zedq,,Delta,CEO,01 Jan 2019",
].join("\n"));
li.importExport(exp);

const page = (id, title, body) => ws.savePage(id, `---\nname: ${title}\ntitle: ${title}\ntype: user\nentity: person\n---\n${body}\n`, { editedBy: "test" });
page("user_ana_perez", "Ana Perez", "Ana runs engineering at Acme.");
page("user_tom_hale", "Tom Hale (cousin)", "Cousin on the user's side; works at Beta Labs.");
page("user_zed_quinn", "Zed Quinn", "Old friend. See https://www.linkedin.com/in/zedq for his profile.");

test("a URL on the page links for certain; names wait for a decision", () => {
  const sc = lp.scan({ ws });
  assert.equal(sc.url_linked, 1);
  const ids = sc.pending.map((p) => p.page_id).sort();
  assert.deepEqual(ids, ["user_ana_perez", "user_tom_hale"]);
  const tom = sc.pending.find((p) => p.page_id === "user_tom_hale");
  assert.equal(tom.candidates.length, 2);
});

test("the model picks the same person, or none; bad answers stay pending", async () => {
  const { pending } = lp.scan({ ws });
  const answers = { user_ana_perez: '{"slug":"ana-perez","why":"Acme"}', user_tom_hale: '{"slug":"somebody-else"}' };
  const r = await lp.autoDecide(pending, { chat: async (o) => answers[JSON.parse(o.user).page_id] });
  assert.deepEqual([r.linked, r.none, r.left], [1, 0, 1]);
  lp.decide("user_tom_hale", "tomhale");
});

test("apply writes the row's page and the page's LinkedIn block", () => {
  const r = lp.apply({ ws });
  assert.equal(r.linked, 3);
  assert.equal(li.get("ana-perez").page_id, "user_ana_perez");
  assert.equal(li.get("tom-hale-2").page_id, "");
  const md = ws.getPage("user_ana_perez").raw_md;
  assert.match(md, /## LinkedIn\n<!-- linkedin:start -->/);
  assert.match(md, /CTO @ Acme Corp/);
  assert.match(md, /ana@example.com/);
  assert.equal(lp.apply({ ws }).pages_written, 0, "idempotent");
});

test("re-import keeps decisions; unlinking removes the block; no pages are created", () => {
  li.importExport(exp);
  lp.apply({ ws });
  assert.equal(li.get("tomhale").page_id, "user_tom_hale");
  lp.decide("user_tom_hale", "none");
  lp.apply({ ws });
  assert.doesNotMatch(ws.getPage("user_tom_hale").raw_md, /linkedin:start/);
  assert.equal(lp.scan({ ws }).pending.length, 0, "a 'none' on the same candidates is not asked again");
  assert.equal(ws.listPages({}).length, 3);
  li.close();
});
