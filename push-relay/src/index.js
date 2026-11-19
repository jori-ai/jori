// push-relay — the Jori push relay (Cloudflare Worker + D1).
//
// Holds the shared Jori app's APNs key so a host never does. A host signs its
// requests with its instance secret; a phone registers with a one-time pairing
// token and gets its own device secret. The relay forwards end-to-end
// encrypted blobs to APNs and never sees what a notification says.
//
// Never log ciphertext, APNs tokens, secrets or pairing tokens. Logs carry
// route, status and a short id prefix only.
//
// Protocol, crypto and deploy: docs/push-relay.md. Pure logic: ./core.js.

import * as core from "./core.js";

const jwtCache = core.createJwtCache();

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status, error, message) => json(status, message ? { error, message } : { error });
const short = (id) => String(id || "").slice(0, 10);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env, Date.now());
    } catch (e) {
      console.error(`[push-relay] ${request.method} ${new URL(request.url).pathname} failed: ${e?.name || "Error"}`);
      return err(500, "internal");
    }
  },

  // Hourly sweep (wrangler.toml [triggers]): expired pairings, old rate
  // windows, devices dead for 30 days.
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairings WHERE expires_at < ?1").bind(now),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 2 * core.HOUR_MS),
      env.DB.prepare("DELETE FROM devices WHERE dead_at IS NOT NULL AND dead_at < ?1").bind(now - 30 * 86_400_000),
    ]);
  },
};

async function route(request, env, now) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > core.MAX_BODY_BYTES) return err(413, "body_too_large");
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.length > core.MAX_BODY_BYTES) return err(413, "body_too_large");

  const ctx = { request, env, now, path, method, bodyBytes };

  if (path === "/v1/instances") return method === "POST" ? createInstance(ctx) : err(405, "method_not_allowed");
  if (path === "/v1/pairings") return method === "POST" ? createPairing(ctx) : err(405, "method_not_allowed");
  if (path === "/v1/devices") {
    if (method === "POST") return registerDevice(ctx);
    if (method === "GET") return listDevices(ctx);
    return err(405, "method_not_allowed");
  }
  const m = path.match(/^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    if (method === "PUT") return updateDevice(ctx, m[1]);
    if (method === "DELETE") return deleteDevice(ctx, m[1]);
    return err(405, "method_not_allowed");
  }
  if (path === "/v1/push") return method === "POST" ? push(ctx) : err(405, "method_not_allowed");
  return err(404, "not_found");
}

function parseBody(bodyBytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return undefined;
  }
}

// ── rate limits ───────────────────────────────────────────────────────────

/** Fixed hourly window; one atomic upsert per hit. True while under `limit`. */
async function underLimit(env, key, limit, now) {
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) " +
      "ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, core.windowStart(now))
    .first();
  return (row?.count ?? 1) <= limit;
}

async function ipKey(request, kind) {
  // Hashed: the relay keeps no client IPs.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return `${kind}:${(await core.sha256Hex(ip)).slice(0, 32)}`;
}

// ── auth ──────────────────────────────────────────────────────────────────

/**
 * Verify a signed request. `allowed` lists which kinds may call ("instance",
 * "device"). → { ok: true, who, id, row } or { ok: false, response }.
 */
async function authenticate(ctx, allowed) {
  const h = core.readAuthHeaders(ctx.request.headers);
  const deny = (error = "unauthorized") => ({ ok: false, response: err(401, error) });
  if (h.error) return deny(h.error);
  if (!allowed.includes(h.who)) return deny();
  if (!core.checkTimestamp(h.timestamp, ctx.now)) return deny("stale_timestamp");
  const row =
    h.who === "instance"
      ? await ctx.env.DB.prepare("SELECT id, secret FROM instances WHERE id = ?1").bind(h.id).first()
      : await ctx.env.DB.prepare("SELECT * FROM devices WHERE id = ?1").bind(h.id).first();
  // Same answer for an unknown id and a bad signature.
  if (!row) return deny();
  const good = await core.verifySignature({
    secret: row.secret,
    method: ctx.method,
    path: ctx.path,
    timestamp: h.timestamp,
    bodyBytes: ctx.bodyBytes,
    signature: h.signature,
  });
  if (!good) return deny();
  return { ok: true, who: h.who, id: h.id, row };
}

// ── handlers ──────────────────────────────────────────────────────────────

async function createInstance({ request, env, now }) {
  if (!(await underLimit(env, await ipKey(request, "instances"), core.LIMITS.instancesPerIpPerHour, now))) return err(429, "rate_limited");
  const id = core.newId("in");
  const secret = core.newSecret();
  // Stored as issued: verifying an HMAC needs the key itself (docs/push-relay.md § Storage).
  await env.DB.prepare("INSERT INTO instances (id, secret, created_at) VALUES (?1, ?2, ?3)").bind(id, secret, now).run();
  console.log(`[push-relay] instance ${short(id)} created`);
  return json(201, { instance_id: id, instance_secret: secret });
}

async function createPairing(ctx) {
  const auth = await authenticate(ctx, ["instance"]);
  if (!auth.ok) return auth.response;
  const v = core.validatePairing(parseBody(ctx.bodyBytes), ctx.now);
  if (!v.ok) return err(400, v.error, v.message);
  const { env, now } = ctx;
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM pairings WHERE instance_id = ?1 AND expires_at > ?2")
    .bind(auth.id, now)
    .first();
  if ((active?.n || 0) >= core.MAX_ACTIVE_PAIRINGS) return err(429, "too_many_pairings");
  try {
    await env.DB.prepare("INSERT INTO pairings (token_hash, instance_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(v.value.token_hash, auth.id, v.value.expires_at, now)
      .run();
  } catch {
    return err(409, "duplicate_pairing");
  }
  return json(201, { expires_at: v.value.expires_at });
}

async function registerDevice(ctx) {
  const { request, env, now } = ctx;
  if (!(await underLimit(env, await ipKey(request, "devices"), core.LIMITS.deviceRegistrationsPerIpPerHour, now))) return err(429, "rate_limited");
  const v = await core.validateDeviceRegistration(parseBody(ctx.bodyBytes));
  if (!v.ok) return err(400, v.error, v.message);
  const b = v.value;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE instance_id = ?1 AND dead_at IS NULL")
    .bind(b.instance_id)
    .first();
  if ((count?.n || 0) >= core.MAX_DEVICES_PER_INSTANCE) return err(409, "too_many_devices");
  // Consume the pairing token in one statement, so two phones can't share it.
  const tokenHash = await core.sha256Hex(b.pairing_token);
  const consumed = await env.DB.prepare(
    "DELETE FROM pairings WHERE token_hash = ?1 AND instance_id = ?2 AND expires_at > ?3 RETURNING token_hash",
  )
    .bind(tokenHash, b.instance_id, now)
    .first();
  if (!consumed) return err(403, "invalid_pairing");
  const id = core.newId("dv");
  const secret = core.newSecret();
  await env.DB.batch([
    // A reinstall re-pairs with the same APNs token: the old row would double-push.
    env.DB.prepare("DELETE FROM devices WHERE instance_id = ?1 AND apns_token = ?2").bind(b.instance_id, b.apns_token),
    env.DB.prepare(
      "INSERT INTO devices (id, instance_id, secret, apns_token, environment, device_name, public_key, created_at, last_seen_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
    ).bind(id, b.instance_id, secret, b.apns_token, b.environment, b.device_name, b.public_key, now),
  ]);
  console.log(`[push-relay] device ${short(id)} paired to ${short(b.instance_id)}`);
  return json(201, { device_id: id, device_secret: secret });
}

async function updateDevice(ctx, deviceId) {
  const auth = await authenticate(ctx, ["device"]);
  if (!auth.ok) return auth.response;
  if (auth.id !== deviceId) return err(403, "forbidden");
  const v = core.validateDeviceUpdate(parseBody(ctx.bodyBytes));
  if (!v.ok) return err(400, v.error, v.message);
  const next = { apns_token: auth.row.apns_token, environment: auth.row.environment, ...v.value };
  // A new token revives a device APNs had retired.
  await ctx.env.DB.prepare("UPDATE devices SET apns_token = ?1, environment = ?2, last_seen_at = ?3, dead_at = NULL WHERE id = ?4")
    .bind(next.apns_token, next.environment, ctx.now, deviceId)
    .run();
  return json(200, { ok: true });
}

async function deleteDevice(ctx, deviceId) {
  const auth = await authenticate(ctx, ["device", "instance"]);
  if (!auth.ok) return auth.response;
  if (auth.who === "device" && auth.id !== deviceId) return err(403, "forbidden");
  const where = auth.who === "device" ? ["id = ?1", [deviceId]] : ["id = ?1 AND instance_id = ?2", [deviceId, auth.id]];
  const r = await ctx.env.DB.prepare(`DELETE FROM devices WHERE ${where[0]}`).bind(...where[1]).run();
  if (!r.meta?.changes) return err(404, "not_found");
  return json(200, { ok: true });
}

async function listDevices(ctx) {
  const auth = await authenticate(ctx, ["instance"]);
  if (!auth.ok) return auth.response;
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, public_key, device_name, created_at, last_seen_at FROM devices WHERE instance_id = ?1 AND dead_at IS NULL ORDER BY created_at",
  )
    .bind(auth.id)
    .all();
  return json(200, {
    devices: (results || []).map((d) => ({
      device_id: d.id,
      public_key: d.public_key,
      device_name: d.device_name,
      created_at: d.created_at,
      last_seen_at: d.last_seen_at,
    })),
  });
}

async function push(ctx) {
  const auth = await authenticate(ctx, ["instance"]);
  if (!auth.ok) return auth.response;
  const v = core.validatePush(parseBody(ctx.bodyBytes));
  if (!v.ok) return err(v.error === "payload_too_large" ? 413 : 400, v.error, v.message);
  const p = v.value;
  const { env, now } = ctx;
  if (!(await underLimit(env, `push:${auth.id}`, core.LIMITS.pushesPerInstancePerHour, now))) return err(429, "rate_limited");
  const device = await env.DB.prepare("SELECT id, apns_token, environment, dead_at FROM devices WHERE id = ?1 AND instance_id = ?2")
    .bind(p.device_id, auth.id)
    .first();
  if (!device) return err(404, "unknown_device");
  if (device.dead_at) return err(410, "device_gone");

  const payload = JSON.stringify(core.buildApnsPayload(p));
  let r = await sendToApns(env, device, payload, p);
  if (core.isProviderTokenError(r.status, r.reason)) {
    jwtCache.reset();
    r = await sendToApns(env, device, payload, p);
  }
  if (r.status === 200) return json(200, { ok: true, apns_id: r.apnsId || null });
  console.error(`[push-relay] APNs ${r.status} ${r.reason || ""} for ${short(device.id)}`);
  if (core.isDeadToken(r.status, r.reason)) {
    await env.DB.prepare("UPDATE devices SET dead_at = ?1 WHERE id = ?2").bind(now, device.id).run();
    return err(410, "device_gone", r.reason || undefined);
  }
  if (r.status === 429) return err(429, "apns_rate_limited");
  return json(502, { error: "apns_error", apns_status: r.status, reason: r.reason || null });
}

async function sendToApns(env, device, payload, p) {
  const jwt = await jwtCache.get(env);
  let res;
  try {
    res = await fetch(`https://${core.apnsHost(device.environment)}/3/device/${device.apns_token}`, {
      method: "POST",
      headers: core.apnsHeaders({ push_type: p.push_type, priority: p.priority, collapse_id: p.collapse_id, topic: env.APNS_TOPIC, jwt }),
      body: payload,
    });
  } catch {
    return { status: 0, reason: "network" };
  }
  let reason = "";
  if (res.status !== 200) {
    try {
      reason = (await res.json())?.reason || "";
    } catch {}
  }
  return { status: res.status, reason, apnsId: res.headers.get("apns-id") };
}
