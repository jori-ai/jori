"use strict";
// routine-summary — the user's usual day, in a few sentences, for the models
// that name a stop.
//
// Why: on 2026-10-28 a 7:44pm stop at the Wednesday-evening farmers market was
// titled after a coffee shop 16 m away (a morning confirmation from an earlier
// day) and narrated as "a second coffee". The user's own notes already said
// coffee is a morning thing; the user's correction: "we hardly ever have a
// second coffee and almost never in the evening." No step that weighed the
// stop's candidates had read those notes. An evening café should look unlikely
// to whatever weighs it.
//
// What this is: a SHORT summary of time-of-day habits (when coffee, meals,
// walks and home time usually happen, and what rarely happens when), written
// by a model from notes the user already has, cached and refreshed only when a
// source changes or the cache is old. Readers hand it to their model as
// context, a prior to weigh candidates with. It is never a rule: no code here
// or in a reader turns it into "no café after 5pm" (Rule #0b — a model reads
// language, code owns structure). Code only gathers the sources, hashes them,
// bounds the size and keeps the cache.
//
// Sources, from agent/local/config/routine-summary.json (private; the kernel
// ships none, so a fresh install has no summary and every reader carries on as
// before):
//   pages             wiki page ids that describe the user's day
//   corrections_days  also read the user's own corrections to recent days
//                     (data/day-corrections/*.jsonl) from this many days back;
//                     0 = off. They are where "almost never in the evening"
//                     was said.
//   max_age_days      rebuild at least this often even when nothing changed
//   max_chars         the summary's size cap (it rides in every naming prompt)
//
// Cache: data/routine-summary.json {text, source_hash, built_at, model, sources}.
// Fail-open: a failed rebuild keeps the previous text; no text means readers
// leave the field out.
//
// CLI: bin/routine-summary [--refresh] [--json]. Tests: tests/routine-summary.test.mjs.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { installTools } = require("./root.cjs");
const { localConfig } = require("./instance.cjs");

const DEFAULTS = Object.freeze({ pages: [], corrections_days: 0, max_age_days: 7, max_chars: 700 });
// Bounds on what goes INTO the model, so a long page or a busy month of
// corrections cannot grow the prompt without limit.
const PAGE_CHARS = 6000;
const MAX_CORRECTIONS = 40;
const CORRECTION_CHARS = 300;
const DAY_MS = 86400000;

const CACHE_FILE = () => process.env.JORI_ROUTINE_SUMMARY_FILE || installTools("data", "routine-summary.json");
const CORRECTIONS_DIR = () => process.env.JORI_DAY_CORRECTIONS_DIR || installTools("data", "day-corrections");

function config(overrides = null) {
  return { ...DEFAULTS, ...localConfig("routine-summary", {}), ...(overrides || {}) };
}

// A wiki page's body by id, through the wiki store (DB-as-truth). Loaded lazily:
// a reader with no pages configured never opens the memory DB.
function wikiPageBody(id) {
  const ws = require("./wiki-store.js");
  const row = ws.getPage(id);
  if (!row || (row.status && row.status !== "active")) return null;
  return String(row.body_md || row.raw_md || "");
}

/** The user's corrections to the last `days` days, newest last. Read verbatim, never interpreted. */
function recentCorrections(days, { dir = CORRECTIONS_DIR(), now = Date.now() } = {}) {
  if (!days || days <= 0) return [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; }
  const cutoff = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  const out = [];
  for (const f of files) {
    const date = f.slice(0, -".jsonl".length);
    if (date < cutoff) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (c && typeof c.text === "string" && c.text.trim()) out.push({ date, text: c.text.trim().slice(0, CORRECTION_CHARS) });
      } catch { /* a torn line is skipped */ }
    }
  }
  return out.slice(-MAX_CORRECTIONS);
}

/** What the summary is built from: {pages: [{id, body}], corrections: [{date, text}]}. */
function gatherSources(cfg = config(), { readPage = wikiPageBody, correctionsDir, now } = {}) {
  const pages = [];
  for (const id of cfg.pages || []) {
    let body = null;
    try { body = readPage(id); } catch { body = null; }
    if (body && body.trim()) pages.push({ id, body: body.slice(0, PAGE_CHARS) });
  }
  const corrections = recentCorrections(cfg.corrections_days, { dir: correctionsDir || CORRECTIONS_DIR(), now: now ?? Date.now() });
  return { pages, corrections };
}

function sourceHash(sources, cfg) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([PROMPT_VERSION, cfg.max_chars, sources]))
    .digest("hex").slice(0, 16);
}

function readCache(file = CACHE_FILE()) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return c && typeof c.text === "string" ? c : null;
  } catch { return null; }
}

function writeCache(entry, file = CACHE_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Fresh = built from these exact sources, and not older than max_age_days. */
function isFresh(cache, hash, cfg, now = Date.now()) {
  if (!cache || cache.source_hash !== hash) return false;
  const built = Date.parse(cache.built_at || "");
  return Number.isFinite(built) && now - built < cfg.max_age_days * DAY_MS;
}

// Bump when the prompt changes, so every cache rebuilds once.
const PROMPT_VERSION = 1;

function buildPrompt(sources, cfg) {
  return `Below are notes about the user's day: pages the user's assistant keeps about the user's routine, and the user's own corrections to recent day summaries (verbatim).

Write a short summary of the user's TIME-OF-DAY habits, for a model that has to decide which kind of place a stop at a given hour most likely was (a café, a restaurant, a market, a park, home). Say when the user usually has coffee, meals and walks, when the user is usually home, and anything the notes say the user rarely or never does at a given time of day. Use clock hours.

Rules:
- Only what the notes say. Do not add habits, places or people the notes do not state.
- Habits, not rules: keep the notes' own hedges ("usually", "rarely", "on weekends").
- No names of businesses, no addresses, no health or money details.
- Plain sentences, at most ${cfg.max_chars} characters in all.
- If the notes say nothing about time-of-day habits, return an empty summary.

Answer with ONLY a JSON object: {"summary": string}

Notes:
${JSON.stringify(sources, null, 1)}`;
}

/** Trim to the cap at a sentence end where one exists (a size bound, not a reading). */
function clip(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = cut.lastIndexOf(". ");
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

async function defaultRun(prompt) {
  const { runToollessDetailed, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require("./models.cjs");
  const { out, error } = await runToollessDetailed({ model: MODELS.sonnet, prompt, timeoutMs: 90000 });
  if (error) throw new Error(`${error.kind}: ${error.message}`);
  const ans = parseModelJson(out);
  if (!ans || typeof ans.summary !== "string") throw new Error("no {summary} in the reply");
  return { summary: ans.summary, model: MODELS.sonnet };
}

/**
 * The cached summary text, or null. Never calls a model: for readers that must
 * stay deterministic (cron-time code), and for the CLI's plain read.
 */
function routineSummarySync({ file } = {}) {
  const c = readCache(file);
  return c && c.text ? c.text : null;
}

/**
 * The summary, rebuilt first when its sources changed or it is older than
 * max_age_days. Returns {text|null, status} where status is "fresh", "rebuilt",
 * "stale" (rebuild failed, previous text kept), "none" (no sources configured
 * or found), or "failed" (no text at all). Never throws.
 */
async function ensureRoutineSummary({ force = false, run = defaultRun, cfg: cfgOverride = null, file, readPage, correctionsDir, now = Date.now() } = {}) {
  const cfg = config(cfgOverride);
  const cacheFile = file || CACHE_FILE();
  const cache = readCache(cacheFile);
  let sources;
  try { sources = gatherSources(cfg, { readPage, correctionsDir, now }); } catch (e) {
    return { text: cache ? cache.text || null : null, status: cache ? "stale" : "failed", error: String(e.message || e) };
  }
  if (!sources.pages.length && !sources.corrections.length) return { text: null, status: "none" };
  const hash = sourceHash(sources, cfg);
  if (!force && isFresh(cache, hash, cfg, now)) return { text: cache.text || null, status: "fresh" };
  try {
    const ans = await run(buildPrompt(sources, cfg));
    const text = clip(ans.summary, cfg.max_chars);
    writeCache({
      text, source_hash: hash, built_at: new Date(now).toISOString(), model: ans.model || null,
      sources: { pages: sources.pages.map((p) => p.id), corrections: sources.corrections.length },
    }, cacheFile);
    return { text: text || null, status: "rebuilt" };
  } catch (e) {
    return { text: cache ? cache.text || null : null, status: cache ? "stale" : "failed", error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = {
  ensureRoutineSummary, routineSummarySync, gatherSources, recentCorrections, buildPrompt, clip, sourceHash, isFresh,
  readCache, DEFAULTS, PROMPT_VERSION,
};
