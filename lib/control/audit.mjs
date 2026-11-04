// control/audit.mjs — the change history behind the control room.
//
// Every write the control room makes appends one line to
// data/config-audit.jsonl: when, who, what (a sentence), the target, and an
// `undo` — the action + args that put it back. File writes keep the previous
// copy under data/backups/control/ and undo restores that copy.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installTools } = require("../root.cjs");
const { writeFileAtomic } = require("../atomic-write.js");

export const AUDIT_FILE = () => process.env.JORI_CONTROL_AUDIT || installTools("data", "config-audit.jsonl");
const BACKUP_DIR = () => process.env.JORI_CONTROL_BACKUPS || installTools("data", "backups", "control");

export function record({ who, page, what, target, undo = null, detail = null }) {
  const entry = { id: crypto.randomBytes(6).toString("hex"), ts: new Date().toISOString(), who, page, what, target, undo, detail };
  fs.mkdirSync(path.dirname(AUDIT_FILE()), { recursive: true });
  fs.appendFileSync(AUDIT_FILE(), JSON.stringify(entry) + "\n");
  return entry;
}

export function history(limit = 200) {
  let text = "";
  try { text = fs.readFileSync(AUDIT_FILE(), "utf8"); } catch { return []; }
  return text.trim().split("\n").filter(Boolean).slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).reverse();
}

export function entry(id) {
  return history(5000).find((e) => e.id === id) || null;
}

// Back up `file` (if it exists) and write `content` atomically. Returns the
// backup path ("" when the file did not exist before).
export function writeWithBackup(file, content) {
  let backup = "";
  if (fs.existsSync(file)) {
    fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = path.join(BACKUP_DIR(), `${path.basename(file)}.${stamp}`);
    fs.copyFileSync(file, backup);
  }
  writeFileAtomic(file, content);
  return backup;
}
