"use strict";
// client.cjs — ask the secrets broker (docs/secrets-broker.md) for a read.
// The broker runs as its own user and holds the keys; this side holds none.

const http = require("node:http");
const fs = require("node:fs");

const DEFAULT_SOCK = "/Library/JoriSecrets/run/broker.sock";
const sockPath = () => process.env.JORI_SECRETS_BROKER_SOCK || DEFAULT_SOCK;

/** Exit codes the helpers already use: 5 none, 64 usage, 77 refused, 78 unavailable. */
const EXIT = { not_found: 5, bad_request: 64, denied: 77, rate_limited: 77, unavailable: 78, op_error: 1, error: 1 };

/** Whether a broker socket exists (cheap; does not ask it). */
function present(sock = sockPath()) {
  try { return fs.statSync(sock).isSocket(); } catch { return false; }
}

/** One request. Resolves { ok, value } or { ok:false, code, error }; never rejects. */
function ask(op, fields = {}, { sock = sockPath(), timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ ...fields, op });
    const req = http.request({ socketPath: sock, path: "/v1", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, code: "unavailable", error: "the broker's answer was not JSON" }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", (e) => resolve({ ok: false, code: "unavailable", error: `secrets broker not reachable at ${sock} (${e.code || e.message})` }));
    req.end(body);
  });
}

module.exports = { ask, present, sockPath, EXIT, DEFAULT_SOCK };
