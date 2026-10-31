// The off-box heartbeat watchdog: two scheduled Cloud Functions that watch the
// host's beats in a Firebase Realtime Database and alert by email and APNs push
// when they go stale. It runs in Google's cloud, so it is the one monitor that
// survives a full-host wedge (system/architecture.md § heartbeat-watchdog).
//
// The writers are on the host: heartbeat-sender.sh (/heartbeat/latest, every
// 2 min) and bin/minibeat (/heartbeat/minibeat, every 30 s).
//
// Every per-installation value is a deploy-time parameter: functions/.env,
// which `bin/heartbeat-watchdog-env --write` renders from the installation's
// own config (agent/local/instance.json, config/heartbeat.json,
// config/apns.json), and the installation's functions/.env.<project id> for
// how the alerts word things. Secrets are Secret Manager secrets bound to the
// functions. Deploying is documented in bin/heartbeat-watchdog-env.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const http2 = require("node:http2");
const crypto = require("node:crypto");

// ── deploy-time parameters (functions/.env) ──
const DATABASE_URL = defineString("HEARTBEAT_DATABASE_URL", { description: "the Realtime Database the host beats into, https://<db>.firebaseio.com" });
const ALERT_EMAIL = defineString("ALERT_EMAIL", { description: "the Gmail account that sends the alerts and receives them (its app password is the GMAIL_APP_PASSWORD secret)" });
const SENDER_NAME = defineString("ALERT_SENDER_NAME", { default: "Jori monitor" });
// How the alerts name the host. Mail rules can key on the subjects, so an
// installation keeps its own wording here.
const HOST_NAME = defineString("HOST_NAME", { default: "the host" });
const HEARTBEAT_HOST_NAME = defineString("HEARTBEAT_HOST_NAME", { default: "" }); // checkHeartbeat's subjects; "" = HOST_NAME
const ROUTER_LABEL = defineString("ROUTER_LABEL", { default: "the router" });
const OUT_OF_BAND_CHECKS = defineString("OUT_OF_BAND_CHECKS", { default: "" }); // where to look while the host is down; "" = no line
const OWNER_TZ = defineString("OWNER_TZ", { default: "UTC" });
const APNS_TEAM_ID = defineString("APNS_TEAM_ID", { default: "" });
const APNS_KEY_ID = defineString("APNS_KEY_ID", { default: "" });
const APNS_BUNDLE_ID = defineString("APNS_BUNDLE_ID", { default: "" });
// Supabase (device_tokens table), read with the service-role key: RLS keeps
// device_tokens off the anon role.
const SUPABASE_URL = defineString("SUPABASE_URL", { default: "" });

// ── secrets (Secret Manager) ──
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const APNS_KEY_P8 = defineSecret("APNS_KEY_P8"); // .p8 signing key contents
const SUPABASE_SERVICE_ROLE_KEY = defineSecret("SUPABASE_SERVICE_ROLE_KEY");

// heartbeat-sender.sh posts every 120 s; 600 s is ~5 missed beats of margin.
// A 300 s threshold (~2.5 beats) was tripped by ordinary Cloud Scheduler and
// network jitter with no real outage behind it.
const STALE_THRESHOLD_SEC = 600;
const ALERT_COOLDOWN_SEC = 1800; // 30 min between repeat alerts

// Fast liveness. heartbeat-sender's 10-minute threshold suits its heavy
// 2-minute payload, but a host going down should be known within minutes.
// bin/minibeat writes a server-timestamped beat to /heartbeat/minibeat every
// 30 s (nothing else in it, so nothing in it can break); checkMinibeat reads
// it every minute. 180 s = 6 missed beats of margin. Worst-case detection
// ~4 min. One alert per outage, one recovery email after.
const MINIBEAT_STALE_SEC = 180;

const APNS_HOST = "api.push.apple.com";

let _db = null;
function db() {
  if (!_db) {
    admin.initializeApp({ databaseURL: DATABASE_URL.value() });
    _db = admin.database();
  }
  return _db;
}
const heartbeatHostName = () => HEARTBEAT_HOST_NAME.value() || HOST_NAME.value();

async function sendEmail(appPassword, subject, body) {
  const user = ALERT_EMAIL.value();
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: appPassword },
  });
  await transporter.sendMail({
    from: `${SENDER_NAME.value()} <${user}>`,
    to: user,
    subject,
    text: body,
  });
}

function derToRaw(derSig) {
  let offset = 2;
  if (derSig[1] & 0x80) offset += (derSig[1] & 0x7f);
  offset += 1;
  const rLen = derSig[offset++];
  const r = derSig.subarray(offset, offset + rLen);
  offset += rLen + 1;
  const sLen = derSig[offset++];
  const s = derSig.subarray(offset, offset + sLen);
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - Math.min(r.length, 32), Math.max(r.length - 32, 0));
  s.copy(raw, 64 - Math.min(s.length, 32), Math.max(s.length - 32, 0));
  return raw;
}

function createApnsJwt(p8Key) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID.value() })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: APNS_TEAM_ID.value(), iat: now })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const key = crypto.createPrivateKey(p8Key);
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const rawSig = derToRaw(sign.sign(key));
  return `${signingInput}.${rawSig.toString("base64url")}`;
}

function sendOne(jwt, deviceToken, payloadString) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${APNS_HOST}`);
    client.on("error", () => { try { client.close(); } catch {} resolve({ status: 0 }); });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_BUNDLE_ID.value(),
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0;
    req.on("response", (h) => { status = Number(h[":status"]) || 0; });
    req.on("end", () => { client.close(); resolve({ status }); });
    req.on("error", () => { try { client.close(); } catch {} resolve({ status: 0 }); });
    req.write(payloadString);
    req.end();
  });
}

async function fetchDeviceTokens() {
  const key = SUPABASE_SERVICE_ROLE_KEY.value();
  const res = await fetch(`${SUPABASE_URL.value()}/rest/v1/device_tokens?select=token`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => r.token).filter(Boolean);
}

// System alert push (time-sensitive so it pierces Focus; no badge for infra).
async function sendPush(p8Key, title, body) {
  if (!APNS_TEAM_ID.value() || !APNS_KEY_ID.value() || !APNS_BUNDLE_ID.value() || !SUPABASE_URL.value()) {
    console.error("[watchdog] push not configured (APNS_* / SUPABASE_URL params), email only");
    return;
  }
  const tokens = await fetchDeviceTokens();
  if (tokens.length === 0) { console.error("[watchdog] no device tokens"); return; }
  const payloadString = JSON.stringify({
    aps: { alert: { title, body }, sound: "default", "interruption-level": "time-sensitive" },
  });
  const jwt = createApnsJwt(p8Key);
  let ok = 0;
  for (const token of tokens) {
    const { status } = await sendOne(jwt, token, payloadString);
    if (status === 200) ok++;
    else console.error(`[watchdog] apns status ${status} for ${token.slice(0, 8)}…`);
  }
  console.log(`[watchdog] push sent to ${ok}/${tokens.length} devices`);
}

// Fire both channels independently — a failure in one must not suppress the other.
async function alert(subject, body, pushTitle, pushBody) {
  const results = await Promise.allSettled([
    sendEmail(GMAIL_APP_PASSWORD.value(), subject, body),
    sendPush(APNS_KEY_P8.value(), pushTitle, pushBody),
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`[watchdog] ${i === 0 ? "email" : "push"} failed: ${r.reason}`);
  });
}

// Runs every 5 minutes
exports.checkHeartbeat = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "us-central1",
    secrets: [GMAIL_APP_PASSWORD, APNS_KEY_P8, SUPABASE_SERVICE_ROLE_KEY],
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async () => {
    const store = db();
    const host = heartbeatHostName();
    const snap = await store.ref("heartbeat/latest").once("value");
    const data = snap.val();

    if (!data || !data.timestamp) {
      await alert(
        `🔴 ${host}: No heartbeat data`,
        "No heartbeat data found in Firebase. Heartbeat sender may have never run.",
        `🔴 ${host} — no heartbeat`,
        "No heartbeat data in Firebase. Sender may never have run."
      );
      return;
    }

    const heartbeatTime = new Date(data.timestamp).getTime();
    const now = Date.now();
    const ageSec = Math.floor((now - heartbeatTime) / 1000);
    const ageMin = Math.floor(ageSec / 60);

    if (ageSec <= STALE_THRESHOLD_SEC) {
      // Heartbeat is fresh — clear any previous alert state
      await store.ref("heartbeat/alert_state").remove();
      return;
    }

    // The fast minibeat check has already said the host is down — the slow
    // check saying it again 6 minutes later is noise.
    const fastSnap = await store.ref("heartbeat/minibeat_alert").once("value");
    if (fastSnap.exists()) return;

    // Heartbeat is stale — check cooldown before alerting
    const alertSnap = await store.ref("heartbeat/alert_state").once("value");
    const alertState = alertSnap.val();

    if (alertState && alertState.last_alert_at) {
      const lastAlert = new Date(alertState.last_alert_at).getTime();
      if ((now - lastAlert) / 1000 < ALERT_COOLDOWN_SEC) {
        return; // Still in cooldown
      }
    }

    // Build alert message
    const services = [];
    if (data.chat_agent_running === false) services.push("chat agent DOWN");
    if (data.ops_agent_running === false) services.push("ops agent DOWN");
    if (data.cloudflared_running === false) services.push("cloudflared tunnel DOWN");
    if (data.tailscale_ok === false) services.push("tailscale DOWN");
    if (data.internet_ok === false) services.push("internet DOWN");

    const serviceInfo = services.length > 0 ? `\nLast known issues: ${services.join(", ")}` : "";
    const body = `${host} has not sent a heartbeat in ${ageMin} minutes.\n\nLast heartbeat: ${data.timestamp}${serviceInfo}\n\nThe server may be offline or the heartbeat sender crashed.\n\nLatest beat: ${DATABASE_URL.value()}/heartbeat/latest.json`;
    const pushBody = `No heartbeat in ${ageMin}m.${services.length ? " " + services.join(", ") + "." : ""} Server may be offline.`;

    await alert(
      `🔴 ${host} UNREACHABLE — ${ageMin}m since last heartbeat`,
      body,
      `🔴 ${host} UNREACHABLE — ${ageMin}m`,
      pushBody
    );

    await store.ref("heartbeat/alert_state").set({
      last_alert_at: new Date().toISOString(),
      stale_since: data.timestamp,
      age_min: ageMin,
    });
  }
);

function localTime(ms) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: OWNER_TZ.value(), dateStyle: "medium", timeStyle: "short",
  });
}

// Fast "is the host alive" check — see MINIBEAT_STALE_SEC. A stale beat means
// the host, its router, or the site's internet link is down; this function
// can't tell which, and says so.
exports.checkMinibeat = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "us-central1",
    secrets: [GMAIL_APP_PASSWORD, APNS_KEY_P8, SUPABASE_SERVICE_ROLE_KEY],
    timeoutSeconds: 60,
    memory: "128MiB",
  },
  async () => {
    const store = db();
    const host = HOST_NAME.value();
    const Host = host.charAt(0).toUpperCase() + host.slice(1);
    const beat = (await store.ref("heartbeat/minibeat").once("value")).val();
    // Never beaten yet (fresh deploy) — nothing to judge against.
    if (!beat || typeof beat.ts !== "number") return;

    const now = Date.now();
    const ageSec = Math.floor((now - beat.ts) / 1000);
    const alertRef = store.ref("heartbeat/minibeat_alert");
    const open = (await alertRef.once("value")).val();

    if (ageSec <= MINIBEAT_STALE_SEC) {
      if (open) {
        const downMin = Math.max(1, Math.round((beat.ts - open.last_beat) / 60000));
        await alert(
          `🟢 ${Host} is back online (down ~${downMin} min)`,
          `${Host} is beating again as of ${localTime(beat.ts)}.\n\n` +
            `Last beat before the outage: ${localTime(open.last_beat)}\n` +
            `Outage length: about ${downMin} minutes.\n\n` +
            `Any device alerts that were queued during the outage will follow from the host itself.`,
          `🟢 ${Host} back online`,
          `Back after ~${downMin} min.`
        );
        await alertRef.remove();
      }
      return;
    }

    if (open) return; // one alert per outage; the recovery email closes it

    const ageMin = Math.floor(ageSec / 60);
    const checks = OUT_OF_BAND_CHECKS.value();
    await alert(
      `🔴 ${Host} OFFLINE — no beat for ${ageMin} min`,
      `${Host} has not checked in for ${ageMin} minutes (last beat ${localTime(beat.ts)}).\n\n` +
        `It beats every 30 seconds, so this is a real outage, not jitter. Likely causes, most to least common:\n` +
        `  - the site's internet is down (modem / ISP)\n` +
        `  - ${ROUTER_LABEL.value()} is down — the whole site would be offline\n` +
        `  - the host itself is off, asleep, or hung\n\n` +
        `While it's down, nothing it watches can be monitored. You'll get a recovery email when it comes back.` +
        (checks ? `\nOut-of-band checks: ${checks}.` : ""),
      `🔴 ${Host} OFFLINE`,
      `No beat for ${ageMin} min. Internet, router or the host is down.`
    );
    await alertRef.set({ alerted_at: now, last_beat: beat.ts });
  }
);
