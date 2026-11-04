// cyber-watch.mjs — fetchers, feed parsing and state for bin/cyber-watch-run.
//
// Everything here is code-owns-structure: RSS/Atom XML, the CISA KEV JSON, the
// HIBP breach list, domain matching. Nothing here decides what a headline
// MEANS — whether a story is a top event or touches one of the user's providers is
// the one model call in cyber-watch-run (Rule #0b).
//
// Playbook: agent/ops-agent/jobs/cyber-watch.md

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig, localDir } = require("./instance.cjs");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, "..");
export const CONFIG_FILE = path.join(REPO, "agent/config/cyber-watch.json");
export const STATE_FILE = path.join(REPO, "data/cyber-watch-state.json");
const UA = (() => {
  const contact = instance().agent_email;
  return `Jori-cyber-watch/1.0 (personal security monitor${contact ? `; contact ${contact}` : ""})`;
})();
const DAY = 86400000;

// The kernel's feeds and knobs (agent/config/cyber-watch.json), overlaid by this
// installation's agent/local/config/cyber-watch.json (`enabled`, `profile`: who
// the user is, one or two sentences for the model, and optionally
// `uninventoried`: devices the inventory cannot see) and by its provider
// inventory, agent/local/cyber-watch/providers.json ({ stack, vendors }; data,
// kept out of config/). Without a local config the job is off: `enabled` stays
// false and the run exits quietly.
export function providersFile() {
  return path.join(localDir(), "cyber-watch", "providers.json");
}

export function loadConfig(file = CONFIG_FILE, { local = localConfig, providers = providersFile() } = {}) {
  const base = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = local("cyber-watch", { enabled: false, profile: "", uninventoried: "", ...base });
  let inv = {};
  try { inv = JSON.parse(fs.readFileSync(providers, "utf8")) || {}; } catch {}
  if (Array.isArray(inv.stack)) cfg.stack = [...(cfg.stack || []), ...inv.stack];
  if (Array.isArray(inv.vendors)) cfg.vendors = [...(cfg.vendors || []), ...inv.vendors];
  cfg.stack ||= [];
  cfg.vendors ||= [];
  return cfg;
}

export function emptyState() {
  return {
    seen: {},             // item id -> first-seen ms (feeds + KEV + HIBP), pruned at 30d
    log: [],              // {id, src, title, link, published, summary, seen_at} kept 9d for the weekly lane
    alerted: [],          // {event_key, headline, at, sent} — every event already checked (sent or not)
    checked: [],          // verdicts {event_key, headline, applies, urgency, analysis, action, link, sent, at}, kept 10d
    osv_known: null,      // "<eco>:<name>:<vuln id>" already seen; null until the first dependency scan
    learned_vendors: [],  // vendors a model added from new Plaid merchants
    rejected_merchants: [], // merchant names a model ruled out, so they are not re-asked
    kev_bootstrapped: false,
    last_alert_run: null,
    last_weekly_run: null,
  };
}

export function loadState(file = STATE_FILE) {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return emptyState(); }
}

export function saveState(state, file = STATE_FILE) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function pruneState(state, now = Date.now()) {
  for (const [k, t] of Object.entries(state.seen)) if (now - t > 30 * DAY) delete state.seen[k];
  state.log = state.log.filter((r) => now - r.seen_at <= 9 * DAY);
  state.alerted = state.alerted.filter((a) => now - Date.parse(a.at) <= 45 * DAY);
  state.checked = (state.checked || []).filter((c) => now - Date.parse(c.at) <= 10 * DAY);
  return state;
}

// ---- XML (RSS 2.0 / Atom) -------------------------------------------------
// Feed XML is machine-generated markup; these regexes read its tags, not meaning.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  // lang-regex-ok: XML/HTML entity decoding of feed markup
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function stripTags(s) {
  // lang-regex-ok: removing CDATA wrappers and HTML tags from feed markup
  // Descriptions are often escaped HTML, so decode once to expose the tags, strip them, decode again.
  return decodeEntities(decodeEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tag(xml, name) {
  // lang-regex-ok: extracting one XML element's inner markup by tag name
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function atomLink(xml) {
  // lang-regex-ok: reading the href attribute of an Atom <link> element
  const alt = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? decodeEntities(alt[1]) : "";
}

/** Parse RSS or Atom into [{title, link, published, summary, guid}]. */
export function parseFeed(xml) {
  const out = [];
  // lang-regex-ok: splitting feed XML into <item>/<entry> elements
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = stripTags(tag(b, "title"));
    const link = stripTags(tag(b, "link")) || atomLink(b);
    const published = stripTags(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const summary = stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 400);
    const guid = stripTags(tag(b, "guid") || tag(b, "id")) || link || title;
    if (title) out.push({ title, link, published, summary, guid });
  }
  return out;
}

export function itemId(src, guid) {
  return `${src}:${crypto.createHash("sha1").update(String(guid)).digest("hex").slice(0, 16)}`;
}

async function getText(url, { timeoutMs = 20000, accept = "*/*" } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Fetch every configured feed; a failing feed is logged and skipped. */
export async function fetchFeeds(cfg, log = () => {}) {
  const items = [];
  for (const f of cfg.feeds) {
    try {
      const parsed = parseFeed(await getText(f.url));
      for (const p of parsed) items.push({ id: itemId(f.id, p.guid), src: f.id, ...p });
      log(`feed ${f.id}: ${parsed.length}`);
    } catch (e) { log(`feed ${f.id} FAILED: ${e.message}`); }
  }
  return items;
}

/** CISA Known Exploited Vulnerabilities — returns every entry as a feed-shaped item. */
export async function fetchKev(cfg) {
  const j = JSON.parse(await getText(cfg.kev_url, { timeoutMs: 30000, accept: "application/json" }));
  return (j.vulnerabilities || []).map((v) => ({
    id: `kev:${v.cveID}`,
    src: "cisa-kev",
    title: `${v.cveID} — ${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`,
    link: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
    published: v.dateAdded,
    summary: `${v.shortDescription || ""} Required action: ${v.requiredAction || ""}${v.knownRansomwareCampaignUse === "Known" ? " Used in ransomware campaigns." : ""}`.slice(0, 400),
    vendor_project: v.vendorProject,
  }));
}

/** HIBP public breach list (no key needed). Returns feed-shaped items. */
export async function fetchHibp(cfg) {
  const list = JSON.parse(await getText(cfg.hibp_breaches_url, { timeoutMs: 30000, accept: "application/json" }));
  return list.map((b) => ({
    id: `hibp:${b.Name}`,
    src: "hibp",
    title: `HIBP breach: ${b.Title} (${b.Domain || "no domain"}) — ${Number(b.PwnCount || 0).toLocaleString("en-US")} accounts`,
    link: `https://haveibeenpwned.com/Breach/${encodeURIComponent(b.Name)}`,
    published: b.AddedDate,
    summary: `Breach date ${b.BreachDate}. Data: ${(b.DataClasses || []).join(", ")}.`.slice(0, 400),
    domain: String(b.Domain || "").toLowerCase(),
    added_ms: Date.parse(b.AddedDate),
  }));
}

/** Exact or parent-domain match of a breach domain against the vendor inventory (structure, not language). */
export function vendorForDomain(domain, vendors) {
  const d = String(domain || "").toLowerCase();
  if (!d) return null;
  for (const v of vendors) {
    for (const vd of v.domains || []) {
      const x = vd.toLowerCase();
      if (d === x || d.endsWith(`.${x}`) || x.endsWith(`.${d}`)) return v;
    }
  }
  return null;
}

/** Last-7-days Google News for one vendor name (the query carries a company name only). */
export async function fetchVendorNews(cfg, vendor) {
  const url = cfg.gnews_vendor_template.replace("{NAME}", encodeURIComponent(vendor.name));
  return parseFeed(await getText(url)).slice(0, cfg.weekly.news_per_vendor)
    .map((p) => ({ id: itemId(`gnv-${vendor.name}`, p.guid), src: "google-news", vendor: vendor.name, ...p }));
}

export function allVendors(cfg, state) {
  const names = new Set(cfg.vendors.map((v) => v.name.toLowerCase()));
  return [...cfg.vendors, ...(state.learned_vendors || []).filter((v) => !names.has(v.name.toLowerCase()))];
}

/** Compact vendor list for a prompt. */
export function vendorBrief(vendors) {
  return vendors.map((v) => ({ name: v.name, aliases: v.aliases || [], tier: v.tier, role: v.role }));
}

/** Keep only items not yet seen; marks nothing (caller commits after a successful run). */
export function unseen(items, state) {
  const seenNow = new Set();
  return items.filter((i) => {
    if (state.seen[i.id] || seenNow.has(i.id)) return false;
    seenNow.add(i.id);
    return true;
  });
}

export function markSeen(items, state, now = Date.now()) {
  for (const i of items) {
    if (state.seen[i.id]) continue;
    state.seen[i.id] = now;
    if (i.src !== "cisa-kev-bootstrap") {
      state.log.push({ id: i.id, src: i.src, title: i.title, link: i.link, published: i.published, summary: i.summary, seen_at: now });
    }
  }
}

/** An article's readable text (scripts/styles/tags stripped), capped — the advisory detail a verdict needs. */
export async function articleText(url, cap = 7000) {
  if (!url || url.includes("news.google.com/")) return null; // Google News links are JS redirects with no article body
  try {
    const html = await getText(url, { timeoutMs: 20000, accept: "text/html" });
    // lang-regex-ok: removing script/style/nav elements and tags from fetched HTML
    const body = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
    return stripTags(body).slice(0, cap);
  } catch { return null; }
}

/** CVE ids in machine text (advisory ids are structure). */
export function cveIds(s) {
  return [...new Set(String(s || "").match(/CVE-\d{4}-\d{4,7}/g) || [])]; // lang-regex-ok: CVE identifier syntax
}

/** NVD record for one CVE: description + affected version ranges, compacted. */
export async function nvdCve(id) {
  try {
    const j = JSON.parse(await getText(`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`, { timeoutMs: 20000, accept: "application/json" }));
    const c = j.vulnerabilities?.[0]?.cve;
    if (!c) return null;
    const ranges = [];
    for (const cfg of c.configurations || []) for (const n of cfg.nodes || []) for (const m of n.cpeMatch || []) {
      if (!m.vulnerable) continue;
      ranges.push([m.criteria.split(":").slice(3, 6).join(":"), m.versionStartIncluding && `>=${m.versionStartIncluding}`, m.versionStartExcluding && `>${m.versionStartExcluding}`,
        m.versionEndExcluding && `<${m.versionEndExcluding}`, m.versionEndIncluding && `<=${m.versionEndIncluding}`].filter(Boolean).join(" "));
    }
    const metric = c.metrics?.cvssMetricV31?.[0] || c.metrics?.cvssMetricV40?.[0];
    return { id, description: (c.descriptions || []).find((d) => d.lang === "en")?.value?.slice(0, 600), cvss: metric?.cvssData?.baseScore, severity: metric?.cvssData?.baseSeverity, affected: ranges.slice(0, 15) };
  } catch { return null; }
}

/** Local hour in a zone. */
export function localHour(tz, d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d));
}

export function inQuiet(hour, { start, end }) {
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
