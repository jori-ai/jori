// jori setup — first-run setup in the browser.
//
// Does the part that needs no answers right away (runtime dirs, webhook
// token, seeds, .env basics, the detected time zone), then serves the setup
// page on 127.0.0.1 and opens it. The page walks through: this Mac, the
// Claude sign-in, about you, starting the service + starter schedule, and the
// ways to reach you. Safe to re-run: it only fills what is missing
// (lib/onboarding/core.mjs).
//
//   jori setup                 open the setup page
//   jori setup --no-open       print the address instead of opening a browser
//   jori setup status [--json] what is done and what is not, in the terminal
//   jori setup start           the "Keep it running" step without the page
//
// The question-by-question terminal wizard is still `jori init`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { CHECKOUT, isHelp } from "./_common.mjs";
import * as core from "../../lib/onboarding/core.mjs";
import { createSetupServer } from "../../lib/onboarding/server.mjs";
import * as host from "../../lib/onboarding/host.mjs";

const { port } = createRequire(import.meta.url)("../../lib/ports.cjs");

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

async function status(ctx, args) {
  const { c } = ctx;
  const s = await core.snapshot(CHECKOUT);
  if (args.includes("--json")) { console.log(JSON.stringify(s, null, 2)); return; }
  const mark = (ok, warn) => (ok ? c.green("✓") : warn ? c.yellow("!") : c.red("✗"));
  const lines = [
    [s.node.ok, false, "Node.js", s.node.version],
    [s.claude.installed, false, "Claude Code", s.claude.version || "not installed: npm install -g @anthropic-ai/claude-code"],
    [s.claude.loggedIn && s.claude.planOk, s.claude.loggedIn, "Claude sign-in", s.claude.loggedIn ? `${s.claude.email} (${s.claude.plan || "no plan"})` : "not signed in: claude auth login"],
    [s.ollama.running && s.ollama.model, true, "Memory search", s.ollama.running ? (s.ollama.model ? "running" : `run: ollama pull ${core.EMBED_MODEL}`) : "Ollama not running (optional)"],
    [s.identity.saved, false, "About you", s.identity.saved ? `${s.identity.owner_name}, ${s.identity.owner_email}, ${s.identity.tz}` : "not saved yet"],
    [s.service.chat && s.service.ops, s.service.running, "Service", s.service.running ? `running (chat ${s.service.chat ? "up" : "down"}, ops ${s.service.ops ? "up" : "down"})` : "not running"],
    [s.schedule.ok && s.schedule.missing === 0, false, "Starter jobs", s.schedule.ok ? `${s.schedule.total - s.schedule.missing} of ${s.schedule.total} scheduled` : s.schedule.error],
  ];
  console.log(c.bold("Jori setup") + c.dim(` — ${CHECKOUT}\n`));  // control-scan-ok: the software's name
  for (const [ok, warn, name, detail] of lines) console.log(`  ${mark(ok, warn)} ${name.padEnd(16)} ${c.dim(detail)}`);
  const h = s.host;
  console.log(c.bold(`\n  This machine`) + c.dim(` — ${h.kind}${h.remote ? ", over SSH" : ""}${h.tailscale ? `, ${h.tailscale.dns || h.tailscale.ip} on Tailscale` : ""}`));
  if (!s.alwaysOn.length) console.log(c.dim("    a laptop: it sleeps, and Jori runs while it's awake")); // control-scan-ok: the software's name
  for (const k of s.alwaysOn) {
    console.log(`  ${mark(k.ok, k.warn)} ${k.name}`);
    if (!k.ok && k.fix) console.log(c.dim(`      ${k.fix}`));
  }
  console.log(c.dim(`\n  Control room: ${s.controlUrl}`));
}

async function start(ctx) {
  const { c } = ctx;
  core.prepareCheckout(CHECKOUT);
  const sv = await core.installService({ base: CHECKOUT });
  console.log(`  ${sv.ok ? c.green("✓") : c.red("✗")} service: ${sv.message}`);
  if (!sv.ok) process.exitCode = 1;
  const sc = await core.installStarterSchedule({ base: CHECKOUT });
  console.log(`  ${sc.ok ? c.green("✓") : c.red("✗")} schedule: ${sc.message}`);
  if (!sc.ok) process.exitCode = 1;
}

export default {
  summary: "first-run setup in the browser (safe to re-run)",
  usage: "setup [status|start] [--no-open] [--local-only]",
  async run(args, ctx) {
    const { c, hasFlag } = ctx;
    if (isHelp(args)) {
      console.log(c.bold("jori setup") + " — first-run setup in the browser\n");
      console.log("  jori setup                 open the setup page (127.0.0.1 only)");
      console.log("  jori setup --no-open       print its address instead of opening a browser");
      console.log("  jori setup --local-only    over SSH, don't also answer on the Tailscale address");
      console.log("  jori setup status [--json] what is done and what is not");
      console.log("  jori setup start           start the service and schedule the starter jobs\n");
      console.log("On an always-on Mac or a VM reached over SSH, setup prints how to open the");
      console.log("page from your own computer: its Tailscale address, or an SSH tunnel.\n");
      console.log("Re-running only fills what is missing: answers already saved, a running");
      console.log("service and jobs already in the crontab are left as they are.");
      console.log("The terminal wizard is `jori init`.");
      return;
    }
    if (args[0] === "status") return status(ctx, args);
    if (args[0] === "start") return start(ctx);

    const prepared = core.prepareCheckout(CHECKOUT);
    // Over SSH (an always-on Mac, a VM) there is no browser here: the page is
    // opened from the owner's own computer, through Tailscale when this
    // machine is on a tailnet, or through an SSH tunnel either way.
    const remote = host.overSsh();
    const ts = remote && !hasFlag(args, "--local-only") ? await host.tailscale() : null;
    const tailnetHosts = ts ? [ts.ip, ts.dns, ts.dns && ts.dns.split(".")[0]].filter(Boolean).map((h) => h.toLowerCase()) : null;
    const { server, token } = createSetupServer({
      base: CHECKOUT,
      tailnetHosts,
      onEvent: (m) => console.log(c.dim(`  · ${m}`)),
      onFinish: () => {
        console.log(c.green("\n  ✓ Setup closed.") + c.dim(" Run `jori setup` any time to come back; `jori setup status` checks from here."));
        server.close();
        process.exit(0);
      },
    });
    const bind = ts ? "0.0.0.0" : "127.0.0.1";
    const want = port("setup");
    await new Promise((resolve, reject) => {
      server.once("error", (e) => (e.code === "EADDRINUSE" ? server.listen(0, bind, resolve) : reject(e)));
      server.listen(want, bind, resolve);
    });
    const p = server.address().port;
    const url = `http://127.0.0.1:${p}/?t=${token}`;
    console.log(c.bold("\n  Jori setup") + c.dim(` — ${CHECKOUT}`));  // control-scan-ok: the software's name
    if (prepared.length) console.log(c.dim(`  prepared: ${prepared.join(", ")}`));
    if (remote) {
      const user = process.env.USER || "you";
      const sshHost = ts?.dns || (await host.localHostname());
      console.log(c.dim(`\n  You're connected over SSH, so open setup from your own computer.`));
      if (ts) {
        console.log(`\n  On your tailnet, open:\n  ${c.bold(`http://${ts.dns || ts.ip}:${p}/?t=${token}`)}`);
        console.log(c.dim("\n  Or, through an SSH tunnel:"));
      } else {
        console.log(c.dim("\n  In a terminal on your computer, run:"));
      }
      console.log(`  ${c.bold(`ssh -N -L ${p}:127.0.0.1:${p} ${user}@${sshHost}`)}`);
      console.log(c.dim("  then open:") + `\n  ${c.bold(url)}\n`);
    } else {
      const opened = !hasFlag(args, "--no-open") && openBrowser(url);
      console.log(`\n  ${opened ? "Continue in your browser. If it didn’t open:" : "Open this in your browser:"}\n  ${c.bold(url)}\n`);
    }
    console.log(c.dim("  Leave this window open until you finish. Ctrl-C stops setup; nothing is lost.\n"));
    // Close by itself if the page is abandoned for two hours.
    setTimeout(() => { console.log(c.dim("  setup page closed after 2 hours")); process.exit(0); }, 2 * 3600_000).unref();
    await new Promise(() => {});
  },
};
