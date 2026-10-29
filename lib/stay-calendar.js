"use strict";
// stay-calendar — who arrives and leaves at a rental portfolio's properties,
// as events on a dedicated Google calendar of the user's.
//
// WHAT IT PRODUCES: for every confirmed stay — a short-term guest from the
// channel manager (the short-term-rental platform aggregator the properties are
// listed through) or a long-term tenant on a signed lease — a 1-hour event at
// the actual check-in time and a 30-minute "<name> is checking out" event at
// the check-out time, each carrying guest name, platform, property, number of
// guests, pets and duration. Shown as FREE: they inform, they never block the
// user's time. Pending requests and unsigned leases are NOT shown.
//
// WHY A DEDICATED CALENDAR. It can be toggled off in one click, and it makes a
// full reconcile safe: this code owns every event on that calendar that carries
// its key (`phStay`) and touches nothing else anywhere.
//
// WHY "TENTATIVE" IS ONLY SHOW-AS-FREE. Google Calendar has no visible
// tentative state for an event you own ("Maybe" is an RSVP to someone else's
// invite), and neither gog nor the Calendar connector can set event.status.
// Free + the separate calendar is the whole cue.
//
// CONFIG. Everything about the portfolio is the installation's:
// agent/local/config/rentals.json `stay_calendar` — the calendar id, what the
// user calls each property, the channel manager's property ids and label, the
// books' label, the admin URL, the zone. No calendar configured = off.
//
// This file is PURE: data in, desired events and a diff out. All I/O lives in
// bin/stay-calendar, so every rule below is unit-tested without a network
// (tests/stay-calendar.test.mjs).

const crypto = require("node:crypto");
const { instance, localConfig } = require("./instance.cjs");

const DEFAULTS = {
  calendar_id: "",            // the dedicated calendar's id; "" = the capability is off
  calendar_account: "",       // the Google account it lives on; "" = the owner's email
  canonical_names: {},        // registry id → what the user calls the property
  channel_label: "Channel manager",   // the short-term channel manager, as named in event footers
  channel_api_base: "",       // its REST base (reservations endpoint below it)
  channel_token_env: "",      // env var holding its API token
  channel_property_ids: {},   // registry id → the channel manager's property id
  lease_reservation_fields: [], // lease fields marking a lease that the channel manager already carries
  books_label: "Portfolio",   // the books, as named in a lease event's footer ("<label> lease L1 …")
  admin_url: "",              // the hub's admin panel; `?property=<slug>&unit=<id>` opens that unit
  rent_provider_labels: {},   // lease paymentProvider → label shown on the platform line
  tz: "",                     // the properties' zone; "" = the user's zone
};
let _override = null;

/** The stay-calendar settings: defaults ← rentals.json `stay_calendar` ← a test's override. */
function settings() {
  const local = _override || localConfig("rentals", { stay_calendar: {} }).stay_calendar || {};
  const out = { ...DEFAULTS, ...local };
  if (!out.tz) out.tz = instance().tz;
  if (!out.calendar_account) out.calendar_account = instance().owner_email;
  return out;
}

/** Tests: replace the settings with synthetic ones (null restores the local config). */
function configure(o) { _override = o; }

const CHECK_IN_MINUTES = 60;
const CHECK_OUT_MINUTES = 30;
/** Lease templates carry dates only; these are the hub's own defaults (checkTimes.ts). */
const DEFAULT_CHECK_IN = "15:00";
const DEFAULT_CHECK_OUT = "11:00";

/** The window a sync owns. Older events are history and are never touched. */
const WINDOW_BACK_MS = 6 * 3600 * 1000;
const WINDOW_FORWARD_DAYS = 400;

const DAY_MS = 86400000;

// ── Which properties count ─────────────────────────────────────────────────

/** Held and not sold: the registry's own definition of an active property. */
function activeProperties(registryProperties) {
  return (registryProperties || []).filter((p) => p.kind === "property" && !p.disposedOn);
}

const propertyName = (p) => settings().canonical_names[p.id] || p.name || p.id;

// ── Time ───────────────────────────────────────────────────────────────────

/** Minutes east of UTC that `tz` is at instant `ms`. */
function tzOffsetMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((x) => x.type === t).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** A wall-clock time at a property ("2027-06-30", "11:00") → epoch ms. DST-correct. */
function zonedMs(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes: the offset at the guessed instant can differ from the offset at
  // the true one when the guess straddles a DST change.
  let ms = wall - tzOffsetMinutes(wall, tz) * 60000;
  ms = wall - tzOffsetMinutes(ms, tz) * 60000;
  return ms;
}

const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Firestore Timestamps arrive as ISO strings; lease dates are stored at 12:00Z. */
const ymdOf = (v) => (v ? String(v).slice(0, 10) : null);
const validHhmm = (v) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);

function fmtWhen(ms, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(ms));
}

function fmtDay(ms, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, month: "short", day: "numeric", year: "numeric",
  }).format(new Date(ms));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Names ──────────────────────────────────────────────────────────────────

/** One name, two names joined, or "first & N others" — short enough for a title. */
function titleNames(names) {
  if (names.length <= 1) return names[0] || "Guest";
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} & ${names.length - 1} others`;
}

function listNames(names) {
  if (names.length <= 2) return names.join(" & ");
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

const PLATFORM_LABELS = {
  airbnb: "Airbnb",
  homeaway: "VRBO",
  vrbo: "VRBO",
  booking: "Booking.com",
  bookingcom: "Booking.com",
  manual: "Direct booking",
  direct: "Direct booking",
};

function platformLabel(platform) {
  const key = String(platform || "").toLowerCase().replace(/[^a-z]/g, "");
  return PLATFORM_LABELS[key] || (platform ? String(platform) : "Unknown");
}

// ── Building the two events of a stay ──────────────────────────────────────

function hashOf(ev) {
  return crypto.createHash("sha1")
    .update(JSON.stringify([ev.summary, ev.description, ev.start, ev.end, "free", 1]))
    .digest("hex").slice(0, 12);
}

/**
 * The check-in and check-out events for one stay.
 *
 * @param {object} s
 * @param {string} s.key        stable id of the stay: `res:<uuid>` or `lease:<id>`
 * @param {string[]} s.names
 * @param {string} s.platform   already a label
 * @param {string} s.property   canonical name, optionally with a unit
 * @param {string} s.guests
 * @param {string} s.pets
 * @param {string} s.duration
 * @param {number} s.inMs / s.outMs
 * @param {string} s.tz
 * @param {string[]} s.source  where this stay's facts come from, one line each
 * @param {boolean} [s.skipIn] / [s.skipOut]  renewal handover — see leaseStays
 */
function stayEvents(s) {
  const verb = s.names.length > 1 ? "are" : "is";
  const who = titleNames(s.names);
  const details = [
    `${s.names.length > 1 ? "Guests" : "Guest"}: ${listNames(s.names) || "Guest"}`,
    `Platform: ${s.platform}`,
    `Property: ${s.property}`,
    `Number of guests: ${s.guests}`,
    `Pets: ${s.pets}`,
    `Stay: ${s.duration}`,
    `Check-in: ${fmtWhen(s.inMs, s.tz)}`,
    `Check-out: ${fmtWhen(s.outMs, s.tz)}`,
  ];
  // Name the exact record this came from, and why the dates are what they are:
  // an event must say clearly where its update came from.
  const [origin, ...why] = s.source;
  const footer = `\n\n${[`Source: ${origin}`, ...why].join("\n")}`
    + "\nKept in sync by Jori. Edits here are overwritten.";
  const out = [];
  if (!s.skipIn) {
    out.push({
      key: `${s.key}:in`,
      kind: "in",
      summary: `${who} ${verb} checking in`,
      description: details.join("\n") + footer,
      start: isoUtc(s.inMs),
      end: isoUtc(s.inMs + CHECK_IN_MINUTES * 60000),
    });
  }
  if (!s.skipOut) {
    out.push({
      key: `${s.key}:out`,
      kind: "out",
      summary: `${who} ${verb} checking out`,
      description: details.join("\n") + footer,
      start: isoUtc(s.outMs),
      end: isoUtc(s.outMs + CHECK_OUT_MINUTES * 60000),
    });
  }
  for (const ev of out) ev.hash = hashOf(ev);
  return out;
}

// ── Short-term: channel-manager reservations ───────────────────────────────

/**
 * Confirmed means the channel manager's own category is "accepted". Everything else —
 * a request, an inquiry, declined, cancelled, expired — has no event, and a
 * stay that moves out of "accepted" loses its events on the next sync.
 */
function isConfirmedReservation(r) {
  const category = r?.reservation_status?.current?.category;
  if (category) return String(category).toLowerCase() === "accepted";
  return String(r?.status || "").toLowerCase() === "accepted";
}

function reservationStays(reservations, properties) {
  const cfg = settings();
  const byChannelId = new Map();
  for (const p of activeProperties(properties)) {
    const hid = cfg.channel_property_ids[p.id];
    if (hid) byChannelId.set(hid, p);
  }

  const stays = [];
  for (const r of reservations || []) {
    if (!r || !r.id || !isConfirmedReservation(r)) continue;
    if (r.owner_stay) continue; // the owner's own stay is not a guest arriving
    const pid = r.properties?.[0]?.id ?? r.property_id;
    const property = byChannelId.get(pid);
    if (!property) continue;

    const inMs = Date.parse(r.check_in || r.arrival_date);
    const outMs = Date.parse(r.check_out || r.departure_date);
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) continue;

    const g = r.guest || {};
    const name = [g.first_name, g.last_name].map((x) => (x || "").trim()).filter(Boolean).join(" ")
      || (g.full_name || "").trim() || "Guest";

    const counts = r.guests || {};
    const total = counts.total ?? ((counts.adult_count || 0) + (counts.child_count || 0));
    const parts = [];
    if (counts.adult_count) parts.push(plural(counts.adult_count, "adult"));
    if (counts.child_count) parts.push(counts.child_count === 1 ? "1 child" : `${counts.child_count} children`);
    if (counts.infant_count) parts.push(plural(counts.infant_count, "infant"));
    const guests = parts.length > 1 ? `${total} (${parts.join(", ")})` : String(total || "unknown");

    const pets = counts.pet_count ? String(counts.pet_count) : "None";
    const nights = r.nights || Math.round((outMs - inMs) / DAY_MS);
    const tz = cfg.tz;

    stays.push({
      key: `res:${r.id}`,
      source: [`${cfg.channel_label} reservation ${r.code || r.id} (${platformLabel(r.platform)}), confirmed`],
      names: [name],
      platform: r.code ? `${platformLabel(r.platform)} · ${r.code}` : platformLabel(r.platform),
      property: propertyName(property),
      guests,
      pets,
      duration: `${plural(nights, "night")} (${fmtDay(inMs, tz)} → ${fmtDay(outMs, tz)})`,
      inMs,
      outMs,
      tz,
    });
  }
  return stays;
}

// ── Long-term: signed leases ───────────────────────────────────────────────

function monthsBetween(aYmd, bYmd) {
  const days = (Date.parse(`${bYmd}T00:00:00Z`) - Date.parse(`${aYmd}T00:00:00Z`)) / DAY_MS;
  return Math.max(1, Math.round(days / 30.44));
}

/**
 * Only a lease both sides signed (`status: completed`) is a residency. Drafts,
 * sent, partially-signed, voided and revoked leases are not shown.
 *
 * A lease tied to a channel-manager reservation (a monthly let booked through
 * a platform) is skipped: that stay already arrives as a reservation, and
 * showing it twice is noise. Which lease fields mark it is the installation's
 * (`lease_reservation_fields`).
 */
/**
 * The leaseholder a lease's events are titled after: the tenant carrying the
 * hub's point-of-contact mark: the point of contact is always the person who
 * led the application. The hub decides who that is
 * — the application's organiser, or an admin's pick — and the calendar only
 * reads it, so the admin Leases card and the calendar can never disagree.
 * Null when nobody on the lease carries it, and the lease's own order stands.
 */
function pointOfContact(linked) {
  const t = linked.find((x) => x?.pointOfContact && !["former", "evicted"].includes(x.status));
  if (!t) return null;
  // The official name: the one the lease lists, so it matches rather than repeats.
  return [t.firstName, t.lastName].map((x) => (x || "").trim()).filter(Boolean).join(" ") || null;
}

/** `names` with `lead` first, matched by name; added if it isn't there. */
function leadFirst(names, lead) {
  if (!lead) return names;
  const key = (n) => n.toLowerCase().replace(/\s+/g, " ").trim();
  const rest = names.filter((n) => key(n) !== key(lead));
  const listed = names.find((n) => key(n) === key(lead));
  return [listed || lead, ...rest];
}

/** "Long-term lease", naming the rent provider when the installation labels it. */
function rentProviderPlatform(l, linked, labels) {
  const known = Object.keys(labels || {});
  const p = known.find((k) => l.paymentProvider === k) || known.find((k) => linked.some((t) => t.paymentProvider === k));
  return p ? `Long-term lease (${labels[p]})` : "Long-term lease";
}

function leaseStays(leases, tenants, properties) {
  const cfg = settings();
  const bySlug = new Map();
  for (const p of activeProperties(properties)) if (p.publicSlug) bySlug.set(p.publicSlug, p);

  const tenantsByLease = new Map();
  for (const t of tenants || []) {
    if (!t.leaseId) continue;
    if (!tenantsByLease.has(t.leaseId)) tenantsByLease.set(t.leaseId, []);
    tenantsByLease.get(t.leaseId).push(t);
  }

  const stays = [];
  for (const l of leases || []) {
    if (!l || String(l.status) !== "completed") continue;
    if ((cfg.lease_reservation_fields || []).some((f) => l[f] || l.terms?.[f])) continue;
    const terms = l.terms || {};
    const property = bySlug.get(terms.propertySlug);
    if (!property) continue;

    const startYmd = ymdOf(terms.startDate);
    let endYmd = ymdOf(terms.endDate);
    if (!startYmd || !endYmd) continue;

    const linked = tenantsByLease.get(l.id) || [];
    const unitLabel = terms.unitId && terms.unitId !== terms.propertySlug ? `, unit ${terms.unitId}` : "";
    const adminUrl = cfg.admin_url
      ? `${cfg.admin_url}?property=${encodeURIComponent(terms.propertySlug)}`
        + (terms.unitId ? `&unit=${encodeURIComponent(terms.unitId)}` : "")
      : "";
    const source = [
      `${cfg.books_label} lease ${l.id} (${propertyName(property)}${unitLabel}), signed by all parties`,
      "Check-in date: the lease start date",
    ];
    // A signed early termination has already rewritten terms.endDate; say so,
    // with the date it replaced.
    const early = l.earlyTermination;
    let outWhy = early?.previousEndDate && ymdOf(early.terminationDate) === endYmd
      ? `Check-out date: the signed early termination (the lease originally ended ${fmtDay(zonedMs(ymdOf(early.previousEndDate), DEFAULT_CHECK_OUT, cfg.tz), cfg.tz)})`
      : "Check-out date: the lease end date";
    // Everyone on the lease has moved out: the real check-out is the day they
    // left (an eviction, an early termination), not the date on the paper.
    const movedOut = linked.map((t) => ymdOf(t.movedOutAt)).filter(Boolean);
    if (linked.length && movedOut.length === linked.length) {
      endYmd = movedOut.sort().pop();
      outWhy = "Check-out date: the move-out recorded on the tenant records, not the lease end date";
    }
    source.push(outWhy);
    if (adminUrl) source.push(`Open in admin: ${adminUrl}`);

    let names = (l.lessees || []).map((x) => (x?.name || "").trim()).filter(Boolean);
    if (!names.length) {
      for (const t of linked) {
        const n = [t.firstName, t.lastName].map((x) => (x || "").trim()).filter(Boolean).join(" ");
        if (n) names.push(n);
      }
    }
    names = leadFirst(names, pointOfContact(linked));

    const occupants = (l.occupants || []).length;
    const people = names.length + occupants;
    const guests = occupants
      ? `${people} (${plural(names.length, "leaseholder")}, ${plural(occupants, "other occupant")})`
      : String(people || "unknown");

    const petTypes = [...new Set(linked.filter((t) => t.hasPet).map((t) => t.petType || "pet"))];
    const pets = petTypes.length ? petTypes.join(", ") : "None";

    const tz = cfg.tz;
    const inMs = zonedMs(startYmd, validHhmm(terms.checkInTime) || DEFAULT_CHECK_IN, tz);
    const outMs = zonedMs(endYmd, validHhmm(terms.checkOutTime) || DEFAULT_CHECK_OUT, tz);
    const unit = terms.unitId && terms.unitId !== terms.propertySlug ? ` · unit ${terms.unitId}` : "";
    const months = monthsBetween(startYmd, endYmd);

    stays.push({
      key: `lease:${l.id}`,
      source,
      names,
      platform: rentProviderPlatform(l, linked, cfg.rent_provider_labels),
      property: `${propertyName(property)}${unit}`,
      guests,
      pets,
      duration: `${plural(months, "month")} (${fmtDay(inMs, tz)} → ${fmtDay(outMs, tz)})`,
      inMs,
      outMs,
      tz,
      _unit: `${terms.propertySlug}/${terms.unitId || ""}`,
      _startYmd: startYmd,
      _endYmd: endYmd,
    });
  }

  // A renewal written as a NEW lease for the same people is not anyone leaving
  // and arriving: drop the old lease's check-out and the new lease's check-in
  // when they hand over within a day in the same unit and share a leaseholder.
  for (const a of stays) {
    for (const b of stays) {
      if (a === b || a._unit !== b._unit) continue;
      const gapDays = (Date.parse(`${b._startYmd}T00:00:00Z`) - Date.parse(`${a._endYmd}T00:00:00Z`)) / DAY_MS;
      if (gapDays < 0 || gapDays > 1) continue;
      if (!a.names.some((n) => b.names.includes(n))) continue;
      a.skipOut = true;
      b.skipIn = true;
    }
  }
  for (const s of stays) { delete s._unit; delete s._startYmd; delete s._endYmd; }
  return stays;
}

// ── Desired state and the diff ─────────────────────────────────────────────

/**
 * The window a run owns. Normally it starts 6h ago, so history is never
 * rewritten. A backfill (`sinceMs`, e.g. every reservation since the start of
 * the year) starts it earlier instead —
 * the same rules, the same diff, just over a longer stretch.
 */
function windowOf(nowMs, sinceMs) {
  const from = Number.isFinite(sinceMs) ? Math.min(sinceMs, nowMs - WINDOW_BACK_MS) : nowMs - WINDOW_BACK_MS;
  return { from, to: nowMs + WINDOW_FORWARD_DAYS * DAY_MS };
}

/** Every event that should exist on the calendar inside the sync window. */
function desiredEvents({ reservations, leases, tenants, properties, nowMs, sinceMs }) {
  const { from, to } = windowOf(nowMs, sinceMs);
  const stays = [...reservationStays(reservations, properties), ...leaseStays(leases, tenants, properties)];
  const out = [];
  for (const s of stays) {
    for (const ev of stayEvents(s)) {
      const ms = Date.parse(ev.start);
      if (ms >= from && ms < to) out.push(ev);
    }
  }
  return out;
}

const eventTime = (t) => Date.parse(t?.dateTime || t?.date || "");

/**
 * What to change so the calendar matches `desired`.
 *
 * Only events carrying our `phStay` key are ever touched. An event whose
 * content hash, time or title drifted (including a hand edit) is updated back;
 * a key that is no longer desired is deleted; a duplicated key keeps its first
 * copy and loses the rest.
 */
function planSync(desired, existing, nowMs, sinceMs) {
  const { from, to } = windowOf(nowMs, sinceMs);
  const want = new Map(desired.map((d) => [d.key, d]));
  const seen = new Set();
  const create = [];
  const update = [];
  const remove = [];

  for (const ev of existing || []) {
    const key = ev?.extendedProperties?.private?.phStay;
    if (!key) continue;
    const startMs = eventTime(ev.start);
    // Outside the window it is history (or far future we have not looked at):
    // leave it exactly as it is.
    if (!(startMs >= from && startMs < to)) continue;

    if (seen.has(key)) { remove.push({ id: ev.id, key, reason: "duplicate" }); continue; }
    seen.add(key);

    const d = want.get(key);
    if (!d) { remove.push({ id: ev.id, key, reason: "no longer a confirmed stay", summary: ev.summary }); continue; }

    const drifted =
      ev.extendedProperties.private.phHash !== d.hash ||
      startMs !== Date.parse(d.start) ||
      eventTime(ev.end) !== Date.parse(d.end) ||
      ev.summary !== d.summary ||
      ev.transparency !== "transparent";
    if (drifted) update.push({ id: ev.id, event: d });
  }
  for (const d of desired) if (!seen.has(d.key)) create.push(d);
  return { create, update, remove };
}

module.exports = {
  settings,
  configure,
  activeProperties,
  isConfirmedReservation,
  reservationStays,
  leaseStays,
  stayEvents,
  desiredEvents,
  planSync,
  windowOf,
  zonedMs,
  isoUtc,
};
