// day-statements-companions.test.mjs — the model is told companions are people.
// 2026-10-23: "My cousins and their kids were also there" came back as the
// companion "cousins and their kids", printed in the dinner's header beside the
// cousins the user's correction had named, as if they were more people.
//
// Run: node --test tests/day-statements-companions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = require(path.join(ROOT, "bin/day-statements"));

test("the schema asks for people by name", () => {
  assert.ok(D.SCHEMA.includes('"companions": ["<a person, by the name the user uses: Sam, Dana>"'), D.SCHEMA);
});

test("the prompt keeps an unnamed group out of companions and puts it in activity", () => {
  const p = D.prompt("2026-10-23", "Asia/Jerusalem", "(chat)", "(windows)");
  assert.ok(p.includes("Companions are people, one per entry, by the name the user uses for each."), p);
  assert.ok(p.includes("is not a name: never put it in companions, say it in activity instead"), p);
  assert.ok(p.includes("(chat)") && p.includes("(windows)"));
});
