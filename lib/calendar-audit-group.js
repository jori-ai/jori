// calendar-audit-group — collapse calendar-attendee-audit findings by recurring
// SERIES instead of by expanded instance.
//
// WHAT THIS DEFENDS AGAINST. The audit once paged the system channel with
// "⚠️ 58 calendar event(s) with attendees Jori cannot account for". The
// 58 bullets were 58 expanded instances of ONE weekly series the user
// created by hand — a single fact, reported fifty-eight times. The
// message ran ~12KB, wrote 58 rows into the seen-ledger, and made the remedy
// the alert itself prints ("calendar-attendee-audit --forget <event-id>")
// unusable: fifty-eight ids to forget instead of one.
//
// WHY IT HAPPENED. `gog calendar list` returns EXPANDED INSTANCES, and every
// instance inherits the series' attendee list, created time and creator. The
// audit's window reaches 400 days forward, so one weekly recurrence fans out
// into ~57 findings. The series id was on every instance the whole time, as
// `recurringEventId`; nothing read it.
//
// DETECTION STRENGTH IS DELIBERATELY UNCHANGED. A series is reported when ANY
// of its instances carries an unaccounted guest, and the guests named are the
// UNION across instances — so a guest added to one instance only (Google allows
// per-instance attendee overrides) still fires. This collapses the REPORT, not
// the check.

/**
 * Is this event in scope for the attendee audit, i.e. could a write by Jori
 * have put its guest list there at all?
 *
 * Only events the user ORGANIZES are in scope. A meeting someone else set up and
 * invited the user to carries the other organizer's attendee list, not Jori's.
 *
 * One shape needs an explicit exclusion. An invitation received from outside
 * Google Calendar (an Outlook or Teams meeting, an emailed .ics) is written into
 * the user's calendar as a PRIVATE COPY: `privateCopy: true`, `creator.self:
 * true`, and the outside sender as `organizer` with no `self` flag. The Calendar
 * API documents a private copy as "event propagation is disabled": its guest
 * list is the outside organizer's, and nothing written to it reaches any guest.
 * Counting `creator.self` alone made those guests surface in the system-channel
 * page "⚠️ N calendar event(s) with attendees Jori cannot account for".
 *
 * The exclusion is narrow on purpose. A private copy is only dropped when an
 * organizer is named and that organizer is not the user (no `self` flag, address
 * not one of `selfAddresses`). A private copy with no organizer at all, or one the
 * user organizes, stays in scope, so a malformed event fails toward reporting.
 * Every other event is judged exactly as before: in scope when the organizer or
 * creator is the user, by `self` flag or by address.
 *
 * @param {object} ev              a Google Calendar event resource
 * @param {Set<string>} selfAddresses the user's own addresses, lower-cased
 * @returns {boolean}
 */
export function inAuditScope(ev, selfAddresses) {
  const self = selfAddresses instanceof Set ? selfAddresses : new Set(selfAddresses || []);
  const organizer = String(ev?.organizer?.email || "").toLowerCase();
  const creator = String(ev?.creator?.email || "").toLowerCase();
  const organizerIsUser = ev?.organizer?.self === true || self.has(organizer);
  if (ev?.privateCopy === true && organizer && !organizerIsUser) return false;
  if (ev?.organizer?.self === true || ev?.creator?.self === true) return true;
  return self.has(organizer) || self.has(creator);
}

/**
 * The stable identity of an event for audit purposes: the recurring series it
 * belongs to, or the event itself when it is a one-off. Instances carry
 * `recurringEventId`; one-offs do not.
 */
export function seriesKey(ev) {
  return String(ev?.recurringEventId || ev?.id || "");
}

/**
 * Fold per-instance findings into one finding per series.
 *
 * Each input finding carries `key` (from seriesKey) and `id` (the instance).
 * The output finding is keyed by the SERIES — which is what the alert names,
 * what the seen-ledger remembers, and what `--forget` takes.
 */
export function collapseFindings(findings) {
  const bySeries = new Map();
  for (const f of findings) {
    const key = f.key || f.id;
    const prev = bySeries.get(key);
    if (!prev) {
      bySeries.set(key, {
        ...f,
        id: key,
        instances: 1,
        instance_ids: [f.id],
        _allUnexplained: f.kind === "unexplained",
      });
      continue;
    }
    prev.instances += 1;
    if (prev.instance_ids.length < 5) prev.instance_ids.push(f.id);
    // Keep the LATEST change across the series, so "last changed" reflects the
    // most recent edit to any instance, not whichever one happened to be first.
    if (Date.parse(f.updated || "") > (Date.parse(prev.updated || "") || -Infinity)) prev.updated = f.updated;
    prev.attendees = [...new Set([...prev.attendees, ...(f.attendees || [])])];
    prev.uncovered = [...new Set([...prev.uncovered, ...(f.uncovered || [])])];
    // "unexplained" means NO log row covers it. One instance that does have a
    // row makes the series only partially explained, which is the weaker and
    // therefore the honest claim.
    prev._allUnexplained = prev._allUnexplained && f.kind === "unexplained";
  }
  return [...bySeries.values()].map(({ _allUnexplained, ...f }) => ({
    ...f,
    kind: _allUnexplained ? "unexplained" : "partial",
  }));
}

// A later edit counts only past this gap; Google bumps `updated` a few seconds
// after creation on an ordinary write.
const LAST_CHANGED_GAP_MS = 10 * 60 * 1000;

const stamp = (iso) => `${String(iso).slice(0, 16).replace("T", " ")}Z`;

/**
 * The bullet line the audit prints for one finding.
 *
 * This used to append "no description, which is how a hand-made meeting
 * usually looks". That tell was false: Jori once created an event with no
 * guests and no description, and the next day the user renamed it and invited
 * two family members.
 * The page blamed the right person for the wrong reason, and in the case this
 * control exists for (a Jori turn adding guests to its own event around the
 * wrapper) the same tell would point at the user. So the description is never
 * read as a tell. What is printed instead is Google's own `updated` time when it
 * is well after `created`: a fact, not a guess about who made the change.
 */
export function formatFindingLine(f) {
  const why = f.kind === "unexplained"
    ? "no row in the write log covers this event"
    : "the write log has rows for this event, but none names these guests";
  const when = f.created ? ` · created ${stamp(f.created)} by ${f.creator || "unknown"}` : "";
  const c = Date.parse(f.created || "");
  const u = Date.parse(f.updated || "");
  const changed = Number.isFinite(c) && Number.isFinite(u) && u - c > LAST_CHANGED_GAP_MS
    ? ` · last changed ${stamp(f.updated)}` : "";
  const many = f.instances > 1 ? ` · recurring series, ${f.instances} occurrences in the window` : "";
  return `• ${f.summary} — ${f.uncovered.join(", ")} (${why})${when}${changed}${many}`;
}
