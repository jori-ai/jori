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
import crypto from "node:crypto";
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
//
// A message email-send put straight into the owner's mailbox (sent-log
// `transport: "mailbox"`, § Straight into the owner's mailbox below) never went
// through the service, so for it the mailbox is the whole answer.

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
 * provider        false = put straight into the owner's mailbox, no mail service involved
 *
 * Returns {status, done, detail}: done = no point waiting further.
 */
export function classifyDelivery({ events, mailbox, ownerRecipient, sentAt, now, final = false, provider = true }) {
  const evs = Array.isArray(events) ? events : [];
  if (mailbox) {
    const labels = mailbox.labels || [];
    const hidden = HIDDEN_LABELS.find((l) => labels.includes(l));
    if (hidden) return { status: "not-in-inbox", done: true, detail: `it arrived, but in ${hidden === "SPAM" ? "the Spam folder" : "the Trash"}` };
    if (!labels.includes("INBOX")) return { status: "not-in-inbox", done: true, detail: "it arrived, but was archived out of the inbox" };
    if (!provider) return { status: "landed", done: true, detail: "in the inbox (put there directly, not through the mail service)" };
    const at = Date.parse(evs.find((e) => e.event === "delivered")?.date ?? "") || mailbox.receivedAt || now;
    return { status: "landed", done: true, detail: `in the inbox, arrived ${ago(at - sentAt)} after sending` };
  }
  if (!provider) {
    // No service record exists to fall back on, and "never taken" would be
    // wrong (the caller re-sends on it): the mailbox was the destination itself.
    if (mailbox === null) {
      return final || now - sentAt >= SEARCH_LAG_MS
        ? { status: "not-in-inbox", done: true, detail: "it was put straight into the mailbox, but it is not there now" }
        : { status: "in-transit", done: false, detail: "put straight into the mailbox, not visible to search yet" };
    }
    return final
      ? { status: "unknown", done: true, detail: "could not read the mailbox to check" }
      : { status: "in-transit", done: false, detail: "could not check yet" };
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

/**
 * {id, labels} for the message in the owner's mailbox, or null when it is not there.
 * messageId: the Message-ID the sent log recorded (a message put straight into
 * the mailbox has its own; a provider send's is built from its email id).
 * gmailId: that message's mailbox id, read directly when search has not caught up.
 */
export async function mailboxLookup(emailId, { gmail, messageId = null, gmailId = null }) {
  const rfcId = messageId ? bareMessageId(messageId) : messageIdFor(emailId);
  const ids = await gmail.searchIds(`in:anywhere rfc822msgid:${rfcId}`, { max: 5 });
  if (ids.length) {
    const msg = await gmail.getMessage(ids[0]);
    return { id: ids[0], labels: msg.labelIds || [], receivedAt: Number(msg.internalDate) || null };
  }
  if (!gmailId) return null;
  let msg;
  try { msg = await gmail.getMessage(gmailId); }
  catch (e) {
    // Gone (deleted) is an answer; anything else means the lookup failed.
    if (String(e && e.message).startsWith("Gmail 404")) return null;
    throw e;
  }
  return msg && msg.id ? { id: msg.id, labels: msg.labelIds || [], receivedAt: Number(msg.internalDate) || null } : null;
}

/**
 * Poll until the message lands, fails, or `waitMs` runs out.
 *
 * sent   the sent-log entry ({email_id, ts, to, subject})
 * deps   {events(emailId, {since, until}), mailbox(emailId, sent), now(), sleep(ms)}: seams
 *        for tests; the CLI wires the real provider and Gmail.
 */
export async function checkDelivery(sent, { owner, waitMs = 300000, intervalMs = 15000, deps }) {
  const sentAt = Date.parse(sent.ts);
  // Old log rows hold `to` as one string.
  const ownerRecipient = !!owner && [].concat(sent.to || []).some((a) => String(a).toLowerCase() === owner.toLowerCase());
  const provider = sent.transport !== "mailbox";
  const deadline = deps.now() + waitMs;
  let result;
  for (;;) {
    const now = deps.now();
    const final = now >= deadline;
    let events = null;
    if (provider) {
      try { events = await deps.events(sent.email_id, { since: sentAt - 120000, until: now + 60000 }); } catch {}
    }
    let mailbox;
    if (ownerRecipient || !provider) {
      try { mailbox = await deps.mailbox(sent.email_id, sent); } catch { mailbox = undefined; }
    }
    result = classifyDelivery({ events, mailbox, ownerRecipient, sentAt, now, final, provider });
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
    mailbox: (emailId, sent = {}) => mailboxLookup(emailId, { gmail, messageId: sent.message_id, gmailId: sent.gmail_id }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function readSentLog(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// ── Straight into the owner's mailbox ────────────────────────────────────────
//
// Why mail to the owner skips the mail service. When a message arrived late,
// it waited inside SMTP2Go: its own Received header has the service accepting
// it, the next hop is the receiving server minutes later, and the service's
// activity record shows no delivery attempt and no deferral in between (a
// message still waiting has no outbound IP yet). The receiving server takes it
// on the first try. Size, format, the sender address and the recipient's
// server make no difference, and nothing in the message or in the agent's
// settings changes how long the service holds it.
//
// A message whose only recipient is the owner does not need to cross the
// internet at all. The agent already holds an OAuth token for the owner's own
// mailbox (lib/google-auth.js, the one gmail-action uses), so email-send hands
// the message to that mailbox directly with the Gmail API's messages.import,
// labelled INBOX + UNREAD. Import delivers it the way Gmail delivers any
// arriving mail (its own importance, category and phone notification), with
// neverMarkSpam so it cannot land in Spam. messages.insert would skip that
// classification, and a fallback alert that arrives without a notification
// defeats its purpose. It is in the inbox when the call returns. What the
// owner's side does with agent mail keys on headers this message carries the
// same way: the From address (the intake's P1 finishing), its own Message-ID
// (In-Reply-To reply matching against the sent log), and In-Reply-To /
// References, by which Gmail threads a reply under its parent.
//
// Anyone else, or a From that is not one of the agent's own addresses, still
// goes through SMTP2Go, and so does this message whenever the direct path
// fails (no token, a token for a different mailbox, an API error), so it is
// never worse than before. EMAIL_SEND_VIA_PROVIDER=1 sends everything through
// SMTP2Go.

const CRLF = "\r\n";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_IMPORT = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/import?uploadType=multipart&neverMarkSpam=true";
// A hung Gmail must leave time for the SMTP2Go fallback inside a caller's own
// limit (sendHtmlEmail allows email-send 60s): the mailbox check and the import
// share one 30s budget, then the lost-answer lookups take at most ~19s more.
const PATH_BUDGET_MS = 30000;
const GET_TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 25000;
const LOOKUP_TIMEOUT_MS = 5000;

const isAscii = (s) => Buffer.byteLength(s, "utf8") === s.length;
// Header values never carry a line break (header injection).
const oneLine = (v) => String(v ?? "").split("\r").join(" ").split("\n").join(" ");

/** A Message-ID without its angle brackets, as Gmail's rfc822msgid: search wants it. */
export function bareMessageId(id) {
  let s = String(id || "").trim();
  if (s.startsWith("<")) s = s.slice(1);
  if (s.endsWith(">")) s = s.slice(0, -1);
  return s;
}

/** True when this send goes straight into the owner's mailbox instead of through SMTP2Go. */
export function ownerMailboxEligible({ to, from, owner = ownerEmail(), agents = agentAddresses(), env = process.env }) {
  if (env.EMAIL_SEND_VIA_PROVIDER === "1") return false;
  const lc = (s) => String(s || "").trim().toLowerCase();
  if (!owner || !Array.isArray(to) || to.length !== 1 || lc(to[0]) !== lc(owner)) return false;
  return agents.map(lc).includes(lc(from));
}

/**
 * A new message's id pair: the Message-ID header, and the id the sent log
 * records for it (`email_id`, the Message-ID's local part, so reply matching,
 * which looks for the logged id inside In-Reply-To, finds it unchanged).
 */
export function newMessageId(fromAddress, { now = Date.now(), rand = crypto.randomBytes(8).toString("hex") } = {}) {
  const from = String(fromAddress || "");
  const at = from.lastIndexOf("@");
  const domain = at >= 0 ? from.slice(at + 1) : "localhost";
  const emailId = `m.${now.toString(36)}.${rand}`;
  return { emailId, messageId: `<${emailId}@${domain}>` };
}

/** RFC 2047 encoded-words for a header value, each under 76 characters, split between whole characters. */
export function encodeHeaderWords(value) {
  const s = oneLine(value);
  if (isAscii(s)) return s;
  const words = [];
  let chunk = "";
  for (const ch of s) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

function addressHeader(name, addr) {
  const a = oneLine(addr).trim();
  if (!name) return a;
  const n = oneLine(name);
  if (!isAscii(n)) return `${encodeHeaderWords(n)} <${a}>`;
  return `"${n.split("\\").join("\\\\").split('"').join('\\"')}" <${a}>`;
}

/** The RFC 5322 date form: "Fri, 30 Oct 2026 12:00:25 +0000". */
export function rfc5322Date(d = new Date()) {
  return d.toUTCString().replace("GMT", "+0000");
}

function base64Lines(buf) {
  const s = Buffer.from(buf).toString("base64");
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join(CRLF);
}

// A file name as a header parameter. A name that is not plain ASCII (Hebrew,
// accents) is written the way Gmail shows it: encoded-words in Content-Type's
// `name`, the RFC 2231 form alone in Content-Disposition's `filename` (with a
// plain ASCII stand-in beside it, Gmail shows the stand-in).
function fileNameParams(param, filename) {
  const name = oneLine(filename);
  if (isAscii(name)) return `; ${param}="${name.split("\\").join("\\\\").split('"').join('\\"')}"`;
  if (param === "name") return `; name="${encodeHeaderWords(name).split(`${CRLF} `).join(" ")}"`;
  const pct = encodeURIComponent(name).split("'").join("%27").split("(").join("%28").split(")").join("%29").split("*").join("%2A");
  return `; ${param}*=UTF-8''${pct}`;
}

// Text parts are canonical before encoding: every line ends in CRLF.
const crlfText = (t) => String(t ?? "").split("\r\n").join("\n").split("\r").join("\n").split("\n").join(CRLF);

function leaf(type, content, extra = []) {
  return { headers: [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra], body: base64Lines(content) };
}

function multipart(subtype, parts, boundary) {
  const b = boundary();
  // Every leaf is base64, whose alphabet has no "-", so "--<boundary>" cannot occur inside a part.
  const body = parts.map((p) => `--${b}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join("") + `--${b}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${b}"`], body };
}

/**
 * The whole message as RFC 5322 text (7-bit: encoded headers, base64 parts).
 *
 * attachments  [{filename, mimetype, content: Buffer, cid?}]: a `cid` makes it an
 *              inline part the HTML refers to as cid:<cid>; the rest are attachments.
 * Shape: text, or alternative(text, html); inside related(…, inlines) when there
 * are inline parts; inside mixed(…, attachments) when there are attachments.
 */
export function buildMimeMessage({
  from, fromName = null, to, subject, html = null, text = "", replyTo = null,
  inReplyTo = null, references = null, messageId, date = new Date(), attachments = [],
  boundary = () => `=_part_${crypto.randomBytes(12).toString("hex")}`,
}) {
  const textPart = leaf("text/plain; charset=UTF-8", Buffer.from(crlfText(text), "utf8"));
  let root = html == null
    ? textPart
    : multipart("alternative", [textPart, leaf("text/html; charset=UTF-8", Buffer.from(crlfText(html), "utf8"))], boundary);
  const inlines = attachments.filter((a) => a.cid);
  const files = attachments.filter((a) => !a.cid);
  if (inlines.length) {
    root = multipart("related", [root, ...inlines.map((a) => leaf(
      `${a.mimetype || "application/octet-stream"}${fileNameParams("name", a.cid)}`, a.content,
      [`Content-ID: <${oneLine(a.cid)}>`, `Content-Disposition: inline${fileNameParams("filename", a.cid)}`],
    ))], boundary);
  }
  if (files.length) {
    root = multipart("mixed", [root, ...files.map((a) => leaf(
      `${a.mimetype || "application/octet-stream"}${fileNameParams("name", a.filename)}`, a.content,
      [`Content-Disposition: attachment${fileNameParams("filename", a.filename)}`],
    ))], boundary);
  }
  const toList = [].concat(to || []).map((t) => oneLine(t).trim()).filter(Boolean);
  const headers = [
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: ${oneLine(messageId)}`,
    `From: ${addressHeader(fromName, from)}`,
    `To: ${toList.join(", ")}`,
    `Subject: ${encodeHeaderWords(subject)}`,
  ];
  if (replyTo) headers.push(`Reply-To: ${oneLine(replyTo)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${oneLine(inReplyTo)}`);
  if (references) {
    const ids = oneLine(references).split(" ").filter(Boolean);
    if (ids.length) headers.push(`References: ${ids.join(`${CRLF} `)}`);
  }
  headers.push("MIME-Version: 1.0", ...root.headers);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`;
}

/**
 * Hand a built message to the owner's mailbox (messages.import). Returns
 * {gmailId, threadId}. Throws when it did not go in; the caller then sends it
 * the usual way.
 *
 * It checks first that the token's mailbox IS the owner's. A reply joins its
 * parent's thread from its own headers. When the import's answer is lost or an
 * error, it looks the message up by Message-ID (three tries over a few
 * seconds) before throwing, so a call that did go through is not followed by a
 * second copy. All of it fits in under a minute (see PATH_BUDGET_MS).
 */
export async function importIntoOwnerMailbox({ raw, messageId, owner, labelIds = ["INBOX", "UNREAD"] },
  { token, fetchImpl = fetch, lookupDelayMs = 2000 }) {
  const auth = { Authorization: `Bearer ${token}` };
  const started = Date.now();
  const within = (capMs) => AbortSignal.timeout(Math.max(1000, Math.min(capMs, PATH_BUDGET_MS - (Date.now() - started))));
  const get = async (p, signal = within(GET_TIMEOUT_MS)) => {
    const res = await fetchImpl(`${GMAIL_API}${p}`, { headers: auth, signal });
    if (!res.ok) throw new Error(`Gmail ${res.status}`);
    return res.json();
  };
  const byMessageId = async (id) => {
    const j = await get(`/messages?q=${encodeURIComponent(`rfc822msgid:${bareMessageId(id)}`)}&maxResults=1&includeSpamTrash=true`,
      AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
    return (j.messages || [])[0] || null;
  };
  const profile = await get("/profile");
  const mailbox = String(profile.emailAddress || "").toLowerCase();
  if (!owner || mailbox !== String(owner).toLowerCase()) {
    throw new Error(`the mailbox token is for ${profile.emailAddress || "an unknown account"}, not the owner`);
  }
  // No threadId: import refuses one ("threadId not allowed") and threads the
  // message by its In-Reply-To / References and subject, as Gmail threads
  // any arriving reply.
  const meta = { labelIds };
  const b = `upload_${crypto.randomBytes(12).toString("hex")}`;
  const body = `--${b}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${JSON.stringify(meta)}${CRLF}`
    + `--${b}${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}${raw}${CRLF}--${b}--${CRLF}`;
  let err;
  try {
    const res = await fetchImpl(GMAIL_IMPORT, {
      method: "POST",
      headers: { ...auth, "Content-Type": `multipart/related; boundary=${b}` },
      body,
      signal: within(UPLOAD_TIMEOUT_MS),
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.id) return { gmailId: j.id, threadId: j.threadId || null };
      err = new Error("Gmail import returned no message id");
    } else {
      err = new Error(`Gmail import ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (e) { err = e; }
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(lookupDelayMs);
    try {
      const hit = await byMessageId(messageId);
      if (hit) return { gmailId: hit.id, threadId: hit.threadId || null };
    } catch {}
  }
  throw err;
}

/**
 * Build the message and hand it to the owner's mailbox.
 * Returns {emailId, messageId, gmailId, threadId}; throws when it did not go in.
 * `getToken` and `fetchImpl` are test seams.
 */
export async function deliverToOwnerMailbox(m, { owner = ownerEmail(), getToken = null, fetchImpl = fetch, now = new Date() } = {}) {
  const { emailId, messageId } = newMessageId(m.from, { now: now.getTime() });
  const raw = buildMimeMessage({ ...m, messageId, date: now });
  const token = await (getToken || require("./google-auth.js").getAccessToken)();
  const r = await importIntoOwnerMailbox({ raw, messageId, owner, labelIds: m.labelIds }, { token, fetchImpl });
  return { emailId, messageId, ...r };
}
