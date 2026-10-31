// zoom-content.mjs — what was said on one of the user's Zoom calls, as text.
//
// Used after a recurring meeting (bin/meeting-notes-from-zoom folds it into the
// meeting notes; bin/meeting-call-talk writes the daily summary's paragraph)
// and by the call log (lib/call-log.mjs). AI Companion meeting summaries exist
// when the account has them on (auto-start is a Zoom account setting); a cloud
// recording's audio transcript exists only when a call was cloud-recorded.
//
// Two sources, best first, for one ended meeting instance (its UUID):
//   1. transcript — GET /meetings/{uuid}/recordings, the TRANSCRIPT file (VTT),
//      downloaded with the same bearer token and reduced to "Speaker: words"
//      lines (VTT structure only: the header, cue numbers and "-->" timing
//      lines are dropped; nothing is interpreted).
//   2. summary — GET /meetings/{uuid}/meeting_summary, AI Companion's overview,
//      sections and next steps, joined as Zoom wrote them.
// Neither → null ("Zoom has nothing for this call yet"). A 404 / code 3001 is
// "none", not an error. Read-only; the token comes from lib/zoom-client.mjs
// (scopes meeting:read:summary:admin, cloud_recording:read:recording:admin,
// cloud_recording:read:list_recording_files:admin on the account's S2S app).
//
// The text is handed to a model (bin/meeting-call-talk,
// bin/meeting-notes-from-zoom, bin/call-log), never parsed for meaning here.

import { encodeUuid, ZoomError } from "./zoom-client.mjs";

export const MAX_CHARS = 60_000;

/** A WebVTT file as plain lines. Structure only. Pure. */
export function vttToText(vtt) {
  const out = [];
  for (const raw of String(vtt || "").split("\n")) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || line.includes("-->")) continue;
    if ([...line].every((ch) => ch >= "0" && ch <= "9")) continue; // cue number
    out.push(line);
  }
  return out.join("\n");
}

/** AI Companion's summary body as text, fields in Zoom's own order. Pure. */
export function summaryToText(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  if (body.summary_title) parts.push(String(body.summary_title));
  if (body.summary_overview) parts.push(String(body.summary_overview));
  for (const d of Array.isArray(body.summary_details) ? body.summary_details : []) {
    if (!d) continue;
    const head = d.label ? `${d.label}: ` : "";
    if (d.summary) parts.push(`${head}${d.summary}`);
  }
  const steps = (Array.isArray(body.next_steps) ? body.next_steps : []).filter(Boolean).map(String);
  if (steps.length) parts.push(`Next steps:\n${steps.map((s) => `- ${s}`).join("\n")}`);
  if (body.summary_content) parts.push(String(body.summary_content));
  return parts.join("\n\n").trim();
}

async function getJson(client, p, fetchImpl) {
  const t = await client.token();
  const res = await fetchImpl(`${t.base}/v2${p}`, { headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" } });
  let body = null;
  try { body = await res.json(); } catch {}
  const code = body && typeof body.code === "number" ? body.code : null;
  if (res.status === 404 || code === 3001 || code === 3301) return null; // no such summary / recording
  if (!res.ok) throw new ZoomError(res.status === 403 ? "forbidden" : res.status === 401 ? "unauthorized" : "http", { status: res.status, code });
  return body;
}

async function transcript(client, uuid, fetchImpl) {
  const rec = await getJson(client, `/meetings/${encodeUuid(uuid)}/recordings`, fetchImpl);
  const f = rec && (rec.recording_files || []).find((x) => x && x.file_type === "TRANSCRIPT" && x.download_url
    && (!x.status || x.status === "completed"));
  if (!f) return null;
  const t = await client.token();
  const url = new URL(f.download_url);
  if (!(url.protocol === "https:" && (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")))) return null;
  const res = await fetchImpl(url.href, { headers: { Authorization: `Bearer ${t.token}` } });
  if (!res.ok) return null;
  const text = vttToText(await res.text());
  return text ? { kind: "transcript", text: text.slice(0, MAX_CHARS) } : null;
}

async function summary(client, uuid, fetchImpl) {
  const body = await getJson(client, `/meetings/${encodeUuid(uuid)}/meeting_summary`, fetchImpl);
  const text = summaryToText(body);
  return text ? { kind: "summary", text: text.slice(0, MAX_CHARS) } : null;
}

/**
 * {kind: "transcript"|"summary", text, uuid} for the first of `uuids` that has
 * either, transcript preferred per instance; null when none has anything.
 * `order: ["summary", "transcript"]` reads the summary first (the call log,
 * lib/call-log.mjs: its next steps are already split by person).
 */
export async function callContent(client, uuids, { fetchImpl = globalThis.fetch, order = ["transcript", "summary"] } = {}) {
  const readers = { transcript, summary };
  for (const uuid of uuids || []) {
    for (const kind of order) {
      const got = await readers[kind](client, uuid, fetchImpl);
      if (got) return { ...got, uuid };
    }
  }
  return null;
}
