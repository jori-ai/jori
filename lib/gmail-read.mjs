// gmail-read.mjs — read-only Gmail REST helpers for scripted jobs (no MCP, no agent).
//
// Uses the same OAuth token as gmail-action (lib/google-auth.js).
// Structure only: MIME walking, base64url decoding, HTML → text, link
// extraction. What any of it MEANS is a model's job downstream.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Tests (and a caller with its own client) swap the transport: a function
// (pathAndQuery) => Promise<json>. null = the real Gmail API.
let transport = null;
export function setTransport(fn) { transport = typeof fn === "function" ? fn : null; }

async function gfetch(pathAndQuery) {
  if (transport) return transport(pathAndQuery);
  const { getAccessToken, fetchWithRetry } = require("./google-auth.js");
  const tok = await getAccessToken();
  const res = await fetchWithRetry(`${API}${pathAndQuery}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** All message ids for a Gmail search query (paginated, capped). */
export async function searchIds(q, { max = 100 } = {}) {
  const ids = [];
  let pageToken = "";
  while (ids.length < max) {
    const j = await gfetch(`/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(100, max)}${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const m of j.messages || []) ids.push(m.id);
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return ids.slice(0, max);
}

export async function getMessage(id) {
  return gfetch(`/messages/${id}?format=full`);
}

export function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function b64url(data) {
  return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); // lang-regex-ok: base64url alphabet
}

/** First text/html and text/plain bodies found walking the MIME tree. */
export function bodies(msg) {
  let html = null, plain = null;
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === "text/html" && !html && p.body?.data) html = b64url(p.body.data);
    if (p.mimeType === "text/plain" && !plain && p.body?.data) plain = b64url(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(msg.payload);
  return { html, plain };
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ") // lang-regex-ok: HTML structure
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n") // lang-regex-ok: HTML structure
    .replace(/<[^>]+>/g, " ") // lang-regex-ok: HTML tag stripping
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim(); // lang-regex-ok: whitespace normalization
}

// Links that are never a story: mail plumbing, unsubscribe/preferences, app
// deep-links, social share intents, images. Structural URL shapes only.
const PLUMBING = ["unsubscribe", "/subscribe", "preferences", "manage", "mailto:", "/app-link/", "list-manage", "twitter.com/intent", "facebook.com/sharer", "linkedin.com/share", "/action/disable_email", "substack.com/redirect/2/"];

/** [{url, text}] anchors in document order, deduped, plumbing removed. */
export function storyLinks(html, { max = 25 } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || "").matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) { // lang-regex-ok: HTML anchor structure
    const url = m[1].replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(url)) continue; // lang-regex-ok: URL scheme
    const low = url.toLowerCase();
    if (PLUMBING.some((p) => low.includes(p))) continue;
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) continue; // lang-regex-ok: image file extension
    const text = htmlToText(m[2]).slice(0, 120);
    if (!text || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text });
    if (out.length >= max) break;
  }
  return out;
}

/** Web link to a message; `account` is the browser's account index (u/N). */
export function gmailLink(id, { account = 0 } = {}) {
  return `https://mail.google.com/mail/u/${account}/#inbox/${id}`;
}
