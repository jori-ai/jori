// call-actions.mjs — the action items of the user's calls, for both sides, kept
// until they are done, and followed up on.
//
// The requirement (the user, 2026-11-22): "Create a list of action items for
// both parties and follow up on them." Every logged call (lib/call-log.mjs) has
// the user's own next steps and the others' ones; this keeps each as one item
// in data/call-log.json's `actions` map, with its owner, its due date when one
// was said, and its status, and decides in code when to bring it up again.
//
// Who decides what:
//   model (bin/call-log's log step) — what the items are, their due dates, and
//     which open items a later call with the same people shows are done.
//   the user (chat: `call-log done|drop|due`) — closes, drops or re-dates one.
//   code (here) — ids, the ledger, which items are due a follow-up, the wording
//     of the follow-up message, and its pacing.
//
// Follow-up pacing (followupPlan): one message a day at most, after
// FOLLOWUP_HOUR local time, only when an item is due for one. An item is due
// for a follow-up when its date has come (once a day, three times at most past
// the date), or, without a date, on the 2nd, 5th and 10th day after the call
// (the others' items one day later, so the user is asked about their own
// first). After that the item stays open and listed (`call-log actions`), and
// is not raised again until the user or a later call settles it.
//
// No I/O: every function takes the store and returns values (some mutate it,
// as named); bin/call-log reads and writes the file.

import crypto from "node:crypto";

export const FOLLOWUP_HOUR = 9;          // local hour before which no follow-up goes out
export const NUDGE_DAYS_SELF = [2, 5, 10];
export const NUDGE_DAYS_OTHER = [3, 6, 11];
export const MAX_PAST_DUE_NUDGES = 3;
export const MAX_LISTED = 8;             // items in one follow-up message

const DAY = 86400_000;

/** The stable id of a call's n-th item: ca-<6 hex of the call uuid>-<n>. Pure. */
export function itemId(uuid, n) {
  return `ca-${crypto.createHash("sha1").update(String(uuid)).digest("hex").slice(0, 6)}-${n}`;
}

/** The person page of a name on this call's log, when it was matched. */
function wikiFor(entry, who) {
  const p = ((entry.log && entry.log.people) || []).find((x) => x.name === who || x.participant === who);
  return p ? p.wiki_id || null : null;
}

/**
 * The items one logged call adds: the user's first, then the others', in the
 * log's order. `selfKey` = the log's key of the user's own steps. Pure.
 */
export function itemsFromEntry(entry, selfKey, now = Date.now()) {
  const l = entry.log;
  if (!l) return [];
  const due = l.due || { self: [], others: [] };
  const base = { uuid: entry.uuid, call_date: entry.local_date, tz: entry.tz, status: "open", created: new Date(now).toISOString(), nudges: [] };
  const out = [];
  (l[selfKey] || []).forEach((step, i) => out.push({ ...base, owner: "self", who: null, wiki_id: null, step, due: (due.self || [])[i] || null }));
  (l.next_steps_others || []).forEach((o, i) => out.push({ ...base, owner: "other", who: o.who, wiki_id: wikiFor(entry, o.who), step: o.step, due: (due.others || [])[i] || null }));
  return out.map((a, n) => ({ id: itemId(entry.uuid, n + 1), ...a }));
}

/**
 * Put a freshly logged call's items in the ledger and close the earlier ones
 * its log says are done. An id already in the ledger is never overwritten (a
 * re-logged call keeps what the user did with its items). Returns
 * {added: [items], closed: [items]}. Mutates store.actions.
 */
export function recordEntry(store, entry, selfKey, now = Date.now()) {
  store.actions = store.actions || {};
  const added = [], closed = [];
  for (const a of itemsFromEntry(entry, selfKey, now)) {
    if (store.actions[a.id]) continue;
    store.actions[a.id] = a;
    added.push(a);
  }
  for (const id of (entry.log && entry.log.done_items) || []) {
    const a = store.actions[id];
    if (!a || a.status !== "open") continue;
    Object.assign(a, { status: "done", closed_at: new Date(now).toISOString(), closed_by: "call", note: `the call on ${entry.local_date} says it is done` });
    closed.push(a);
  }
  return { added, closed };
}

/** Open items that involve any of these people (their page or their name) or are the user's from a call with them. Pure. */
export function openItemsFor(store, people) {
  const ids = new Set(people.map((p) => p.wiki_id).filter(Boolean));
  const names = new Set(people.map((p) => String(p.name || "").toLowerCase()).filter(Boolean));
  const callPeople = new Map(Object.values(store.calls || {}).map((e) => [e.uuid, ((e.log && e.log.people) || []).concat((e.guests || []).map((g) => ({ name: g.name })))]));
  const touches = (list) => list.some((p) => (p.wiki_id && ids.has(p.wiki_id)) || names.has(String(p.name || "").toLowerCase()));
  return Object.values(store.actions || {}).filter((a) => a.status === "open" && (
    (a.wiki_id && ids.has(a.wiki_id)) || (a.who && names.has(a.who.toLowerCase())) || touches(callPeople.get(a.uuid) || [])));
}

/** The local YYYY-MM-DD and hour of `now` in `tz`. Pure. */
export function localNow(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/**
 * Why this open item is due for a follow-up today, or null. `today` = local
 * YYYY-MM-DD. Pure.
 */
export function followupReason(a, today) {
  if (a.status !== "open") return null;
  const nudged = a.nudges || [];
  if (nudged.includes(today)) return null;
  if (a.due) {
    const late = daysBetween(a.due, today);
    if (late < 0) return null;
    const pastDue = nudged.filter((d) => d >= a.due).length;
    if (pastDue >= MAX_PAST_DUE_NUDGES) return null;
    return late === 0 ? "due today" : `due ${a.due}, ${late} day${late === 1 ? "" : "s"} ago`;
  }
  const age = daysBetween(a.call_date, today);
  const marks = a.owner === "self" ? NUDGE_DAYS_SELF : NUDGE_DAYS_OTHER;
  // The latest mark already reached, raised once: a missed day (the machine off) still gets its follow-up.
  const reached = marks.filter((d) => age >= d);
  if (!reached.length) return null;
  const mark = reached[reached.length - 1];
  const since = nudged.filter((d) => daysBetween(a.call_date, d) >= mark);
  return since.length ? null : `from the call on ${a.call_date}`;
}

/**
 * Today's follow-up: {send, date, items:[{item, why}], text} or {send:false, why}.
 * `state` = store.followup ({last_date}). Pure.
 */
export function followupPlan(store, { now = Date.now(), tz, lastDate = (store.followup || {}).last_date } = {}) {
  const { date, hour } = localNow(now, tz);
  if (lastDate === date) return { send: false, date, why: "a follow-up already went out today" };
  if (hour < FOLLOWUP_HOUR) return { send: false, date, why: `before ${FOLLOWUP_HOUR}:00` };
  const due = Object.values(store.actions || {})
    .map((item) => ({ item, why: followupReason(item, date) })).filter((x) => x.why)
    .sort((x, y) => (x.item.owner === y.item.owner ? 0 : x.item.owner === "self" ? -1 : 1)
      || (x.item.due ? 0 : 1) - (y.item.due ? 0 : 1)
      || String(x.item.due || x.item.call_date).localeCompare(String(y.item.due || y.item.call_date)))
    .slice(0, MAX_LISTED);
  if (!due.length) return { send: false, date, why: "no action item is due a follow-up" };
  return { send: true, date, items: due, text: followupText(due, store) };
}

function callWho(store, uuid) {
  const e = (store.calls || {})[uuid];
  const names = e ? ((e.log && e.log.people && e.log.people.length) ? e.log.people.map((p) => p.name) : (e.guests || []).map((g) => g.name)) : [];
  return names.length <= 1 ? (names[0] || "someone") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The follow-up message. Plain, short, the user's items first. Pure. */
export function followupText(due, store) {
  const mine = due.filter((x) => x.item.owner === "self");
  const theirs = due.filter((x) => x.item.owner !== "self");
  const lines = [];
  if (mine.length) {
    lines.push(mine.length === 1 ? "One thing you said you'd do on a call:" : "Things you said you'd do on your calls:");
    for (const { item, why } of mine) lines.push(`• ${item.step} (call with ${callWho(store, item.uuid)}, ${why})`);
  }
  if (theirs.length) {
    if (lines.length) lines.push("");
    lines.push(theirs.length === 1 ? "Still waiting on:" : "Still waiting on others:");
    for (const { item, why } of theirs) lines.push(`• ${item.who}: ${item.step} (${why})`);
  }
  lines.push("");
  lines.push(theirs.length
    ? "Tell me which are done or no longer needed. If someone hasn't come through, I can draft a nudge for you to send."
    : "Tell me which are done or no longer needed, or give me a new date.");
  return lines.join("\n");
}

/** Mark every item of a sent follow-up as raised today. Mutates the store. */
export function markFollowedUp(store, plan) {
  for (const { item } of plan.items) {
    const a = store.actions[item.id];
    if (a) a.nudges = [...new Set([...(a.nudges || []), plan.date])];
  }
  store.followup = { last_date: plan.date, last_items: plan.items.map((x) => x.item.id) };
}

/** Close, drop, reopen or re-date one item. Returns the item, or throws. Mutates the store. */
export function setStatus(store, id, change, { note = null, by = "chat", due = null, now = Date.now() } = {}) {
  const a = (store.actions || {})[id];
  if (!a) throw new Error(`no action item ${id}`);
  const at = new Date(now).toISOString();
  if (change === "done" || change === "drop") Object.assign(a, { status: change === "done" ? "done" : "dropped", closed_at: at, closed_by: by, note });
  else if (change === "reopen") Object.assign(a, { status: "open", closed_at: null, closed_by: null, note, ...(due ? { due } : {}) });
  else if (change === "due") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due))) throw new Error("due needs YYYY-MM-DD");
    Object.assign(a, { due, nudges: (a.nudges || []).filter((d) => d < due) });
  } else throw new Error(`unknown change ${change}`);
  return a;
}

/** The post-call recap for one freshly logged call. Pure. */
export function recapText(entry, added, closed, { who }) {
  const l = entry.log || {};
  const lines = [`Call with ${who}, ${entry.minutes} min: ${l.title || "logged"}.`];
  if (l.summary) lines.push(l.summary);
  const mine = added.filter((a) => a.owner === "self"), theirs = added.filter((a) => a.owner !== "self");
  const dueText = (a) => (a.due ? ` (by ${a.due})` : "");
  if (mine.length) { lines.push(""); lines.push("Your action items:"); for (const a of mine) lines.push(`• ${a.step}${dueText(a)}`); }
  if (theirs.length) { lines.push(""); lines.push("Theirs:"); for (const a of theirs) lines.push(`• ${a.who}: ${a.step}${dueText(a)}`); }
  if (closed.length) { lines.push(""); lines.push("Done since last time:"); for (const a of closed) lines.push(`• ${a.owner === "self" ? "You" : a.who}: ${a.step}`); }
  lines.push("");
  lines.push(added.length ? "I'll follow up on these. Tell me if I got anything wrong." : "No action items came out of it. Tell me if I missed one.");
  const src = entry.source === "transcript" ? "from the call's transcript" : entry.source === "summary" ? "from Zoom's AI summary (no transcript was available)" : null;
  if (src) lines.push(`(${src})`);
  return lines.join("\n");
}

/** Items for `call-log actions`: open first (the user's, then others'), newest call first. Pure. */
export function listItems(store, { all = false } = {}) {
  const rank = (a) => (a.status === "open" ? 0 : 1) * 2 + (a.owner === "self" ? 0 : 1);
  return Object.values(store.actions || {}).filter((a) => all || a.status === "open")
    .sort((a, b) => rank(a) - rank(b) || String(b.call_date).localeCompare(String(a.call_date)));
}
