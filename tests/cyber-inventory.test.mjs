// cyber-inventory.test.mjs — lockfile parsing and the exact-name lookup that
// cyber-watch's exposure check rests on. A parser that silently drops a format
// makes every verdict for that ecosystem a false "not found".

import test from "node:test";
import assert from "node:assert/strict";
import { parseManifest, indexPackages, lookupSoftware } from "../lib/cyber-inventory.mjs";

const names = (rows) => rows.map((r) => `${r.eco}:${r.name}@${r.version}${r.dev ? ":dev" : ""}`).sort();

test("package-lock v3", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/next": { version: "15.5.2" }, "node_modules/a/node_modules/@scope/b": { version: "1.0.0", dev: true } } });
  assert.deepEqual(names(parseManifest("web/package-lock.json", lock)), ["npm:@scope/b@1.0.0:dev", "npm:next@15.5.2"]);
});

test("package-lock v1", () => {
  const lock = JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: "4.17.21", dependencies: { x: { version: "1.0.0" } } } } });
  assert.deepEqual(names(parseManifest("package-lock.json", lock)), ["npm:lodash@4.17.21", "npm:x@1.0.0"]);
});

test("pnpm-lock v9 and v6 keys", () => {
  const y = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages:\n  next@15.1.0:\n    resolution: {}\n  '@babel/core@7.24.0':\n    resolution: {}\nsnapshots:\n  react@19.0.0(x@1):\n    dependencies: {}\n";
  assert.deepEqual(names(parseManifest("pnpm-lock.yaml", y)), ["npm:@babel/core@7.24.0", "npm:next@15.1.0", "npm:react@19.0.0"]);
  const y6 = "lockfileVersion: '6.0'\npackages:\n  /lodash@4.17.21:\n    resolution: {}\n";
  assert.deepEqual(names(parseManifest("pnpm-lock.yaml", y6)), ["npm:lodash@4.17.21"]);
});

test("yarn.lock v1 and berry", () => {
  const v1 = '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.2.0"\n  resolved "x"\n\nlodash@^4:\n  version "4.17.21"\n';
  assert.deepEqual(names(parseManifest("yarn.lock", v1)), ["npm:@babel/core@7.2.0", "npm:lodash@4.17.21"]);
  const berry = '"next@npm:^15.0.0":\n  version: 15.0.3\n  resolution: "next@npm:15.0.3"\n';
  assert.deepEqual(names(parseManifest("yarn.lock", berry)), ["npm:next@15.0.3"]);
});

test("pubspec.lock, requirements, poetry, Cargo, Package.resolved, Podfile.lock, Dockerfile", () => {
  assert.deepEqual(names(parseManifest("pubspec.lock", 'packages:\n  http:\n    dependency: "direct main"\n    version: "1.2.0"\n')), ["Pub:http@1.2.0"]);
  assert.deepEqual(names(parseManifest("requirements.txt", "LiteLLM==1.107.0\nrequests>=2\n# c\nflask[async]==3.0.0\n")), ["PyPI:flask@3.0.0", "PyPI:litellm@1.107.0"]);
  assert.deepEqual(names(parseManifest("poetry.lock", '[[package]]\nname = "Django"\nversion = "5.0.1"\n')), ["PyPI:django@5.0.1"]);
  assert.deepEqual(names(parseManifest("Cargo.lock", '[[package]]\nname = "tokio"\nversion = "1.38.0"\n')), ["crates.io:tokio@1.38.0"]);
  assert.deepEqual(names(parseManifest("Package.resolved", JSON.stringify({ pins: [{ identity: "swift-nio", location: "https://github.com/apple/swift-nio.git", state: { version: "2.60.0" } }] }))), ["SwiftURL:github.com/apple/swift-nio@2.60.0"]);
  assert.deepEqual(names(parseManifest("ios/Podfile.lock", "PODS:\n  - Firebase/Core (10.1.0):\n    - x\n")), ["CocoaPods:Firebase/Core@10.1.0"]);
  assert.deepEqual(names(parseManifest("Dockerfile", "FROM --platform=linux/amd64 node:20-slim AS b\nRUN x\n")), ["docker-image:node@20-slim"]);
});

test("unparseable manifest is skipped, not fatal", () => {
  assert.deepEqual(parseManifest("package-lock.json", "{not json"), []);
});

test("lookup: exact name across repos and the host, ecosystem filter honoured", () => {
  const inv = {
    index: indexPackages([{ eco: "npm", name: "next", version: "15.5.2", repo: "rentals-site", file: "package-lock.json" }, { eco: "PyPI", name: "next", version: "1.0", repo: "x", file: "r.txt" }]),
    host: { runtimes: { node: "v26.10.0" }, brew: { node: "26.10.0_1" }, npm_global: {}, pip: {}, docker_images: [] },
  };
  const npmOnly = lookupSoftware(inv, [{ name: "Next", ecosystem: "npm" }]);
  assert.equal(npmOnly.length, 1);
  assert.equal(npmOnly[0].installs[0].repo, "rentals-site");
  assert.equal(lookupSoftware(inv, [{ name: "next", ecosystem: "any" }]).length, 2);
  const node = lookupSoftware(inv, [{ name: "node", ecosystem: "runtime" }]);
  assert.deepEqual(node.map((h) => h.where).sort(), ["mac-mini homebrew", "mac-mini runtime"]); // no repo row named node here
  assert.equal(lookupSoftware(inv, [{ name: "litellm", ecosystem: "any" }]).length, 0);
});
