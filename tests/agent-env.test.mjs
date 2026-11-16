// lib/agent-env.cjs — the environment a claude agent is started with
// (docs/agent-secrets.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function withLocal(config, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-"));
  fs.mkdirSync(path.join(dir, "config"));
  if (config) fs.writeFileSync(path.join(dir, "config", "agent-env.json"), JSON.stringify(config));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, [
    "PLAID_SECRET=p", "OP_SERVICE_ACCOUNT_TOKEN=o", "SUPABASE_SERVICE_ROLE_KEY=s",
    "SLACK_D=cookie", "ICLOUD_APP=pw", "JORI_WIKI_API_KEY=w", "JORI_CRON_CLAUDE_TOKEN=c",
    "SUPABASE_URL=https://x", "JORI_TZ=Etc/UTC", "OLLAMA_URL=http://h",
    "GOG_KEYRING_PASSWORD=g", "JORI_APNS_KEY_ID=k",
  ].join("\n"));
  const prev = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = dir;
  try { return fn({ dir, envFile }); } finally {
    if (prev === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev;
  }
}

const PARENT = {
  PATH: "/usr/bin", HOME: "/Users/u", USER: "u", TMPDIR: "/tmp/",
  PLAID_SECRET: "p", OP_SERVICE_ACCOUNT_TOKEN: "o", SUPABASE_SERVICE_ROLE_KEY: "s",
  SLACK_D: "cookie", ICLOUD_APP: "pw", JORI_WIKI_API_KEY: "w", JORI_CRON_CLAUDE_TOKEN: "c",
  SUPABASE_URL: "https://x", JORI_TZ: "Etc/UTC", OLLAMA_URL: "http://h",
  GOG_KEYRING_PASSWORD: "g", JORI_APNS_KEY_ID: "k", JORI_HOME: "/r",
  CLAUDE_CODE_OAUTH_TOKEN: "max", CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  SOME_RANDOM_API_KEY: "r", TRIAGE_RULES_FILE: "/tmp/rules.md",
};

test("a locked-down agent keeps no secret, including JORI_-prefixed ones", () => {
  withLocal({ lockdown: ["ops-haiku"] }, ({ envFile }) => {
    const { agentEnv } = require("../lib/agent-env.cjs");
    const { env, locked, dropped } = agentEnv("ops-haiku", { parentEnv: PARENT, envPath: envFile });
    assert.equal(locked, true);
    for (const k of ["PLAID_SECRET", "OP_SERVICE_ACCOUNT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
      "SLACK_D", "ICLOUD_APP", "JORI_WIKI_API_KEY", "JORI_CRON_CLAUDE_TOKEN", "SOME_RANDOM_API_KEY"]) {
      assert.equal(k in env, false, `${k} must be dropped`);
    }
    // Never a value in the report.
    assert.ok(dropped.every((d) => Object.keys(d).sort().join() === "name,reason"));
  });
});

test("it keeps what claude and the agent's tools need", () => {
  withLocal({ lockdown: "all" }, ({ envFile }) => {
    const { agentEnv } = require("../lib/agent-env.cjs");
    const { env } = agentEnv("chat", { parentEnv: PARENT, envPath: envFile });
    for (const k of ["PATH", "HOME", "USER", "TMPDIR", "JORI_HOME", "JORI_TZ", "SUPABASE_URL",
      "OLLAMA_URL", "JORI_APNS_KEY_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS",
      "GOG_KEYRING_PASSWORD", "TRIAGE_RULES_FILE"]) {
      assert.equal(env[k], PARENT[k], `${k} must be kept`);
    }
  });
});

test("an agent that is not locked down inherits everything (staged roll-out)", () => {
  withLocal({ lockdown: ["ops-haiku"] }, ({ envFile }) => {
    const { agentEnv } = require("../lib/agent-env.cjs");
    const { env, locked } = agentEnv("chat", { parentEnv: PARENT, envPath: envFile });
    assert.equal(locked, false);
    assert.deepEqual(env, PARENT);
  });
  withLocal(null, ({ envFile }) => {
    const { agentEnv } = require("../lib/agent-env.cjs");
    assert.equal(agentEnv("ops", { parentEnv: PARENT, envPath: envFile }).locked, false);
  });
});

test("keep and strip lists from the installation", () => {
  withLocal({ lockdown: "all", keep: ["SLACK_D"], strip: ["OLLAMA_URL"] }, ({ envFile }) => {
    const { agentEnv } = require("../lib/agent-env.cjs");
    const { env } = agentEnv("ops", { parentEnv: PARENT, envPath: envFile });
    assert.equal(env.SLACK_D, "cookie");
    assert.equal("OLLAMA_URL" in env, false);
  });
});

test("secret shapes", () => {
  const { isSecretShaped } = require("../lib/agent-env.cjs");
  for (const n of ["PLAID_SECRET", "X_TOKEN", "OP_LOGINS_SERVICE_ACCOUNT_TOKEN", "TYPESAFE_API_KEY",
    "SMTP2GO_API_KEY", "RESEND_API_KEY_SECOND", "ICLOUD_APP_PASSWORD", "SLACK_XOXC", "SLACK_D_COOKIE", "AWS_SECRET_ACCESS_KEY"]) {
    assert.equal(isSecretShaped(n), true, n);
  }
  for (const n of ["PATH", "JORI_APNS_KEY_ID", "GMAIL_OAUTH_CLIENT_ID", "SUPABASE_URL", "JORI_TZ"]) {
    assert.equal(isSecretShaped(n), false, n);
  }
});

test("the bash helper hands the fork the filtered set, and nothing when not locked", () => {
  withLocal({ lockdown: ["forks"] }, ({ dir }) => {
    const script = `source "${ROOT}/agent/scripts/lib/agent-env.sh"; jori_agent_env_cmd forks; ` +
      `\${AGENT_ENV_CMD[@]+"\${AGENT_ENV_CMD[@]}"} /usr/bin/env`;
    const r = spawnSync("/bin/bash", ["-c", script], {
      env: { PATH: process.env.PATH, HOME: os.homedir(), JORI_LOCAL_DIR: dir, PLAID_SECRET: "p", GOG_KEYRING_PASSWORD: "g" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /PLAID_SECRET/);
    assert.match(r.stdout, /GOG_KEYRING_PASSWORD=g/);
  });
  withLocal({ lockdown: [] }, ({ dir }) => {
    const script = `source "${ROOT}/agent/scripts/lib/agent-env.sh"; jori_agent_env_cmd forks; ` +
      `\${AGENT_ENV_CMD[@]+"\${AGENT_ENV_CMD[@]}"} /usr/bin/env`;
    const r = spawnSync("/bin/bash", ["-c", script], {
      env: { PATH: process.env.PATH, HOME: os.homedir(), JORI_LOCAL_DIR: dir, PLAID_SECRET: "p" },
      encoding: "utf8",
    });
    assert.match(r.stdout, /PLAID_SECRET=p/);
  });
});
