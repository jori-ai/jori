// onboarding/pairing.mjs — the code the Jori app scans to find this
// installation, and the "say hi from your phone" round-trip check.
//
// One shared app learns its server at runtime instead of at build time
// (apps/companion SupabaseConfig.swift `Install`, the pairing store). The
// code is `jori-pair:1:` + base64url(JSON):
//   u  Supabase URL           k  anon (public) key
//   n  assistant name         e  owner email (a sign-in hint)
//   sp purchase signing domain   sa approve signing domain
//   r  push relay URL, i  relay instance id, t  one-time pairing token
//      (only when this installation pushes through the relay, lib/push-relay.mjs)
// The anon key is public by design (RLS + the allowlist guard every table),
// so the code carries no secret; the relay token expires in ten minutes.

import fs from "node:fs";
import path from "node:path";
import { instancePath } from "./core.mjs";
import { supabaseSaved } from "./services.mjs";

export const PAIR_PREFIX = "jori-pair:1:";
const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

export function encodePairing(obj) {
  return PAIR_PREFIX + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function decodePairing(code) {
  const s = String(code || "").trim();
  if (!s.startsWith(PAIR_PREFIX)) throw new Error("not a Jori pairing code");
  return JSON.parse(Buffer.from(s.slice(PAIR_PREFIX.length), "base64url").toString("utf8"));
}

/** system/app-distribution.json: the shared app's relay and TestFlight link (env overrides). */
export function appDistribution(base, env = process.env) {
  const d = readJson(path.join(base, "system", "app-distribution.json"), {});
  return {
    relayUrl: String(env.JORI_PUSH_RELAY_URL || d.push_relay_url || "").trim(),
    testflightUrl: String(env.JORI_TESTFLIGHT_URL || d.testflight_url || "").trim(),
  };
}

/** True when this host signs its own pushes (its own app and Apple key): it keeps pushing directly. */
function hasOwnApnsKey(base) {
  const a = readJson(path.join(base, "agent", "local", "config", "apns.json"), {});
  return !!(a.key_id && a.team_id);
}

/**
 * A new host on the shared app registers with the shared push relay the first
 * time it builds a pairing code. A host with its own Apple key, one already
 * registered, or no relay configured is left as it is.
 */
export async function ensureRelay(base, { relay, env = process.env } = {}) {
  const R = relay || (await import("../push-relay.mjs"));
  if (R.relayConfig?.()) return { registered: false, already: true };
  if (hasOwnApnsKey(base)) return { registered: false, direct: true };
  const { relayUrl } = appDistribution(base, env);
  if (!relayUrl) return { registered: false };
  const r = await R.registerInstance({ relayUrl });
  return { registered: true, ...r };
}

/** Build a pairing code for this installation. `relay` is lib/push-relay.mjs (injectable for tests). */
export async function buildPairing(base, { relay } = {}) {
  const sb = supabaseSaved(base);
  if (!sb.url || !sb.anonKey) return { ok: false, message: "Connect Supabase first: the app talks to me through it." };
  const I = readJson(instancePath(base), {});
  const purchase = readJson(path.join(base, "agent", "local", "config", "purchase.json"), {});
  const obj = {
    u: sb.url,
    k: sb.anonKey,
    n: I.assistant_name || "Jori", // control-scan-ok: the setting's default
    e: I.owner_email || undefined,
    sp: purchase.signing_domain || "jori-purchase.v1",
    sa: I.approval_domain || "jori-approve.v1",
  };
  let expiresAt = null;
  let relayError = null;
  try { await ensureRelay(base, { relay }); } catch (e) { relayError = e.message; }
  try {
    const R = relay || (await import("../push-relay.mjs"));
    const cfg = R.relayConfig?.();
    if (cfg) {
      const p = await R.createPairing({ ttlMs: 10 * 60_000 });
      Object.assign(obj, { r: cfg.relay_url || cfg.relayUrl, i: cfg.instance_id || cfg.instanceId, t: p.token });
      expiresAt = p.expiresAt;
    }
  } catch { /* no relay on this installation: the app pairs without it */ }
  const code = encodePairing(obj);
  const QR = (await import("qrcode")).default;
  return { ok: true, code, svg: await QR.toString(code, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), relay: !!obj.r, relayError, expiresAt };
}

/**
 * The round trip: has a message from the app arrived since `since` (ISO), and
 * has the assistant answered it? Reads jori_messages with the service key.
 */
export async function roundTrip(base, since, { fetchFn = fetch } = {}) {
  const sb = supabaseSaved(base);
  if (!sb.url || !sb.serviceKey) return { ok: false, message: "Supabase isn’t connected" };
  const h = { apikey: sb.serviceKey, Authorization: `Bearer ${sb.serviceKey}` };
  const q = (role) => `${sb.url}/rest/v1/jori_messages?select=id,role,content,created_at&channel=eq.chat&role=eq.${role}&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&limit=1`;
  try {
    const [u] = await (await fetchFn(q("user"), { headers: h })).json();
    if (!u) return { ok: true, sent: false };
    const [a] = await (await fetchFn(q("assistant").replace(encodeURIComponent(since), encodeURIComponent(u.created_at)), { headers: h })).json();
    return { ok: true, sent: true, text: String(u.content || "").slice(0, 200), answered: !!a, reply: a ? String(a.content || "").slice(0, 300) : null, seconds: a ? Math.round((Date.parse(a.created_at) - Date.parse(u.created_at)) / 1000) : null };
  } catch (e) {
    return { ok: false, message: `Couldn’t read the chat: ${e.message}` };
  }
}
