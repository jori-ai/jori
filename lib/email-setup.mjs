// email-setup — give the assistant its own email address, step by step, and
// say exactly what is missing when a step can't be done from here.
//
// The owner (2026-11-04), about other installations: "what should other users
// do? do they need their own domain? how would they get emails?" and then
// "yes" to making it part of setup. An address is optional: without one the
// assistant reads and sends through the owner's own mailbox (Gmail). With one,
// two services carry the mail:
//   in   Cloudflare Email Routing sends <address> to the email worker
//        (cf-email-worker), which posts it to the supervisor's /email-inbound;
//   out  smtp2go sends as <address> once the domain is verified there
//        (bin/email-send).
// Every check here is a read or an idempotent add, so the control room's
// "Check and switch" can be pressed again after fixing what it reported.
// Used by lib/control/actions.mjs `email.setup`; the address change itself
// then goes through instance.save, which starts bin/identity-propagate.

import fs from "node:fs";
import { ensureCloudflareRoute } from "./identity-propagate.mjs";

const CF = "https://api.cloudflare.com/client/v4";
const SMTP2GO = "https://api.smtp2go.com/v3";
export const DEFAULT_WORKER = "jori-email-inbound";

/** The worker's name as cf-email-worker/wrangler.toml deploys it. */
export function workerName(wranglerToml) {
  try {
    const m = fs.readFileSync(wranglerToml, "utf8").match(/^name\s*=\s*"([^"]+)"/m); // lang-regex-ok: TOML syntax
    return m ? m[1] : DEFAULT_WORKER;
  } catch { return DEFAULT_WORKER; }
}

/** "name@example.com" → "example.com", or null when it isn't an address. */
export function domainOf(address) {
  const a = String(address || "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1 || at === a.length - 1 || a.includes(" ") || !a.slice(at + 1).includes(".")) return null;
  return a.slice(at + 1);
}

/** The zone that holds `domain`: the longest zone name it ends with. */
function zoneFor(zones, domain) {
  return zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] || null;
}

/**
 * Cloudflare: zone, Email Routing on, the worker deployed, the rule for the
 * address. Returns { ok, zone_id, checks: [{ name, ok, detail }] }.
 */
export async function cloudflareSetup({ token, address, worker = DEFAULT_WORKER }, { fetchFn = fetch } = {}) {
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
  const domain = domainOf(address);
  if (!domain) return { ok: false, checks: [{ name: "Address", ok: false, detail: `${address} isn't an email address` }] };
  if (!token) return { ok: false, checks: [{ name: "Cloudflare token", ok: false, detail: `Paste a Cloudflare API token with Zone Read and Email Routing Rules Edit on ${domain}` }] };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const get = async (p) => (await fetchFn(`${CF}${p}`, { headers })).json();

  const zones = await get(`/zones?per_page=50`);
  if (!zones.success) return { ok: false, checks: [{ name: "Cloudflare token", ok: false, detail: `Cloudflare refused the token: ${(zones.errors || []).map((e) => e.message).join("; ") || "unknown error"}` }] };
  const zone = zoneFor(zones.result || [], domain);
  if (!add("Domain on Cloudflare", !!zone, zone ? `${zone.name}` : `The token can't see ${domain}. Add the domain to Cloudflare (free), or give the token access to its zone.`)) return { ok: false, checks };

  const routing = await get(`/zones/${zone.id}/email/routing`);
  let enabled = routing.success && routing.result?.enabled;
  if (!enabled) {
    const on = await (await fetchFn(`${CF}/zones/${zone.id}/email/routing/enable`, { method: "POST", headers, body: "{}" })).json().catch(() => ({}));
    enabled = !!on.success;
  }
  if (!add("Email Routing", enabled, enabled ? "On" : `Turn on Email Routing for ${zone.name} in the Cloudflare dashboard (Email → Email Routing); it adds the MX records. The token could not do it.`)) return { ok: false, zone_id: zone.id, checks };

  const accountId = zone.account?.id;
  let workerOk = null;
  if (accountId) {
    const w = await fetchFn(`${CF}/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/settings`, { headers });
    workerOk = w.status === 200 ? true : w.status === 404 ? false : null;
  }
  if (workerOk === false) {
    add("Email worker", false, `The worker ${worker} isn't deployed. From cf-email-worker/: wrangler deploy --name ${worker}, then wrangler secret put WEBHOOK_URL (your public /email-inbound address) and INBOUND_SECRET.`);
    return { ok: false, zone_id: zone.id, checks };
  }
  add("Email worker", true, workerOk ? `${worker} is deployed` : `${worker} (the token can't read workers, so this wasn't checked)`);

  try {
    const r = await ensureCloudflareRoute({ zone_id: zone.id, worker, token_env: "_T" }, address.toLowerCase(), { fetchFn, env: { _T: token } });
    add("Routing rule", true, `${address} → ${worker} (${r})`);
  } catch (e) {
    add("Routing rule", false, e.message);
    return { ok: false, zone_id: zone.id, checks };
  }
  return { ok: true, zone_id: zone.id, worker, checks };
}

/**
 * smtp2go: the domain verified for sending. When it isn't there yet it is
 * added, and its two DNS records are created on Cloudflare when `cfToken`
 * can edit DNS; otherwise the records are listed for the owner to add.
 */
export async function smtp2goSetup({ key, address, cfToken, zoneId }, { fetchFn = fetch } = {}) {
  const checks = [];
  const domain = domainOf(address);
  if (!key) return { ok: false, checks: [{ name: "smtp2go key", ok: false, detail: "Paste an smtp2go API key (free plan works): smtp2go.com → Sending → API Keys" }] };
  const call = async (p, body = {}) => (await fetchFn(`${SMTP2GO}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Smtp2go-Api-Key": key }, body: JSON.stringify(body) })).json();
  const view = await call("/domain/view");
  if (view.data?.error) return { ok: false, checks: [{ name: "smtp2go key", ok: false, detail: view.data.error }] };
  let d = (view.data?.domains || []).map((x) => x.domain).find((x) => x.fulldomain === domain);
  if (!d) {
    const added = await call("/domain/add", { domain, auto_verify: false });
    d = added.data?.domains?.[0]?.domain || added.data?.domain;
    if (!d) return { ok: false, checks: [{ name: "Sending domain", ok: false, detail: `smtp2go would not add ${domain}: ${added.data?.error || "unknown error"}` }] };
    checks.push({ name: "Sending domain", ok: true, detail: `Added ${domain} to smtp2go` });
  }
  if (d.dkim_verified && d.rpath_verified) {
    checks.push({ name: "Sending domain", ok: true, detail: `${domain} is verified for sending` });
    return { ok: true, checks };
  }
  const records = [
    { name: `${d.dkim_selector}._domainkey.${domain}`, content: d.dkim_expected || d.dkim_value },
    { name: `${d.rpath_selector}.${domain}`, content: d.rpath_expected || d.rpath_value },
  ].filter((r) => r.content && !r.name.startsWith("undefined"));
  let created = false;
  if (cfToken && zoneId && records.length) {
    created = true;
    for (const r of records) {
      const res = await (await fetchFn(`${CF}/zones/${zoneId}/dns_records`, { method: "POST", headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "CNAME", name: r.name, content: r.content, proxied: false, ttl: 1 }) })).json().catch(() => ({}));
      // 81053/81057: the record is already there.
      if (!res.success && !(res.errors || []).some((e) => [81053, 81057].includes(e.code))) created = false;
    }
  }
  const verify = await call("/domain/verify", { domain });
  const v = verify.data?.domains?.[0]?.domain || {};
  if (v.dkim_verified && v.rpath_verified) {
    checks.push({ name: "Sending domain", ok: true, detail: `${domain} verified${created ? " (DNS records created on Cloudflare)" : ""}` });
    return { ok: true, checks };
  }
  checks.push({ name: "Sending domain", ok: false, detail: `${domain} isn't verified at smtp2go yet. ${created ? "The DNS records were just created; DNS can take a few minutes, then press Check again." : `Add these CNAME records (DNS only, not proxied), then press Check again: ${records.map((r) => `${r.name} → ${r.content}`).join("; ")}`}` });
  return { ok: false, checks };
}
