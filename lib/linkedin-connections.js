// linkedin-connections.js — the owner's LinkedIn connections as a local SQLite
// table with FTS5, built from a LinkedIn data export ("Get a copy of your data").
//
// Import reads Connections.csv (required) and, when present in the same folder,
// messages.csv, Recommendations_Received.csv, Recommendations_Given.csv,
// Endorsement_Received_Info.csv and Endorsement_Given_Info.csv. Those add
// relationship signals per connection (messages each way, last message date,
// recommendations, endorsements), so a lookup can tell "connected on LinkedIn"
// apart from "actually knows them". A connection alone proves little: big
// networks hold thousands of people the owner never met.
//
// Each import replaces the table (the export is a full snapshot).
// Zero external dependencies (node:sqlite). DB: data/linkedin.db, or
// $LINKEDIN_DB (tests).

"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = process.env.LINKEDIN_DB || path.join(__dirname, "..", "data", "linkedin.db");

let _db = null;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS li_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL,
      name_folded TEXT NOT NULL,
      slug TEXT DEFAULT '',
      url TEXT DEFAULT '',
      email TEXT DEFAULT '',
      company TEXT DEFAULT '',
      position TEXT DEFAULT '',
      connected_on TEXT DEFAULT '',
      msgs_sent INTEGER NOT NULL DEFAULT 0,
      msgs_received INTEGER NOT NULL DEFAULT 0,
      first_msg_at TEXT DEFAULT '',
      last_msg_at TEXT DEFAULT '',
      rec_received INTEGER NOT NULL DEFAULT 0,
      rec_given INTEGER NOT NULL DEFAULT 0,
      endorsed_me INTEGER NOT NULL DEFAULT 0,
      i_endorsed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS li_conn_slug ON li_connections(slug);
    CREATE INDEX IF NOT EXISTS li_conn_name ON li_connections(name_folded);
    CREATE VIRTUAL TABLE IF NOT EXISTS li_connections_fts USING fts5(
      full_name, name_folded, company, position, email,
      content=li_connections, content_rowid=id, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS li_meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return _db;
}

function close() { if (_db) { _db.close(); _db = null; } }

// ── CSV ──────────────────────────────────────────────────────────────────────
// RFC 4180: quoted fields may hold commas, doubled quotes and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows as objects, starting at the first row whose first cell is `firstHeader`
// (Connections.csv opens with a "Notes:" preamble before its header).
function readCsv(file, firstHeader) {
  if (!fs.existsSync(file)) return null;
  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  let h = 0;
  if (firstHeader) {
    h = rows.findIndex((r) => (r[0] || "").trim() === firstHeader);
    if (h === -1) throw new Error(`${path.basename(file)}: no header row starting "${firstHeader}"`);
  }
  const head = rows[h].map((s) => s.trim());
  return rows.slice(h + 1)
    .filter((r) => r.some((x) => x && x.trim()))
    .map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// ── Normalising ──────────────────────────────────────────────────────────────
function fold(s) {
  return String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function slugOf(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "18 Nov 2026" → "2026-11-18"
function isoDate(s) {
  const m = String(s || "").match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!m) return String(s || "");
  const mo = MONTHS[m[2].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}` : String(s);
}

// ── Import ───────────────────────────────────────────────────────────────────
function importExport(dir) {
  const connFile = ["Connections.csv", "connections.csv"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!connFile) throw new Error(`no Connections.csv in ${dir}`);
  const conns = readCsv(connFile, "First Name");

  const bySlug = new Map();
  const byName = new Map(); // folded full name → rows (several people can share one)
  const recs = conns.map((r) => {
    const full = `${r["First Name"]} ${r["Last Name"]}`.replace(/\s+/g, " ").trim();
    const rec = {
      first_name: r["First Name"], last_name: r["Last Name"], full_name: full, name_folded: fold(full),
      slug: slugOf(r.URL), url: r.URL, email: r["Email Address"], company: r.Company, position: r.Position,
      connected_on: isoDate(r["Connected On"]),
      msgs_sent: 0, msgs_received: 0, first_msg_at: "", last_msg_at: "",
      rec_received: 0, rec_given: 0, endorsed_me: 0, i_endorsed: 0,
    };
    if (rec.slug) bySlug.set(rec.slug, rec);
    if (!byName.has(rec.name_folded)) byName.set(rec.name_folded, []);
    byName.get(rec.name_folded).push(rec);
    return rec;
  });
  // A name match counts only when exactly one connection has that name.
  const uniqueByName = (first, last) => {
    const l = byName.get(fold(`${first} ${last}`));
    return l && l.length === 1 ? l[0] : null;
  };

  const stats = { connections: recs.length, messages: 0, recommendations: 0, endorsements: 0 };

  const msgs = readCsv(path.join(dir, "messages.csv"));
  if (msgs) {
    // The owner is the profile that appears on the most messages.
    const freq = new Map();
    for (const m of msgs) {
      for (const u of [m["SENDER PROFILE URL"], ...String(m["RECIPIENT PROFILE URLS"] || "").split(/[,\s]+/)]) {
        const s = slugOf(u); if (s) freq.set(s, (freq.get(s) || 0) + 1);
      }
    }
    const me = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const touch = (rec, date, sent) => {
      if (sent) rec.msgs_sent++; else rec.msgs_received++;
      const d = String(date || "").slice(0, 10);
      if (d && (!rec.first_msg_at || d < rec.first_msg_at)) rec.first_msg_at = d;
      if (d && d > rec.last_msg_at) rec.last_msg_at = d;
    };
    for (const m of msgs) {
      const from = slugOf(m["SENDER PROFILE URL"]);
      if (from && from !== me) {
        const rec = bySlug.get(from);
        if (rec) { touch(rec, m.DATE, false); stats.messages++; }
      } else if (from === me) {
        let hit = false;
        for (const u of String(m["RECIPIENT PROFILE URLS"] || "").split(/[,\s]+/)) {
          const rec = bySlug.get(slugOf(u));
          if (rec) { touch(rec, m.DATE, true); hit = true; }
        }
        if (hit) stats.messages++;
      }
    }
  }

  for (const [file, key] of [["Recommendations_Received.csv", "rec_received"], ["Recommendations_Given.csv", "rec_given"]]) {
    for (const r of readCsv(path.join(dir, file)) || []) {
      const rec = uniqueByName(r["First Name"], r["Last Name"]);
      if (rec) { rec[key]++; stats.recommendations++; }
    }
  }
  for (const r of readCsv(path.join(dir, "Endorsement_Received_Info.csv")) || []) {
    const rec = bySlug.get(slugOf(r["Endorser Public Url"])) || uniqueByName(r["Endorser First Name"], r["Endorser Last Name"]);
    if (rec) { rec.endorsed_me++; stats.endorsements++; }
  }
  for (const r of readCsv(path.join(dir, "Endorsement_Given_Info.csv")) || []) {
    const rec = bySlug.get(slugOf(r["Endorsee Public Url"])) || uniqueByName(r["Endorsee First Name"], r["Endorsee Last Name"]);
    if (rec) { rec.i_endorsed++; stats.endorsements++; }
  }

  const d = db();
  const cols = Object.keys(recs[0] || { full_name: "" });
  d.exec("BEGIN");
  try {
    d.exec("DELETE FROM li_connections");
    d.exec("INSERT INTO li_connections_fts(li_connections_fts) VALUES('delete-all')");
    const ins = d.prepare(`INSERT INTO li_connections (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const r of recs) ins.run(...cols.map((c) => r[c] ?? ""));
    d.exec("INSERT INTO li_connections_fts(li_connections_fts) VALUES('rebuild')");
    const meta = d.prepare("INSERT OR REPLACE INTO li_meta (k, v) VALUES (?, ?)");
    meta.run("imported_at", new Date().toISOString());
    meta.run("source", dir);
    meta.run("stats", JSON.stringify(stats));
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  return stats;
}

// ── Lookup ───────────────────────────────────────────────────────────────────
// How well the owner knows them, from the signals (not from the connection).
function tie(r) {
  const two = r.msgs_sent > 0 && r.msgs_received > 0;
  if (r.rec_received || r.rec_given || (two && r.msgs_sent + r.msgs_received >= 10)) return "strong";
  if (two || r.endorsed_me >= 3 || r.i_endorsed >= 3) return "some";
  if (r.msgs_sent || r.msgs_received || r.endorsed_me || r.i_endorsed) return "weak";
  return "connection only";
}

function score(r) {
  return r.msgs_sent * 3 + r.msgs_received + (r.rec_received + r.rec_given) * 20 + r.endorsed_me + r.i_endorsed * 2;
}

function ftsQuery(q) {
  const toks = fold(q).split(" ").filter(Boolean).slice(0, 8);
  return toks.length ? toks.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ") : null;
}

// find("dana cohen"), find("google", { field: "company" }), find("", { company: "wix" })
function find(q, { company, limit = 20 } = {}) {
  const d = db();
  const where = [], params = [];
  const fq = ftsQuery(q);
  let sql;
  if (fq) {
    sql = "SELECT c.*, bm25(li_connections_fts, 6, 6, 2, 1, 3) AS rank FROM li_connections_fts JOIN li_connections c ON c.id = li_connections_fts.rowid WHERE li_connections_fts MATCH ?";
    params.push(fq);
  } else {
    sql = "SELECT c.*, 0 AS rank FROM li_connections c WHERE 1=1";
  }
  if (company) { where.push("c.company LIKE ?"); params.push(`%${company}%`); }
  if (where.length) sql += " AND " + where.join(" AND ");
  sql += " LIMIT 500";
  const rows = d.prepare(sql).all(...params);
  // An exact full-name match first, then FTS rank blended with how well they're known.
  const nq = fold(q);
  rows.sort((a, b) =>
    (b.name_folded === nq) - (a.name_folded === nq)
    || (a.rank - Math.log1p(score(a))) - (b.rank - Math.log1p(score(b))));
  return rows.slice(0, limit).map((r) => ({ ...r, tie: tie(r) }));
}

function get(slugOrUrl) {
  const s = slugOf(slugOrUrl) || String(slugOrUrl || "").toLowerCase();
  const r = db().prepare("SELECT * FROM li_connections WHERE slug = ?").get(s);
  return r ? { ...r, tie: tie(r) } : null;
}

function stats() {
  const d = db();
  const meta = Object.fromEntries(d.prepare("SELECT k, v FROM li_meta").all().map((r) => [r.k, r.v]));
  return {
    connections: d.prepare("SELECT COUNT(*) n FROM li_connections").get().n,
    imported_at: meta.imported_at || null,
    source: meta.source || null,
    matched: meta.stats ? JSON.parse(meta.stats) : null,
    top_companies: d.prepare("SELECT company, COUNT(*) n FROM li_connections WHERE company != '' GROUP BY LOWER(company) ORDER BY n DESC LIMIT 15").all(),
  };
}

function format(r) {
  const head = `${r.full_name}${r.position ? ` — ${r.position}` : ""}${r.company ? ` @ ${r.company}` : ""}`;
  const bits = [`connected ${r.connected_on || "?"}`, `tie: ${r.tie}`];
  if (r.msgs_sent || r.msgs_received) bits.push(`messages ${r.msgs_sent} sent / ${r.msgs_received} received, last ${r.last_msg_at}`);
  if (r.rec_received) bits.push(`recommended you ${r.rec_received}×`);
  if (r.rec_given) bits.push(`you recommended them ${r.rec_given}×`);
  if (r.endorsed_me) bits.push(`endorsed you ${r.endorsed_me}×`);
  if (r.i_endorsed) bits.push(`you endorsed them ${r.i_endorsed}×`);
  const lines = [head, `  ${bits.join(" · ")}`];
  if (r.url) lines.push(`  ${r.url}`);
  if (r.email) lines.push(`  ${r.email}`);
  return lines.join("\n");
}

module.exports = { DB_PATH, db, close, parseCsv, readCsv, fold, slugOf, isoDate, importExport, find, get, stats, tie, format };
