// kernel-guard.test.mjs — the personal-data scanner for kernel files, run
// against a synthetic repo with synthetic patterns (no real pattern list).
//
// Run: node --test tests/kernel-guard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "kernel-guard");

const PATTERNS = {
  patterns: [
    { name: "owner", group: "people", severity: "hard", flags: "i", regex: "\\bzorblax\\b" },
    { name: "place", group: "places", severity: "hard", flags: "i", regex: "quuxville" },
    { name: "uuid", group: "generic_ids", severity: "hard", flags: "i", regex: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b", exclude_paths: "(^|/)tests?/" },
    { name: "pronoun", group: "people", severity: "report", flags: "i", regex: "(?<![\\w'\"`/-])(?:he|his)(?![\\w'\"`/-])" },
  ],
};

function fixture(files, manifestFiles = Object.keys(files)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-guard-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  fs.mkdirSync(path.join(root, "system"), { recursive: true });
  fs.writeFileSync(path.join(root, "system/kernel-manifest.json"), JSON.stringify({ files: Object.fromEntries(manifestFiles.map((f) => [f, f])) }));
  fs.writeFileSync(path.join(root, "system/personal-patterns.json"), JSON.stringify(PATTERNS));
  return root;
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [BIN, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, KERNEL_GUARD_PATTERNS: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("a hard hit is printed with its file and line number and exits 1", () => {
  const root = fixture({ "lib/a.mjs": "const x = 1;\n// ask zorblax first\n", "lib/b.mjs": "clean\n" });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /lib\/a\.mjs\n\s+2\s+\[owner\] \/\/ ask zorblax first/);
  assert.ok(!r.out.includes("lib/b.mjs"));
  assert.match(r.out, /1 hard, 0 report-only/);
});

test("--report never fails; report-only patterns never fail", () => {
  const root = fixture({ "a.md": "He likes quuxville.\n" });
  assert.equal(run(root, "--report").code, 0);
  const root2 = fixture({ "a.md": "when he is free\n" });
  const r = run(root2);
  assert.equal(r.code, 0);
  assert.match(r.out, /\[pronoun\] \(report\) when he is free/);
});

test("the allow marker needs a reason and exempts only its own line", () => {
  const root = fixture({ "a.sh": "echo zorblax # kernel-guard-ok: test fixture name\necho zorblax # kernel-guard-ok:\n" });
  const r = run(root, "--json");
  const res = JSON.parse(r.out);
  assert.equal(res.totals.allowed, 1);
  assert.equal(res.totals.hard, 1);
  assert.deepEqual(res.hits.filter((h) => h.status === "hard").map((h) => h.line), [2]);
  assert.equal(r.code, 1);
});

test("--summary and --json count by file and by pattern", () => {
  const root = fixture({ "x.md": "zorblax\nquuxville and zorblax\nhis\n", "y.md": "quuxville\n" });
  const s = run(root, "--summary", "--report");
  assert.match(s.out, /^\s+3\s+1\s+0\s+0\s+x\.md$/m);
  assert.match(s.out, /owner\s+hard\s+hard=2 report=0 allowed=0 baselined=0 files=1/);
  assert.match(s.out, /place\s+hard\s+hard=2 report=0 allowed=0 baselined=0 files=2/);
  const j = JSON.parse(run(root, "--json", "--summary").out);
  assert.equal(j.totals.hard, 4);
  assert.equal(j.totals.report, 1);
  assert.equal(j.by_file["y.md"].hard, 1);
  assert.equal(j.hits, undefined, "--summary leaves out the per-hit list");
});

test("exclude_paths: a UUID is fine in tests, a hit elsewhere", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const root = fixture({ "tests/t.test.mjs": `const id = "${id}";\n`, "lib/l.mjs": `const id = "${id}";\n` });
  const j = JSON.parse(run(root, "--json").out);
  assert.deepEqual(j.hits.map((h) => h.file), ["lib/l.mjs"]);
});

test("only manifest files are scanned by default; explicit paths scan what they name", () => {
  const root = fixture({ "kernel.md": "clean\n", "personal.md": "zorblax\n" }, ["kernel.md"]);
  assert.equal(run(root).code, 0);
  const r = run(root, path.join(root, "personal.md"));
  assert.equal(r.code, 1);
  assert.match(r.out, /personal\.md/);
});

test("baseline: --new fails only on hits that are not in it, and stores no raw text", () => {
  const root = fixture({ "a.md": "intro\nzorblax one\nzorblax one\n" });
  assert.equal(run(root, "--write-baseline").code, 0);
  const basePath = path.join(root, "system/kernel-guard-baseline.json");
  const raw = fs.readFileSync(basePath, "utf8");
  assert.ok(!raw.includes("zorblax"), "baseline holds hashes, not lines");
  assert.equal(JSON.parse(raw).files["a.md"].owner.length, 2);
  assert.equal(run(root, "--new").code, 0);

  // Moving the same lines does not make them new.
  fs.writeFileSync(path.join(root, "a.md"), "zorblax one\nnew intro\n\nzorblax one\n");
  assert.equal(run(root, "--new").code, 0);

  // A third copy of a baselined line is new (multiset), and so is a new line.
  fs.writeFileSync(path.join(root, "a.md"), "zorblax one\nzorblax one\nzorblax one\nquuxville\n");
  const r = run(root, "--new", "--json");
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.totals.baselined, 2);
  assert.equal(j.totals.hard, 2);
  assert.deepEqual(j.hits.filter((h) => h.status === "hard").map((h) => h.pattern).sort(), ["owner", "place"]);
});

test("--write-baseline with paths updates only those files", () => {
  const root = fixture({ "a.md": "zorblax\n", "b.md": "quuxville\n" });
  run(root, "--write-baseline");
  fs.writeFileSync(path.join(root, "a.md"), "zorblax\nzorblax two\n");
  run(root, "--write-baseline", path.join(root, "a.md"));
  const base = JSON.parse(fs.readFileSync(path.join(root, "system/kernel-guard-baseline.json"), "utf8"));
  assert.equal(base.files["a.md"].owner.length, 2);
  assert.equal(base.files["b.md"].place.length, 1);
});

test("--staged scans the staged copy of staged manifest files only", () => {
  const root = fixture({ "k.md": "clean\n", "p.md": "clean\n" }, ["k.md"]);
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, "k.md"), "zorblax staged\n");
  fs.writeFileSync(path.join(root, "p.md"), "zorblax but not kernel\n");
  git("add", "k.md", "p.md");
  fs.writeFileSync(path.join(root, "k.md"), "clean again in the working tree\n");
  const r = run(root, "--staged");
  assert.equal(r.code, 1);
  assert.match(r.out, /k\.md\n\s+1\s+\[owner\] zorblax staged/);
  assert.ok(!r.out.includes("p.md"));
});

test("a broken pattern file is a usage error (exit 2)", () => {
  const root = fixture({ "a.md": "x\n" });
  fs.writeFileSync(path.join(root, "system/personal-patterns.json"), JSON.stringify({ patterns: [{ name: "bad", regex: "(" }] }));
  assert.equal(run(root).code, 2);
});

// ── classification (--unclassified) ─────────────────────────────────────────

import { createRequire } from "node:module";
const kg = createRequire(import.meta.url)("../lib/kernel-guard.cjs");

function repo(files, manifestFiles, personalGlobs = []) {
  const root = fixture(files, manifestFiles);
  const mf = path.join(root, "system/kernel-manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.personal_globs = personalGlobs;
  fs.writeFileSync(mf, JSON.stringify(m));
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed");
  return { root, git };
}

test("globs: * stays in a directory, ** crosses them, the rest is literal", () => {
  const m = (g, p) => kg.globToRegExp(g).test(p);
  assert.ok(m("bin/travel-*", "bin/travel-sync"));
  assert.ok(!m("bin/travel-*", "bin/travel-x/y"));
  assert.ok(m("**/_ext/**", "lib/_ext/presence.mjs"));
  assert.ok(m("**/_ext/**", "_ext/a"));
  assert.ok(m("**/*-local.test.mjs", "tests/a-local.test.mjs"));
  assert.ok(!m("lib/a.mjs", "lib/aXmjs"), "a dot is literal");
  assert.ok(m("lib/place[-_]*", "lib/place_x.py"));
});

test("--unclassified: a tracked file in a kernel area must be in the manifest or personal_globs", () => {
  const { root } = repo({
    "README.md": "r\n",            // root file, root holds a manifest file → in an area
    "lib/k.mjs": "k\n",            // kernel
    "lib/travel-sync.mjs": "p\n",  // personal by glob
    "lib/sub/new.mjs": "n\n",      // below a kernel dir → in an area
    "lib/_ext/hook.mjs": "h\n",    // personal by glob
    "lib/_ext/.gitkeep": "\n",     // kernel AND matched by a glob: the manifest wins
    "data/x.json": "{}\n",         // no manifest file under data/ → outside
  }, ["package.json", "lib/k.mjs", "lib/_ext/.gitkeep"], ["lib/travel-*", "**/_ext/**", "lib/gone-*"]);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  execFileSync("git", ["add", "package.json"], { cwd: root });
  const r = run(root, "--unclassified", "--json");
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.unclassified.sort(), ["README.md", "lib/sub/new.mjs"]);
  assert.deepEqual(j.unused_globs, ["lib/gone-*"]);
  const t = run(root, "--unclassified");
  assert.match(t.out, /unclassified {2}README\.md/);
  assert.match(t.err, /personal_globs/);
});

test("--unclassified is clean when everything is decided", () => {
  const { root } = repo({ "lib/k.mjs": "k\n", "lib/p.mjs": "p\n" }, ["lib/k.mjs"], ["lib/p.mjs"]);
  const r = run(root, "--unclassified");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /0 unclassified/);
});

test("--unclassified --staged judges only the files the commit adds, against the staged manifest", () => {
  const { root, git } = repo({ "lib/k.mjs": "k\n", "lib/old.mjs": "legacy\n" }, ["lib/k.mjs"]);
  // lib/old.mjs is unclassified but already committed: not this commit's doing.
  fs.writeFileSync(path.join(root, "lib/k.mjs"), "k2\n");
  git("add", "lib/k.mjs");
  assert.equal(run(root, "--unclassified", "--staged").code, 0);

  fs.writeFileSync(path.join(root, "lib/new.mjs"), "n\n");
  git("add", "lib/new.mjs");
  const r = run(root, "--unclassified", "--staged", "--json");
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).unclassified, ["lib/new.mjs"]);

  // Classifying it in the same commit (staged manifest) clears it, even with
  // the working-tree manifest unchanged afterwards.
  const mf = path.join(root, "system/kernel-manifest.json");
  const orig = fs.readFileSync(mf, "utf8");
  const m = JSON.parse(orig);
  m.files["lib/new.mjs"] = "lib/new.mjs";
  fs.writeFileSync(mf, JSON.stringify(m));
  git("add", "system/kernel-manifest.json");
  fs.writeFileSync(mf, orig);
  assert.equal(run(root, "--unclassified", "--staged").code, 0);
});

test("--unclassified --staged sees the new name of a renamed file", () => {
  const { root, git } = repo({ "lib/k.mjs": "kernel body that is long enough to be detected as a rename\n" }, ["lib/k.mjs"]);
  git("mv", "lib/k.mjs", "lib/k2.mjs");
  const j = JSON.parse(run(root, "--unclassified", "--staged", "--json").out);
  assert.deepEqual(j.unclassified, ["lib/k2.mjs"]);
});

test("a hard hit prints where the content belongs instead", () => {
  const root = fixture({ "lib/a.mjs": "// ask zorblax\n" });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /changelog\.md/);
  assert.match(r.err, /agent\/local/);
  assert.match(r.err, /_ext\//);
});

// ── the library the landing hook uses ───────────────────────────────────────

test("addedHardHits counts only what the change adds (a multiset: moving a line is not new)", () => {
  const pats = kg.compilePatterns(PATTERNS);
  assert.equal(kg.addedHardHits("a.md", "x\nzorblax\n", "zorblax\ny\n", pats).length, 0);
  assert.equal(kg.addedHardHits("a.md", "zorblax\n", "zorblax\nzorblax\n", pats).length, 1);
  assert.equal(kg.addedHardHits("a.md", null, "quuxville\nhe\n", pats).length, 1, "report-only patterns never count");
  assert.equal(kg.addedHardHits("a.md", null, "zorblax # kernel-guard-ok: fixture\n", pats).length, 0);
});

test("changeRefusals: personal data in kernel files and unclassified new files; personal files are free", () => {
  const pats = kg.compilePatterns(PATTERNS);
  const manifest = { files: { "lib/k.mjs": "lib/k.mjs" }, personal_globs: ["lib/p-*"] };
  const r = kg.changeRefusals({ files: { "lib/k.mjs": "zorblax\n", "lib/p-x.mjs": "zorblax\n", "lib/n.mjs": "x\n" }, before: { "lib/k.mjs": "", "lib/p-x.mjs": "" }, manifest, patterns: pats });
  assert.equal(r.length, 2);
  assert.match(r[0], /^personal data in kernel file lib\/k\.mjs:1 \[owner\]/);
  assert.match(r[1], /^new file lib\/n\.mjs is not classified/);
  // The same change carrying its manifest entry is judged against it.
  const withEntry = { ...manifest, files: { ...manifest.files, "lib/n.mjs": "lib/n.mjs" } };
  assert.deepEqual(kg.changeRefusals({ files: { "lib/n.mjs": "x\n", "system/kernel-manifest.json": JSON.stringify(withEntry) }, before: {}, manifest, patterns: pats }), []);
  // No pattern list (a fresh install): classification still holds, the scan is skipped.
  assert.equal(kg.changeRefusals({ files: { "lib/k.mjs": "zorblax\n" }, before: {}, manifest, patterns: null }).length, 0);
});

// ── shape detectors ─────────────────────────────────────────────────────────
// Every value below is made up; each detector has a hit case and a no-hit case
// for its placeholders.

function shapeHits(files) {
  const root = fixture(files);
  const j = JSON.parse(run(root, "--json", "--report").out);
  return j.hits.map((h) => `${h.file}:${h.line}:${h.pattern}:${h.status}`);
}

test("hex_id_near_context: an 8/12-hex id next to approval/decision/disagreement/cluster words, outside tests", () => {
  const hits = shapeHits({
    "lib/a.mjs": [
      "// approval 7f3e91c2 reverted the change",
      "// disagreement 3fa9c1e07b42 closed",
      "// approval abc123def456 (a placeholder)",
      "// approval deadbeef, decision a1b2c3d4, cluster 44444444",
      "const color = '7f3e91c2'; // no record word near it",
    ].join("\n"),
    "tests/a.test.mjs": "// approval 7f3e91c2 in a fixture\n",
  });
  assert.deepEqual(hits.filter((h) => h.includes("hex_id")), ["lib/a.mjs:1:hex_id_near_context:hard", "lib/a.mjs:2:hex_id_near_context:hard"]);
});

test("incident_id: a dated si-/sic- id outside tests; the YYYYMMDD placeholder is fine", () => {
  const hits = shapeHits({
    "lib/a.mjs": "// fixed under si-20250101-03\n// cluster sic-20250102-flaky-thing\n// ids look like si-YYYYMMDD-NN\n",
    "tests/a.test.mjs": "// si-20250101-03\n",
  });
  assert.deepEqual(hits.filter((h) => h.includes("incident_id")), ["lib/a.mjs:1:incident_id:hard", "lib/a.mjs:2:incident_id:hard"]);
});

test("commit_sha: a SHA in a doc or a code comment; code strings, placeholders, colors and UUIDs are not", () => {
  const hits = shapeHits({
    "docs/a.md": "Fixed in 4e7a91c.\nPlaceholders: abc1234, def5678, 1a2b3c4, deadbeef.\nColor `#4e7a91c2`.\nid 9b1e4c7a-1d2e-4f3a-8b9c-0d1e2f3a4b5c\n",
    "lib/a.mjs": 'const sha = "4e7a91c"; // the sha under test\n// landed as 4e7a91c\n', // kernel-guard-ok: synthetic fixture for the detector under test
  });
  assert.deepEqual(hits.filter((h) => h.includes("commit_sha")), ["docs/a.md:1:commit_sha:hard", "lib/a.mjs:2:commit_sha:hard"]);
});

test("email_address: real-looking mailboxes hit; example domains, role senders, owner@ and Message-IDs do not", () => {
  const lines = [
    "zed.quorp@gmail.com",               // 1 consumer domain: always a person. kernel-guard-ok: synthetic fixture
    "pat.lin@quorpvendor.io",            // 2 a person at a company. kernel-guard-ok: synthetic fixture
    "someone@example.com",               // placeholder domain
    "a@b.c x@y.com",                     // made-up short domains
    "noreply@quorpvendor.io",            // a role sender: a triage rule, not a person
    "owner@gmail.com",                   // a placeholder mailbox
    "orders@shop.example",               // RFC 2606 TLD
    "<abc1@mail.gmail.com>",             // a short Message-ID
    "svc@example-project.iam.gserviceaccount.com",
  ];
  const hits = shapeHits({ "lib/a.md": lines.join("\n") + "\n" });
  assert.deepEqual(hits.filter((h) => h.includes("email")), ["lib/a.md:1:email_address:hard", "lib/a.md:2:email_address:hard"]);
});

test("tenant_subdomain: an account name as a SaaS tenant hits; placeholders do not", () => {
  const hits = shapeHits({
    "lib/a.md": "team zorbcorp.cloudflareaccess.com\nuse <team>.cloudflareaccess.com\nteam.cloudflareaccess.com\nhttps://example-project.supabase.co\nhttps://abcdefgh.supabase.co\nhttps://quorp-wiki.zorbcorp.workers.dev\n", // kernel-guard-ok: synthetic fixture for the detector under test
  });
  assert.deepEqual(hits.filter((h) => h.includes("tenant")), ["lib/a.md:1:tenant_subdomain:hard", "lib/a.md:6:tenant_subdomain:hard"]);
});

test("home_timezone: the pattern list's home_zones (and their abbreviations) in kernel files is hard, report-only in tests; market-hours lines and zone lists are exempt", () => {
  const root = fixture({
    "lib/a.mjs": [
      "// runs at 9:00 AEST",
      'const zone = "Australia/Sydney";',
      "const AEST_HOUR = 9;",
      "// 10:00-16:00 AEST market hours",
      '// labels like "AEST", "PT", "CT"',
      "GET /api/x and SET a key",
    ].join("\n"),
    "tests/a.test.mjs": "// 9:00 AEST\n",
  });
  fs.writeFileSync(path.join(root, "system/personal-patterns.json"), JSON.stringify({ ...PATTERNS, home_zones: ["Australia/Sydney"] }));
  const hits = JSON.parse(run(root, "--json", "--report").out).hits.map((h) => `${h.file}:${h.line}:${h.pattern}:${h.status}`);
  assert.deepEqual(hits.filter((h) => h.includes("home_timezone")), [
    "lib/a.mjs:1:home_timezone:hard", "lib/a.mjs:2:home_timezone:hard", "lib/a.mjs:3:home_timezone:hard",
    "tests/a.test.mjs:1:home_timezone_test:report",
  ]);
});

test("no home zone known (no instance tz, no home_zones): the home_timezone detector is off, not matching every line", () => {
  const hits = shapeHits({ "lib/a.mjs": "// runs at 9:00 AEST\nconst x = 1;\n" });
  assert.deepEqual(hits.filter((h) => h.includes("home_timezone")), []);
});

// ── the pattern list is the installation's ──────────────────────────────────

test("no pattern list: the scan still runs its shape detectors, says so, and --write-baseline refuses", () => {
  const root = fixture({ "lib/a.mjs": "// ask zorblax first\n// landed as 4e7a91c\n" });
  fs.rmSync(path.join(root, "system/personal-patterns.json"));
  const r = run(root, "--json");
  assert.equal(r.code, 1);
  const hits = JSON.parse(r.out).hits.map((h) => h.pattern);
  assert.deepEqual(hits, ["commit_sha"]); // the static "owner" pattern is not there to hit
  assert.match(run(root).err, /no private pattern list/);
  const b = run(root, "--write-baseline");
  assert.equal(b.code, 2);
  assert.ok(!fs.existsSync(path.join(root, "system/kernel-guard-baseline.json")));
  assert.equal(run(fixture({ "lib/b.mjs": "clean\n" }), "--patterns", "/nonexistent/patterns.json").code, 2);
});

test("the pattern list is found through $KERNEL_GUARD_PATTERNS, then kernel-guard.json patterns_file, then system/personal-patterns.json", () => {
  const root = fixture({ "lib/a.mjs": "// ask zorblax first\n// visit quuxville\n" });
  fs.rmSync(path.join(root, "system/personal-patterns.json"));
  const only = (name) => JSON.stringify({ patterns: PATTERNS.patterns.filter((p) => p.name === name) });
  fs.mkdirSync(path.join(root, "agent/local/config"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent/local/owner-only.json"), only("owner"));
  fs.writeFileSync(path.join(root, "agent/local/place-only.json"), only("place"));
  fs.writeFileSync(path.join(root, "agent/local/config/kernel-guard.json"), JSON.stringify({ patterns_file: "agent/local/owner-only.json" }));
  const names = (env) => {
    const r = spawnSync(process.execPath, [BIN, "--root", root, "--json", "lib/a.mjs"], { encoding: "utf8", cwd: root, env: { ...process.env, KERNEL_GUARD_PATTERNS: "", ...env } });
    return JSON.parse(r.stdout).hits.map((h) => h.pattern);
  };
  assert.deepEqual(names({}), ["owner"]);
  assert.deepEqual(names({ KERNEL_GUARD_PATTERNS: "agent/local/place-only.json" }), ["place"]);
  fs.rmSync(path.join(root, "agent/local/config/kernel-guard.json"));
  fs.writeFileSync(path.join(root, "system/personal-patterns.json"), JSON.stringify(PATTERNS));
  assert.deepEqual(names({}), ["owner", "place"]);
});

test("coordinates: a 4-decimal pair or keyed lat/lon hits; placeholder pairs do not", () => {
  const hits = shapeHits({
    "lib/a.md": "at 33.98712, 128.44391\n{\"lat\": 33.987, \"lon\": 128.443}\n12.3456, -65.4321\n0.0000, 0.0000\n{ lat: 10.00000, lon: 20.00000 }\nversion 1.2.3, 4.5.6\n", // kernel-guard-ok: synthetic fixture for the detector under test
  });
  assert.deepEqual(hits.filter((h) => h.includes("coordinates")), ["lib/a.md:1:coordinates:hard", "lib/a.md:2:coordinates:hard"]);
});

test("street_address: number + street + suffix hits; placeholder streets do not", () => {
  const hits = shapeHits({
    "lib/a.md": "lives at 742 Quorlington Ave\n305 W 18th St\n12 Main St, Springfield\n40 Oak Ave\n742 Evergreen Terrace\nstep 3 Read Me\n", // kernel-guard-ok: synthetic fixture for the detector under test
  });
  assert.deepEqual(hits.filter((h) => h.includes("street")), ["lib/a.md:1:street_address:hard", "lib/a.md:2:street_address:hard"]);
});

test("isPlaceholderHex: obvious fakes vs random-looking ids", () => {
  for (const h of ["abc123def456", "deadbeef", "44444444", "a1b2c3d4", "9c8d7e6f", "c0ffee01", "bead1234", "abc1234", "def5678"]) assert.ok(kg.isPlaceholderHex(h), h);
  for (const h of ["7f3e91c2", "3fa9c1e07b42", "4e7a91c", "f2d8b45e"]) assert.ok(!kg.isPlaceholderHex(h), h);
});

// ── derived patterns ────────────────────────────────────────────────────────
// A synthetic installation: personal registries and local config with made-up
// names, a kernel registry, personal files matched by personal_globs.

function derivedRepo(kernelFiles, { allow = [], tz = "Asia/Tokyo" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-guard-derived-"));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), typeof body === "string" ? body : JSON.stringify(body, null, 1)); };
  for (const [rel, body] of Object.entries(kernelFiles)) w(rel, body);
  w("lib/yacht-rebalance-core.mjs", "export {};\n"); // a kernel name that contains a personal token
  w("system/kernel-manifest.json", {
    files: Object.fromEntries(Object.keys(kernelFiles).concat(["lib/yacht-rebalance-core.mjs"]).map((f) => [f, f.replace(/^/, "")])),
    personal_globs: ["agent/local/**", "bin/zorp-*", "bin/plainword", "browsing-skills/skills/**", "agent/ops-agent/jobs/zorp-*"],
  });
  w("system/personal-patterns.json", { ...PATTERNS, derived_allow: allow });
  w("system/tasks.json", { tasks: [{ name: "kernel-task" }] });
  w("agent/local/instance.json", { _comment: "synthetic", owner_name: "Quillon", owner_email: "quillon.vex@gmail.com", domain: "quillonvex.co", tz }); // kernel-guard-ok: synthetic fixture for the detector under test
  w("agent/local/tasks.json", { tasks: [{ name: "zorp-gala-watch" }, { name: "daily-digest" }, { name: "kernel-task" }] });
  w("agent/local/job-routing.json", { jobs: { "yacht-rebalance": {} } });
  w("agent/local/services.json", { services: [{ name: "blorbo-heartbeat" }] });
  w("agent/local/chrome-jobs.json", { jobs: ["mkz-citation-monitor"] });
  w("agent/local/config/demo.json", {
    _comment: "never read",
    examples: { hedge: "As of Monday, Thaddeus Wimbleton hadn't enrolled at Glimmerholt Manor." },
    address: "742 Quorlington Ave", // kernel-guard-ok: synthetic fixture for the detector under test
    page: "user_quillon_tastes",
    team_id: "QX7Z9K2LMB",
    tags: ["calendar-event", "glorp-update"],
  });
  w("bin/zorp-ledger", "#!/bin/sh\n");
  w("bin/plainword", "#!/bin/sh\n");
  w("browsing-skills/skills/frobtix.com/SKILL.md", "# skill\n");
  w("agent/ops-agent/jobs/zorp-feast.md", "# job\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const KERNEL_DOC = [
  "ask Quillon first",                // 1 derived_instance
  "the zorp-gala-watch job",          // 2 derived_task
  "daily-digest and kernel-task",     // 3 generic / kernel: no hit
  "yacht-rebalance runs monthly",     // 4 derived_job (a life word)
  "blorbo-heartbeat posts health",    // 5 derived_service
  "yacht-rebalance-core is ours",     // 6 a kernel name containing a token: no hit
  "mkz-citation-monitor",             // 7 derived_job (chrome-jobs)
  "see zorp-ledger",                  // 8 derived_bin
  "plainword is a one-word tool",     // 9 one-word bin names are not tokens
  "the frobtix.com skill",            // 10 derived_site
  "zorp-feast playbook",              // 11 derived_job (personal playbook)
  "Thaddeus said so",                 // 12 derived_config (proper noun)
  "dinner at Glimmerholt Manor",      // 13 derived_config (phrase)
  "page user_quillon_tastes",         // 14 derived_wiki_id
  "team QX7Z9K2LMB",                  // 15 derived_config (id)
  "calendar-event tags",              // 16 common words: no hit
  "glorp-update tags",                // 17 derived_config unless allowed
  "notifyThaddeus()",                 // 18 camelCase hump: derived_config
  "mail quillonvex.co",               // 19 derived_instance (domain)
].join("\n") + "\n";

test("derived patterns: personal registry names, identity values and config proper nouns hit; generic and kernel names do not", () => {
  const root = derivedRepo({ "docs/k.md": KERNEL_DOC });
  const r = run(root, "--json");
  assert.equal(r.code, 1);
  const got = JSON.parse(r.out).hits.filter((h) => h.pattern.startsWith("derived_")).map((h) => `${h.line}:${h.pattern}`);
  assert.deepEqual(got, [
    "1:derived_instance", "2:derived_task", "4:derived_job", "5:derived_service", "7:derived_job", "8:derived_bin",
    "10:derived_site", "11:derived_job", "12:derived_config", "13:derived_config",
    "14:derived_instance", "14:derived_wiki_id", // user_quillon_tastes names the owner too
    "15:derived_config",
    "17:derived_config", "18:derived_config", "19:derived_instance",
  ]);
});

test("derived patterns: a personal file named by path in kernel code is left to --closure", () => {
  const root = derivedRepo({ "lib/k.mjs": 'import fs from "node:fs";\nexport const z = fs.existsSync(new URL("../bin/zorp-ledger.mjs", import.meta.url));\n// zorp-ledger keeps the books\n' });
  const hits = JSON.parse(run(root, "--json").out).hits.filter((h) => h.pattern === "derived_bin").map((h) => h.line);
  assert.deepEqual(hits, [3]);
});

test("derived_allow: a {token} entry drops that token, a {word} entry stops a word making names personal", () => {
  const root = derivedRepo({ "docs/k.md": "glorp-update tags\nyacht-rebalance runs\n" }, {
    allow: [{ token: "glorp-update", reason: "test: generic" }, { word: "rebalance", reason: "test: generic" }, { word: "yacht", reason: "test: generic" }],
  });
  const j = JSON.parse(run(root, "--json").out);
  assert.deepEqual(j.hits.filter((h) => h.pattern.startsWith("derived_")), []);
  const list = run(root, "--list-patterns", "--explain").out;
  assert.match(list, /derived_allow in use \(3\):/);
  assert.match(list, /"glorp-update": test: generic/);
});

test("an IANA zone id in local config is not a derived name (its area and city words are generic in kernel text)", () => {
  const root = derivedRepo({ "lib/k.mjs": "// Europe/Lisbon and Europe/Madrid are listed\nconst m = 'Lisbon';\n" });
  fs.writeFileSync(path.join(root, "agent/local/config/market.json"), JSON.stringify({ market_tz: "Europe/Lisbon" }));
  const hits = JSON.parse(run(root, "--json").out).hits.filter((h) => h.pattern === "derived_config" && h.file === "lib/k.mjs");
  assert.deepEqual(hits, []);
});

test("the instance zone is a home_timezone source too", () => {
  const root = derivedRepo({ "lib/k.mjs": "// at 09:00 JST\nconst z = 'Asia/Tokyo';\n// a line about Asia/Tokyo and Europe/Paris\n" });
  const hits = JSON.parse(run(root, "--json").out).hits.filter((h) => h.pattern === "home_timezone").map((h) => h.line);
  assert.deepEqual(hits, [1, 2]);
});

test("--explain names the registry or rule behind each hit; plain output and --json are unchanged without it", () => {
  const root = derivedRepo({ "docs/k.md": "the zorp-gala-watch job\nfixed in 4e7a91c\n" });
  const plain = run(root);
  assert.ok(!plain.out.includes("↳"));
  const ex = run(root, "--explain");
  assert.equal(ex.code, 1);
  assert.match(ex.out, /\[derived_task\] the zorp-gala-watch job\n\s+↳ derived_task: "zorp-gala-watch" from agent\/local\/tasks\.json/);
  assert.match(ex.out, /\[commit_sha\] fixed in 4e7a91c\n\s+↳ shape: a commit SHA/);
  assert.equal(JSON.parse(run(root, "--json").out).hits[0].source, undefined);
  assert.match(JSON.parse(run(root, "--json", "--explain").out).hits[0].source, /tasks\.json/);
  const list = run(root, "--list-patterns", "--explain").out;
  assert.match(list, /^derived_task\s+hard\s+derived/m);
  assert.match(list, /task\s+"zorp-gala-watch"\s+<- agent\/local\/tasks\.json/);
});

test("the landing hook's loadRepo carries the derived and shape detectors", () => {
  const root = derivedRepo({ "docs/k.md": "clean\n" });
  const { manifest, patterns } = kg.loadRepo(root);
  const r = kg.changeRefusals({ files: { "docs/k.md": "clean\nask Quillon\n// approval 7f3e91c2\n" }, before: { "docs/k.md": "clean\n" }, manifest, patterns });
  assert.equal(r.length, 2);
  assert.match(r[0], /\[derived_instance\]/);
  assert.match(r[1], /\[hex_id_near_context\]/);
});

test("kernel-guard-ok exempts a line from every detector kind: static, shape and derived", () => {
  const lines = [
    "zorblax runs it",               // 1 static
    "fixed in 4e7a91c",              // 2 shape (commit_sha)
    "ask Quillon first",             // 3 derived_instance
    "the zorp-gala-watch job",       // 4 derived_task
  ];
  const plain = derivedRepo({ "docs/k.md": lines.join("\n") + "\n" });
  const got = JSON.parse(run(plain, "--json").out).hits.filter((h) => h.status === "hard").map((h) => `${h.line}:${h.pattern}`);
  assert.deepEqual(got, ["1:owner", "2:commit_sha", "3:derived_instance", "4:derived_task"]);
  const marked = derivedRepo({ "docs/k.md": lines.map((l) => `${l} <!-- kernel-guard-ok: test fixture -->`).join("\n") + "\n" });
  const r = run(marked, "--json");
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.totals.hard, 0);
  assert.deepEqual(j.hits.map((h) => `${h.line}:${h.pattern}:${h.status}`), ["1:owner:allowed", "2:commit_sha:allowed", "3:derived_instance:allowed", "4:derived_task:allowed"]);
});

test("--staged derives its patterns from the staged registries, not the working tree", () => {
  const root = derivedRepo({ "docs/k.md": "clean\n" });
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  const tasks = path.join(root, "agent/local/tasks.json");
  const before = fs.readFileSync(tasks, "utf8");
  // A personal task registered in this commit, and a kernel line naming it.
  fs.writeFileSync(tasks, JSON.stringify({ tasks: [...JSON.parse(before).tasks, { name: "qwixtrel-scan" }] }));
  fs.writeFileSync(path.join(root, "docs/k.md"), "clean\nthe qwixtrel-scan job\n");
  git("add", "agent/local/tasks.json", "docs/k.md");
  fs.writeFileSync(tasks, before); // the working tree no longer registers it
  const r = run(root, "--staged", "--json");
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).hits.filter((h) => h.status === "hard").map((h) => `${h.line}:${h.pattern}`), ["2:derived_task"]);
  // The reverse: registered only in the working tree, so the staged view has no such token.
  const root2 = derivedRepo({ "docs/k.md": "clean\n" });
  const git2 = (...a) => execFileSync("git", a, { cwd: root2, stdio: "pipe" });
  fs.writeFileSync(path.join(root2, "docs/k.md"), "clean\nthe qwixtrel-scan job\n");
  git2("add", "docs/k.md");
  const tasks2 = path.join(root2, "agent/local/tasks.json");
  fs.writeFileSync(tasks2, JSON.stringify({ tasks: [...JSON.parse(fs.readFileSync(tasks2, "utf8")).tasks, { name: "qwixtrel-scan" }] }));
  assert.equal(run(root2, "--staged").code, 0);
  assert.equal(run(root2).code, 1, "the working-tree scan does see it");
});
