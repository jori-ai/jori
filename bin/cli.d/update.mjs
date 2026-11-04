// jori update — bring this checkout up to date and restart Jori on it.
//
//   jori update              pull (fast-forward only), install packages, restart
//   jori update --check      fetch and say how far behind this checkout is
//   jori update --no-restart pull and install, leave the running service alone
//
// Steps, each skipped when there is nothing to do:
//   1. git fetch + `git pull --ff-only` on the current branch's upstream. A
//      checkout with uncommitted changes to tracked files, or one that has
//      diverged, is left exactly as it is and the command says why.
//   2. `jori overlay sync` when overlays are registered (agent/local/overlays.json).
//   3. scripts/bootstrap.sh --quiet (npm install, new runtime dirs).
//   4. launchctl kickstart -k of the loaded service (ai.jori.session, or
//      ai.claude.session on installations from before the rename).
// The Homebrew formula's `brew upgrade jori` and the Mac app's Update item
// both call this.

import fs from "node:fs";
import path from "node:path";
import { CHECKOUT, isHelp } from "./_common.mjs";
import * as core from "../../lib/onboarding/core.mjs";

const git = (args, opts) => core.run("git", ["-C", CHECKOUT, ...args], { timeout: 120000, ...opts });

export async function updateStatus() {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok) return { ok: false, branch, message: `Branch ${branch} has no upstream to update from` };
  const upstream = up.stdout.trim();
  const f = await git(["fetch", "--quiet"]);
  if (!f.ok) return { ok: false, branch, upstream, message: `git fetch failed: ${f.stderr.trim().split("\n").pop()}` };
  const counts = (await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).stdout.trim().split(/\s+/).map(Number);
  const [ahead, behind] = counts.length === 2 ? counts : [0, 0];
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  return { ok: true, branch, upstream, ahead, behind, dirty: dirty ? dirty.split("\n").length : 0 };
}

export default {
  summary: "pull the latest Jori, install packages, restart it",
  usage: "update [--check] [--no-restart]",
  async run(args, ctx) {
    const { c, hasFlag, die } = ctx;
    if (isHelp(args)) {
      console.log(c.bold("jori update") + " — bring this checkout up to date and restart Jori\n");
      console.log("  jori update              pull (fast-forward only), install packages, restart");
      console.log("  jori update --check      say how far behind this checkout is");
      console.log("  jori update --no-restart pull and install, leave the running service alone\n");
      console.log("Never merges, rebases or touches uncommitted changes.");
      return;
    }
    const st = await updateStatus();
    if (!st.ok) die(st.message);
    const where = c.dim(`${st.branch} ← ${st.upstream}`);
    if (hasFlag(args, "--check")) {
      if (hasFlag(args, "--json")) { console.log(JSON.stringify(st)); return; }
      console.log(st.behind ? `${st.behind} update(s) available ${where}` : `Up to date ${where}`);
      if (st.ahead) console.log(c.dim(`  ${st.ahead} local commit(s) not upstream`));
      return;
    }
    console.log(c.bold("Updating Jori") + " " + where);
    let pulled = false;
    if (!st.behind) {
      console.log(`  ${c.green("✓")} already up to date`);
    } else if (st.dirty) {
      die(`${st.dirty} tracked file(s) have uncommitted changes, so nothing was pulled. Commit or stash them, then run jori update again.`);
    } else if (st.ahead) {
      die(`This checkout has ${st.ahead} commit(s) that ${st.upstream} doesn't, so it can't fast-forward. Nothing was changed.`);
    } else {
      const before = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      const p = await git(["pull", "--ff-only", "--quiet"]);
      if (!p.ok) die(`git pull failed: ${p.stderr.trim()}`);
      const after = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      console.log(`  ${c.green("✓")} pulled ${st.behind} update(s) ${c.dim(`${before} → ${after}`)}`);
      pulled = true;
    }

    const overlays = path.join(CHECKOUT, "agent", "local", "overlays.json");
    if (fs.existsSync(overlays)) {
      const o = await core.run(path.join(CHECKOUT, "bin", "jori"), ["overlay", "sync"], { timeout: 120000 });
      console.log(`  ${o.ok ? c.green("✓") : c.yellow("!")} overlay sync${o.ok ? "" : `: ${o.stderr.trim().split("\n").pop()}`}`);
    }

    if (pulled || hasFlag(args, "--force")) {
      const b = await core.run(path.join(CHECKOUT, "scripts", "bootstrap.sh"), ["--quiet"], { timeout: 600000 });
      if (!b.ok) die(`scripts/bootstrap.sh failed: ${(b.stderr || b.stdout).trim().split("\n").slice(-3).join(" ")}`);
      console.log(`  ${c.green("✓")} packages installed`);
    }

    if (hasFlag(args, "--no-restart") || !pulled) {
      if (!pulled) return;
      console.log(c.dim("  not restarted (--no-restart)"));
      return;
    }
    const svc = await core.loadedServiceLabel();
    if (!svc) {
      console.log(c.dim("  Jori isn't running as a service here; start it with `jori setup start` or `jori up`."));
      return;
    }
    const k = await core.run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${svc.label}`]);
    console.log(`  ${k.ok ? c.green("✓") : c.red("✗")} restarted ${svc.label}${k.ok ? "" : `: ${k.stderr.trim()}`}`);
    if (!k.ok) process.exitCode = 1;
  },
};
