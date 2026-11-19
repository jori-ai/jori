// onboarding/services.mjs — the outside services Jori can use, each with what
// it switches on, what it costs, how to set it up, and a connect step that
// tests what the person typed before saving it.
//
// One table for every place that asks for keys: the setup page's Connect step
// (lib/onboarding/server.mjs), the control room (lib/control/actions.mjs
// `service.connect`) and `jori init`. Each connect follows the pattern of
// `email.setup`: run the checks, save only the keys that worked, return the
// list of checks; a key is never echoed back. Spec: the per-user onboarding
// spec, Phase 1 (docs/per-user-onboarding-spec.md in the overlay).
//
// Nothing here runs a shell string built from input: commands are execFile
// with fixed argv.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readDotEnv, setEnv, findOnPath, instancePath } from "./core.mjs";

const SUPABASE_API = "https://api.supabase.com/v1";
const SLACK_API = "https://slack.com/api";
const JEV_ENDPOINT = process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
// The shared Jori app returns from Google sign-in to <scheme>://auth-callback
// (apps/companion SupabaseManager.redirectURL; Install.urlScheme, default "jori").
export const APP_REDIRECT = `${process.env.JORI_APP_URL_SCHEME || "jori"}://auth-callback`; // control-scan-ok: the shared app's default URL scheme

// ── the table ───────────────────────────────────────────────────────────────

export const SERVICES = [
  {
    id: "supabase",
    name: "Supabase",
    title: "Supabase: my online home base",
    group: "app",
    switchesOn: "Chat and notifications in the Jori app, history that survives restarts, and your memory site staying up when this computer is off.", // control-scan-ok: the software's name
    cost: "Free: 2 projects, 500 MB",
    steps: [
      "Create a free project at supabase.com. Pick the region closest to you.",
      "Settings → API: copy the project URL and both keys below.",
      "Account → Access Tokens: make one so I can create my tables and turn on app sign-in. Without it I show you the SQL to paste.",
      "App sign-in uses Google, so connect Google too.",
    ],
    fields: [
      { key: "url", label: "Project URL", placeholder: "https://abcd1234.supabase.co" },
      { key: "anon_key", label: "Public (anon) key" },
      { key: "service_role_key", label: "Secret (service role) key", secret: true },
      { key: "access_token", label: "Access token", secret: true, optional: true },
    ],
  },
  {
    id: "google",
    name: "Google",
    title: "Google: Gmail, Calendar, Tasks",
    group: "optional",
    switchesOn: "Inbox sorting, urgent-mail alerts, your day in the morning brief, “put Alice on Tuesday at 2”, and signing in to the app.",
    cost: "Free",
    steps: [
      "console.cloud.google.com: create a project and turn on the Gmail, Calendar and Tasks APIs.",
      "OAuth consent screen: External, then set it to In production (Testing logs you out every 7 days). Google will call it unverified: it’s your own app.",
      "Credentials → OAuth client ID, type Desktop app: paste its ID and secret below.",
      "For app sign-in, a second OAuth client of type Web application, with the redirect URI shown below.",
    ],
    fields: [
      { key: "client_id", label: "Desktop client ID", placeholder: "….apps.googleusercontent.com" },
      { key: "client_secret", label: "Desktop client secret", secret: true },
      { key: "web_client_id", label: "Web client ID (app sign-in)", optional: true },
      { key: "web_client_secret", label: "Web client secret (app sign-in)", secret: true, optional: true },
      { key: "gcp_project", label: "Project ID", optional: true },
    ],
  },
  {
    id: "tunnel",
    name: "Instant mail",
    title: "Instant mail (Cloudflare Tunnel)",
    group: "optional",
    switchesOn: "Urgent mail reaches you in about a minute instead of within 30.",
    cost: "Free Cloudflare account with a domain on it (a domain is about $10 a year)",
    steps: [
      "Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared).",
      "Copy the token from the install command it shows (the long string after --token).",
      "Add a public hostname, e.g. gmail-push.yourdomain.com, pointing to http://localhost:9090.",
    ],
    fields: [{ key: "token", label: "Tunnel token", secret: true }],
  },
  {
    id: "email",
    name: "My own email address",
    title: "My own email address",
    group: "optional",
    switchesOn: "People can email me directly, and mail I send comes from me, not from you.",
    cost: "A domain on Cloudflare (free routing) plus smtp2go to send (free up to 1,000 a month)",
    steps: ["Set up from the control room’s Email page: it checks Cloudflare and smtp2go before it switches anything."],
    fields: [],
    controlPage: "#email",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    title: "WhatsApp",
    group: "optional",
    switchesOn: "Message me from WhatsApp, and I read your chats for the daily message digest. I never reply as you on my own.",
    cost: "Free. Uses WhatsApp’s linked-devices protocol, which WhatsApp doesn’t officially support.",
    steps: ["On your phone: WhatsApp → Settings → Linked Devices → Link a Device, then scan the code."],
    fields: [],
    qr: true,
    jobs: ["message-digest"],
  },
  {
    id: "slack",
    name: "Slack",
    title: "Slack",
    group: "optional",
    switchesOn: "@Jori in your team’s channels: times found, meetings booked, promises recalled, and a digest of what you missed.", // control-scan-ok: the software's name
    cost: "Free",
    steps: [
      "api.slack.com/apps → Create New App → From a manifest, and paste the manifest shown below.",
      "Install to your workspace, then copy the User OAuth Token (xoxp-…).",
      "Basic Information → App-Level Tokens: make one with connections:write and copy it (xapp-…).",
    ],
    fields: [
      { key: "user_token", label: "User OAuth token", secret: true, placeholder: "xoxp-…" },
      { key: "app_token", label: "App-level token", secret: true, placeholder: "xapp-…" },
    ],
    manifest: true,
    jobs: ["message-digest"],
  },
  {
    id: "jev",
    name: "Jev",
    title: "Jev: sharper quick decisions",
    group: "optional",
    switchesOn: "A dedicated model for my small yes/no calls, like whether a message is worth interrupting you. Without it, Claude makes those calls.",
    cost: "Prepaid TypeSafe account, about $0.0004 a decision",
    steps: ["Make an account at typesafe.ai, add credit, and copy an API key."],
    fields: [{ key: "api_key", label: "TypeSafe API key", secret: true }],
  },
];

export const serviceById = (id) => SERVICES.find((s) => s.id === id) || null;

/** The Slack app manifest the Slack card offers (scopes as docs/slack-channel-setup.md lists them). */
export function slackManifest(name = "Jori") { // control-scan-ok: the software's name
  return {
    display_information: { name },
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: {
      scopes: { user: ["channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read", "mpim:history", "mpim:read", "users:read", "chat:write"] },
    },
    settings: {
      event_subscriptions: { user_events: ["message.channels", "message.groups", "message.im", "message.mpim"] },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// ── files ───────────────────────────────────────────────────────────────────

const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const configFile = (base, name) => path.join(base, "agent", "local", "config", `${name}.json`);
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
function setInstance(base, values) {
  const f = instancePath(base);
  writeJson(f, { ...readJson(f, {}), ...values });
}
const envOf = (base) => readDotEnv(path.join(base, ".env"));
const save = (base, key, value) => { setEnv(path.join(base, ".env"), key, value); process.env[key] = value; };

/** Where the Supabase project is, from what this installation saved. */
export function supabaseSaved(base) {
  const I = readJson(instancePath(base), {});
  const E = envOf(base);
  const ref = E.JORI_SUPABASE_PROJECT || I.supabase_project || "";
  const url = E.SUPABASE_URL || (ref ? `https://${ref}.supabase.co` : "");
  return { ref, url, anonKey: readJson(configFile(base, "supabase"), {}).anon_key || "", serviceKey: E.SUPABASE_SERVICE_ROLE_KEY || "", token: E.SUPABASE_ACCESS_TOKEN || "" };
}

/** <ref> from https://<ref>.supabase.co, or null for a custom domain. */
export function refFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h.endsWith(".supabase.co") ? h.slice(0, -".supabase.co".length) : null;
  } catch { return null; }
}

const check = (name, ok, detail) => ({ name, ok: !!ok, detail });

// ── status ──────────────────────────────────────────────────────────────────

async function localJson(port, p, fetchFn) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Every service: connected or not, in a sentence. Cheap: files and local health only. */
export async function servicesStatus(base, { fetchFn = fetch } = {}) {
  const E = envOf(base);
  const I = readJson(instancePath(base), {});
  const sb = supabaseSaved(base);
  const out = {};
  out.supabase = sb.ref && sb.serviceKey && sb.anonKey
    ? { connected: true, detail: `Project ${sb.ref}` }
    : { connected: false, detail: "Not connected: the phone app needs it" };
  const gmailToken = fs.existsSync(path.join(base, "credentials", "gmail-push-token.json"));
  const gog = !!findOnPath("gog");
  out.google = E.GMAIL_OAUTH_CLIENT_ID && gmailToken
    ? { connected: true, detail: `Gmail authorized${gog ? "" : ". Calendar and Tasks also need the gog CLI (github.com/steipete/gogcli)."}` }
    : E.GMAIL_OAUTH_CLIENT_ID ? { connected: false, detail: "Client saved; sign in with Google to finish" } : { connected: false, detail: "Not connected" };
  out.tunnel = E.JORI_TUNNEL_TOKEN ? { connected: true, detail: "Tunnel token saved; the tunnel runs with Jori" } : { connected: false, detail: "Not connected: new mail is checked every 30 minutes" };
  out.email = I.agent_email ? { connected: true, detail: I.agent_email } : { connected: false, detail: "Not set: mail goes out from your own address" };
  const wa = await localJson(9100, "/health", fetchFn);
  out.whatsapp = wa?.ok ? { connected: true, detail: `Linked${wa.host_name ? ` as ${wa.host_name}` : ""}` } : { connected: false, detail: wa ? "Waiting for you to scan the code" : "Not linked" };
  out.slack = E.SLACK_USER_TOKEN && E.SLACK_APP_TOKEN ? { connected: true, detail: "Tokens saved" } : { connected: false, detail: "Not connected" };
  out.jev = E.TYPESAFE_API_KEY ? { connected: true, detail: "Key saved" } : { connected: false, detail: "Not connected: Claude makes the quick calls" };
  return out;
}

/** Ids of the connected services, for jobs that wait on one. */
export async function connectedIds(base, opts) {
  const st = await servicesStatus(base, opts);
  return Object.keys(st).filter((k) => st[k].connected);
}

// ── connect ─────────────────────────────────────────────────────────────────

function runNode(base, args, { env = {}, timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: base, env: { ...process.env, ...env }, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";

/** Turn on Google sign-in for the shared app on the Supabase project (Management API). */
export async function configureSupabaseSignIn({ ref, token, clientId, clientSecret, fetchFn = fetch }) {
  const h = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const cur = await fetchFn(`${SUPABASE_API}/projects/${ref}/config/auth`, { headers: h });
  if (!cur.ok) return check("App sign-in turned on", false, `Supabase didn’t let me read the sign-in settings (${cur.status})`);
  const conf = await cur.json().catch(() => ({}));
  const allow = String(conf.uri_allow_list || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.includes(APP_REDIRECT)) allow.push(APP_REDIRECT);
  const r = await fetchFn(`${SUPABASE_API}/projects/${ref}/config/auth`, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ external_google_enabled: true, external_google_client_id: clientId, external_google_secret: clientSecret, uri_allow_list: allow.join(",") }),
  });
  return check("App sign-in turned on", r.ok, r.ok ? `Google sign-in on, returning to ${APP_REDIRECT}` : `Supabase refused the change (${r.status})`);
}

const CONNECT = {
  async supabase(base, f, { fetchFn, owner }) {
    const saved = supabaseSaved(base);
    const url = String(f.url || saved.url || "").trim().replace(/\/+$/, "");
    const anon = String(f.anon_key || saved.anonKey || "").trim();
    const service = String(f.service_role_key || saved.serviceKey || "").trim();
    const token = String(f.access_token || saved.token || "").trim();
    const checks = [];
    if (!/^https:\/\/[^/\s]+$/.test(url)) return { ok: false, checks: [check("Project URL", false, "That isn’t a project URL. It looks like https://abcd1234.supabase.co")] }; // lang-regex-ok: URL syntax
    const ref = refFromUrl(url) || String(f.ref || saved.ref || "").trim();
    if (!ref) return { ok: false, checks: [check("Project", false, "A custom domain: add the project ref too")] };
    const a = await fetchFn(`${url}/auth/v1/settings`, { headers: { apikey: anon } }).catch((e) => ({ ok: false, status: e.message }));
    checks.push(check("Public key works", a.ok, a.ok ? "Yes" : `Supabase answered ${a.status}`));
    const s = await fetchFn(`${url}/auth/v1/admin/users?per_page=1`, { headers: { apikey: service, Authorization: `Bearer ${service}` } }).catch((e) => ({ ok: false, status: e.message }));
    checks.push(check("Secret key works", s.ok, s.ok ? "Yes" : `Supabase answered ${s.status}`));
    if (!a.ok || !s.ok) return { ok: false, checks };
    save(base, "SUPABASE_SERVICE_ROLE_KEY", service);
    if (refFromUrl(url) !== ref) save(base, "SUPABASE_URL", url);
    setInstance(base, { supabase_project: ref });
    writeJson(configFile(base, "supabase"), { ...readJson(configFile(base, "supabase"), {}), anon_key: anon });

    let tokenOk = false;
    if (token) {
      const t = await fetchFn(`${SUPABASE_API}/projects/${ref}`, { headers: { Authorization: `Bearer ${token}` } }).catch((e) => ({ ok: false, status: e.message }));
      tokenOk = t.ok;
      checks.push(check("Access token works", t.ok, t.ok ? "Yes" : `Supabase answered ${t.status}`));
      if (t.ok) save(base, "SUPABASE_ACCESS_TOKEN", token);
    }
    if (tokenOk) {
      const args = [path.join(base, "bin", "jori-migrate"), "--apply", "--project", ref];
      if (owner) args.push("--allow-user", owner);
      const m = await runNode(base, args, { env: { SUPABASE_ACCESS_TOKEN: token } });
      checks.push(check("My tables", m.ok, m.ok ? `Created or already there${owner ? `; ${owner} may sign in to the app` : ""}` : `jori-migrate stopped: ${lastLine(m.stderr || m.stdout)}`));
      const E = envOf(base);
      if (E.GOOGLE_SIGNIN_CLIENT_ID && E.GOOGLE_SIGNIN_CLIENT_SECRET) {
        checks.push(await configureSupabaseSignIn({ ref, token, clientId: E.GOOGLE_SIGNIN_CLIENT_ID, clientSecret: E.GOOGLE_SIGNIN_CLIENT_SECRET, fetchFn }));
      } else {
        checks.push(check("App sign-in turned on", false, "Connect Google with a Web client and I’ll turn it on"));
      }
    } else {
      checks.push(check("My tables", false, "No access token: run `bin/jori-migrate --print` and paste the SQL into the dashboard’s SQL editor, or add a token and press Test again"));
    }
    return { ok: true, checks, what: `Supabase project ${ref} connected` };
  },

  async google(base, f, { fetchFn }) {
    const E = envOf(base);
    const id = String(f.client_id || E.GMAIL_OAUTH_CLIENT_ID || "").trim();
    const secret = String(f.client_secret || E.GMAIL_OAUTH_CLIENT_SECRET || "").trim();
    const webId = String(f.web_client_id || E.GOOGLE_SIGNIN_CLIENT_ID || "").trim();
    const webSecret = String(f.web_client_secret || E.GOOGLE_SIGNIN_CLIENT_SECRET || "").trim();
    const isClient = (s) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(s); // lang-regex-ok: OAuth client id syntax
    const checks = [check("Desktop client", isClient(id) && secret, isClient(id) && secret ? "Saved" : "Paste the Desktop client’s ID (it ends in .apps.googleusercontent.com) and secret")];
    if (!(isClient(id) && secret)) return { ok: false, checks };
    save(base, "GMAIL_OAUTH_CLIENT_ID", id);
    save(base, "GMAIL_OAUTH_CLIENT_SECRET", secret);
    if (f.gcp_project) setInstance(base, { gcp_project: String(f.gcp_project).trim() });
    if (webId || webSecret) {
      const ok = isClient(webId) && !!webSecret;
      checks.push(check("Web client for app sign-in", ok, ok ? "Saved" : "Needs both the Web client’s ID and secret"));
      if (ok) {
        save(base, "GOOGLE_SIGNIN_CLIENT_ID", webId);
        save(base, "GOOGLE_SIGNIN_CLIENT_SECRET", webSecret);
        const sb = supabaseSaved(base);
        if (sb.ref && sb.token) checks.push(await configureSupabaseSignIn({ ref: sb.ref, token: sb.token, clientId: webId, clientSecret: webSecret, fetchFn }));
      }
    }
    checks.push(check("Calendar and Tasks tool", !!findOnPath("gog"), findOnPath("gog") ? "gog is installed" : "Install the gog CLI (github.com/steipete/gogcli), then `gog auth add <your email> --services gmail,calendar,tasks`"));
    return { ok: true, checks, what: "Google client saved", next: "authorize" };
  },

  async tunnel(base, f) {
    const token = String(f.token || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(Buffer.from(token, "base64").toString("utf8")); } catch { /* not a token */ }
    const ok = !!(parsed && parsed.a && parsed.t && parsed.s);
    const checks = [check("Tunnel token", ok, ok ? "Looks right" : "That isn’t a tunnel token: copy the long string after --token")];
    if (!ok) return { ok: false, checks };
    const bin = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"].find((p) => fs.existsSync(p)) || findOnPath("cloudflared");
    checks.push(check("cloudflared installed", !!bin, bin ? bin : process.platform === "darwin" ? "Run `brew install cloudflared`" : "Install cloudflared from Cloudflare’s package repository"));
    save(base, "JORI_TUNNEL_TOKEN", token);
    checks.push(check("Starts with Jori", true, "The tunnel starts the next time Jori restarts"));
    return { ok: true, checks, what: "Tunnel token saved" };
  },

  async slack(base, f, { fetchFn }) {
    const user = String(f.user_token || "").trim();
    const app = String(f.app_token || "").trim();
    const checks = [];
    const u = await fetchFn(`${SLACK_API}/auth.test`, { method: "POST", headers: { Authorization: `Bearer ${user}` } }).then((r) => r.json()).catch(() => ({ ok: false, error: "no answer" }));
    checks.push(check("User token works", u.ok, u.ok ? `Signed in to ${u.team || "your workspace"} as ${u.user || "you"}` : `Slack said: ${u.error}`));
    const c = await fetchFn(`${SLACK_API}/apps.connections.open`, { method: "POST", headers: { Authorization: `Bearer ${app}` } }).then((r) => r.json()).catch(() => ({ ok: false, error: "no answer" }));
    checks.push(check("App token works", c.ok, c.ok ? "Socket Mode connects" : `Slack said: ${c.error}`));
    if (!u.ok || !c.ok) return { ok: false, checks };
    save(base, "SLACK_USER_TOKEN", user);
    save(base, "SLACK_APP_TOKEN", app);
    return { ok: true, checks, what: "Slack connected" };
  },

  async jev(base, f, { fetchFn }) {
    const key = String(f.api_key || "").trim();
    const r = await fetchFn(JEV_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" }).catch((e) => ({ ok: false, status: e.message }));
    const ok = !!key && r.status !== 401 && r.status !== 403 && typeof r.status === "number";
    const checks = [check("Key accepted", ok, ok ? "TypeSafe recognised it" : `TypeSafe answered ${r.status}`)];
    if (!ok) return { ok: false, checks };
    save(base, "TYPESAFE_API_KEY", key);
    return { ok: true, checks, what: "Jev key saved" };
  },
};

/** Test and save one service. Returns { ok, checks, what?, next? }; never echoes a key. */
export async function connectService(base, id, fields = {}, { fetchFn = fetch, owner = "" } = {}) {
  const svc = serviceById(id);
  if (!svc) throw new Error(`no such service: ${id}`);
  const fn = CONNECT[id];
  if (!fn) throw new Error(`${svc.name} is set up from the control room`);
  const ownerEmail = owner || readJson(instancePath(base), {}).owner_email || "";
  return fn(base, fields, { fetchFn, owner: ownerEmail });
}

/** The WhatsApp pairing QR as SVG, or { paired }. */
export async function whatsappQr({ fetchFn = fetch } = {}) {
  const j = await localJson(9100, "/qr", fetchFn);
  if (!j) return { ok: false, message: "The WhatsApp channel isn’t running yet. Start Jori first." };
  if (j.paired) return { ok: true, paired: true };
  if (!j.qr) return { ok: true, waiting: true };
  const QR = (await import("qrcode")).default;
  return { ok: true, svg: await QR.toString(j.qr, { type: "svg", margin: 1 }) };
}
