"use strict";
// comedy-config.cjs — this installation's comedy-club-watch settings.
//
// comedy-club-watch catches big-name comedians (or any headliners) booking
// small rooms. WHICH comedians, WHICH rooms, the metro they are in and who the
// user goes to shows with are this installation's, from
// agent/local/config/comedy-club-watch.json (lib/instance.cjs localConfig). A
// `data_file` there (repo-relative JSON with any of the same keys) fills what
// the config leaves out: the venue table, the companions and the place label
// are proper nouns, and a private data file keeps them out of the config the
// kernel guard derives tokens from.
//
//   roster_file        the roster (bin/comedian), {comedians: [{name, aka[], taste, language}]}
//   venues_file        the rooms, {venues: [{name, cap, url, method|kind, aggregator,
//                      days{fast,deep}, performer_days{fast,deep}}]} — none: the watch is OFF
//   sightings_file     hand-kept sightings the calendar cannot name (lib/comedy-seen.mjs)
//   seen_file          the watch's state
//   pause_file         present → the scheduled run does nothing
//   metro              the metro the rooms are in (`travel in-city <metro> <date>`)
//   place_label        how messages name it ("small <place> rooms"); "" → "small rooms"
//   quiet_before_hour  scheduled runs before this local hour do nothing (0 = never quiet)
//   companions         [{name, email}] — someone on a calendar sighting's invite is
//                      named in the reminder ("you and <name> saw …")
//   max_cap            a room above this many seats is not a small room (default 400)
//   horizon_days       how far ahead a show may be (default 240)
//   roster_slice       roster names handed to the daily roster-down search (default 12)
//   email_threshold    this many comedians at once go out as one email (default 3)
//   link_hosts         ticketing hosts whose links on a room's calendar page are event
//                      links (besides /event(s)/, /e/, /show(s)/ and "ticket" paths)
//
// A fresh install has no venues: the scheduled run logs that it is not
// configured and exits 0 — off, not broken.

const fs = require("fs");
const path = require("path");
const { localConfig } = require("./instance.cjs");
const { REPO_ROOT } = require("./root.cjs");

const DEFAULTS = {
  data_file: null,
  roster_file: "data/comedy-headliners.json",
  venues_file: null,
  sightings_file: "data/comedy-sightings.json",
  seen_file: "data/comedy-club-watch-seen.json",
  pause_file: "data/comedy-club-watch-pause.json",
  metro: "home",
  place_label: "",
  quiet_before_hour: 0,
  companions: [],
  max_cap: 400,
  horizon_days: 240,
  roster_slice: 12,
  email_threshold: 3,
  link_hosts: [],
};

/** The repo root the data paths resolve against (JORI_ROOT for tests). */
const root = () => process.env.JORI_ROOT || REPO_ROOT;

const resolve = (f) => (f ? (path.isAbsolute(f) ? f : path.join(root(), f)) : null);

function comedyConfig() {
  const cfg = localConfig("comedy-club-watch", { data_file: null });
  let file = {};
  if (cfg.data_file) {
    try { file = JSON.parse(fs.readFileSync(resolve(cfg.data_file), "utf8")) || {}; }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`comedy-club-watch data_file ${cfg.data_file}: ${e.message}`); }
  }
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) out[k] = cfg[k] ?? file[k] ?? d;
  for (const k of ["roster_file", "venues_file", "sightings_file", "seen_file", "pause_file"]) out[k] = resolve(out[k]);
  return out;
}

module.exports = { comedyConfig, root, DEFAULTS };
