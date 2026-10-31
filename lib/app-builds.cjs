// app-builds — where this installation's companion app builds run.
//
// The owner (2026-10-31): "where to run builds should be a configurable option
// in jori". Before this the release procedure said "dispatch the
// installation's TestFlight workflow" and left every agent to work out which
// repo and workflow that meant. One got it wrong: it dispatched jori-ai/jori's
// own workflows, which have no runner, and both builds sat queued.
//
// Config: agent/local/config/app-builds.json (lib/instance.cjs localConfig),
// one target per platform:
//
//   {
//     "ios":   { "repo": "owner/name", "workflow": "file.yml", "ref": "main",
//                "inputs": { "kernel_ref": "install" } },
//     "macos": { ... }
//   }
//
// A platform you leave out keeps the kernel default: the shipped workflows in
// this repo (.github/workflows/{ios,macos}-testflight.yml on `install`), which
// need a self-hosted runner labelled [self-hosted, macos, ios] (see
// docs/dependencies.md). A platform set to `false` is not built.
// `inputs` are passed as workflow_dispatch inputs (`gh workflow run -f k=v`).
//
// Read by bin/app-build, the one way to start an app build.

const { localConfig } = require("./instance.cjs");

const PLATFORMS = ["ios", "macos"];

const DEFAULTS = {
  ios: { repo: "jori-ai/jori", workflow: "ios-testflight.yml", ref: "install", inputs: {} },
  macos: { repo: "jori-ai/jori", workflow: "macos-testflight.yml", ref: "install", inputs: {} },
};

/** The resolved target per platform: {repo, workflow, ref, inputs} or null (disabled). */
function buildTargets(cfg = localConfig("app-builds", {})) {
  const out = {};
  for (const p of PLATFORMS) {
    const v = cfg[p];
    if (v === false) { out[p] = null; continue; }
    const t = { ...DEFAULTS[p], ...(v && typeof v === "object" ? v : {}) };
    t.inputs = { ...(t.inputs || {}) };
    for (const k of ["repo", "workflow", "ref"]) {
      if (typeof t[k] !== "string" || !t[k].trim()) throw new Error(`app-builds: ${p}.${k} must be a non-empty string`);
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(t.repo)) throw new Error(`app-builds: ${p}.repo must be owner/name (got ${t.repo})`);
    out[p] = t;
  }
  return out;
}

/** argv for `gh` that dispatches one target. `overrides` are extra inputs. */
function dispatchArgs(t, overrides = {}) {
  const args = ["workflow", "run", t.workflow, "-R", t.repo, "--ref", t.ref];
  for (const [k, v] of Object.entries({ ...t.inputs, ...overrides })) {
    if (v == null || v === "") continue;
    args.push("-f", `${k}=${v}`);
  }
  return args;
}

/** The run id in `gh workflow run`'s output (it prints the run URL), or null. */
function runIdFrom(stdout) {
  const m = String(stdout || "").match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

module.exports = { PLATFORMS, DEFAULTS, buildTargets, dispatchArgs, runIdFrom };
