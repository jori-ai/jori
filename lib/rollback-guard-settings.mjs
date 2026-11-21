// rollback-guard-settings — the PreToolUse hook block that wires
// bin/rollback-guard (D2, 2026-10-22) and bin/secrets-guard (2026-11-15) into
// a Jori `claude -p` session. The supervisors merge it into the per-session --settings JSON,
// so it binds Jori's own sessions only; the user's interactive sessions are
// untouched. The node binary is pinned to the one running the supervisor, so
// the hook does not depend on the child's PATH.

import path from "node:path";
import { REPO_ROOT as ROOT } from "./root.cjs";

export function gitGuardHooks({ node = process.execPath, root = ROOT } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // lang-regex-ok: POSIX shell single-quote escaping of a file path
  return {
    PreToolUse: [{
      matcher: "Bash",
      hooks: [{ type: "command", command: `${q(node)} ${q(path.join(root, "bin/rollback-guard"))}`, timeout: 60 }],
    }, {
      // The secrets guard rides along with every Jori session that gets the
      // git guard: an agent reading .env / the secrets dirs / `op` / the
      // keychain itself (lib/secrets-guard.mjs, docs/agent-secrets.md).
      matcher: "Bash|Read|Grep|Glob|Edit|Write",
      hooks: [{ type: "command", command: `${q(node)} ${q(path.join(root, "bin/secrets-guard"))}`, timeout: 15 }],
    }],
  };
}
