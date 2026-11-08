// The assistant's pronouns: parsed into every form, told to the agents, used
// by the pages. The owner (2026-11-04): "jori is an "it" but "Claudette" is a "She/her"".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function withInstance(obj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pronouns-"));
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify(obj));
  const was = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = dir;
  delete require.cache[require.resolve("../lib/instance.cjs")];
  try { return fn(require("../lib/instance.cjs")); } finally {
    if (was === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = was;
    delete require.cache[require.resolve("../lib/instance.cjs")];
  }
}

test("parsePronouns: known sets, custom sets, default it/its", () => {
  const { parsePronouns } = require("../lib/instance.cjs");
  assert.equal(parsePronouns("She/Her").possessive, "her");
  assert.equal(parsePronouns("she/her").possessivePronoun, "hers");
  assert.equal(parsePronouns("he/him").possessive, "his");
  assert.equal(parsePronouns("they/them").reflexive, "themselves");
  assert.equal(parsePronouns("").label, "it/its");
  const xe = parsePronouns("xe/xem/xyr");
  assert.deepEqual([xe.subject, xe.object, xe.possessive], ["xe", "xem", "xyr"]);
});

test("identityBlock names the assistant, its pronouns and earlier names", () => {
  withInstance({ assistant_name: "Ada", assistant_pronouns: "she/her", owner_name: "Sam", assistant_aliases: ["Bo"] }, (inst) => {
    const b = inst.identityBlock();
    assert.match(b, /You are Ada, Sam's assistant\. Your pronouns are she\/her/);
    assert.ok(b.includes(`"Ada said she'll check"`));
    assert.match(b, /never "it"/);
    assert.match(b, /earlier called Bo/);
  });
  withInstance({ assistant_name: "Ada" }, (inst) => {
    const b = inst.identityBlock();
    assert.match(b, /pronouns are it\/its/);
    assert.doesNotMatch(b, /never "it"/);
  });
});

test("the wiki homepage uses the possessive", () => {
  const portal = require("../lib/wiki-portal.js");
  portal.setAssistant("Ada", "she/her");
  assert.match(portal.homeBody({ pages: [], portal: { topics: [] } }), /Ada searches everything in her memory[^.]*with her sources/);
  portal.setAssistant("Ada", "they/them");
  assert.match(portal.homeBody({ pages: [], portal: { topics: [] } }), /in their memory/);
  portal.setAssistant("Ada", "it/its");
});
