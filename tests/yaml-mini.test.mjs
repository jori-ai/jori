// yaml-mini.test.mjs — unit tests for lib/yaml-mini.js.
// Run: node --test tests/yaml-mini.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yml = require(path.resolve("lib/yaml-mini.js"));

test("parses a flat mapping", () => {
  const out = yml.parse("name: Foo\ntype: user\n");
  assert.deepEqual(out, { name: "Foo", type: "user" });
});

test("parses inline array", () => {
  const out = yml.parse("scope: [lake_house, city_flat]\n");
  assert.deepEqual(out, { scope: ["lake_house", "city_flat"] });
});

test("parses quoted inline array with spaces", () => {
  const out = yml.parse('aliases: ["lake house", "12 Example Rd"]');
  assert.deepEqual(out, { aliases: ["lake house", "12 Example Rd"] });
});

test("parses nested mapping", () => {
  const text = `
entities:
  lake_house:
    type: property
    aliases: [lakehouse]
`.trimStart();
  const out = yml.parse(text);
  assert.deepEqual(out, {
    entities: {
      lake_house: { type: "property", aliases: ["lakehouse"] },
    },
  });
});

test("strips line comments outside strings", () => {
  const out = yml.parse("# top comment\nname: Foo # trailing\ntype: user");
  assert.deepEqual(out, { name: "Foo", type: "user" });
});

test("preserves # inside quoted strings", () => {
  const out = yml.parse('note: "do not # strip"');
  assert.deepEqual(out, { note: "do not # strip" });
});

test("handles booleans + null", () => {
  const out = yml.parse("a: true\nb: false\nc: null\nd: ~\n");
  assert.deepEqual(out, { a: true, b: false, c: null, d: null });
});

test("handles numbers", () => {
  const out = yml.parse("n: 42\nf: 3.14\n");
  assert.deepEqual(out, { n: 42, f: 3.14 });
});

test("empty array + empty map", () => {
  const out = yml.parse("empty_arr: []\nname: foo");
  assert.deepEqual(out, { empty_arr: [], name: "foo" });
});

test("block array of scalars", () => {
  const text = `
items:
  - alpha
  - beta
  - "gamma delta"
`.trimStart();
  const out = yml.parse(text);
  assert.deepEqual(out, { items: ["alpha", "beta", "gamma delta"] });
});

test("nested mapping with multiple entities", () => {
  const text = `
entities:
  lake_house:
    type: property
    aliases: [lakehouse, "lake-house"]
  josh_black:
    type: person
    scope: [duplex_12]
    status: active
`.trimStart();
  const out = yml.parse(text);
  assert.deepEqual(out.entities.lake_house, {
    type: "property",
    aliases: ["lakehouse", "lake-house"],
  });
  assert.deepEqual(out.entities.josh_black, {
    type: "person",
    scope: ["duplex_12"],
    status: "active",
  });
});
