#!/usr/bin/env node
// tier3-sentinel.mjs — the code half of a daily Tier-3 portfolio sentinel.
//
// The sentinel's model turn (its playbook) reads the news and writes its
// candidates to the sentinel state file (a JSON file the caller passes).
// Whether that starts an off-cycle weekly-monitor run is decided HERE, in code,
// from the structured fields the model wrote — never by reading its prose.
//
// Fire rule: a candidate with `hard_event: true` whose `id` has not already
// started an off-cycle run (`fired_ids`). One off-cycle run per event, ever:
// the weekly monitor owns everything after that, including the Phase 2A
// second-half check five trading days later.
//
// Dated headlines (fetch-news, 2026-11-10). The model turn used to find its
// news with a handful of web searches, and could not tell "searched and
// nothing happened" from "the results were old or undated": for six runs in a
// row it logged no new hard event while a qualifying event was in the news,
// because every result it got was older coverage. So before the turn, code
// fetches headlines from a news search feed for each family of rows the caller
// defines (the families file — no company is named in this file), keeps only
// items whose publication date falls inside the window, and writes them to a
// file the turn reads first. A family that must be covered and came back with
// no dated item, or whose feed failed, is listed as `degraded`: that night's
// check could not see the family's news, which is not the same as nothing
// having happened. Fail-soft: every error is recorded in the file, the file is
// always written, and the command exits 0 so the trigger carries on.
//
// Usage:
//   tier3-sentinel.mjs decide <state.json>         → prints {"fire":bool,"ids":[...],"summary":"..."}
//   tier3-sentinel.mjs mark-fired <state.json> <id,...>
//   tier3-sentinel.mjs fetch-news <families.json|-> <out.json>
//       families: {"window_hours":72,"families":[{"id":"<id>","queries":["<query>",...],"must_cover":true},...]}
//       writes {generated_at, window_hours, families:{<id>:{items, items_in_window, newest_item_date, errors, error?}}, degraded:[...]}
//       (items are {title, source, published}: no URL — the feed's redirect links are most of the bytes
//       and the model reads this file whole) and prints a one-line summary; always exits 0 once written
//   tier3-sentinel.mjs coverage <news.json>
//       → prints {"degraded":bool,"families":[...],"failed":[...],"empty":[...],"items_in_window":n[,"reason"]}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function pendingFire(state) {
  if (!state || !Array.isArray(state.candidates)) return [];
  const fired = new Set(Array.isArray(state.fired_ids) ? state.fired_ids : []);
  return state.candidates.filter(
    (c) => c && c.hard_event === true && typeof c.id === 'string' && c.id && !fired.has(c.id),
  );
}

export function markFired(state, ids, now = new Date()) {
  const fired = new Set(Array.isArray(state.fired_ids) ? state.fired_ids : []);
  for (const id of ids) fired.add(id);
  return { ...state, fired_ids: [...fired], last_fired_at: now.toISOString() };
}

// ── Dated headlines ─────────────────────────────────────────────────────────

export const NEWS_LIMITS = {
  windowHours: 72,
  maxQueriesPerFamily: 4,
  maxItemsPerQuery: 15, // first N in-window items of each query, in the feed's own (relevance) order
  requestTimeoutMs: 10_000,
  deadlineMs: 45_000, // no new request starts after this; with the per-request timeout, under ~60 s
  concurrency: 4,
  futureSkewMs: 3_600_000, // an item dated more than an hour ahead is a bad date, not news
};

// The RSS parsing follows bin/news-headlines (copied, not imported: a bin
// script is not a module).
const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };

function unescapeEntities(s) {
  // lang-regex-ok: HTML entity references in feed markup, not language
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (whole, hex, dec, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0x2013 || cp === 0x2014) return '-';
    if (cp === 0x2018 || cp === 0x2019) return "'";
    if (cp === 0x201c || cp === 0x201d) return '"';
    try { return String.fromCodePoint(cp); } catch { return whole; }
  });
}

// Unescape, strip the tags that unescaping exposed, unescape again (feeds
// escape in two layers), then collapse whitespace.
function decode(s) {
  const unwrapped = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); // lang-regex-ok: XML CDATA wrapper, feed structure
  return unescapeEntities(unescapeEntities(unwrapped).replace(/<\/?[a-z][^>]*>/gi, ' ')) // lang-regex-ok: strip HTML tags from feed markup
    .replace(/\s+/g, ' ').trim(); // lang-regex-ok: collapse whitespace in feed text
}

function tag(block, name) {
  // lang-regex-ok: reads an XML element out of RSS markup, not language
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
}

export function isRss(xml) {
  const head = String(xml || '').slice(0, 2000).toLowerCase();
  return head.includes('<rss') || head.includes('<channel') || head.includes('<feed');
}

// RSS <item>s → [{title, source, url, published}], in feed order. `published`
// is an ISO timestamp, or null when the item carries no parseable date.
export function parseRssItems(xml, fallbackSource = '') {
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || []; // lang-regex-ok: RSS <item> elements
  return blocks.map((b) => {
    const ms = Date.parse(tag(b, 'pubDate') || tag(b, 'dc:date'));
    const source = tag(b, 'source') || fallbackSource;
    let title = tag(b, 'title');
    // A news-search feed appends " - <outlet>" to each title; the outlet is
    // already in `source`.
    const suffix = source ? ` - ${source}` : '';
    if (suffix && title.endsWith(suffix) && title.length > suffix.length) title = title.slice(0, -suffix.length).trim();
    return {
      title,
      source,
      url: tag(b, 'link'),
      published: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    };
  }).filter((it) => it.title && it.url);
}

export function newsSearchUrl(query, windowHours = NEWS_LIMITS.windowHours) {
  const days = Math.max(1, Math.ceil(windowHours / 24));
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
}

// Only items with a real publication date inside [sinceMs, nowMs + skew].
// An undated item is not evidence of anything.
export function inWindow(items, sinceMs, nowMs = Date.now(), skewMs = NEWS_LIMITS.futureSkewMs) {
  return items.filter((it) => {
    const t = it && it.published ? Date.parse(it.published) : NaN;
    return Number.isFinite(t) && t >= sinceMs && t <= nowMs + skewMs;
  });
}

export function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = String(it.title || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const newestFirst = (a, b) => Date.parse(b.published || 0) - Date.parse(a.published || 0);

// The families file → {windowHours, families:[{id, queries, must_cover}]}.
// must_cover defaults to true: a family nobody marked optional is one whose
// silence should be noticed.
export function normaliseFamilies(spec, limits = NEWS_LIMITS) {
  const hours = Number(spec && spec.window_hours);
  const windowHours = Number.isFinite(hours) && hours > 0 ? hours : limits.windowHours;
  const list = spec && Array.isArray(spec.families) ? spec.families : [];
  const seen = new Set();
  const families = [];
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    const queries = (Array.isArray(f.queries) ? f.queries : [])
      .filter((q) => typeof q === 'string' && q.trim())
      .map((q) => q.trim())
      .slice(0, limits.maxQueriesPerFamily);
    families.push({ id: f.id, queries, must_cover: f.must_cover !== false });
  }
  return { windowHours, families };
}

// Fetch every family's queries (bounded: per-request timeout, a time budget,
// a few at a time) and return the news object written by `fetch-news`.
// `fetchImpl` and `now` are injectable so tests never touch the network.
export async function fetchNews(spec, opts = {}) {
  const limits = { ...NEWS_LIMITS, ...(opts.limits || {}) };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const nowMs = (opts.now ? new Date(opts.now) : new Date()).getTime();
  const { windowHours, families } = normaliseFamilies(spec, limits);
  const sinceMs = nowMs - windowHours * 3_600_000;
  const started = Date.now();

  const acc = new Map(families.map((f) => [f.id, { lists: [], seen: [], errors: [], answered: 0 }]));
  // Round-robin across families, so a spent time budget still leaves every
  // family its first query.
  const jobs = [];
  const depth = Math.max(0, ...families.map((f) => f.queries.length));
  for (let i = 0; i < depth; i++) for (const f of families) if (f.queries[i]) jobs.push({ family: f.id, query: f.queries[i] });

  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const a = acc.get(job.family);
      if (Date.now() - started > limits.deadlineMs) {
        a.errors.push({ query: job.query, error: 'skipped: time budget spent' });
        continue;
      }
      try {
        const res = await fetchImpl(newsSearchUrl(job.query, windowHours), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) jori-tier3-sentinel' },
          signal: AbortSignal.timeout(limits.requestTimeoutMs),
        });
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
        const xml = await res.text();
        if (!isRss(xml)) throw new Error('response is not an RSS feed');
        const parsed = parseRssItems(xml);
        a.seen.push(...parsed);
        a.lists.push(inWindow(parsed, sinceMs, nowMs, limits.futureSkewMs));
        a.answered += 1;
      } catch (e) {
        a.errors.push({ query: job.query, error: String((e && e.message) || e).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, jobs.length) }, worker));

  const out = {};
  for (const f of families) {
    const a = acc.get(f.id);
    const allInWindow = dedupeByTitle(a.lists.flat());
    // No URL in the file: the model reads it whole, and a feed's redirect
    // links are about three quarters of its size. Title + outlet + date is
    // what the model searches on to find the primary source.
    const items = dedupeByTitle(a.lists.flatMap((l) => l.slice(0, limits.maxItemsPerQuery)))
      .sort(newestFirst)
      .map(({ title, source, published }) => ({ title, source, published }));
    const newest = a.seen.filter((it) => it.published).sort(newestFirst)[0];
    const rec = {
      must_cover: f.must_cover,
      queries: f.queries,
      items,
      items_in_window: allInWindow.length,
      // The newest publication date the feed returned for this family, inside
      // the window or not: an old date here means the feed was stale, null that
      // it returned nothing dated at all.
      newest_item_date: newest ? newest.published : null,
      errors: a.errors,
    };
    if (!f.queries.length) rec.error = 'no queries defined';
    else if (a.answered === 0) rec.error = `every query failed: ${a.errors[0] ? a.errors[0].error : 'unknown'}`;
    out[f.id] = rec;
  }
  const news = { generated_at: new Date(nowMs).toISOString(), window_hours: windowHours, families: out };
  if (!families.length) news.error = 'no families defined';
  news.degraded = coverageVerdict(news).families;
  return news;
}

// Did the news reach us? An empty feed or a failed fetch for a must-cover
// family is DEGRADED, never "nothing found". No news object at all is degraded.
// `families` lists every degraded family; `failed` those whose feed failed
// (`error` set), `empty` those whose feed answered with no dated item.
export function coverageVerdict(news) {
  if (!news || typeof news !== 'object' || !news.families || typeof news.families !== 'object') {
    return { degraded: true, families: [], failed: [], empty: [], items_in_window: 0, reason: 'no news file' };
  }
  const ids = Object.keys(news.families);
  const items = ids.reduce((n, id) => n + (Number(news.families[id] && news.families[id].items_in_window) || 0), 0);
  if (!ids.length) return { degraded: true, families: [], failed: [], empty: [], items_in_window: 0, reason: news.error || 'no families' };
  const failed = [];
  const empty = [];
  for (const id of ids) {
    const f = news.families[id] || {};
    if (f.must_cover === false) continue;
    if (f.error) failed.push(id);
    else if (!(Number(f.items_in_window) > 0)) empty.push(id);
  }
  const bad = ids.filter((id) => failed.includes(id) || empty.includes(id));
  return { degraded: bad.length > 0, families: bad, failed, empty, items_in_window: items };
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The `fetch-news` command as a function: read the families, fetch, write the
// news file atomically. Never throws for a fetch or families problem; those
// land in the file as a degraded result. Returns the news object.
export async function runFetchNews(familiesPath, outPath, opts = {}) {
  let news;
  try {
    const raw = familiesPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(familiesPath, 'utf8');
    news = await fetchNews(JSON.parse(raw), opts);
  } catch (e) {
    news = {
      generated_at: new Date().toISOString(),
      window_hours: NEWS_LIMITS.windowHours,
      families: {},
      error: `families unreadable or fetch crashed: ${String((e && e.message) || e).slice(0, 200)}`,
    };
    news.degraded = coverageVerdict(news).families;
  }
  writeJsonAtomic(outPath, news);
  return news;
}

async function main(argv) {
  const [cmd, file, idList] = argv;
  if (cmd === 'decide' && file) {
    const hits = pendingFire(readState(file));
    const summary = hits.map((c) => `${c.row || 'tier3'}: ${c.headline || c.id}${c.event_date ? ` (${c.event_date})` : ''}`).join('; ');
    process.stdout.write(JSON.stringify({ fire: hits.length > 0, ids: hits.map((c) => c.id), summary }) + '\n');
    return 0;
  }
  if (cmd === 'mark-fired' && file && idList) {
    const state = readState(file);
    if (!state) return 1;
    const next = markFired(state, idList.split(',').filter(Boolean));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return 0;
  }
  if (cmd === 'fetch-news' && file && idList) {
    let news;
    try {
      news = await runFetchNews(file, idList);
    } catch (e) {
      process.stderr.write(`tier3-sentinel fetch-news: could not write ${idList}: ${e.message}\n`);
      return 1;
    }
    const v = coverageVerdict(news);
    const counts = Object.entries(news.families).map(([id, f]) => `${id}=${f.items_in_window}`).join(' ');
    process.stdout.write(`${v.degraded ? `DEGRADED (${v.families.join(', ') || v.reason})` : 'ok'}; dated items in window: ${counts || 'none'}\n`);
    return 0;
  }
  if (cmd === 'coverage' && file) {
    process.stdout.write(JSON.stringify(coverageVerdict(readState(file))) + '\n');
    return 0;
  }
  process.stderr.write('usage: tier3-sentinel.mjs decide <state.json> | mark-fired <state.json> <id,...> | fetch-news <families.json|-> <out.json> | coverage <news.json>\n');
  return 2;
}

// Run as a command only when this file is the entry point. Compared by real
// path: reached through a symlinked directory (macOS /tmp is one), a plain
// string compare is false and `decide` would print nothing, which reads as
// "no fire".
function isEntryPoint() {
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { process.stderr.write(`tier3-sentinel: ${e && e.message}\n`); process.exit(1); },
  );
}
