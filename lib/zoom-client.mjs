// zoom-client.mjs — read-only Zoom REST client (Server-to-Server OAuth).
//
// The user's own Zoom account, through a Server-to-Server OAuth app created on
// it in the Zoom Marketplace. The user's recurring meetings run in the user's
// OWN room (lib/meetings.mjs `zoom.room_id`), so the user is the host and an
// app on the account can read those meetings. GETs on past meetings only;
// nothing here can create, change or join a meeting.
//
// Scopes the app needs (Zoom's granular scopes, as its API reference names them):
//   meeting:read:list_past_instances:admin   GET /past_meetings/{meetingId}/instances
//   meeting:read:past_meeting:admin          GET /past_meetings/{meetingUUID}
//   meeting:read:list_past_participants:admin GET /past_meetings/{meetingUUID}/participants
// Participants need a paid (Pro or higher) plan; Zoom answers 400 / code 200
// ("Only available for paid account") when the account is on the free plan.
//
// THE THREE VALUES (Account ID, Client ID, Client Secret):
//   1. secrets/zoom-s2s.json, mode 0600 (secrets/ is gitignored):
//      {"account_id": "...", "client_id": "...", "client_secret": "..."}.
//      writeCredentials() writes it (the installation's setup copies the values
//      from its secret store). A file other users can read is refused, not used.
//   2. Else ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in the env.
// The values leave this module only inside the token request. They are never
// logged, printed, put in an error, a prompt or an event row: every error here
// is a ZoomError built from our own words, the HTTP status and Zoom's numeric
// code, and Zoom's own text is kept only after scrub() has taken the three
// values out of it (Zoom's "Only available for paid account: {accountId}"
// quotes one). A parse error's own text is never kept (V8 quotes the input).
//
// The access token lives in memory until a minute before Zoom's expires_in.
// Zoom lets an S2S app hold several live tokens at once, so a second process
// asking for its own does not knock out the first, and none is written to disk.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { installRoot } = createRequire(import.meta.url)("./root.cjs");
export const SECRETS_FILE = process.env.ZOOM_S2S_FILE || path.join(installRoot(), "secrets/zoom-s2s.json");
export const REQUIRED_SCOPES = [
  "meeting:read:list_past_instances:admin",
  "meeting:read:past_meeting:admin",
  "meeting:read:list_past_participants:admin",
];
const TOKEN_URL = "https://zoom.us/oauth/token";
const DEFAULT_API = "https://api.zoom.us";

export class ZoomError extends Error {
  /** kind: no_credentials | token | unauthorized | forbidden | not_found | paid_plan_required |
   *        missing_scope | rate_limited | timeout | network | bad_response | http */
  constructor(kind, { status = null, code = null, detail = "" } = {}) {
    super([kind, status ? `HTTP ${status}` : "", code != null ? `code ${code}` : ""].filter(Boolean).join(", "));
    this.name = "ZoomError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.detail = detail; // Zoom's own words, scrubbed; for zoom-probe, never for logs
  }
}

/** Replace any of the three values in `text` with ***. Plain string search. */
export function scrub(text, cfg) {
  let out = String(text == null ? "" : text);
  for (const v of cfg ? [cfg.accountId, cfg.clientId, cfg.clientSecret] : []) {
    if (v && v.length >= 4) out = out.split(v).join("***");
  }
  return out;
}

/** How a value is shown: its last two characters and its length, never more. */
export function maskValue(v, { secret = false } = {}) {
  if (!v) return "missing";
  return secret ? `set (${v.length} chars)` : `••••${v.slice(-2)} (${v.length} chars)`;
}

const nonEmpty = (x) => typeof x === "string" && x.trim().length > 0;

/**
 * The three values, from the 0600 file, else the environment.
 * @returns {{cfg: {accountId, clientId, clientSecret}|null, source: "file"|"env"|null, problem: string|null}}
 */
export function loadCredentials({ file = SECRETS_FILE, env = process.env } = {}) {
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (st) {
    if (!st.isFile()) return { cfg: null, source: "file", problem: `${file} is not a file` };
    if (st.mode & 0o077) {
      return { cfg: null, source: "file", problem: `${file} can be read by other users; run chmod 600 on it` };
    }
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      return { cfg: null, source: "file", problem: `${file} is not valid JSON` };
    }
    const cfg = j && { accountId: j.account_id, clientId: j.client_id, clientSecret: j.client_secret };
    if (!cfg || ![cfg.accountId, cfg.clientId, cfg.clientSecret].every(nonEmpty)) {
      return { cfg: null, source: "file", problem: `${file} needs account_id, client_id and client_secret` };
    }
    return { cfg: { accountId: cfg.accountId.trim(), clientId: cfg.clientId.trim(), clientSecret: cfg.clientSecret.trim() },
             source: "file", problem: null };
  }
  const { ZOOM_ACCOUNT_ID: a, ZOOM_CLIENT_ID: b, ZOOM_CLIENT_SECRET: c } = env || {};
  if ([a, b, c].every(nonEmpty)) return { cfg: { accountId: a.trim(), clientId: b.trim(), clientSecret: c.trim() }, source: "env", problem: null };
  return { cfg: null, source: null, problem: null };
}

/**
 * Write the three values to `file` at 0600 (the directory at 0700), atomically.
 * The caller got them from 1Password; this prints nothing.
 */
export function writeCredentials({ accountId, clientId, clientSecret }, file = SECRETS_FILE) {
  if (![accountId, clientId, clientSecret].every(nonEmpty)) throw new ZoomError("no_credentials", { detail: "a value is empty" });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ account_id: accountId.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim() }) + "\n");
  } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * A meeting UUID as a path segment. Zoom: "If you provide a meeting UUID that
 * begins with a / character or contains the // characters, you must double
 * encode the meeting UUID before making an API request."
 */
export function encodeUuid(uuid) {
  const u = String(uuid);
  return u.startsWith("/") || u.includes("//") ? encodeURIComponent(encodeURIComponent(u)) : encodeURIComponent(u);
}

const isDigits = (s) => s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9");

/**
 * The numeric meeting id in a Zoom join link ("https://us02web.zoom.us/j/1234567890?pwd=..."),
 * or null. URL structure only: host under zoom.us, path /j/<digits> (or /s/, /w/).
 */
export function meetingIdFromUrl(text) {
  for (const tok of String(text || "").split("\n").join(" ").split(" ")) {
    const at = tok.indexOf("http");
    const href = at >= 0 ? tok.slice(at) : tok.includes("zoom.us/") ? `https://${tok}` : null;
    if (!href) continue;
    let u;
    try { u = new URL(href); } catch { continue; }
    if (!(u.hostname === "zoom.us" || u.hostname.endsWith(".zoom.us"))) continue;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2 && ["j", "s", "w"].includes(seg[0]) && isDigits(seg[1])) return seg[1];
  }
  return null;
}

/** Only ever send the bearer token to Zoom's own API hosts. */
function apiBase(apiUrl) {
  try {
    const u = new URL(apiUrl);
    if (u.protocol === "https:" && (u.hostname === "api.zoom.us" || u.hostname.endsWith(".zoom.us"))) return u.origin;
  } catch {}
  return DEFAULT_API;
}

function errorFor(status, body, cfg) {
  const code = body && typeof body.code === "number" ? body.code : null;
  const detail = scrub((body && (body.message || body.reason || body.error)) || "", cfg).slice(0, 300);
  if (status === 401) return new ZoomError("unauthorized", { status, code, detail });
  if (status === 403) return new ZoomError("forbidden", { status, code, detail });
  if (status === 404) return new ZoomError("not_found", { status, code, detail });
  if (status === 429) return new ZoomError("rate_limited", { status, code, detail });
  if (code === 200) return new ZoomError("paid_plan_required", { status, code, detail });
  if (code === 4711 || code === 4700) return new ZoomError("missing_scope", { status, code, detail });
  return new ZoomError("http", { status, code, detail });
}

/**
 * @param cfg        {accountId, clientId, clientSecret}
 * @param fetchImpl  injectable for tests (nothing in a test may touch the network)
 */
export function createZoomClient({ cfg, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 } = {}) {
  if (!cfg) throw new ZoomError("no_credentials");
  let cached = null; // {token, expiresAt, scopes, base}

  // The timer covers the whole exchange, body included: a response whose body
  // stalls is a timeout like any other.
  async function call(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ac.signal });
      let body = null;
      try { body = await res.json(); } catch (e) { if (e && e.name === "AbortError") throw e; }
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      if (e && e.name === "AbortError") throw new ZoomError("timeout");
      throw new ZoomError("network", { detail: String((e && e.cause && e.cause.code) || (e && e.name) || "") });
    } finally { clearTimeout(timer); }
  }

  async function token() {
    if (cached && now() < cached.expiresAt) return cached;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    const res = await call(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "account_credentials", account_id: cfg.accountId }).toString(),
    });
    const { body } = res;
    if (!res.ok) {
      const e = errorFor(res.status, body, cfg);
      throw new ZoomError("token", { status: e.status, code: e.code, detail: e.detail });
    }
    if (!body || !nonEmpty(body.access_token)) throw new ZoomError("bad_response", { status: res.status, detail: "no access_token in the token response" });
    const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
    cached = {
      token: body.access_token,
      expiresAt: now() + Math.max(60, ttl - 60) * 1000,
      scopes: String(body.scope || "").split(" ").filter(Boolean),
      base: apiBase(body.api_url),
    };
    return cached;
  }

  async function get(p) {
    const t = await token();
    const res = await call(`${t.base}/v2${p}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" } });
    const { body } = res;
    if (!res.ok) throw errorFor(res.status, body, cfg);
    if (!body || typeof body !== "object") throw new ZoomError("bad_response", { status: res.status });
    return body;
  }

  return {
    token,
    /** Granted scopes, from the token response (after token()). */
    scopes: () => (cached ? cached.scopes.slice() : null),
    /** Ended instances of a meeting id: [{uuid, start_time}]. from/to are UTC YYYY-MM-DD. */
    async pastInstances(meetingId, { from, to } = {}) {
      const q = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
      const body = await get(`/past_meetings/${encodeURIComponent(String(meetingId))}/instances${q}`);
      return Array.isArray(body.meetings) ? body.meetings.filter((m) => m && m.uuid && m.start_time) : [];
    },
    /** One ended instance: {uuid, start_time, end_time, duration, participants_count, type, ...}. */
    pastMeeting: (uuid) => get(`/past_meetings/${encodeUuid(uuid)}`),
    /** Everyone who joined one ended instance, every page. */
    async pastParticipants(uuid, { maxPages = 10 } = {}) {
      const out = [];
      let next = "";
      for (let page = 0; page < maxPages; page++) {
        const body = await get(`/past_meetings/${encodeUuid(uuid)}/participants?page_size=300`
          + (next ? `&next_page_token=${encodeURIComponent(next)}` : ""));
        out.push(...(Array.isArray(body.participants) ? body.participants : []));
        next = body.next_page_token || "";
        if (!next) break;
      }
      return out;
    },
  };
}
