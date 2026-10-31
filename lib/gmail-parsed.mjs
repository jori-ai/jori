// gmail-parsed.mjs — minimal read-only Gmail API access for scripts:
// search(q) → message ids, getMessage(id) → {id, subject, from, date, text, links}.
//
// Uses the same OAuth path as gmail-action / jev-email-triage (lib/google-auth.js).
// `links` is every href in the HTML part plus every URL in the text part, so a
// "click to confirm" anchor survives even when the plain part is missing. The
// Gmail API returns base64url-decoded bodies, so the quoted-printable mangling
// the old agent playbook had to repair by hand (Gmail connector HTML eating
// "=10" out of `lottery=1088924`) does not happen on this path.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function api(pathAndQuery, { timeoutMs = 15000 } = {}) {
  const { getAccessToken } = require("./google-auth.js");
  const token = await getAccessToken();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GMAIL_API}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    if (!res.ok) throw new Error(`gmail HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function search(q, max = 20) {
  const j = await api(`/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  return (j.messages || []).map((m) => m.id);
}

const b64 = (d) => Buffer.from(String(d).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

export function parsePayload(payload) {
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (p.body?.data) {
      if (mt === "text/plain" && !plain) plain = b64(p.body.data);
      else if (mt === "text/html" && !html) html = b64(p.body.data);
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  // lang-regex-ok: HTML structure (href attributes, tags) of a machine-generated email
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  // lang-regex-ok: tag strip for a text fallback when there is no plain part
  const text = plain || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const headers = Object.fromEntries((payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  return { text, hrefs, headers };
}

export async function getMessage(id) {
  const j = await api(`/messages/${encodeURIComponent(id)}?format=full`);
  const { text, hrefs, headers } = parsePayload(j.payload);
  return {
    id,
    subject: headers.subject || "",
    from: headers.from || "",
    date: headers.date || "",
    internalDate: Number(j.internalDate || 0),
    text,
    links: hrefs,
  };
}
