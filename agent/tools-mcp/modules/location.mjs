// tools-mcp/modules/location.mjs — location context and Find My: the user's
// phone GPS (whereami, location-wake, location-track), the resolved day
// (location-day, location-segment), named places (geofence-check,
// location-commute, location-pattern), companions (location-annotate) and
// Find My (findme).
// Served by agent/tools-mcp/index.mjs (loadExtTools). `after` keeps the tools
// at their place in the served tool list; the anchor is the installation's
// (agent/local/config/location-tools.json `tools_after`). A tool whose bin is
// not installed stays listed and answers that it is not installed: the
// capability is off, not broken.
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("../../../lib/instance.cjs");
const cfg = localConfig("location-tools", { tools_after: null });
const OWNER = instance().owner_name;

export const after = cfg.tools_after || null;

export function tools({ BIN, run: runBin }) {
  // Run one of the location bins by name; a missing bin is "not installed",
  // never a spawn error.
  const run = (name, args) => {
    const bin = path.join(BIN, name);
    return fsSync.existsSync(bin) ? runBin(bin, args) : `${name} is not installed in this installation (location tools are off).`;
  };
  return [
    // ── Location Context (aggregating tools) ──
    {
      name: "whereami",
      description: `Current context snapshot for ${OWNER}: GPS, resolved place name, motion activity, phone_context freshness, recent photos. Use for 'where am I?' / 'what am I doing?'. Returns JSON. Reads Supabase (no phone wake).`,
      schema: {
        type: "object",
        properties: {
          brief: { type: "boolean", description: "Return one-line summary instead of full JSON" },
          no_reverse: { type: "boolean", description: "Skip Nominatim reverse geocode (faster, named locations only)" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.brief) args.push("--brief");
        if (a.no_reverse) args.push("--no-reverse");
        args.push("--no-calendar");
        return run("whereami", args);
      },
    },
    {
      name: "location_wake",
      description: `Force a fresh GPS fix from the phone of ${OWNER} via jori_commands.get_location. Wakes the phone; use only when latest GPS is >15 min stale AND a real-time answer matters.`,
      schema: {
        type: "object",
        properties: {
          timeout: { type: "number", description: "Seconds to wait for phone response (default 15)" },
        },
      },
      run: (a) => run("location-wake", a.timeout ? ["--timeout", String(a.timeout)] : []),
    },
    {
      name: "location_track",
      description: "Raw GPS breadcrumb sequence for a time range. Returns samples with distance/speed between points. Use for 'show me my path', debugging sparse data.",
      schema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "yesterday"], description: "Named period" },
          last: { type: "string", description: "Relative window e.g. '2h' or '90m'" },
          start: { type: "string", description: "ISO 8601 or YYYY-MM-DD" },
          end: { type: "string", description: "ISO 8601 or YYYY-MM-DD" },
          min_accuracy: { type: "number", description: "Drop samples with accuracy_m > this (default 500)" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.period) args.push(a.period);
        if (a.last) args.push("--last", a.last);
        if (a.start) args.push("--start", a.start);
        if (a.end) args.push("--end", a.end);
        if (a.min_accuracy !== undefined) args.push("--min-accuracy", String(a.min_accuracy));
        return run("location-track", args);
      },
    },
    {
      name: "location_stops",
      description: "Resolved day timeline (stops + routes + gaps) with venue resolution (named → confirmed → known-recurring → wifi → OSM/Google merged → reverse-geocode), pattern flag (dwell|browse), per-route mode classification, and Google Calendar fusion. Use for 'where was I yesterday?' / 'what did I do today?' / 'what was that long stop near <street>?'. Wraps `location-day` (which calls resolve-day → location-segment).",
      schema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "yesterday"], description: "Date selector (overrides start/end if set)" },
          date: { type: "string", description: "YYYY-MM-DD (alternative to period)" },
        },
      },
      run: (a) => {
        const arg = a.period || a.date || "today";
        return run("location-day", [arg]);
      },
    },
    {
      name: "location_segment",
      description: "Raw location-segment output for a date or window. Use when you need the GPS-only timeline (no calendar fusion, no companions merge). Returns stops[] with venue resolution + pattern flag, routes[] with multi-leg mode classification + waypoints + polyline, gaps[], and summary{}.",
      schema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "yesterday"] },
          start: { type: "string", description: "YYYY-MM-DD or ISO 8601" },
          end: { type: "string", description: "YYYY-MM-DD or ISO 8601" },
          no_places: { type: "boolean", description: "Skip Google Places enrichment" },
          no_overpass: { type: "boolean", description: "Skip OSM Overpass primary lookup" },
          no_photos: { type: "boolean", description: "Skip photo waypoints" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.period) args.push(a.period);
        if (a.start) args.push("--start", a.start);
        if (a.end) args.push("--end", a.end);
        if (a.no_places) args.push("--no-places");
        if (a.no_overpass) args.push("--no-overpass");
        if (a.no_photos) args.push("--no-photos");
        return run("location-segment", args);
      },
    },
    {
      name: "geofence_check",
      description: `Is ${OWNER} currently at X? Accepts a named location (a name or alias from the installation's named locations, e.g. 'home') OR coordinates OR an address. Use --all for distance to every named place.`,
      schema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Named location or address (e.g. 'home', '<named place>', '<street address>')" },
          coords: { type: "string", description: "Comma-separated lat,lon (e.g. '<lat>,<lon>')" },
          address: { type: "string", description: "Free-text address to geocode" },
          radius_km: { type: "number", description: "Match radius in km (default 0.15)" },
          all: { type: "boolean", description: "Return distance to every named location" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.all) args.push("--all");
        else if (a.target) args.push(a.target);
        if (a.coords) args.push("--coords", a.coords);
        if (a.address) args.push("--address", a.address);
        if (a.radius_km !== undefined) args.push("--radius", String(a.radius_km));
        return run("geofence-check", args);
      },
    },
    {
      name: "location_pattern",
      description: "Find habitual location for a time window. Use for 'where am I usually at 6pm Wednesdays?' or --now for current time slot.",
      schema: {
        type: "object",
        properties: {
          now: { type: "boolean", description: "Use current hour ±1h and current day-of-week" },
          hour: { type: "number", description: "Hour of day 0-23 (home time zone)" },
          time_range: { type: "string", description: "Time range e.g. '17:00-19:00'" },
          dow: { type: "string", description: "Day(s) of week: mon|tue|wed|thu|fri|sat|sun, comma-separated" },
          weekdays: { type: "boolean" },
          weekends: { type: "boolean" },
          weeks: { type: "number", description: "Weeks of history to analyze (default 4)" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.now) args.push("--now");
        if (a.hour !== undefined) args.push("--hour", String(a.hour));
        if (a.time_range) args.push("--time", a.time_range);
        if (a.dow) args.push("--dow", a.dow);
        if (a.weekdays) args.push("--weekdays");
        if (a.weekends) args.push("--weekends");
        if (a.weeks !== undefined) args.push("--weeks", String(a.weeks));
        return run("location-pattern", args);
      },
    },
    {
      name: "location_commute",
      description: `Google Routes ETA from the current location of ${OWNER} to a destination. Supports named locations (e.g. home), addresses, or coords.`,
      schema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Destination: named location or address" },
          mode: { type: "string", enum: ["driving", "walking", "transit", "bicycling"], description: "Travel mode (default driving)" },
        },
        required: ["target"],
      },
      run: (a) => run("location-commute", [a.target, ...(a.mode ? ["--mode", a.mode] : [])]),
    },
    {
      name: "location_annotate",
      description: `Tag location_history samples retroactively with companions and/or notes. Use for 'yeah that was with <name>' / 'mark the evening as with <name>' / learning patterns. Idempotent — companions are merged, not duplicated. A companion name Jori does not already know is refused (nothing written): ask ${OWNER} who it is first, then pass the answer as new_companion_authorized.`,
      schema: {
        type: "object",
        properties: {
          last: { type: "string", description: "Relative window e.g. '30m' or '2h'" },
          today: { type: "string", description: "Today's time range HH:MM-HH:MM (home time zone)" },
          yesterday: { type: "string", description: "Yesterday's time range HH:MM-HH:MM (home time zone)" },
          date: { type: "string", description: "Explicit YYYY-MM-DD (pair with date_range)" },
          date_range: { type: "string", description: "HH:MM-HH:MM for --date" },
          start: { type: "string", description: "ISO 8601 start" },
          end: { type: "string", description: "ISO 8601 end" },
          companions: {
            type: "array",
            items: { type: "string" },
            description: "Add these people/entities as companions (e.g. ['<name>'], ['<name>','<name>'])",
          },
          new_companion_authorized: { type: "string", description: `What ${OWNER} actually said when telling you who an unfamiliar companion is (a quote, not a flag). A name not already known is refused until you ask and pass the answer here.` },
          note: { type: "string", description: "Set or append note on matching rows" },
          append_note: { type: "boolean", description: "Append to existing notes instead of overwriting" },
          dry_run: { type: "boolean", description: "Preview match count without writing" },
          scan_similar: { type: "boolean", description: "Also tag past walks matching the reference window's pattern (time-of-day ±90min, duration ±50%, start/end within 500m). Use when the user confirms a recurring habit like 'the evening dog walk' so we retroactively tag all matching history." },
          weeks: { type: "number", description: "Weeks of history to scan for scan_similar (default 4)" },
        },
      },
      run: (a) => {
        const args = [];
        if (a.last) args.push("--last", a.last);
        if (a.today) args.push("--today", a.today);
        if (a.yesterday) args.push("--yesterday", a.yesterday);
        if (a.date) args.push("--date", a.date);
        if (a.date_range) args.push("--date-range", a.date_range);
        if (a.start) args.push("--start", a.start);
        if (a.end) args.push("--end", a.end);
        for (const c of a.companions || []) args.push("--companion", c);
        if (a.new_companion_authorized) args.push("--new-companion-authorized", a.new_companion_authorized);
        if (a.note) args.push("--note", a.note);
        if (a.append_note) args.push("--append-note");
        if (a.dry_run) args.push("--dry-run");
        if (a.scan_similar) args.push("--scan-similar");
        if (a.weeks !== undefined) args.push("--weeks", String(a.weeks));
        return run("location-annotate", args);
      },
    },

    // ── Find My + Location ──
    {
      name: "findme_locate",
      description: `Locate a person or device. For ${OWNER}: uses Jori app GPS (live). For others: iCloud Find My. Use 'all' for everyone.`,
      schema: { type: "object", properties: { target: { type: "string", description: "Person name, device name, or 'all'" } }, required: ["target"] },
      run: (a) => run("findme", ["locate", a.target, "--json"]),
    },
    {
      name: "findme_history",
      description: `The location history of ${OWNER} — timeline of places visited, restaurants, walks, drives. Returns sparse segments: 'was at X from T1 to T2'.`,
      schema: { type: "object", properties: { date: { type: "string", description: "Date: 'today' (default), 'yesterday', or YYYY-MM-DD" } } },
      run: (a) => run("findme", ["history", a.date || "today", "--json"]),
    },
    {
      name: "findme_activity",
      description: `What is ${OWNER} doing right now — stationary at home, walking, driving, at a restaurant, etc.`,
      schema: { type: "object", properties: {} },
      run: () => run("findme", ["activity", "--json"]),
    },
    {
      name: "findme_list",
      description: "List all available Find My devices and people",
      schema: { type: "object", properties: {} },
      run: () => run("findme", ["list"]),
    },
  ];
}
