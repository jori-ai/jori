// onboarding/server.mjs — the setup page `jori setup` opens in the browser.
//
// Runs only while setup runs, before any other part of Jori is up, so it
// depends on nothing but this checkout. Listens on 127.0.0.1 only; every
// request must name a loopback Host (no DNS rebinding) and every API call
// must carry the random token that was put in the page's URL.
//
// API (JSON):
//   GET  /api/state             snapshot() + the background jobs' progress
//   POST /api/identity          the "About you" answers (+ telemetry yes/no)
//   POST /api/claude/install    npm install -g @anthropic-ai/claude-code
//   POST /api/claude/login      claude auth login --claudeai
//   POST /api/claude/code       the code Claude shows when its page can't call back
//   POST /api/memory            install/start Ollama and pull the embed model
//   POST /api/service/connect   {id, fields}: test a service's keys, save what works
//   POST /api/service/qr        the WhatsApp pairing QR (SVG)
//   POST /api/google/authorize  the Gmail sign-in (agent/scripts/gmail-auth.mjs)
//   POST /api/pairing           the code the Jori app scans (pairing.mjs)
//   POST /api/try               {since}: has a message from the app arrived, and been answered?
//   POST /api/start             the service, then the starter schedule
//   POST /api/finish            closes the page's server

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as core from "./core.mjs";
import * as services from "./services.mjs";
import { appDistribution, buildPairing, roundTrip } from "./pairing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 100.64.0.0/10, the addresses Tailscale hands out. */
export function isTailnetAddress(addr) {
  const v4 = String(addr || "").replace(/^::ffff:/, "");
  const m = v4.match(/^100\.(\d+)\.\d+\.\d+$/); // lang-regex-ok: an IPv4 address
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export function isLoopback(addr) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(addr || ""));
}

/**
 * tailnetHosts: when set (an always-on Mac or a VM reached over Tailscale),
 * the page also answers to these Host names, from tailnet addresses only.
 * publicHost: a rented server set up from the browser (site/cloud-init.sh):
 * the page also answers to this one Host name, from loopback only, which is
 * where the HTTPS proxy in front of it (Caddy) connects from. The token still
 * guards every request.
 */
export function createSetupServer({ base, token = crypto.randomBytes(18).toString("hex"), onFinish = () => {}, onEvent = () => {}, tailnetHosts = null, publicHost = null } = {}) {
  const jobs = {};             // name → startJob() handle
  const results = {};          // name → last { ok, message }

  const jobView = () => Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, { state: j.state, out: j.out.slice(-600), url: core.firstUrl(j.out) }]));

  async function body(req) {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new Error("too large"); }
    return raw ? JSON.parse(raw) : {};
  }

  const actions = {
    async identity(b) {
      const before = core.currentUse(base);
      const saved = core.writeIdentity(base, b);
      if (b.telemetry === true || b.telemetry === false) core.setEnv(path.join(base, ".env"), "JORI_TELEMETRY", b.telemetry ? "on" : "off");
      onEvent(`saved who you are (${saved.owner_name})`);
      // The team follows the answer the first time it is given, or when it changes.
      let team = null;
      if (saved.use && saved.use !== before) {
        team = await core.applyUse(base, saved.use);
        onEvent(saved.use === "personal" ? "set up the personal assistant" : `set up the team (${team.enabled.length} roles)`);
      }
      return { ok: true, identity: saved, team };
    },
    async "claude/install"() {
      if (jobs.claudeInstall?.state === "running") return { ok: true };
      jobs.claudeInstall = core.startJob("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
      onEvent("installing Claude Code");
      return { ok: true };
    },
    async "claude/login"() {
      const bin = core.findClaude();
      if (!bin) return { ok: false, message: "Claude Code is not installed yet" };
      if (jobs.claudeLogin?.state === "running") return { ok: true };
      // stdin stays open: when the browser can't reach the CLI's local
      // callback, Claude shows a code to paste, which claude/code passes on.
      jobs.claudeLogin = core.startJob(bin, ["auth", "login", "--claudeai"], { stdin: true });
      onEvent("opened the Claude sign-in page");
      return { ok: true };
    },
    async "claude/code"(b) {
      const j = jobs.claudeLogin;
      const code = String(b.code || "").trim();
      if (!j || j.state !== "running" || !j.child?.stdin?.writable) return { ok: false, message: "The sign-in isn't waiting for a code. Press Sign in with Claude again." };
      // lang-regex-ok: checks the shape of a one-time code, not meaning
      if (!code || code.length > 2000 || /\s/.test(code)) return { ok: false, message: "That doesn't look like the code Claude showed. Copy it again." };
      j.child.stdin.write(code + "\n");
      onEvent("passed the sign-in code to Claude Code");
      return { ok: true };
    },
    async memory() {
      if (jobs.memory?.state === "running") return { ok: true };
      // One shell line so the page shows a single progress row; each step is
      // skipped when already done.
      const script = [
        "set -e",
        // Ollama's Mac app may sit in ~/Applications with no `ollama` on PATH
        // (site/install.sh without Homebrew installs it there).
        "APP=; for a in /Applications/Ollama.app \"$HOME/Applications/Ollama.app\"; do [ -d \"$a\" ] && APP=\"$a\"; done",
        "if ! command -v ollama >/dev/null 2>&1 && [ -z \"$APP\" ]; then",
        "  if command -v brew >/dev/null 2>&1; then brew install ollama",
        "  elif [ \"$(uname -s)\" = Darwin ]; then t=$(mktemp -d); curl -fsSL https://ollama.com/download/Ollama-darwin.zip -o \"$t/o.zip\"; mkdir -p \"$HOME/Applications\"; ditto -x -k \"$t/o.zip\" \"$HOME/Applications/\"; APP=\"$HOME/Applications/Ollama.app\"",
        "  elif sudo -n true 2>/dev/null; then curl -fsSL https://ollama.com/install.sh | sudo -n sh",
        "  else echo 'Install Ollama from https://ollama.com, then try again.'; exit 3; fi",
        "fi",
        "if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null; then",
        "  if [ -n \"$APP\" ]; then open -g \"$APP\"; else (command -v brew >/dev/null 2>&1 && brew services start ollama) || (nohup ollama serve >/dev/null 2>&1 &); fi",
        "  for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done",
        "fi",
        // The HTTP API, so no `ollama` command is needed.
        `curl -sf http://127.0.0.1:11434/api/pull -d '{"name":"${core.EMBED_MODEL}","stream":false}' >/dev/null`,
      ].join("\n");
      jobs.memory = core.startJob("/bin/bash", ["-c", script], { env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } });
      onEvent("setting up memory search");
      return { ok: true };
    },
    async "service/connect"(b) {
      const r = await services.connectService(base, String(b.id || ""), b.fields || {});
      results[`service:${b.id}`] = { ok: r.ok, what: r.what || null };
      onEvent(`${b.id}: ${r.ok ? r.what || "connected" : "not connected"}`);
      // A job that waited for this service joins the schedule once Jori runs.
      const svc = services.serviceById(b.id);
      if (r.ok && svc?.jobs?.length && (await core.serviceStatus()).running) {
        r.schedule = await core.installStarterSchedule({ base, connected: await services.connectedIds(base) });
      }
      return r;
    },
    async "service/qr"() {
      return services.whatsappQr();
    },
    async "google/authorize"() {
      const script = path.join(base, "agent", "scripts", "gmail-auth.mjs");
      if (!fs.existsSync(script)) return { ok: false, message: "This checkout has no Gmail sign-in script" };
      if (jobs.googleAuth?.state === "running") return { ok: true };
      jobs.googleAuth = core.startJob(process.execPath, [script]);
      onEvent("opened the Google sign-in page");
      return { ok: true };
    },
    async pairing() {
      return buildPairing(base);
    },
    async try(b) {
      return roundTrip(base, String(b.since || new Date(Date.now() - 10 * 60_000).toISOString()));
    },
    async start() {
      const service = await core.installService({ base });
      results.service = service;
      onEvent(`background service: ${service.message}`);
      if (!service.ok) return { ok: false, service };
      const schedule = await core.installStarterSchedule({ base, connected: await services.connectedIds(base) });
      results.schedule = schedule;
      onEvent(`schedule: ${schedule.message}`);
      return { ok: schedule.ok, service, schedule };
    },
    async finish() {
      setTimeout(onFinish, 300);
      return { ok: true };
    },
  };

  const page = () => fs.readFileSync(path.join(HERE, "page.html"), "utf8").replace("__SETUP_TOKEN__", token);
  if (publicHost && String(token).length < 24) throw new Error("a public setup page needs a token of at least 24 characters");

  const server = http.createServer(async (req, res) => {
    const send = (code, obj, type = "application/json") => {
      res.writeHead(code, {
        "content-type": type === "application/json" ? "application/json; charset=utf-8" : type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(type === "application/json" ? JSON.stringify(obj) : obj);
    };
    try {
      const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
      const peer = req.socket.remoteAddress;
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(host) && isLoopback(peer);
      const viaTailnet = !!tailnetHosts && tailnetHosts.includes(host) && (isTailnetAddress(peer) || isLoopback(peer));
      const viaProxy = !!publicHost && host === String(publicHost).toLowerCase() && isLoopback(peer);
      if (!local && !viaTailnet && !viaProxy) return send(403, { error: "setup answers on this machine, or over Tailscale, only" });
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== token) return send(403, "Open the address `jori setup` printed in Terminal.", "text/plain; charset=utf-8");
        return send(200, page(), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/icon.png") {
        try { return send(200, fs.readFileSync(path.join(base, "site", "icon.png")), "image/png"); } catch { return send(404, { error: "no icon" }); }
      }
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
      if (req.headers["x-setup-token"] !== token) return send(403, { error: "bad token" });
      if (req.method === "GET" && url.pathname === "/api/state") {
        const status = await services.servicesStatus(base);
        const connected = Object.keys(status).filter((k) => status[k].connected);
        const snap = await core.snapshot(base, { connected });
        const sb = services.supabaseSaved(base);
        const catalog = services.SERVICES.map(({ id, name, title, group, switchesOn, cost, steps, fields, qr, manifest, controlPage }) => ({ id, name, title, group, switchesOn, cost, steps, fields, qr: !!qr, manifest: !!manifest, controlPage: controlPage || null, ...status[id] }));
        return send(200, {
          ...snap, jobs: jobView(), results,
          services: catalog,
          slackManifest: JSON.stringify(services.slackManifest(snap.identity.assistant_name || undefined), null, 2),
          googleRedirect: sb.url ? `${sb.url}/auth/v1/callback` : null,
          appRedirect: services.APP_REDIRECT,
          testflightUrl: appDistribution(base).testflightUrl || null,
        });
      }
      const name = url.pathname.slice("/api/".length);
      if (req.method === "POST" && actions[name]) {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(415, { error: "json only" });
        const b = await body(req);
        try { return send(200, await actions[name](b)); } catch (e) { return send(400, { ok: false, message: e.message }); }
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });

  return { server, token, jobs };
}
