// calendar-zoom — attach a Zoom link to a Google Calendar event as its real
// video conference, the same field the user fills by picking "Zoom Meeting"
// under "Add video conferencing" in Calendar.
//
// WHY (2026-11-23, the owner): "when scheduling a zoom meeting using google
// calendar (which all my meetings are) the video conferencing field should be
// set to zoom (automatically connects my link)." Jori's Zoom events carried the
// link only in the location and description, so Calendar showed no Join button
// and the conferencing field was empty.
//
// HOW. gog (0.12) has no way to set conferenceData, so after gog writes the
// event, `bin/jori-calendar` calls attachZoom(), which PATCHes the event with
// conferenceDataVersion=1 and a conferenceSolution of type "addOn" named
// "Zoom Meeting". Google accepts that from any client with calendar scope (tested
// on the live install 2026-11-23: HTTP 200, the fields read back intact). The
// access token is minted from gog's own stored refresh token and OAuth client,
// in a private temp dir that is removed before returning; nothing is printed or
// kept. Notifications: sendUpdates=none — guests already got the link in the
// invite gog sent; a second "event changed" email for the same call is noise.
//
// Called only from bin/jori-calendar (the one sanctioned calendar writer).
// Conference data cannot add a guest, so the attendee rule is untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Zoom's add-on icon, as Google stores it on events made with the add-on.
export const ZOOM_ICON = "https://lh3.googleusercontent.com/pw/AM-JKLUkiyTEgH-6DiQP85RGtd_BORvAuFnS9katNMgwYQBJUTiUh2LD6VjPh5Je5nCrVxGZAA6Xy0CPV4vY8LnhFsmhgS0LwrH6UQbsW6ABbcUNP1hy7arm-fh3OaHSG16hbVfHCKZmlFQ5fOHJyD8cJ5FJ=s0";

// A Zoom join link: <sub>.zoom.us/j/<digits>[?pwd=…]. URL syntax, not language.
const ZOOM_JOIN = /https?:\/\/(?:[a-z0-9-]+\.)*zoom\.us\/j\/(\d{9,12})(?:\?[^\s"'<>)\]]*)?/i;

/** The first Zoom join link in any of the texts, or null. Pure. */
export function findZoomLink(...texts) {
  for (const t of texts) {
    const m = String(t || "").match(ZOOM_JOIN);
    if (m) return { uri: m[0].replace(/[.,;]+$/, ""), meetingCode: m[1] };
  }
  return null;
}

/** A "Passcode: 123456" line in the texts, or null. Pure. */
export function findPasscode(...texts) {
  for (const t of texts) {
    const m = String(t || "").match(/\bpass(?:code|word)\s*[:=]\s*([A-Za-z0-9]{3,12})\b/i);
    if (m) return m[1];
  }
  return null;
}

/** The conferenceData body for a Zoom link. Pure. */
export function zoomConferenceData({ uri, meetingCode }, passcode = null) {
  const entry = { entryPointType: "video", uri, label: uri.replace(/^https?:\/\//, ""), meetingCode };
  if (passcode) entry.passcode = passcode;
  return {
    conferenceId: meetingCode,
    conferenceSolution: { key: { type: "addOn" }, name: "Zoom Meeting", iconUri: ZOOM_ICON },
    entryPoints: [entry],
  };
}

/** True when the event already has a video conference (Zoom, Meet, anything). Pure. */
export function hasConference(event) {
  if (!event) return false;
  if (event.hangoutLink) return true;
  const eps = event.conferenceData?.entryPoints || [];
  return eps.some((p) => p && p.entryPointType === "video" && p.uri);
}

/** The event id from gog's create output (text or --json). Pure. */
export function parseCreatedId(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    const id = j?.id || j?.event?.id;
    if (id) return String(id);
  } catch { /* text output */ }
  const m = s.match(/^\s*id\s*[:\t ]\s*([A-Za-z0-9_]+)\s*$/m);
  return m ? m[1] : null;
}

function gogConfigDir() {
  if (process.env.GOG_CONFIG_DIR) return process.env.GOG_CONFIG_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "gogcli");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gogcli");
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k]) return obj[k];
  return null;
}

// A short-lived access token from gog's stored refresh token. Never logged.
async function accessToken({ gog, account }) {
  if (process.env.JORI_CALENDAR_ACCESS_TOKEN) return process.env.JORI_CALENDAR_ACCESS_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jori-cal-zoom-"));
  fs.chmodSync(dir, 0o700);
  try {
    const out = path.join(dir, "token.json");
    const r = spawnSync(gog, ["auth", "tokens", "export", account, "--out", out, "--no-input"], { encoding: "utf8" });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`gog auth tokens export failed (exit ${r.status})`);
    const tok = JSON.parse(fs.readFileSync(out, "utf8"));
    const refresh = pick(tok, "refresh_token", "RefreshToken", "refreshToken") || pick(tok.token || {}, "refresh_token", "RefreshToken");
    if (!refresh) throw new Error("no refresh token in gog's export");
    const credsRaw = JSON.parse(fs.readFileSync(path.join(gogConfigDir(), "credentials.json"), "utf8"));
    const creds = credsRaw.installed || credsRaw.web || credsRaw;
    const clientId = pick(creds, "client_id", "ClientID", "clientId");
    const clientSecret = pick(creds, "client_secret", "ClientSecret", "clientSecret");
    if (!clientId || !clientSecret) throw new Error("no OAuth client in gog's credentials.json");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`token refresh failed (HTTP ${res.status})`);
    return j.access_token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const API = () => process.env.JORI_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3";

/**
 * Attach `link` to the event as its Zoom conference, unless it already has a
 * video conference. Returns { ok, skipped?, reason? }. Never throws.
 */
export async function attachZoom({ gog, account, calendar = "primary", eventId, link, passcode = null, force = false }) {
  try {
    if (!eventId || !link) return { ok: false, reason: "missing event id or link" };
    const token = await accessToken({ gog, account });
    const url = `${API()}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`;
    const auth = { authorization: `Bearer ${token}` };
    if (!force) {
      const g = await fetch(`${url}?conferenceDataVersion=1`, { headers: auth });
      if (g.ok && hasConference(await g.json())) return { ok: true, skipped: true, reason: "already has a video conference" };
    }
    const res = await fetch(`${url}?conferenceDataVersion=1&sendUpdates=none`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ conferenceData: zoomConferenceData(link, passcode) }),
    });
    if (!res.ok) return { ok: false, reason: `PATCH HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
