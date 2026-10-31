// partner-invite-ask — "Invite <partner> to <restaurant>, <day time>?" as one
// tappable question, and filing the user's answer.
//
// WHY. Shows and entertainment the agent books can invite the user's partner
// automatically (agent/CLAUDE.md § Calendar Invitations), but whether to bring
// the partner to a restaurant reservation depends, so the user is asked
// first. A reservation the agent puts on the user's calendar is created with
// no attendees and this asks once. Only a yes invites the partner. No answer =
// no invite (nothing here ever acts on silence).
//
// THIS FILE DOES NO LANGUAGE INTERPRETATION (Rule #0b). A tap is matched in
// code by lib/choice-reply.mjs against the exact labels built here. A
// typed answer is read by the chat agent (a model), which then calls
// `partner-invite-ask answer --yes|--no` — this file only files what it is told.
//
// Config: agent/local/config/partner-invite.json — `partner_name`,
// `invite_email` (the address added as attendee), `partner_emails` (the
// partner's addresses, for partner-invite-accept), and the identifiers an
// installation already stores (`choice_kind`, `state_file`, `intent`,
// `metadata_key`). No `invite_email` = the capability is off.
//
// State: data/<state_file> → { asks: [{ ref, event_id, calendar,
// title, start, tz, when, asked_at, message_id, status, answered_at, answer,
// words, invited_at }] }, one entry per calendar event (an event is never
// asked about twice).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeJsonAtomic } = require("./atomic-write.js");
const { instance, localConfig } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

export function config() {
  const c = localConfig("partner-invite", {
    partner_name: "your partner",
    invite_email: "",
    partner_emails: [],
    choice_kind: "partner_invite",
    state_file: "partner-invite-asks.json",
    intent: "partner-invite:ask",
    metadata_key: "partner_invite_ref",
  });
  return {
    ...c,
    invite_email: String(c.invite_email || "").toLowerCase(),
    partner_emails: (c.partner_emails || []).map((e) => String(e).toLowerCase()),
  };
}

export const NO_LABEL = "No, just me";
/** A typed answer with no thread finds the ask sent in this window. */
export const LATEST_WINDOW_H = 72;

export const yesLabel = (c = config()) => `Yes, invite ${c.partner_name}`;
export const kind = (c = config()) => c.choice_kind;
export const inviteEmail = (c = config()) => c.invite_email;
const zoneOr = (tz) => tz || instance().tz || "UTC";

export function statePath() {
  return process.env.PARTNER_INVITE_ASKS_FILE
    || path.join(process.env.JORI_DATA_DIR || path.join(installTools(), "data"), config().state_file);
}

export function readState(p = statePath()) {
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return { asks: Array.isArray(s?.asks) ? s.asks : [] };
  } catch {
    return { asks: [] };
  }
}

export function writeState(s, p = statePath()) {
  // Keep the file small: drop entries for events more than 60 days past.
  const cutoff = Date.now() - 60 * 86400e3;
  const asks = (s.asks || []).filter((a) => !(Date.parse(a.start) < cutoff)).slice(-300);
  writeJsonAtomic(p, { asks });
}

/** "Fri Oct 30, 8:00 PM" in the reservation's own zone. */
export function formatWhen(startIso, tz) {
  const zone = zoneOr(tz);
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return String(startIso);
  const day = d.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

/**
 * The message and its `metadata.choices` payload. `ref` is the calendar event
 * id — what the answer acts on.
 */
export function buildAsk({ eventId, title, start, tz, promptId = crypto.randomUUID(), now = Date.now(), cfg = config() }) {
  if (!eventId || !title || !start) throw new Error("buildAsk needs eventId, title and start");
  const when = formatWhen(start, tz);
  const question = `Invite ${cfg.partner_name} to ${title}, ${when}?`;
  const startMs = Date.parse(start);
  const choices = {
    v: 1,
    id: promptId,
    kind: cfg.choice_kind,
    ref: eventId,
    prompt: question,
    options: [
      { id: "yes", label: yesLabel(cfg), value: "yes" },
      { id: "no", label: NO_LABEL, value: "no" },
    ],
    // Not tappable once the reservation has started — an invite then is noise.
    ...(Number.isFinite(startMs) && startMs > now ? { expires_at: new Date(startMs).toISOString() } : {}),
  };
  const text = `🍽️ ${question}\nIt's on your calendar with just you for now. I'll add ${cfg.partner_name} only if you say yes.`;
  return { question, when, text, choices };
}

export function findAsk(ref, state = readState()) {
  return state.asks.find((a) => a.ref === ref) || null;
}

/** The newest ask still waiting for an answer, sent in the last LATEST_WINDOW_H. */
export function latestOpenAsk({ state = readState(), now = Date.now() } = {}) {
  const open = state.asks
    .filter((a) => a.status === "asked" && now - Date.parse(a.asked_at) <= LATEST_WINDOW_H * 3600e3)
    .sort((a, b) => Date.parse(b.asked_at) - Date.parse(a.asked_at));
  return open[0] || null;
}

/**
 * Whether an ask for this event should be sent. One per event, ever; never
 * for a reservation that has already started; never with no partner configured.
 * @returns {{ok: boolean, reason?: string}}
 */
export function canAsk({ eventId, start, state = readState(), now = Date.now(), cfg = config() }) {
  if (!cfg.invite_email) return { ok: false, reason: "no partner configured (agent/local/config/partner-invite.json invite_email)" };
  if (findAsk(eventId, state)) return { ok: false, reason: `already asked about ${eventId}` };
  const s = Date.parse(start);
  if (!Number.isFinite(s)) return { ok: false, reason: `unreadable start "${start}"` };
  if (s <= now) return { ok: false, reason: "the reservation has already started" };
  return { ok: true };
}

export function recordAsk({ eventId, calendar = "primary", title, start, tz, when, messageId, promptId, state = readState(), now = Date.now() }) {
  state.asks.push({
    ref: eventId, event_id: eventId, calendar, title, start, tz, when,
    asked_at: new Date(now).toISOString(), message_id: messageId || null, prompt_id: promptId || null,
    status: "asked",
  });
  return state;
}

/**
 * What answering means, before anything is done. Pure — the caller performs
 * the calendar write (`invite: true`) and then calls markAnswered.
 * @returns {{ok: boolean, error?: string, already?: boolean, invite?: boolean, authorization?: string, ask?: object}}
 */
export function planAnswer({ ref, answer, words = "", state = readState(), now = Date.now(), cfg = config() }) {
  if (answer !== "yes" && answer !== "no") return { ok: false, error: `answer must be yes or no, got "${answer}"` };
  const ask = findAsk(ref, state);
  if (!ask) return { ok: false, error: `no partner-invite question was asked about event ${ref}` };
  if (ask.status !== "asked") return { ok: true, already: true, invite: false, ask };
  if (answer === "no") return { ok: true, invite: false, ask };
  if (Date.parse(ask.start) <= now) return { ok: false, error: `${ask.title} (${ask.when}) has already started; not inviting` };
  // The quote jori-calendar requires and the nightly attendee audit reads:
  // the user's actual answer to this exact question.
  const said = String(words || "").trim() ? `"${String(words).trim()}"` : `"${yesLabel(cfg)}" (tapped)`;
  const who = instance().owner_name;
  const authorization = `${who} answered ${said} to "Invite ${cfg.partner_name} to ${ask.title}, ${ask.when}?" (${new Date(now).toISOString().slice(0, 10)})`;
  return { ok: true, invite: true, authorization, ask };
}

export function markAnswered({ ref, answer, words = "", invited = false, messageId = null, state = readState(), now = Date.now() }) {
  const ask = findAsk(ref, state);
  if (!ask) return state;
  ask.status = "answered";
  ask.answer = answer;
  ask.answered_at = new Date(now).toISOString();
  if (words) ask.words = String(words).trim();
  if (messageId) ask.answer_message_id = messageId;
  if (invited) ask.invited_at = new Date(now).toISOString();
  return state;
}
