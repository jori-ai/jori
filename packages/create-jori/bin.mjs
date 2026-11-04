#!/usr/bin/env node
// create-jori — `npm create jori` / `npx create-jori`.
//
// Runs the same installer as `curl -fsSL https://getjori.ai/install.sh | bash`
// (site/install.sh, copied into this package when it is packed): installs what
// is missing, puts Jori in ~/Dev/jori and opens the setup page.
//
//   npx create-jori [dir] [--no-setup] [--no-ollama]

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv, env = process.env) {
  const out = { env: {}, help: false };
  for (const a of argv) {
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--no-setup") out.env.JORI_NO_SETUP = "1";
    else if (a === "--no-ollama") out.env.JORI_NO_OLLAMA = "1";
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else out.env.JORI_HOME = path.resolve(a.replace(/^~(?=$|\/)/, env.HOME || os.homedir()));
  }
  return out;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`create-jori: ${e.message}`); process.exit(2); }
  if (opts.help) {
    console.log("npm create jori [-- [dir] [--no-setup] [--no-ollama]]\n");
    // kernel-closure-ok: help text naming the installer default, before any checkout exists
    console.log("Installs Jori (default ~/Dev/jori) and opens the setup page in your browser.");
    console.log("  dir          where to put Jori");
    console.log("  --no-setup   install only; run `jori setup` later");
    console.log("  --no-ollama  skip local memory search");
    return;
  }
  if (!["darwin", "linux"].includes(process.platform)) { console.error("create-jori: Jori runs on macOS (and, partly, Linux)."); process.exit(1); }
  const script = path.join(HERE, "install.sh");
  if (!fs.existsSync(script)) { console.error("create-jori: this package is missing install.sh; reinstall it."); process.exit(1); }
  const child = spawn("/bin/bash", [script], { stdio: "inherit", env: { ...process.env, ...opts.env } });
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
