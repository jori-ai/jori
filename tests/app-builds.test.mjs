// app-builds.test.mjs — where app builds run is configuration.
// Run: node --test tests/app-builds.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTargets, dispatchArgs, runIdFrom, DEFAULTS } = require("../lib/app-builds.cjs");

test("with no config, the kernel's own workflows are the target", () => {
  const t = buildTargets({});
  assert.deepEqual(t.ios, DEFAULTS.ios);
  assert.deepEqual(t.macos, DEFAULTS.macos);
});

test("an installation's config replaces the target per platform", () => {
  const t = buildTargets({ ios: { repo: "me/overlay", workflow: "app-ios.yml", ref: "main", inputs: { kernel_ref: "install" } } });
  assert.deepEqual(t.ios, { repo: "me/overlay", workflow: "app-ios.yml", ref: "main", inputs: { kernel_ref: "install" } });
  assert.deepEqual(t.macos, DEFAULTS.macos);
});

test("a platform can be turned off", () => {
  assert.equal(buildTargets({ macos: false }).macos, null);
});

test("a malformed target is refused", () => {
  assert.throws(() => buildTargets({ ios: { repo: "no-slash" } }), /owner\/name/);
  assert.throws(() => buildTargets({ ios: { workflow: "" } }), /ios.workflow/);
});

test("dispatch args carry the target and its inputs; overrides win, empties drop", () => {
  const t = { repo: "me/overlay", workflow: "app-ios.yml", ref: "main", inputs: { kernel_ref: "install", x: "" } };
  assert.deepEqual(dispatchArgs(t, { kernel_ref: "feature" }),
    ["workflow", "run", "app-ios.yml", "-R", "me/overlay", "--ref", "main", "-f", "kernel_ref=feature"]);
});

test("the run id is read from gh's printed run URL", () => {
  assert.equal(runIdFrom("https://github.com/me/overlay/actions/runs/41186928190\n"), "41186928190");
  assert.equal(runIdFrom("nothing here"), null);
});
