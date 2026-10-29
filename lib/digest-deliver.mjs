// digest-deliver.mjs — the long-form delivery rule, in code.
//
// ops-agent/CLAUDE.md § Long-form delivery rule: a scheduled-job digest ships
// as ONE email from the agent, then (in the user's Gmail) label `personal` +
// star + mark read — where the installation's P1 sender policy makes all agent
// email P1 (data/p1-senders.json; intake adds `p1`), gmail-action refuses that
// mark-read unless an exception there lets a digest go read; then an optional
// one-line phone pointer and an APNs push. Every digest playbook used to hand-roll the Gmail half as an
// `until … do sleep 5; done` loop with no cap — morning-digest's could wait
// forever if Gmail never indexed the message, until the supervisor killed the
// turn. Here the wait is bounded and a miss is logged, not fatal: the email
// still arrived, it is just unlabeled.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, agentAddresses } = require("./instance.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, "..");
const BIN = (n) => path.join(REPO, "bin", n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The owner's address (instance().owner_email), the default recipient. */
export const ownerEmail = () => instance().owner_email;

/** Send the HTML email via email-send (the agent's identity). Throws on failure. */
export function sendHtmlEmail({ to = ownerEmail(), subject, html }) {
  if (!to) throw new Error("sendHtmlEmail: no recipient (instance owner_email is not set)");
  const file = path.join(os.tmpdir(), `digest-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  try {
    execFileSync(BIN("email-send"), ["--to", to, "--subject", subject, "--body-file", file, "--html"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  } finally { try { fs.unlinkSync(file); } catch {} }
}

/** Find the just-sent message in the user's Gmail by exact subject; bounded wait. */
//
// Gmail's `subject:` operator is a contains-match, so it also returns
// the agent's own "Re: <subject>" answers in the same thread — an early
// version picked the agent's reply to the user (a P1, meant to stay unread)
// instead of the digest. So every candidate's Subject header must equal the
// subject exactly; Gmail returns newest first, so the first exact match wins.
// `gmail` is a test seam ({ searchIds, getMessage }).
// The sender clause is the agent's own addresses (agentAddresses()); with none
// configured there is nothing to look for and the answer is null at once.
export async function findSentMessageId(subject, { attempts = 12, delayMs = 10000, gmail = null, fromAddresses = agentAddresses() } = {}) {
  if (!fromAddresses.length) return null;
  const g = gmail || (await import("./gmail-read.mjs"));
  // Gmail search syntax: the subject is quoted, so a stray quote is dropped.
  const q = `{${fromAddresses.map((a) => `from:${a}`).join(" ")}} subject:"${String(subject).replaceAll('"', "")}" newer_than:1d`;
  for (let i = 0; i < attempts; i++) {
    try {
      for (const id of await g.searchIds(q, { max: 10 })) {
        const msg = await g.getMessage(id);
        const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === "subject");
        if (h && h.value === subject) return id;
      }
    } catch {}
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

const gmailAction = (args) => spawnSync(BIN("gmail-action"), args, { stdio: "ignore", timeout: 30000 }).status;

async function messageLabels(id) {
  const { getMessage } = await import("./gmail-read.mjs");
  return (await getMessage(id)).labelIds || [];
}

/**
 * label + star + mark read (never p1, never archive), then verify the message
 * is still in the INBOX and put it back if not. Returns the message id, or
 * false if it was never found.
 *
 * The verify step exists because a digest turn once hand-ran
 * `gmail-action label-archive` and a summary was sent but never appeared in
 * the inbox. `opts.findId` / `opts.action` / `opts.labels`
 * are test seams.
 */
export async function labelDigest(subject, opts = {}) {
  const { label = "personal", findId = findSentMessageId, action = gmailAction, labels = messageLabels, log = () => {} } = opts;
  const id = await findId(subject, opts);
  if (!id) return false;
  for (const args of [["label", id, label], ["star", id], ["mark-read", id]]) {
    if (action(args) !== 0) log(`gmail-action ${args[0]} ${id} failed`);
  }
  try {
    if (!(await labels(id)).includes("INBOX")) {
      action(["unarchive", id]);
      log(`${id} was not in INBOX after labeling — restored`);
    }
  } catch (e) {
    log(`could not verify INBOX for ${id}: ${e.message}`);
  }
  return id;
}

/**
 * Phone pointer (no push — the push below is the one buzz) + APNs push.
 * Event digests whose candidates were geo-gated per item pass `geoGated: true`
 * and are expected to carry their own `geo-gate-ok:` declaration at the call site.
 */
export function pointerAndPush({ pointer, push, intent, evidenceLive = false }) {
  if (pointer) {
    const args = ["--no-push", "--suppress-hook", "--intent", intent];
    if (evidenceLive) args.push("--evidence-as-of", "live");
    args.push(pointer);
    spawnSync(BIN("jori-send-curl"), args, { stdio: "ignore", timeout: 120000 });
  }
  if (push) spawnSync(BIN("jori-notify"), [push], { stdio: "ignore", timeout: 30000 });
}

/** Batch og-card render: urls[] → html[] in input order (plain links on failure). */
export function ogCards(urls) {
  if (!urls.length) return [];
  try {
    const out = execFileSync(BIN("og-card"), ["--batch"], { input: urls.join("\n") + "\n", encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const parts = out.split("<!-- og-card-sep -->").map((s) => s.trim());
    return urls.map((u, i) => parts[i] || `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`);
  } catch {
    return urls.map((u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`);
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); // lang-regex-ok: HTML escaping
}

/** travel in-city: exit 0 in, 1 away; anything else (error) fails OPEN to "in". */
export function inCity(metro, date) {
  const r = spawnSync(BIN("travel"), ["in-city", metro, date], { stdio: "ignore", timeout: 30000 });
  return r.status !== 1;
}

/** Today's date (YYYY-MM-DD) in the installation's time zone (instance().tz). */
export function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: instance().tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
/** Older name for todayLocal(), kept for existing callers. */
export const todayET = todayLocal;
