// link-check.test.mjs: a message to someone else is not sent with a dead or
// moved link in it.
//
// Requirement: a message that says "a link to the project repo" but carries
// the project's old URL (an archived repo since deleted) must not go out. The send
// path must refuse a GitHub link that is missing, renamed or archived, and a web link
// that answers 404/410, and must let everything it cannot judge through.
//
// GitHub and HTTP are injected (`gh`, `fetchImpl`); nothing here touches the network.
//
// Run: node --test tests/link-check.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { extractUrls, githubRepoOf, findBadLinks } from "../lib/link-check.mjs";

const repos = {
  "acme/app": { status: 200, full_name: "acme/app", archived: false },
  "acme-old/app": { status: 404 },
  "acme-old/leftover": { status: 200, full_name: "acme-old/leftover", archived: true },
  "old-owner/old-name": { status: 200, full_name: "acme/app", archived: false },
  "flaky/repo": { status: "unknown" },
};
const gh = (repo) => repos[repo] || { status: 404 };
const fetchImpl = async (url) => ({ status: url.includes("gone") ? 404 : url.includes("down") ? 503 : 200 });

test("the old-repo message is refused", async () => {
  const bad = await findBadLinks("Hi Sam, this is the assistant. You asked for a link to the app repo: https://github.com/acme-old/app", { gh, fetchImpl });
  assert.equal(bad.length, 1);
  assert.match(bad[0].problem, /does not exist/);
});

test("its correction goes through", async () => {
  assert.deepEqual(await findBadLinks("the current repo is https://github.com/acme/app (the earlier link is the old name).", { gh, fetchImpl }), []);
});

test("an archived repo is refused even while it still resolves", async () => {
  const [b] = await findBadLinks("https://github.com/acme-old/leftover", { gh, fetchImpl });
  assert.match(b.problem, /archived/);
});

test("a renamed repo is refused with the new address", async () => {
  const [b] = await findBadLinks("see github.com/old-owner/old-name.", { gh, fetchImpl });
  assert.equal(b.suggest, "https://github.com/acme/app");
});

test("only 404/410 stop a web link; down, blocked or unreachable pass", async () => {
  const bad = await findBadLinks("https://a.example/gone and https://b.example/down and https://app.example", { gh, fetchImpl });
  assert.deepEqual(bad.map((b) => b.url), ["https://a.example/gone"]);
  const throwing = async () => { throw new Error("ENOTFOUND"); };
  assert.deepEqual(await findBadLinks("https://c.example/x", { gh, fetchImpl: throwing }), []);
});

test("a GitHub lookup that cannot run lets the link through", async () => {
  assert.deepEqual(await findBadLinks("https://github.com/flaky/repo", { gh, fetchImpl }), []);
});

test("URL extraction trims sentence punctuation and unopened brackets", () => {
  assert.deepEqual(extractUrls("(see https://x.example/a_(b)), then https://y.example/z."), ["https://x.example/a_(b)", "https://y.example/z"]);
  assert.deepEqual(extractUrls("no links here"), []);
});

test("repo paths are recognised; GitHub's own pages are not repos", () => {
  assert.equal(githubRepoOf("https://github.com/acme/app/tree/main/lib"), "acme/app");
  assert.equal(githubRepoOf("https://github.com/acme/app.git"), "acme/app");
  assert.equal(githubRepoOf("https://github.com/settings/tokens"), null);
  assert.equal(githubRepoOf("https://github.com/jori-ai"), null);
  assert.equal(githubRepoOf("https://gitlab.com/a/b"), null);
});
