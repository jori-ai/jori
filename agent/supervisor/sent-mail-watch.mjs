// sent-mail-watch: tracks the mail the user SENDS, the outbound half that the
// Gmail push never covers (the push watch is INBOX-only, and gmail-source drops
// the user's own mail to third parties: isOwnSentToThirdParty).
//
// Every ~60 s it reads the Gmail history for the SENT label from a persisted
// historyId (data/sent-mail-state.json; first start begins at "now", no
// backfill) and, for each new sent message:
//   - appends one row to data/email-sent.jsonl: headers, ids and the text the
//     user wrote (quoted history cut off), the same shape as the realtime
//     channels' inboxes, so `from_me` mail is a first-class record;
//   - hands it to lib/jori-mention.mjs, so "@jori …" written in an outgoing
//     email is an instruction, exactly as in iMessage, WhatsApp and Slack.
// Mail addressed to the assistant's own address is skipped for the mention
// (gmail-source's command channel already dispatches it) but still logged.
//
// Runs inside the ops supervisor next to GmailSource and borrows its token.

import fs from "node:fs";
import path from "node:path";
import { installTools } from "../../lib/root.cjs";
import { handleMention } from "../../lib/jori-mention.mjs";
import { isAddressedToJori } from "./gmail-source.mjs";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const POLL_MS = Number(process.env.SENT_MAIL_POLL_MS || 60 * 1000);
const TEXT_CHARS = 4000;

const b64 = (d) => Buffer.from(String(d || ""), "base64url").toString("utf8");

function log(msg) {
  console.error(`[sent-mail-watch] ${new Date().toISOString()} ${msg}`);
}

// The part of a sent message the user actually wrote: Gmail puts the quoted
// thread in <div class="gmail_quote"> / <blockquote> (HTML) or "> " lines
// (plain). Cutting there keeps an "@jori" from an earlier message in the
// thread from firing again on every reply.
export function writtenPart(payload) {
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (p.body?.data) {
      if (mt === "text/plain" && !plain) plain = b64(p.body.data);
      else if (mt === "text/html" && !html) html = b64(p.body.data);
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  let out;
  if (html) {
    const lower = html.toLowerCase();
    const cuts = [lower.indexOf('class="gmail_quote'), lower.indexOf("<blockquote")].filter((i) => i >= 0);
    let h = cuts.length ? html.slice(0, Math.min(...cuts)) : html;
    h = h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " "); // lang-regex-ok: HTML markup
    h = h.replace(/<br\s*\/?>|<\/(div|p|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " "); // lang-regex-ok: HTML markup
    out = h.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"'); // lang-regex-ok: HTML entities
  } else {
    out = plain.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
  }
  return out.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, TEXT_CHARS); // lang-regex-ok: whitespace collapse
}

export function sentEntry(msg) {
  const headers = msg.payload?.headers || [];
  const hdr = (n) => headers.find((h) => String(h.name).toLowerCase() === n.toLowerCase())?.value || "";
  return {
    ts: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    logged_at: new Date().toISOString(),
    kind: "sent",
    from_me: true,
    message_id: msg.id,
    thread_id: msg.threadId,
    rfc_message_id: hdr("Message-ID"),
    to: hdr("To"),
    cc: hdr("Cc"),
    bcc: hdr("Bcc"),
    subject: hdr("Subject"),
    text: writtenPart(msg.payload),
  };
}

export class SentMailWatch {
  constructor({ getToken, stateFile = installTools("data/sent-mail-state.json"), logFile = installTools("data/email-sent.jsonl") }) {
    this.getToken = getToken;
    this.stateFile = stateFile;
    this.logFile = logFile;
    this.timer = null;
    this.busy = false;
  }

  _state() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch { return {}; }
  }

  _save(historyId) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ historyId: String(historyId), ts: new Date().toISOString() }));
    fs.renameSync(tmp, this.stateFile);
  }

  async _get(token, pathname) {
    const res = await fetch(`${GMAIL_API}${pathname}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { const e = new Error(`gmail http_${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.poll();
    log(`started (every ${POLL_MS / 1000}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const token = await this.getToken();
      if (!token) return;
      let { historyId } = this._state();
      if (!historyId) {
        const profile = await this._get(token, "/profile");
        this._save(profile.historyId);
        log(`first start: from historyId ${profile.historyId} (no backfill)`);
        return;
      }
      const ids = [];
      let pageToken = null;
      let latest = historyId;
      try {
        do {
          const body = await this._get(token, `/history?startHistoryId=${historyId}&historyTypes=messageAdded&labelId=SENT&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
          for (const h of body.history || []) for (const a of h.messagesAdded || []) {
            const labels = a.message?.labelIds || [];
            if (labels.includes("SENT") && !labels.includes("DRAFT") && !ids.includes(a.message.id)) ids.push(a.message.id);
          }
          if (body.historyId) latest = body.historyId;
          pageToken = body.nextPageToken || null;
        } while (pageToken);
      } catch (err) {
        // historyId older than Gmail keeps (~7 days): restart from now.
        if (err.status === 404) {
          const profile = await this._get(token, "/profile");
          this._save(profile.historyId);
          log(`history expired; restarted from ${profile.historyId}`);
          return;
        }
        throw err;
      }
      for (const id of ids) await this._handle(token, id);
      this._save(latest);
    } catch (err) {
      log(`poll failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  async _handle(token, id) {
    let msg;
    try { msg = await this._get(token, `/messages/${id}?format=full`); } catch (err) { log(`fetch ${id} failed: ${err.message}`); return; }
    const entry = sentEntry(msg);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch (err) { log(`log write failed: ${err.message}`); }
    if (isAddressedToJori([entry.to, entry.cc, entry.bcc].join(", "))) return;
    let recent = [];
    try {
      const thread = await this._get(token, `/threads/${entry.thread_id}?format=metadata&metadataHeaders=From`);
      recent = (thread.messages || []).filter((m) => m.id !== id).slice(-8).map((m) => ({
        at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
        from: (m.labelIds || []).includes("SENT") ? "me" : (m.payload?.headers || []).find((h) => h.name === "From")?.value || "them",
        text: m.snippet || "",
      }));
    } catch {}
    await handleMention({
      channel: "email", message_id: entry.message_id, chat_id: entry.thread_id, chat_name: entry.subject || null,
      participants: [entry.to, entry.cc].filter(Boolean).join(", "), subject: entry.subject,
      is_group: true, from_me: true, ts: entry.ts, text: entry.text,
    }, recent, { log });
  }
}
