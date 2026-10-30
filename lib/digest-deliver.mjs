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

// ── Did it arrive? ───────────────────────────────────────────────────────────
//
// email-send returns as soon as the mail service (SMTP2Go) accepts a message,
// and prints `succeeded=1`. Acceptance is not delivery: the service can hold a
// message in its queue for minutes before the recipient's server takes it. A
// job that reads "succeeded" as "in the inbox" tells the user to look for mail
// that is not there yet. These answer the real question from two sources:
//
//   - the mail service's own activity log for that message (processed, then
//     delivered, or a soft/hard bounce, a rejection, a spam complaint), and
//   - when the owner is a recipient, the owner's mailbox itself, searched by
//     the message's Message-ID (in:anywhere, so Spam and Trash count too).
//
// Structure only: ids, event names, label ids, timestamps. Nothing here reads
// what an email says. The CLI is `email-send --check-delivery`.

/** Exit codes of `email-send --check-delivery`, which playbooks branch on. */
export const DELIVERY_EXIT = Object.freeze({
  landed: 0,
  unknown: 1,
  "in-transit": 2,
  bounced: 3,
  "not-in-inbox": 4,
});

// SMTP2Go builds the Message-ID header from its own email id:
// email_id 1abcDE-FGhiJK-lmNO → <E1abcDE-FGhiJK-lmNO@message-id.smtpcorp.com>. kernel-guard-ok: the provider's Message-ID format, not a mailbox
export function messageIdFor(emailId) {
  return `E${emailId}@message-id.smtpcorp.com`;
}

// Provider events that end the wait with a failure.
const FAILED_EVENTS = new Set(["hard-bounced", "rejected", "spam"]);
// Mailbox labels that mean the message arrived but not where the user looks.
const HIDDEN_LABELS = ["SPAM", "TRASH"];
// With a working activity lookup, a message the service has never heard of this
// long after sending was not taken at all. Generous, because the caller may
// re-send on that answer and a lagging log must not produce a duplicate.
const NO_RECORD_AFTER_MS = 10 * 60 * 1000;
// Accepted by the receiving server this long ago and still not in the mailbox:
// it is not a search lag any more.
const SEARCH_LAG_MS = 3 * 60 * 1000;

/**
 * The newest sent-mail log entry (data/jori-sent-mail.jsonl, written by
 * email-send) for this email id, or with exactly this subject sent within
 * `maxAgeMs`. Null when there is none.
 */
export function findSentLogEntry({ emailId = null, subject = null, logText = "", now = Date.now(), maxAgeMs = 24 * 3600 * 1000 }) {
  let found = null;
  for (const line of String(logText).split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (emailId) {
      if (e.email_id === emailId) found = e;
      continue;
    }
    if (subject != null && e.subject === subject && e.email_id && now - Date.parse(e.ts) <= maxAgeMs) found = e;
  }
  return found;
}

/**
 * Where the message stands, from what the two sources returned this round.
 *
 * events          the provider's events for this email id ([] = none yet; null = lookup failed)
 * mailbox         {id, labels, receivedAt} when found in the owner's mailbox; null = not found;
 *                 undefined = not looked (the owner is not a recipient, or the lookup failed)
 * ownerRecipient  the owner's mailbox is one of the recipients
 * sentAt, now     ms timestamps
 * final           this is the last round (the wait is over)
 *
 * Returns {status, done, detail}: done = no point waiting further.
 */
export function classifyDelivery({ events, mailbox, ownerRecipient, sentAt, now, final = false }) {
  const evs = Array.isArray(events) ? events : [];
  if (mailbox) {
    const labels = mailbox.labels || [];
    const hidden = HIDDEN_LABELS.find((l) => labels.includes(l));
    if (hidden) return { status: "not-in-inbox", done: true, detail: `it arrived, but in ${hidden === "SPAM" ? "the Spam folder" : "the Trash"}` };
    if (!labels.includes("INBOX")) return { status: "not-in-inbox", done: true, detail: "it arrived, but was archived out of the inbox" };
    const at = Date.parse(evs.find((e) => e.event === "delivered")?.date ?? "") || mailbox.receivedAt || now;
    return { status: "landed", done: true, detail: `in the inbox, arrived ${ago(at - sentAt)} after sending` };
  }
  const failed = evs.find((e) => FAILED_EVENTS.has(e.event));
  if (failed) return { status: "bounced", done: true, detail: `the mail service reports ${failed.event}${failed.smtp_response ? `: ${failed.smtp_response}` : ""}` };
  const delivered = evs.find((e) => e.event === "delivered");
  if (delivered && (!ownerRecipient || mailbox === undefined)) {
    // Not the owner's mailbox (or it could not be read): the receiving server's word is all there is.
    return { status: "landed", done: true, detail: `the receiving server accepted it ${ago(Date.parse(delivered.date) - sentAt)} after sending${ownerRecipient ? " (the mailbox itself could not be checked)" : ""}` };
  }
  if (Array.isArray(events) && evs.length === 0 && now - sentAt >= NO_RECORD_AFTER_MS) {
    return { status: "bounced", done: true, detail: "the mail service has no record of this message, so it was never taken for delivery" };
  }
  if (delivered && mailbox === null) {
    // The receiving server took it; Gmail search can lag behind. Only call it
    // missing once that is no longer a plausible lag, else report it in transit
    // so the caller looks again rather than telling the user it is lost.
    const deliveredAt = Date.parse(delivered.date);
    return final && now - deliveredAt >= SEARCH_LAG_MS
      ? { status: "not-in-inbox", done: true, detail: `the receiving server accepted it ${ago(deliveredAt - sentAt)} after sending, but it is not in the mailbox` }
      : { status: "in-transit", done: false, detail: "accepted by the receiving server, not visible in the mailbox yet" };
  }
  if (events == null && mailbox === undefined) {
    return final
      ? { status: "unknown", done: true, detail: "could not reach the mail service or the mailbox to check" }
      : { status: "in-transit", done: false, detail: "could not check yet" };
  }
  if (events == null) {
    // Not in the mailbox, and no word from the service: "held" would be a guess.
    const detail = `not in the mailbox ${ago(now - sentAt)} after sending, and the mail service could not be checked`;
    return final ? { status: "unknown", done: true, detail } : { status: "in-transit", done: false, detail };
  }
  const soft = evs.find((e) => e.event === "soft-bounced");
  return {
    status: "in-transit",
    done: false,
    detail: `the mail service accepted it ${ago(now - sentAt)} ago and has not delivered it yet${soft ? ` (the receiving server deferred it: ${soft.smtp_response || "no reason given"})` : ""}`,
  };
}

function ago(ms) {
  if (!Number.isFinite(ms)) return "some time";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

const isoSecond = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

/** The provider's activity events for one email id. Throws when the lookup fails. */
export async function providerEvents(emailId, { since, until, apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("SMTP2GO_API_KEY not set");
  const out = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const body = { api_key: apiKey, start_date: isoSecond(since), end_date: isoSecond(until), limit: 500 };
    if (token) body.continue_token = token;
    const res = await fetchImpl("https://api.smtp2go.com/v3/activity/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j?.data?.error) throw new Error(`activity search: ${j?.data?.error || res.status}`);
    const events = j.data?.events || [];
    for (const e of events) if (e.email_id === emailId) out.push(e);
    token = j.data?.continue_token;
    if (!token || events.length === 0) break;
  }
  return out;
}

/** {id, labels} for the message in the owner's mailbox, or null when it is not there. */
export async function mailboxLookup(emailId, { gmail }) {
  const ids = await gmail.searchIds(`in:anywhere rfc822msgid:${messageIdFor(emailId)}`, { max: 5 });
  if (!ids.length) return null;
  const msg = await gmail.getMessage(ids[0]);
  return { id: ids[0], labels: msg.labelIds || [], receivedAt: Number(msg.internalDate) || null };
}

/**
 * Poll until the message lands, fails, or `waitMs` runs out.
 *
 * sent   the sent-log entry ({email_id, ts, to, subject})
 * deps   {events(emailId, {since, until}), mailbox(emailId), now(), sleep(ms)}: seams
 *        for tests; the CLI wires the real provider and Gmail.
 */
export async function checkDelivery(sent, { owner, waitMs = 300000, intervalMs = 15000, deps }) {
  const sentAt = Date.parse(sent.ts);
  // Old log rows hold `to` as one string.
  const ownerRecipient = !!owner && [].concat(sent.to || []).some((a) => String(a).toLowerCase() === owner.toLowerCase());
  const deadline = deps.now() + waitMs;
  let result;
  for (;;) {
    const now = deps.now();
    const final = now >= deadline;
    let events = null;
    try { events = await deps.events(sent.email_id, { since: sentAt - 120000, until: now + 60000 }); } catch {}
    let mailbox;
    if (ownerRecipient) {
      try { mailbox = await deps.mailbox(sent.email_id); } catch { mailbox = undefined; }
    }
    result = classifyDelivery({ events, mailbox, ownerRecipient, sentAt, now, final });
    if (result.done || final) break;
    await deps.sleep(Math.min(intervalMs, Math.max(0, deadline - deps.now())));
  }
  return { ...result, exit: DELIVERY_EXIT[result.status], email_id: sent.email_id, subject: sent.subject, sent_at: sent.ts };
}

/** The real dependencies: SMTP2Go's activity API and the owner's Gmail. */
export async function deliveryDeps() {
  const { loadEnv } = require("./load-env.js");
  loadEnv();
  const gmail = await import("./gmail-read.mjs");
  const apiKey = process.env.SMTP2GO_API_KEY;
  return {
    events: (emailId, w) => providerEvents(emailId, { ...w, apiKey }),
    mailbox: (emailId) => mailboxLookup(emailId, { gmail }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function readSentLog(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}
