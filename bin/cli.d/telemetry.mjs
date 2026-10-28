// jori telemetry — show or change the anonymous install-ping setting.
//
//   jori telemetry [status]   effective setting, endpoint, contexts already pinged
//   jori telemetry on|off     write JORI_TELEMETRY=on|off to .env
//   jori telemetry ping [--ctx C] [--force]
//                               send the ping now (still honours every opt-out)
//
// What is sent and why: bin/cli.d/_telemetry.mjs and apps/telemetry/README.md.
// JORI_NO_TELEMETRY=1 in the environment always wins.

import fs from "node:fs";
import path from "node:path";
import { CHECKOUT, setDotEnv, isHelp } from "./_common.mjs";
import { telemetryState, telemetryUrl, payloadFor, sendInstallPing } from "./_telemetry.mjs";

export default {
  summary: "show or change the anonymous install ping",
  usage: "telemetry [on|off|ping]",
  async run(args, ctx) {
    const { c, die, getFlag, hasFlag } = ctx;
    const sub = args.find((a) => !a.startsWith("--")) || "status";
    if (isHelp(args)) {
      console.log("Usage: jori telemetry [status] | on | off | ping [--ctx <label>] [--force]");
      console.log("One anonymous first-run ping per host and context; no PII, no raw IP.");
      console.log("JORI_NO_TELEMETRY=1 in the environment disables it whatever .env says.");
      return;
    }
    const envPath = path.join(CHECKOUT, ".env");
    if (sub === "status") {
      const st = telemetryState(CHECKOUT);
      console.log(`${c.bold("install ping:")} ${st.enabled ? c.green("on") : c.yellow("off")}  ${c.dim(`(${st.reason})`)}`);
      console.log(`${c.bold("endpoint:")}     ${telemetryUrl()}`);
      let pinged = [];
      try { pinged = fs.readdirSync(path.join(CHECKOUT, "data")).filter((f) => f.startsWith(".install-pinged-")).map((f) => f.slice(".install-pinged-".length)); } catch {}
      console.log(`${c.bold("pinged:")}       ${pinged.length ? pinged.join(", ") : c.dim("never")}`);
      console.log(`${c.bold("payload:")}      ${JSON.stringify(payloadFor(CHECKOUT, "<ctx>"))}`);
      return;
    }
    if (sub === "on" || sub === "off") {
      setDotEnv(envPath, "JORI_TELEMETRY", sub);
      console.log(c.green(`✓ JORI_TELEMETRY=${sub} written to .env`));
      if (sub === "on" && process.env.JORI_NO_TELEMETRY === "1") console.log(c.yellow("  note: JORI_NO_TELEMETRY=1 in this environment still disables the ping"));
      return;
    }
    if (sub === "ping") {
      const ctxLabel = getFlag(args, "--ctx", "fresh-install");
      if (!/^[a-z0-9-]{1,40}$/.test(ctxLabel)) die("--ctx: lowercase letters, digits and dashes only");
      const r = await sendInstallPing(CHECKOUT, ctxLabel, { force: hasFlag(args, "--force") });
      console.log(r === "sent" ? c.green(`✓ ping sent (ctx=${ctxLabel})`) : c.dim(`not sent — ${r.replace(/^skipped:/, "")}`));
      return;
    }
    die(`unknown: telemetry ${sub}. Try: jori telemetry help`);
  },
};
