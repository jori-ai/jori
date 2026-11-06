"use strict";
// lock-health — the rules behind bin/lock-health, as pure functions.
//
// WHAT IT IS FOR. A door code fails at the moment someone needs it: a tenant's
// code is pushed to a lock whose gateway is busy or which the gateway can no
// longer reach, or a guest stands at a door whose lock has been off Wi-Fi for
// days. Both happened in one fortnight (late October 2026): four tenant codes
// failed at once on a busy gateway and a dead back-door lock, and a lock was
// offline for twelve days while every remote unlock was refused. Each time the
// first anyone heard was the failure itself. This turns the lock's state into
// one message BEFORE the code is needed, and one more when it is fixed.
//
// The bin gathers readings (TTLock cloud + live probes, Schlage via
// the installation's Schlage status command) and the upcoming needs (leases starting,
// codes the hub is still retrying); this file decides what is wrong, what is
// new, what has recovered, and how to say it. No I/O here, so it is all tested.
//
// Every string matched below is machine data — TTLock error codes, provider
// ids, slugs. Nothing reads a person's words (Rule #0b).

const { ERR } = require("./ttlock.js");
const { zonedMs } = require("./stay-calendar.js");

const HOUR = 3600 * 1000;

const DEFAULTS = {
  battery_low_pct: 20,      // at or below: one alert (the hub separately warns the tenants at 25/15/10)
  probe_every_hours: 6,     // a healthy TTLock lock is woken through its gateway this often, no more
  preflight_hours: 36,      // a lease starting this soon makes its locks "needed"
  confirm_runs: 2,          // a problem must be seen on this many runs in a row before it alerts…
  // …except these, which are facts the provider states outright rather than a
  // single failed probe that may be a blip.
  confirm_once: ["battery_low", "no_gateway"],
};

function settings(cfg = {}) {
  return { ...DEFAULTS, ...cfg };
}

// The four ways a TTLock lock can be out of reach, from the outermost layer in.
// They are one problem seen at different layers: a gateway dropping in and out
// shows as "gateway offline" on one run, "no gateway paired" on the next and a
// failed probe on the one after. So they share one condition per lock, keyed
// `<lock>|reach`; `kind` keeps the layer seen last, for the words. Keyed by
// layer instead, every change of layer read as a recovery plus a brand-new
// problem, and one row could say a lock was both broken and back to normal.
const REACH = ["no_gateway", "gateway_offline", "unreachable", "gateway_busy"];

/** The state key a condition lives under (one `reach` key per lock for every REACH layer). */
function conditionKey(lockKey, kind) {
  return `${lockKey}|${REACH.includes(kind) ? "reach" : kind}`;
}

// ── Readings → conditions ──────────────────────────────────────────────────

/** Short, plain words for each condition, as they appear in a bullet. */
function conditionText(kind, r) {
  switch (kind) {
    case "offline": return "offline (its cloud can't reach it)";
    case "gateway_offline": return `gateway${r.gateway?.name ? ` ${r.gateway.name}` : ""} offline`;
    case "no_gateway": return "no gateway paired, so codes can't be sent to it";
    case "unreachable":
      if (r.probe?.errcode === ERR.NOT_CONNECTED_TO_GATEWAY) return "the gateway can't reach the lock (dead batteries or out of range)";
      if (r.probe?.errcode === ERR.FAILED) return "the gateway can't reach the lock (the lock didn't answer it)";
      return `the gateway can't reach the lock (${r.probe?.errmsg || `error ${r.probe?.errcode}`})`;
    case "gateway_busy": return "the gateway keeps answering busy";
    case "battery_low": return `battery ${r.battery}%`;
    case "unreadable": return `can't read its status (${r.error})`;
    default: return kind;
  }
}

/**
 * What is wrong with one lock right now, from one reading. A reading carries
 * `error` when its provider could not be asked at all; that is one
 * "unreadable" condition and nothing else, because no other fact is known.
 */
function conditionsOf(r, cfg) {
  const s = settings(cfg);
  if (r.error) return ["unreadable"];
  const out = [];
  if (r.provider === "schlage") {
    if (r.online === false) out.push("offline");
  } else if (r.provider === "ttlock") {
    if (!r.has_gateway) out.push("no_gateway");
    else if (r.gateway && r.gateway.online === false) out.push("gateway_offline");
    else if (r.probe && !r.probe.ok) {
      out.push(r.probe.errcode === ERR.GATEWAY_BUSY ? "gateway_busy" : "unreachable");
    }
  }
  // TTLock reports 0 for a lock it has not heard from — not a reading.
  const lowFlag = r.provider === "schlage" && r.battery_low === true;
  if (lowFlag || (Number.isFinite(r.battery) && r.battery > 0 && r.battery <= s.battery_low_pct)) out.push("battery_low");
  return out;
}

// ── Which TTLock locks to wake this run ────────────────────────────────────

/**
 * A probe wakes the lock over Bluetooth through its gateway, which costs
 * battery and occupies the gateway (a busy gateway is exactly what failed the
 * codes on 2026-10-31). So a healthy lock is probed only every
 * `probe_every_hours`; a lock with an open problem is probed every run so its
 * recovery is seen, and a lock someone is about to need is probed if its last
 * probe is over an hour old.
 */
function shouldProbe(lockKey, state, { needed = false, nowMs, cfg }) {
  const s = settings(cfg);
  const last = state.probes?.[lockKey];
  const age = last?.at ? nowMs - Date.parse(last.at) : Infinity;
  const open = Object.keys(state.conditions || {}).some((k) => k.startsWith(`${lockKey}|`));
  if (open) return true;
  if (needed && age > HOUR) return true;
  return age >= s.probe_every_hours * HOUR;
}

// ── Needs: who will need which lock soon ───────────────────────────────────

const ymd = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * Upcoming needs from the books: a signed lease starting within the window,
 * and a tenant whose code the hub has not managed to set yet (its retry cron
 * keeps re-sending until check-in, so the lock must be reachable for that).
 * Returns [{ property, unit, atMs, why }]. Names stay out of it: the alert
 * says "a check-in", not whose.
 */
function upcomingNeeds({ leases = [], tenants = [], nowMs, cfg, tz = "UTC" }) {
  const s = settings(cfg);
  const until = nowMs + s.preflight_hours * HOUR;
  const out = [];
  for (const l of leases) {
    if (!l || String(l.status) !== "completed") continue;
    const t = l.terms || {};
    const start = ymd(t.startDate);
    if (!t.propertySlug || !start) continue;
    // The hub's lease check-in time, at the property's wall clock (its default is 15:00).
    const atMs = zonedMs(start, /^\d{2}:\d{2}$/.test(t.checkInTime || "") ? t.checkInTime : "15:00", tz);
    // The day matters, not the minute: a lease that started earlier today still needs its door.
    if (atMs + 24 * HOUR < nowMs || atMs > until) continue;
    out.push({ property: t.propertySlug, unit: t.unitId || null, atMs, why: "check-in" });
  }
  for (const t of tenants) {
    if (!t || !t.propertySlug) continue;
    if (["former", "evicted"].includes(t.status)) continue;
    if (!t.ttlockError && !t.schlageError) continue;
    out.push({ property: t.propertySlug, unit: t.unitId || null, atMs: null, why: "code-pending" });
  }
  return out;
}

/** The lock keys a need touches: its unit's locks, or every lock at the property when the unit is unknown. */
function locksForNeed(need, readings) {
  const atProperty = readings.filter((r) => r.property === need.property);
  const inUnit = need.unit ? atProperty.filter((r) => (r.units || []).includes(need.unit)) : [];
  return (inUnit.length ? inUnit : atProperty).map((r) => r.key);
}

/** lockKey → the needs that touch it. */
function needsByLock(needs, readings) {
  const m = new Map();
  for (const n of needs) for (const k of locksForNeed(n, readings)) {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(n);
  }
  return m;
}

// ── State transitions: alert once, recover once ────────────────────────────

/**
 * Fold this run's readings into the remembered state and decide what to say.
 *
 * A condition is keyed `conditionKey(lockKey, kind)`. It alerts once, when it has been
 * seen `confirm_runs` runs in a row (at once if it is a stated fact like a low
 * battery, or if someone needs that lock within the pre-flight window). It
 * says nothing more while it lasts. When a run no longer sees it, a condition
 * that alerted sends one recovery line; one that never alerted is dropped
 * quietly.
 *
 * A lock whose provider could not be read this run (`unread`) keeps its
 * conditions as they were: no data is not a recovery.
 *
 * A REACH condition that moves to another layer keeps its key, its run count
 * and its alerted_at, and only its words change: no recovery, no second alert.
 * State written under the older per-layer keys is folded in the same way.
 *
 * @returns {{ alerts: object[], recoveries: object[], state: object }}
 */
function plan({ readings, state = {}, needs = new Map(), nowMs, cfg, unread = new Set() }) {
  const s = settings(cfg);
  const prev = {};
  for (const [k, c] of Object.entries(state.conditions || {})) {
    const [lock, kind] = k.split("|");
    const nk = conditionKey(c?.lock || lock, kind === "reach" ? "unreachable" : kind);
    if (!prev[nk]) prev[nk] = c;
  }
  const next = {};
  const alerts = [];
  const recoveries = [];
  const now = new Date(nowMs).toISOString();
  const seenNow = new Set();

  for (const r of readings) {
    const lockNeeds = needs.get(r.key) || [];
    for (const kind of conditionsOf(r, s)) {
      const key = conditionKey(r.key, kind);
      seenNow.add(key);
      const p = prev[key];
      const c = {
        lock: r.key, kind, name: r.name, property: r.property,
        first_seen: p?.first_seen || now, runs: (p?.runs || 0) + 1,
        alerted_at: p?.alerted_at || null, text: conditionText(kind, r),
      };
      const ready = c.runs >= s.confirm_runs || s.confirm_once.includes(kind) || lockNeeds.length > 0;
      if (!c.alerted_at && ready) {
        c.alerted_at = now;
        alerts.push({ ...c, needs: lockNeeds, reading: r });
      }
      next[key] = c;
    }
  }

  for (const [key, c] of Object.entries(prev)) {
    if (seenNow.has(key)) continue;
    if (unread.has(c.lock) || unread.has(`provider:${c.lock.split(":")[0]}`)) { next[key] = c; continue; }
    if (c.alerted_at) recoveries.push({ ...c, recovered_at: now });
  }

  return { alerts, recoveries, state: { ...state, conditions: next, last_run_at: now } };
}

// ── Words ──────────────────────────────────────────────────────────────────

function fmtWhen(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(ms)).replace(":00", "");
}

function needText(needs, tz) {
  if (!needs || !needs.length) return "";
  const checkIns = needs.filter((n) => n.why === "check-in" && n.atMs).sort((a, b) => a.atMs - b.atMs);
  const pending = needs.filter((n) => n.why === "code-pending").length;
  const bits = [];
  if (checkIns.length) bits.push(`check-in ${fmtWhen(checkIns[0].atMs, tz)}`);
  if (pending) bits.push(`${pending} code${pending === 1 ? "" : "s"} waiting to be set`);
  return bits.length ? ` · needed: ${bits.join(", ")}` : "";
}

function label(c, propertyNames) {
  const prop = c.property ? (propertyNames[c.property] || c.property) : null;
  return prop ? `${prop} · ${c.name}` : c.name;
}

/**
 * One system-channel message for a run: problems first, then recoveries.
 * Returns { text, push } — push is the one-line banner, set only when there
 * is something new to act on (a recovery alone posts silently).
 */
function compose({ alerts, recoveries, propertyNames = {}, tz = "UTC" }) {
  if (!alerts.length && !recoveries.length) return null;
  const lines = [];
  let push = null;
  if (alerts.length) {
    // One bullet per lock, its conditions joined, so a dead lock is one line, not three.
    const byLock = new Map();
    for (const a of alerts) {
      if (!byLock.has(a.lock)) byLock.set(a.lock, []);
      byLock.get(a.lock).push(a);
    }
    const n = byLock.size;
    // The banner names the lock when there is one; the row's bullets carry the detail.
    lines.push(n === 1 ? "🔐 Lock problem, before anyone needs the door" : `🔐 ${n} locks need attention, before anyone needs the doors`);
    for (const group of byLock.values()) {
      const a = group[0];
      lines.push(`- ${label(a, propertyNames)}: ${group.map((g) => g.text).join("; ")}${needText(group.flatMap((g) => g.needs), tz)}`);
    }
    push = n === 1 ? `Lock problem: ${label(alerts[0], propertyNames)}` : `${n} locks need attention`;
  }
  if (recoveries.length) {
    if (lines.length) lines.push("");
    const byLock = new Map();
    for (const r of recoveries) {
      if (!byLock.has(r.lock)) byLock.set(r.lock, []);
      byLock.get(r.lock).push(r);
    }
    lines.push(`✅ Lock${byLock.size === 1 ? "" : "s"} back to normal`);
    for (const group of byLock.values()) {
      lines.push(`- ${label(group[0], propertyNames)}: ${group.map((g) => g.kind === "battery_low" ? "battery changed" : `no longer ${g.text.replace(/ \(.*\)$/, "")}`).join("; ")}`);
    }
  }
  return { text: lines.join("\n"), push };
}

/**
 * The pre-flight verdict for one property/unit, for `lock-health preflight`:
 * every lock that need touches and what is wrong with it now (confirmed or
 * not — a pre-flight wants to know about a blip too).
 */
function preflightVerdict({ need, readings, cfg }) {
  const keys = locksForNeed(need, readings);
  const locks = readings.filter((r) => keys.includes(r.key)).map((r) => ({
    key: r.key, name: r.name, problems: conditionsOf(r, cfg).map((k) => conditionText(k, r)),
  }));
  return { ok: locks.length > 0 && locks.every((l) => !l.problems.length), locks };
}

module.exports = {
  DEFAULTS, REACH, settings, conditionKey, conditionsOf, conditionText, shouldProbe,
  upcomingNeeds, locksForNeed, needsByLock, plan, compose, preflightVerdict, fmtWhen,
};
