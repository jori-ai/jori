// Search-list arithmetic in .github/scripts/ci-keychain-lock.sh (2026-07-28).
//
// `security list-keychains -d user -s <list>` is a whole-list REPLACE, so every
// caller must read-modify-write global state shared by every runner on the
// host. Two bugs lived in that arithmetic:
//
//   1. `security list-keychains -d user -s $REMAINING` with an EMPTY $REMAINING
//      sets an EMPTY search list rather than doing nothing — evicting
//      login.keychain-db, where the Max OAuth token lives, and taking every
//      `claude -p` on the mini auth-down (no API-key fallback by design).
//   2. `grep -v "^$KEYCHAIN$"` treated `.` in the path as a regex wildcard.
//
// `security` is stubbed with a shell function, so these assert the real
// kc_prepend/kc_remove logic without touching the host's actual keychains.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".github/scripts/ci-keychain-lock.sh");

const LOGIN = "/Users/ci/Library/Keychains/login.keychain-db";
const TEMP = "/tmp/runner/_temp/app-signing.keychain-db";
const OTHER = "/tmp/runner2/_temp/build.keychain-db";
const SYSTEM = "/Library/Keychains/System.keychain";

// Apply one operation to a starting list and return the resulting list.
// failRead simulates `security list-keychains` erroring / returning nothing,
// which really happens under concurrent load on a shared runner host.
function apply(op, arg, startList, { failRead = false } = {}) {
  const script = `
    export KC_LOCK="$(mktemp -d)/l.lock"
    export KC_LOGIN_KEYCHAIN=${JSON.stringify(LOGIN)}
    source ${JSON.stringify(SRC)}
    FAKE_LIST=${JSON.stringify(startList)}
    FAIL_READ=${failRead ? 1 : 0}
    security() {
      if [ "$1" = "list-keychains" ] && [ "$4" = "-s" ]; then
        shift 4; FAKE_LIST="$*"; return 0
      fi
      if [ "$1" = "list-keychains" ]; then
        [ "$FAIL_READ" = "1" ] && return 1
        for k in $FAKE_LIST; do echo "    \\"$k\\""; done; return 0
      fi
      return 0
    }
    ${op} ${JSON.stringify(arg)}
    echo "$FAKE_LIST" | xargs
  `;
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

test("kc_prepend puts our keychain first and preserves the rest", () => {
  assert.equal(apply("kc_prepend", TEMP, LOGIN), `${TEMP} ${LOGIN}`);
  assert.equal(apply("kc_prepend", TEMP, `${LOGIN} ${SYSTEM}`), `${TEMP} ${LOGIN} ${SYSTEM}`);
});

test("kc_prepend is idempotent — no duplicate entry on re-run", () => {
  assert.equal(apply("kc_prepend", TEMP, `${TEMP} ${LOGIN}`), `${TEMP} ${LOGIN}`);
});

test("kc_remove drops only our keychain", () => {
  assert.equal(apply("kc_remove", TEMP, `${TEMP} ${LOGIN}`), LOGIN);
  assert.equal(apply("kc_remove", TEMP, `${TEMP} ${LOGIN} ${SYSTEM}`), `${LOGIN} ${SYSTEM}`);
});

test("kc_remove NEVER produces an empty list (the auth-down bug)", () => {
  // Our keychain is the only entry. The old code emitted `-s` with no args,
  // which sets an EMPTY list and evicts login.
  assert.equal(apply("kc_remove", TEMP, TEMP), LOGIN);
});

test("kc_remove re-adds login when it is already missing", () => {
  assert.equal(apply("kc_remove", TEMP, `${TEMP} ${OTHER}`), `${LOGIN} ${OTHER}`);
});

test("kc_remove preserves a concurrent job's keychain", () => {
  assert.equal(apply("kc_remove", TEMP, `${TEMP} ${OTHER} ${LOGIN}`), `${OTHER} ${LOGIN}`);
});

test("kc_remove is idempotent — safe when our keychain is already gone", () => {
  assert.equal(apply("kc_remove", TEMP, LOGIN), LOGIN);
});

// Regression: 2026-07-28. Five repos built concurrently; a `list-keychains`
// read came back empty under contention, so kc_prepend wrote a ONE-ENTRY list
// containing only the temp keychain — evicting login.keychain-db and taking
// Jori auth down for ~4s. kc_remove already guaranteed login; kc_prepend did
// not. BOTH write the list, so both need the guarantee.
test("kc_prepend never evicts login when the list read FAILS", () => {
  const got = apply("kc_prepend", TEMP, LOGIN, { failRead: true });
  assert.ok(got.includes(LOGIN), `login evicted on failed read: [${got}]`);
  assert.ok(got.includes(TEMP), `temp keychain missing: [${got}]`);
});

test("kc_remove never evicts login when the list read FAILS", () => {
  const got = apply("kc_remove", TEMP, `${LOGIN} ${TEMP}`, { failRead: true });
  assert.ok(got.includes(LOGIN), `login evicted on failed read: [${got}]`);
});

test("kc_prepend never evicts login when the list reads back EMPTY", () => {
  const got = apply("kc_prepend", TEMP, "");
  assert.ok(got.includes(LOGIN), `login absent from [${got}]`);
  assert.ok(got.includes(TEMP), `temp keychain absent from [${got}]`);
});

test("path matching is literal, not regex (grep -vxF)", () => {
  // `.` in the path must not act as a wildcard: a sibling differing only where
  // a dot sits must survive kc_remove.
  const sibling = "/tmp/runner/_temp/appXsigning.keychain-db";
  assert.equal(apply("kc_remove", TEMP, `${TEMP} ${sibling} ${LOGIN}`), `${sibling} ${LOGIN}`);
});
