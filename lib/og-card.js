"use strict";
// og-card.js — fetch OG/Twitter/fallback meta for a URL and render an
// email-safe HTML "link card" (image + title + description + domain).
//
// Gmail and other email clients do NOT auto-render OG previews from plain
// URLs the way chat apps do. This module builds the card HTML itself so
// emails can carry rich link previews. The output uses a <table> layout,
// inline CSS only, and no external fonts — broadly compatible across
// email clients (Gmail web/mobile, Apple Mail, Outlook, etc.).
//
// See system/architecture.md and agent/ops-agent/CLAUDE.md
// ("Use og-card for every URL in outbound email").

// node-html-parser lives in bin/node_modules (bin/package.json).
// Lib files live in lib and have no node_modules of their own, so we
// resolve from the bin package instead of walking up the usual way.
const { createRequire } = require("node:module");
const path = require("node:path");
const binRequire = createRequire(path.join(__dirname, "..", "bin", "package.json"));
const { parse: parseHtml } = binRequire("node-html-parser");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function htmlEscape(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attrEscape(s) {
  return htmlEscape(s);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Google Maps place-detail pages (maps.google.com/?cid=..., google.com/maps?cid=...)
// don't render server-side per-place OG tags — every cid link returns the same
// generic {title:"Google Maps", image:<static-map centered on the FETCHING
// SERVER'S rough geolocation>} regardless of which place the cid points to.
// Confirmed: two different venues in another country both returned an
// identical static-map image centered on the host's own city — i.e. the
// fetching server's IP, not either venue. Carding this
// generic response would show a *misleadingly specific-looking* but wrong-
// location thumbnail, which is worse than no image. Detect and treat as a
// non-card (falls back to a plain link) rather than trust it.
function isGenericGoogleMapsMeta(meta, target) {
  if (!meta || !meta.ok) return false;
  const host = domainOf(target);
  if (!/(^|\.)google\.[a-z.]+$/.test(host) && !/^maps\.google\.[a-z.]+$/.test(host)) return false;
  const isMapsUrl = /\/maps(\?|$)/.test(target) || host.startsWith("maps.");
  if (!isMapsUrl) return false;
  return (meta.title === "Google Maps" || meta.siteName === "Google Maps") &&
    /maps\/api\/staticmap/.test(meta.image || "");
}

function absolutize(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, baseUrl).toString(); }
  catch { return null; }
}

function truncate(s, n) {
  if (!s) return "";
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

async function fetchWithRedirects(url, { timeoutMs, userAgent }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally { clearTimeout(timer); }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { ok: false, finalUrl: current, status: res.status };
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) return { ok: false, finalUrl: current, status: res.status };

    // Cap body read to avoid pulling huge pages.
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let html;
    if (reader) {
      const chunks = [];
      let total = 0;
      while (total < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      try { reader.cancel(); } catch {}
      html = new TextDecoder("utf-8", { fatal: false }).decode(
        Buffer.concat(chunks.map(u8 => Buffer.from(u8)))
      );
    } else {
      html = await res.text();
      if (html.length > MAX_BODY_BYTES * 2) html = html.slice(0, MAX_BODY_BYTES * 2);
    }
    return { ok: true, finalUrl: current, html };
  }
  return { ok: false, finalUrl: current, status: 0, reason: "too many redirects" };
}

function extractMeta(html, finalUrl) {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const pickMeta = (selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      const v = el && (el.getAttribute("content") || el.getAttribute("value"));
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  const ogTitle = pickMeta([
    'meta[property="og:title"]',
    'meta[name="og:title"]',
    'meta[name="twitter:title"]',
  ]);
  const ogDesc = pickMeta([
    'meta[property="og:description"]',
    'meta[name="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);
  const ogImage = pickMeta([
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]);
  const ogSite = pickMeta([
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ]);
  const ogUrl = pickMeta([
    'meta[property="og:url"]',
  ]);
  const titleEl = root.querySelector("title");
  const htmlTitle = titleEl ? titleEl.text.trim() : null;

  let favicon = null;
  for (const sel of ['link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]']) {
    const el = root.querySelector(sel);
    const href = el && el.getAttribute("href");
    if (href) { favicon = absolutize(href, finalUrl); break; }
  }

  return {
    title: ogTitle || htmlTitle || null,
    description: ogDesc || null,
    image: absolutize(ogImage, finalUrl),
    siteName: ogSite || null,
    canonicalUrl: absolutize(ogUrl, finalUrl) || finalUrl,
    favicon,
  };
}

async function fetchMeta(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  try {
    const r = await fetchWithRedirects(url, { timeoutMs, userAgent });
    if (!r.ok) return { url, finalUrl: r.finalUrl, ok: false, status: r.status, reason: r.reason };
    const m = extractMeta(r.html, r.finalUrl);
    return { url, finalUrl: r.finalUrl, ok: true, ...m };
  } catch (err) {
    return { url, ok: false, reason: err && err.message || String(err) };
  }
}

const CARD_A_STYLE =
  "display:block;text-decoration:none;color:inherit;margin:10px 0";
const CARD_TABLE_STYLE =
  "border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;" +
  "max-width:560px;width:100%;background:#ffffff;border-collapse:separate";
const CARD_IMG_CELL_STYLE = "width:120px;vertical-align:top";
const CARD_IMG_STYLE =
  "display:block;width:120px;height:120px;object-fit:cover;border:0";
const CARD_BODY_STYLE = "padding:10px 12px;vertical-align:top";
const CARD_TITLE_STYLE =
  "font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;" +
  "font-weight:600;color:#1a1a1a;line-height:1.3";
const CARD_DESC_STYLE =
  "font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:13px;" +
  "color:#555555;line-height:1.4;margin-top:4px";
const CARD_DOMAIN_STYLE =
  "font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:12px;" +
  "color:#888888;margin-top:6px";
const PLAIN_LINK_STYLE = "color:#1a73e8;text-decoration:underline";

function renderPlainLink(url, label) {
  const href = attrEscape(url);
  const txt = htmlEscape(label || url);
  return `<a href="${href}" style="${PLAIN_LINK_STYLE}">${txt}</a>`;
}

function renderCard(meta, opts = {}) {
  // `meta` may be a success result from fetchMeta or a failure object.
  const target = (meta && (meta.canonicalUrl || meta.finalUrl || meta.url)) || opts.url || "";
  if (!target) return "";

  if (!meta || !meta.ok || isGenericGoogleMapsMeta(meta, target)) {
    return renderPlainLink(target, opts.linkText || target);
  }

  const title = truncate(meta.title, 140);
  const description = truncate(meta.description, 220);
  const domain = meta.siteName || domainOf(target);
  const hasImage = Boolean(meta.image);

  // If we couldn't get a title AND no image, fall back to plain link — a
  // naked card with just a URL isn't helpful.
  if (!title && !hasImage) return renderPlainLink(target, opts.linkText || target);

  const titleHtml = title ? `<div style="${CARD_TITLE_STYLE}">${htmlEscape(title)}</div>` : "";
  const descHtml = description ? `<div style="${CARD_DESC_STYLE}">${htmlEscape(description)}</div>` : "";
  const domainHtml = domain ? `<div style="${CARD_DOMAIN_STYLE}">${htmlEscape(domain)}</div>` : "";

  const imgCell = hasImage
    ? `<td style="${CARD_IMG_CELL_STYLE}"><img src="${attrEscape(meta.image)}" width="120" height="120" alt="" style="${CARD_IMG_STYLE}"/></td>`
    : "";

  return (
    `<a href="${attrEscape(target)}" style="${CARD_A_STYLE}">` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="${CARD_TABLE_STYLE}"><tr>` +
        imgCell +
        `<td style="${CARD_BODY_STYLE}">${titleHtml}${descHtml}${domainHtml}</td>` +
      `</tr></table>` +
    `</a>`
  );
}

async function cardFor(url, opts = {}) {
  const meta = await fetchMeta(url, opts);
  return renderCard(meta, { url, linkText: opts.linkText });
}

async function cardsForMany(urls, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const results = new Array(urls.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= urls.length) return;
      const u = urls[idx];
      const meta = await fetchMeta(u, opts);
      results[idx] = renderCard(meta, { url: u });
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  fetchMeta,
  renderCard,
  renderPlainLink,
  cardFor,
  cardsForMany,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UA,
};
