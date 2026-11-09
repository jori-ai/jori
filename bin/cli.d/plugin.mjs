// jori plugin — list, enable, disable, install, remove and sync feature plugins.
// Design: system/plugins.md. Logic: lib/plugins.cjs (questions) and
// lib/plugin-manager.mjs (changes). Every change is also recorded in the
// control room's change history.

import { createRequire } from "node:module";
import * as M from "../../lib/plugin-manager.mjs";
import { record } from "../../lib/control/audit.mjs";

const require = createRequire(import.meta.url);
const P = require("../../lib/plugins.cjs");

const who = () => `cli ${process.env.USER || ""}`.trim();

function describeSync(r, c) {
  const lines = [];
  for (const x of r.cron || []) lines.push(`  crontab ${x.op.padEnd(8)} ${x.label}${x.problem ? `  (${x.problem})` : ""}`);
  for (const x of r.launchd || []) lines.push(`  launchd ${x.op.padEnd(8)} ${x.label}`);
  if (r.skipped) lines.push(c.dim(`  ${r.skipped}`));
  return lines.length ? lines.join("\n") : c.dim("  nothing to change");
}

export default {
  name: "plugin",
  summary: "feature plugins: list, info, new, enable, disable, install, remove, sync, check",
  usage: "plugin [list|info <name>|new <name> [--title T] [--local] [--schedule CRON] [--job] [--approval ACTION]|enable <name> [--force]|disable <name>|install <path|git-url> [--local]|remove <name> [--purge-config]|sync [--dry-run]|check]",
  async run(args, ctx) {
    const { c, die, hasFlag } = ctx;
    const [cmd = "list", name] = args;
    if (hasFlag(args, "--dry-run")) M._setIo({ dryRun: true });
    switch (cmd) {
      case "list": {
        const all = P.plugins();
        if (!all.length) { console.log(c.dim("No plugins installed (plugins/ and agent/local/plugins/).")); return; }
        console.log(ctx.table(all.map((p) => ({ state: P.isEnabled(p.name, all) ? c.green("on") : c.dim("off"), plugin: p.name, where: p.scope, what: p.errors.length ? c.red(`invalid: ${p.errors[0]}`) : p.manifest.title })), ["state", "plugin", "where", "what"]));
        return;
      }
      case "info": {
        const p = P.plugin(name) || die(`no plugin named ${name}`);
        const m = p.manifest;
        console.log(`${c.bold(m.title || p.name)} ${c.dim(`(${p.name} ${m.version || ""}, ${p.scope}, ${P.isEnabled(p.name) ? "on" : "off"})`)}`);
        console.log(m.description || "");
        console.log(c.dim(`  dir       ${p.dir}`));
        const sch = P.schedulesOf(p);
        if (sch.length) console.log(`  schedules ${sch.map((s) => `${s.label} (${s.cron})`).join(", ")}`);
        if (m.launchd?.length) console.log(`  launchd   ${m.launchd.map((l) => l.label).join(", ")}`);
        if (Object.keys(m.jobs || {}).length) console.log(`  jobs      ${Object.keys(m.jobs).join(", ")}`);
        if (Object.keys(m.approvals || {}).length) console.log(`  approvals ${Object.keys(m.approvals).join(", ")} (Face ID before each run)`);
        if (m.provides_bins?.length) console.log(`  commands  ${m.provides_bins.join(", ")}`);
        if (m.config?.name) console.log(`  settings  agent/local/config/${m.config.name}.json`);
        const miss = M.missingRequirements(p);
        console.log(miss.length ? c.yellow(`  needs     ${miss.join(", ")}`) : c.dim("  needs     nothing missing"));
        for (const e of p.errors) console.log(c.red(`  problem   ${e}`));
        return;
      }
      case "enable": {
        if (!name) die("usage: jori plugin enable <name>");
        const r = M.enable(name, { force: hasFlag(args, "--force") });
        record({ who: who(), page: "plugins", what: `Turned on the ${name} plugin`, target: `plugin:${name}`, undo: { action: "plugin.disable", args: { name } } });
        console.log(c.green(`✓ ${name} is on`) + (r.seeded ? c.dim(`  (settings seeded: ${r.seeded})`) : ""));
        console.log(describeSync(r, c));
        return;
      }
      case "disable": {
        if (!name) die("usage: jori plugin disable <name>");
        const r = M.disable(name);
        record({ who: who(), page: "plugins", what: `Turned off the ${name} plugin`, target: `plugin:${name}`, undo: { action: "plugin.enable", args: { name } } });
        console.log(c.green(`✓ ${name} is off`) + c.dim("  (settings and data kept)"));
        console.log(describeSync(r, c));
        return;
      }
      case "install": {
        if (!name) die("usage: jori plugin install <path|git-url> [--local]");
        const r = M.install(name, { local: hasFlag(args, "--local") });
        record({ who: who(), page: "plugins", what: `Installed the ${r.name} plugin`, target: `plugin:${r.name}`, undo: { action: "plugin.remove", args: { name: r.name } } });
        console.log(c.green(`✓ installed ${r.name}`) + c.dim(` at ${r.dir}`));
        console.log(describeSync(r, c));
        return;
      }
      case "remove": {
        if (!name) die("usage: jori plugin remove <name> [--purge-config]");
        const r = M.remove(name, { purgeConfig: hasFlag(args, "--purge-config") });
        record({ who: who(), page: "plugins", what: `Removed the ${name} plugin`, target: `plugin:${name}` });
        console.log(c.green(`✓ removed ${name}`) + c.dim(` (${r.removed})`));
        console.log(describeSync(r, c));
        return;
      }
      case "new": {
        if (!name) die('usage: jori plugin new <name> [--title "Title"] [--local] [--schedule "15 8 * * *"] [--job] [--approval <action>]');
        const r = M.create(name, { local: hasFlag(args, "--local"), title: ctx.getFlag(args, "--title"), schedule: ctx.getFlag(args, "--schedule"), job: hasFlag(args, "--job"), approval: ctx.getFlag(args, "--approval") });
        record({ who: who(), page: "plugins", what: `Created the ${name} plugin`, target: `plugin:${name}` });
        console.log(c.green(`✓ created ${name}`) + c.dim(` at ${r.dir}`));
        for (const f of r.files) console.log(c.dim(`  ${f}`));
        console.log(`Next: fill in plugin.json and the command, run ${c.bold(`node --test ${r.dir}/tests/`)}, then ${c.bold(`jori plugin enable ${name}`)}.`);
        console.log(c.dim("Guide: docs/writing-a-plugin.md"));
        return;
      }
      case "sync": {
        const r = M.sync();
        console.log(describeSync(r, c));
        return;
      }
      case "check": {
        const probs = M.check();
        if (!probs.length) { console.log(c.green("✓ plugins check clean")); return; }
        for (const p of probs) console.log(`${c.red("✗")} ${p.plugin}: ${p.problem}`);
        process.exitCode = 1;
        return;
      }
      default:
        die(`unknown: jori plugin ${cmd}. ${this.usage}`);
    }
  },
};
