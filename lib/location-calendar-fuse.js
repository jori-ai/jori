"use strict";
// location-calendar-fuse.js — fetch Google Calendar events for a date range
// and write a JSON file in the format expected by `location-stops --calendar`.
//
// Why it exists: both the daily-summary playbook and the chat-agent need to
// fuse calendar + location-stops on historical "where was I / what did I do"
// queries. daily-summary did this inline via the MCP Calendar tool; the
// chat-agent historically answered location-stops-only and missed planned
// events (see 2026-04-16 "Check my calendar? It's all there" correction).
// This module gives both callers a single, consistent path.
//
// Exports:
//   fetchCalendarJson(startDate, endDate, { tz = instance().tz })
//     → Promise<{ events: Array<{summary, location, description, start, end}> }>
//   writeCalendarFile(startDate, endDate, { path, tz }) → Promise<string path>
//
// Date args are YYYY-MM-DD strings (inclusive start, exclusive end).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Calendar reads go through the `gog` CLI, NOT the raw Calendar API.
//
// This module used to call the API directly with the token from
// google-auth.js — but that token is `credentials/gmail-push-token.json`,
// whose grant is gmail.modify / gmail.settings.basic / userinfo.email /
// drive.readonly. No calendar scope. So every call 403'd with "Request had
// insufficient authentication scopes", which is what took out `resolve-day`
// (seen 2026-07-20). It could never have worked; nothing here was a regression.
//
// `gog` holds a separate, properly-scoped calendar grant and is already the
// calendar path used elsewhere (france-itinerary-layout, retired 2026-07-22), so
// reusing it fixes the 403 without asking the user to re-consent the Gmail token
// — and avoids widening a Gmail push token's scope to cover calendar reads.
// gog's keyring needs GOG_KEYRING_PASSWORD, which cron jobs already get from
// .env; env is inherited here.
const GOG_BIN = process.env.GOG_BIN || "/opt/homebrew/bin/gog";
const { instance } = require("./instance.cjs");
// The calendar account: JORI_CAL_ACCOUNT, else the owner's address (instance owner_email).
const calAccount = () => process.env.JORI_CAL_ACCOUNT || instance().owner_email;

// `tz` is accepted but no longer used: gog takes plain YYYY-MM-DD bounds and
// resolves the range itself, so the hand-rolled RFC3339 offset math the raw API
// needed is gone. Kept in the signature so existing callers don't have to change.
async function fetchCalendarJson(startDate, endDate, { tz = instance().tz } = {}) { // eslint-disable-line no-unused-vars
  const CAL_ACCOUNT = calAccount();
  if (!CAL_ACCOUNT) throw new Error("no calendar account (set owner_email in agent/local/instance.json or JORI_CAL_ACCOUNT)");
  // Per-event start/end keep their original API shape ({date} or {dateTime}),
  // so callers (location-stops --calendar) are unaffected by this switch.
  const res = spawnSync(
    GOG_BIN,
    ["calendar", "events", "--account", CAL_ACCOUNT,
     "--from", startDate, "--to", endDate,
     "--max", "250", "--json", "--results-only"],
    { encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env: process.env },
  );
  if (res.status !== 0) {
    throw new Error(`gog calendar events failed (${res.status}): ${(res.stderr || "").slice(0, 300)}`);
  }
  let items;
  try {
    const j = JSON.parse(res.stdout);
    items = Array.isArray(j) ? j : (j.events || j.items || []);
  } catch (e) {
    throw new Error(`gog calendar events returned unparseable JSON: ${e.message}`);
  }
  const events = (items || []).map((ev) => ({
    summary: ev.summary || "",
    location: ev.location || "",
    description: ev.description || "",
    start: ev.start || {},
    end: ev.end || {},
  }));
  return { events };
}

async function writeCalendarFile(startDate, endDate, opts = {}) {
  const out = opts.path || path.join("/tmp", `cal-${startDate}.json`);
  const json = await fetchCalendarJson(startDate, endDate, opts);
  fs.writeFileSync(out, JSON.stringify(json));
  return out;
}

module.exports = { fetchCalendarJson, writeCalendarFile };
