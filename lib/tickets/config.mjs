// lib/tickets/config.mjs — shared root + env loader for the `tickets` toolchain (event search; purchases go through bin/purchase-queue).
// No dependencies. Node 20+ (native fetch).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this file's location so case-sensitive filesystems
// (or a relocated repo) don't break. config.mjs lives at lib/tickets/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JORI_ROOT = path.resolve(__dirname, "../..");
export const ENV_PATH = path.join(JORI_ROOT, ".env");

// Tiny .env loader — same KEY=VALUE subset as lib/load-env.js.
export function loadEnv(envPath = ENV_PATH) {
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* missing .env is fine */ }
}

export function requireKey(name, docsHint) {
  loadEnv();
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing ${name} in .env. ${docsHint || ""}`.trim());
  }
  return v;
}
