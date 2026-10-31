// Per-job scoping of provisioning profiles + ASC API keys
// (.github/scripts/ci-signing-assets.sh, 2026-07-28).
//
// `~/Library/MobileDevice/Provisioning Profiles/` and `~/private_keys/` are
// per-USER. Every signing workflow on the shared mini cleared them with globs
// (`rm -f ...*.mobileprovision`, `rm -f ...AuthKey_*.p8`), so the first job to
// reach setup or teardown deleted every other in-flight job's signing assets.
// Observed 2026-07-28: Butterfly died with "AuthKey_***.p8 ... no such file",
// Tracker with "No App Store profile ... found on this runner".
//
// The hygiene the globs wanted — no stale duplicate profile for MY app — must
// survive, so sa_install_profile prunes same-application-identifier profiles
// and nothing else. `security cms` is stubbed: these tests assert the scoping
// logic, not Apple's CMS decoder.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".github/scripts/ci-signing-assets.sh");

// A fake "profile" file is one line: `APPID<TAB>UUID<TAB>NAME`. SA_SECURITY and
// SA_PLISTBUDDY are injected so the scoping logic is exercised without Apple's
// CMS decoder — that indirection exists in the library precisely so this is
// testable rather than shipped on faith.
function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"));
  const sec = path.join(dir, "fake-security");
  const plb = path.join(dir, "fake-plistbuddy");
  fs.writeFileSync(sec, `#!/bin/bash\n# args: cms -D -i <file>\ncat "$4"\n`);
  fs.writeFileSync(plb, `#!/bin/bash
# args: -c "Print <key>" /dev/stdin
# REAL PlistBuddy needs a SEEKABLE file and cannot read a pipe — it prints
# "Error Reading File" to STDOUT and exits 0-ish. The first version of this stub
# just ran 'cat', which happily reads a pipe, so it passed while the library
# was piping and broken in production (an app build installed
# "Error.mobileprovision" and the archive failed). Reproduce the constraint.
if [ -p "$3" ]; then
  echo "Error Reading File: $3"
  exit 0
fi
line=$(cat "$3")
case "$2" in
  *application-identifier) printf '%s' "$(printf '%s' "$line" | cut -f1)" ;;
  *UUID) printf '%s' "$(printf '%s' "$line" | cut -f2)" ;;
  *Name) printf '%s' "$(printf '%s' "$line" | cut -f3)" ;;
esac
`);
  fs.chmodSync(sec, 0o755);
  fs.chmodSync(plb, 0o755);

  const script = `
    export SA_PROFILES_DIR="${dir}/profiles"
    export HOME="${dir}/home"
    export SA_SECURITY="${sec}"
    export SA_PLISTBUDDY="${plb}"
    export SA_STATE="${dir}/installed.ledger"
    mkdir -p "$SA_PROFILES_DIR" "$HOME"
    mkprofile() { printf '%s\\t%s\\t%s' "$2" "$3" "$4" > "$1"; }
    source ${JSON.stringify(SRC)}
    ${body}
  `;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return { out, dir };
}

test("the helper exists and is syntactically valid", () => {
  assert.ok(fs.existsSync(SRC), `${SRC} missing`);
  execFileSync("bash", ["-n", SRC]);
});

test("sa_asc_key_remove deletes ONLY the named key, never siblings", () => {
  const { out } = run(`
    mkdir -p "$HOME/private_keys" "$HOME/.appstoreconnect/private_keys"
    : > "$HOME/private_keys/AuthKey_MINE.p8"
    : > "$HOME/private_keys/AuthKey_SIBLING.p8"
    : > "$HOME/.appstoreconnect/private_keys/AuthKey_MINE.p8"
    : > "$HOME/.appstoreconnect/private_keys/AuthKey_OTHER.p8"
    sa_asc_key_remove MINE
    echo "remaining:"
    ls "$HOME/private_keys" "$HOME/.appstoreconnect/private_keys" 2>/dev/null | grep AuthKey | sort | tr '\\n' ' '
  `);
  assert.doesNotMatch(out, /AuthKey_MINE/, "our own key was not removed");
  assert.match(out, /AuthKey_SIBLING/, "a sibling job's key was deleted");
  assert.match(out, /AuthKey_OTHER/, "another directory's sibling key was deleted");
});

test("sa_asc_key_remove with an empty id is a no-op, not a wildcard", () => {
  const { out } = run(`
    mkdir -p "$HOME/private_keys"
    : > "$HOME/private_keys/AuthKey_A.p8"
    : > "$HOME/private_keys/AuthKey_B.p8"
    sa_asc_key_remove ""
    ls "$HOME/private_keys" | sort | tr '\\n' ' '
  `);
  assert.match(out, /AuthKey_A\.p8/);
  assert.match(out, /AuthKey_B\.p8/);
});

test("sa_asc_key_stage writes a 0600 key and echoes its path", () => {
  const { out } = run(`
    p=$(sa_asc_key_stage KID123 "PEMDATA")
    echo "path=$p"
    echo "mode=$(stat -f '%Lp' "$p")"
    echo "content=$(cat "$p")"
  `);
  assert.match(out, /path=.*AuthKey_KID123\.p8/);
  assert.match(out, /mode=600/);
  assert.match(out, /content=PEMDATA/); // lang-regex-ok: matches a generated key=value line, not language
});

test("sa_install_profile installs under the UUID filename", () => {
  const { out } = run(`
    mkprofile "$HOME/mine" "TEAM.co.silo.tracker" "aaaaaaaa-1111-2222-3333-444444444444" "Tracker App Store"
    echo "returned=$(sa_install_profile "$HOME/mine")"
    ls "$SA_PROFILES_DIR" | tr '\\n' ' '
  `);
  assert.match(out, /returned=aaaaaaaa-1111-2222-3333-444444444444 Tracker App Store/);
  assert.match(out, /aaaaaaaa-1111-2222-3333-444444444444\.mobileprovision/);
});

// The whole point: keep the "no stale duplicate for MY app" hygiene the blanket
// `rm -f *` was after, WITHOUT deleting other apps' profiles.
test("sa_install_profile prunes same-app-id, SPARES other apps", () => {
  const { out } = run(`
    mkprofile "$SA_PROFILES_DIR/stale.mobileprovision"   "TEAM.co.silo.tracker" "bbbbbbbb-1111-2222-3333-444444444444"   "Tracker Old"
    mkprofile "$SA_PROFILES_DIR/sibling.mobileprovision" "TEAM.com.other.app"   "cccccccc-1111-2222-3333-444444444444" "Other App"
    mkprofile "$HOME/new" "TEAM.co.silo.tracker" "dddddddd-1111-2222-3333-444444444444" "Tracker New"
    sa_install_profile "$HOME/new" >/dev/null
    ls "$SA_PROFILES_DIR" | sort | tr '\\n' ' '
  `);
  assert.doesNotMatch(out, /stale\.mobileprovision/, "stale same-app profile survived");
  assert.match(out, /sibling\.mobileprovision/, "another app's profile was deleted — the bug");
  assert.match(out, /dddddddd-1111-2222-3333-444444444444\.mobileprovision/, "new profile not installed");
});

test("sa_cleanup_installed removes only what THIS job installed", () => {
  const { out } = run(`
    mkprofile "$SA_PROFILES_DIR/sibling.mobileprovision" "TEAM.com.other.app" "cccccccc-1111-2222-3333-444444444444" "Other"
    mkprofile "$HOME/mine" "TEAM.co.silo.tracker" "eeeeeeee-1111-2222-3333-444444444444" "Mine"
    sa_install_profile "$HOME/mine" >/dev/null
    sa_cleanup_installed
    ls "$SA_PROFILES_DIR" | sort | tr '\\n' ' '
  `);
  assert.doesNotMatch(out, /eeeeeeee-1111-2222-3333-444444444444/, "our own profile was left behind");
  assert.match(out, /sibling\.mobileprovision/, "cleanup deleted another job's profile");
});

// Regression: 2026-07-28. Workflows call this inside command substitution to
// capture the uuid/name — which runs it in a SUBSHELL, so the old
// $SA_INSTALLED accumulation evaporated. With two profiles, both calls started
// from an empty parent value and GITHUB_ENV's last-wins left only the second
// path; teardown leaked the first. Observed on a GREEN jori-macOS build,
// where "Gandalf Mac Profile" survived cleanup. Every earlier test called the
// function DIRECTLY, so none of them exercised the way it is actually used.
test("two profiles installed via $( ) are BOTH cleaned up", () => {
  const { out } = run(`
    mkprofile "$HOME/app" "TEAM.com.app"     "aaaaaaaa-0000-0000-0000-000000000001" "App Profile"
    mkprofile "$HOME/ext" "TEAM.com.app.ext" "bbbbbbbb-0000-0000-0000-000000000002" "Ext Profile"
    # exactly how the workflows invoke it
    read -r U1 N1 <<< "$(sa_install_profile "$HOME/app" provisionprofile)"
    read -r U2 N2 <<< "$(sa_install_profile "$HOME/ext" provisionprofile)"
    echo "installed: $(ls "$SA_PROFILES_DIR" | wc -l | tr -d ' ')"
    sa_cleanup_installed
    echo "after_cleanup: [$(ls "$SA_PROFILES_DIR" | tr '\n' ' ')]"
  `);
  assert.match(out, /installed: 2/, "both profiles should install");
  assert.match(out, /after_cleanup: \[\]/, "a profile leaked — subshell accumulation lost it");
});

test("sa_install_profile honours the macOS .provisionprofile extension", () => {
  const { out } = run(`
    mkprofile "$HOME/mac" "TEAM.com.mac.app" "ffffffff-1111-2222-3333-444444444444" "Mac Profile"
    sa_install_profile "$HOME/mac" provisionprofile >/dev/null
    ls "$SA_PROFILES_DIR" | tr '\\n' ' '
  `);
  assert.match(out, /ffffffff-1111-2222-3333-444444444444\.provisionprofile/);
});

// Regression: 2026-07-28. sa__field piped into `PlistBuddy /dev/stdin`, which
// cannot read a pipe. It returned "Error Reading File: /dev/stdin" ON STDOUT,
// that flowed through as the UUID, and an app build installed
// "Error.mobileprovision" — the archive then died with "No profile for team".
test("sa__field survives PlistBuddy's refusal to read a pipe", () => {
  const { out } = run(`
    mkprofile "$HOME/p" "TEAM.app" "abcdef01-1111-2222-3333-444444444444" "Name Here"
    echo "uuid=[$(sa__field "$HOME/p" UUID)]"
  `);
  assert.match(out, /uuid=\[abcdef01-1111-2222-3333-444444444444\]/, "sa__field did not read the profile correctly");
  assert.doesNotMatch(out, /Error Reading File/, "PlistBuddy error leaked through as a value");
});

test("sa_install_profile REFUSES an implausible UUID instead of installing it", () => {
  const { out } = run(`
    # a profile whose UUID field decodes to an error string
    printf 'TEAM.app\tError Reading File: /dev/stdin\tName' > "$HOME/bad"
    if sa_install_profile "$HOME/bad" 2>&1; then echo "ACCEPTED"; else echo "REFUSED"; fi
    ls "$SA_PROFILES_DIR" | tr '\n' ' '
  `);
  assert.match(out, /REFUSED/, "installed a profile with a garbage UUID");
  assert.doesNotMatch(out, /Error.*\.mobileprovision/, "wrote Error.mobileprovision");
});

test("sa_cleanup_installed removes nothing when the job installed nothing", () => {
  const { out } = run(`
    : > "$SA_PROFILES_DIR/someone-else.mobileprovision"
    sa_cleanup_installed
    ls "$SA_PROFILES_DIR" | tr '\\n' ' '
  `);
  assert.match(out, /someone-else\.mobileprovision/,
    "cleanup deleted a profile this job never installed");
});
