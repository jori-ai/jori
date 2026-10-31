// launch-watch.mjs — pure logic for bin/launch-watch-run: normalise the
// Launch Library 2 response, reconcile it against state, and size the calendar
// hold. Kept I/O-free so tests/launch-watch.test.mjs can pin it with fixtures.
//
// The source is structured JSON (NET timestamps already UTC ISO with an
// explicit precision field), so none of this is language — it is the diff /
// window arithmetic a playbook would otherwise spell out step by step.
//
// Which launches are watched (the search term), how they are labelled and the
// zone holds are rendered in are the caller's: bin/launch-watch-run reads them
// from agent/local/config/launch-watch.json and instance().tz.

const H = 3600_000;
const DAY = 24 * H;

export const API_BASE = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/";

/** The upcoming-launches query for one search term. */
export function apiUrl(search, limit = 10) {
  return `${API_BASE}?search=${encodeURIComponent(search)}&limit=${limit}`;
}

/** The `source` string recorded in state for one search term. */
export function sourceLabel(search) {
  return `ll.thespacedevs.com/2.3.0 launches/upcoming?search=${search}`;
}

export function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function launchKey(l) {
  return `${slug(l.mission)}::${l.net_iso ? l.net_iso.slice(0, 13).toLowerCase() : "tbd"}`;
}

export function precision(name) {
  const n = String(name || "").toLowerCase();
  if (n === "second" || n === "minute") return "minute";
  if (n === "hour") return "hour";
  if (n === "day") return "day";
  return "month"; // Month, Quarter, Half, Year, unknown → track only
}

/** API results[] → normalised launches (future, or within the last 24h). */
export function normalize(results, now = Date.now(), { vehicle = "launch" } = {}) {
  const out = [];
  for (const r of results || []) {
    if (!r?.net) continue;
    const t = Date.parse(r.net);
    if (Number.isNaN(t) || t < now - DAY) continue;
    const we = r.window_end && r.window_end !== r.window_start ? r.window_end : null;
    out.push({
      mission: String(r.name || vehicle).split(" | ").join(" "),
      vehicle,
      net_iso: r.net,
      net_precision: precision(r.net_precision?.name),
      window_end_iso: we,
      api_status: r.status?.abbrev || null,
      site: r.pad?.location?.name || r.pad?.name || null,
      source_url: r.url || null,
    });
  }
  return out;
}

/** Calendar-worthy: day-or-finer precision and within `horizonDays` (default 180). */
export function calendarWorthy(l, now = Date.now(), horizonDays = 180) {
  if (l.net_precision === "month") return false;
  return Date.parse(l.net_iso) - now <= horizonDays * DAY;
}

/**
 * Reconcile fetched launches against state.launches.
 * → [{action, key, launch, prev?}] where action ∈ create|update|touch|archive|cancel|miss
 */
export function reconcile(stateLaunches, fetched, now = Date.now(), horizonDays = 180) {
  const actions = [];
  const byMission = new Map();
  for (const [key, l] of Object.entries(stateLaunches || {})) {
    if (l.status === "launched" || l.status === "removed") continue;
    byMission.set(slug(l.mission), { key, l });
  }
  const seen = new Set();
  for (const f of fetched) {
    const m = slug(f.mission);
    seen.add(m);
    const ex = byMission.get(m);
    if (!ex) { actions.push({ action: "create", key: launchKey(f), launch: f }); continue; }
    const moved = Math.abs(Date.parse(f.net_iso) - Date.parse(ex.l.net_iso)) > 10 * 60_000;
    const rank = { month: 0, day: 1, hour: 2, minute: 3 };
    const sharper = (rank[f.net_precision] ?? 0) > (rank[ex.l.net_precision] ?? 0);
    const needsEvent = !ex.l.calendar_event_id && calendarWorthy(f, now, horizonDays);
    actions.push({ action: moved || sharper || needsEvent ? "update" : "touch", key: ex.key, launch: f, prev: ex.l });
  }
  for (const [m, { key, l }] of byMission) {
    if (seen.has(m)) continue;
    const t = Date.parse(l.net_iso);
    if (t <= now - DAY) actions.push({ action: "archive", key, prev: l });
    else if ((l.missing_runs || 0) + 1 >= 2) actions.push({ action: "cancel", key, prev: l });
    else actions.push({ action: "miss", key, prev: l });
  }
  return actions;
}

/** "-04:00"/"+01:00" for a UTC instant in zone `tz`, from the tz database. */
export function zoneOffset(ms, tz = "UTC") {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const o = v.replace("GMT", "");
  return o || "+00:00";
}

/** UTC instant → "YYYY-MM-DDTHH:MM:SS±HH:MM" in zone `tz`. */
export function localRfc3339(ms, tz = "UTC") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${zoneOffset(ms, tz)}`;
}

/** The zone's short generic name ("ET", "PT", …), else its id. */
export function zoneLabel(ms, tz = "UTC") {
  try {
    const v = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortGeneric" })
      .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value;
    return v || tz;
  } catch { return tz; }
}

/** The free hold's window by precision (minute: real window or +90m; hour: floor, +2h; day: +3h). */
export function holdWindow(l, tz = "UTC") {
  const t = Date.parse(l.net_iso);
  const we = l.window_end_iso ? Date.parse(l.window_end_iso) : NaN;
  let start = t, end;
  if (l.net_precision === "minute") end = we > t ? we : t + 90 * 60_000;
  else if (l.net_precision === "hour") { start = Math.floor(t / H) * H; end = we > start ? we : start + 2 * H; }
  else end = t + 3 * H;
  return { from: localRfc3339(start, tz), to: localRfc3339(end, tz) };
}

export function displayWhen(l, tz = "UTC") {
  if (l.net_precision === "month") return "month TBD";
  const ms = Date.parse(l.net_iso);
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
  if (l.net_precision === "day") return d;
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  return `${d} ${t} ${zoneLabel(ms, tz)}`;
}

/** Ping lines for material changes only (create, >6h move, cancel). Empty → silent run. */
export function pingLines(results, tz = "UTC") {
  const lines = [];
  for (const r of results) {
    const site = r.launch?.site || r.prev?.site;
    const at = site ? ` (${site})` : "";
    const fail = r.calendarFailed ? " (calendar sync failed)" : "";
    if (r.action === "create") lines.push(`• ADDED ${r.launch.mission} — ${displayWhen(r.launch, tz)}${at}${fail}`);
    else if (r.action === "update" && r.prev && Math.abs(Date.parse(r.launch.net_iso) - Date.parse(r.prev.net_iso)) > 6 * H) {
      lines.push(`• MOVED ${r.launch.mission} — ${displayWhen(r.prev, tz)} → ${displayWhen(r.launch, tz)}${at}${fail}`);
    } else if (r.action === "cancel") lines.push(`• REMOVED ${r.prev.mission} (off the manifest)`);
  }
  return lines;
}

/** Should a run go ahead? Any known launch within 7 days, or the last check ≥ baselineDays old / never. */
export function shouldRun(state, now = Date.now(), baselineDays = 7) {
  if (!state) return true;
  const launches = state.launches || {};
  const imminent = Object.values(launches).some((l) => {
    if (!l || !l.net_iso || l.status === "launched" || l.status === "removed") return false;
    const t = Date.parse(l.net_iso);
    if (Number.isNaN(t)) return false;
    return t - now <= 7 * DAY && t - now > -DAY;
  });
  if (imminent) return true;
  const last = state.last_check_at ? Date.parse(state.last_check_at) : 0;
  return !last || now - last >= baselineDays * DAY;
}
