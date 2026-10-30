#!/bin/bash
# jori-sync.test.sh — the sync cron keeps a host that commits locally
# (self-improve on the mini) and a host that pushes (the laptop) on one main,
# without a human, and never leaves conflict markers in a live tree.
#
# Builds a bare origin and two clones in a temp dir, copies jori-sync into
# each clone at bin/jori-sync (it self-locates from its own path),
# and replays the 2026-09-08 shapes:
#   1. mini has local commits, laptop pushed first        → rebase + push
#   2. mini has runtime drift, laptop pushed              → drift carried across
#   3. both, at once                                      → rebase, drift kept, push
#   4. rebase conflict                                    → abort, tree untouched, exit 1
#   5. drift conflicts with the incoming commit           → incoming wins, stash kept, exit 1
#   6. in sync with drift                                 → no-op
#   7. both hosts prepend a "Recent changes" bullet       → merge-changelog keeps both
#   8. both hosts edit the same existing sentence         → still a real conflict
#   9. the repo's .gitattributes routes system/changelog.md to merge-changelog
#  10. a clone with no core.hooksPath gets the commit gates wired; another value is kept
#
# Run: bash tests/jori-sync.test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
# The kernel tree's directory inside a repo: tools/ here, the repo root in a
# root-layout install (lib/root.cjs KERNEL_SUBDIR); fixtures build that layout.
KT=$(node -p "const s=require('$HERE/../lib/root.cjs').KERNEL_SUBDIR; s ? s + '/' : ''")
SYNC="$HERE/../bin/jori-sync"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/gsync.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1 — [$2]"; fi; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export JORI_ALLOW_BARE_COMMIT=1
g() { git -C "$1" "${@:2}"; }

fresh() {   # rebuild origin + laptop + mini from scratch
  rm -rf "$TMP/origin" "$TMP/laptop" "$TMP/mini"
  git init --quiet --bare -b main "$TMP/origin"
  git clone --quiet "$TMP/origin" "$TMP/laptop" 2>/dev/null
  mkdir -p "$TMP/laptop/${KT}bin" "$TMP/laptop/${KT}data"
  cp "$SYNC" "$TMP/laptop/${KT}bin/jori-sync"
  cp "$HERE/../bin/merge-changelog" "$TMP/laptop/${KT}bin/merge-changelog"
  mkdir -p "$TMP/laptop/${KT}system"
  printf 'system/changelog.md merge=changelog\n' > "$TMP/laptop/.gitattributes"
  printf '# Changelog\n\nIntro sentence.\n\n## Recent changes\n\n- 2026-09-01 — **old entry.** details\n' > "$TMP/laptop/${KT}system/changelog.md"
  printf 'v1\n' > "$TMP/laptop/${KT}data/playbook.md"
  printf 'a\n' > "$TMP/laptop/${KT}data/other.md"
  g "$TMP/laptop" add -A && g "$TMP/laptop" commit -q -m base && g "$TMP/laptop" push -q origin main
  git clone --quiet "$TMP/origin" "$TMP/mini" 2>/dev/null
}
laptop_pushes() {   # $1 = file, $2 = content
  printf '%s\n' "$2" > "$TMP/laptop/$1"
  g "$TMP/laptop" add -A && g "$TMP/laptop" commit -q -m "laptop: $1" && g "$TMP/laptop" push -q origin main
}
mini_commits() {    # $1 = file, $2 = content
  printf '%s\n' "$2" > "$TMP/mini/$1"
  g "$TMP/mini" add -A && g "$TMP/mini" commit -q -m "self-improve: $1"
}
run_sync() { (cd "$TMP/mini" && ./${KT}bin/jori-sync "$@"); }

echo "1. local commits + laptop pushed first → rebase and push"
fresh
laptop_pushes data/other.md b
mini_commits data/fix.md fixed
out=$(run_sync 2>&1); rc=$?
check "exit 0"                        '[ "$rc" -eq 0 ]'
check "rebased then pushed"           'echo "$out" | grep -q rebased && echo "$out" | grep -q pushed'
check "origin has the mini commit"    'g "$TMP/origin" log --oneline main | grep -q "self-improve: data/fix.md"'
check "origin has the laptop commit"  'g "$TMP/origin" log --oneline main | grep -q "laptop: data/other.md"'
check "mini == origin"                '[ "$(g "$TMP/mini" rev-parse HEAD)" = "$(g "$TMP/origin" rev-parse main)" ]'
check "no stash left"                 '[ -z "$(g "$TMP/mini" stash list)" ]'

echo "2. runtime drift + laptop pushed → drift carried across"
fresh
printf 'v1\nagent edit\n' > "$TMP/mini/${KT}data/playbook.md"
laptop_pushes data/other.md b
out=$(run_sync 2>&1); rc=$?
check "exit 0"                        '[ "$rc" -eq 0 ]'
check "pulled"                        'echo "$out" | grep -q pulled'
check "drift survives"                'grep -q "agent edit" "$TMP/mini/${KT}data/playbook.md"'
check "drift is unstaged"             'g "$TMP/mini" status --porcelain | grep -q "^ M data/playbook.md"'
check "incoming arrived"              '[ "$(cat "$TMP/mini/${KT}data/other.md")" = b ]'
check "no stash left"                 '[ -z "$(g "$TMP/mini" stash list)" ]'

echo "3. local commits + drift + laptop pushed → all three"
fresh
mini_commits data/fix.md fixed
printf 'v1\nagent edit\n' > "$TMP/mini/${KT}data/playbook.md"
laptop_pushes data/other.md b
out=$(run_sync 2>&1); rc=$?
check "exit 0"                        '[ "$rc" -eq 0 ]'
check "pushed"                        'g "$TMP/origin" log --oneline main | grep -q "self-improve"'
check "drift survives"                'grep -q "agent edit" "$TMP/mini/${KT}data/playbook.md"'
check "clean apart from drift"        '[ "$(g "$TMP/mini" status --porcelain | grep -vc "^ M data/playbook.md")" -eq 0 ]'

echo "4. rebase conflict → abort, tree exactly as before, exit 1"
fresh
mini_commits data/other.md mini-version
printf 'v1\nagent edit\n' > "$TMP/mini/${KT}data/playbook.md"
laptop_pushes data/other.md laptop-version
before=$(g "$TMP/mini" rev-parse HEAD)
out=$(run_sync 2>&1); rc=$?
check "exit 1"                        '[ "$rc" -eq 1 ]'
check "says DIVERGED"                 'echo "$out" | grep -q DIVERGED'
check "HEAD unchanged"                '[ "$(g "$TMP/mini" rev-parse HEAD)" = "$before" ]'
check "no rebase in progress"         '[ ! -d "$TMP/mini/.git/rebase-merge" ] && [ ! -d "$TMP/mini/.git/rebase-apply" ]'
check "drift restored"                'grep -q "agent edit" "$TMP/mini/${KT}data/playbook.md"'
check "no conflict markers"           '! grep -rq "^<<<<<<<" "$TMP/mini/${KT}data"'
check "nothing pushed"                '! g "$TMP/origin" log --oneline main | grep -q "self-improve"'

echo "5. drift conflicts with the incoming commit → incoming wins, stash kept, exit 1"
fresh
printf 'agent-version\n' > "$TMP/mini/${KT}data/playbook.md"
laptop_pushes data/playbook.md laptop-version
out=$(run_sync 2>&1); rc=$?
check "exit 1"                        '[ "$rc" -eq 1 ]'
check "says DRIFT CONFLICT"           'echo "$out" | grep -q "DRIFT CONFLICT"'
check "names the file"                'echo "$out" | grep -q "data/playbook.md"'
check "incoming version on disk"      '[ "$(cat "$TMP/mini/${KT}data/playbook.md")" = laptop-version ]'
check "no conflict markers"           '! grep -rq "^<<<<<<<" "$TMP/mini/${KT}data"'
check "stash kept with the edit"      'g "$TMP/mini" stash show -p | grep -q "agent-version"'
check "HEAD == origin"                '[ "$(g "$TMP/mini" rev-parse HEAD)" = "$(g "$TMP/origin" rev-parse main)" ]'

echo "6. in sync, dirty → nothing to do, exit 0"
fresh
printf 'v1\nagent edit\n' > "$TMP/mini/${KT}data/playbook.md"
out=$(run_sync 2>&1); rc=$?
check "exit 0"                        '[ "$rc" -eq 0 ]'
check "drift untouched"               'grep -q "agent edit" "$TMP/mini/${KT}data/playbook.md"'

prepend_entry() {   # $1 = clone, $2 = bullet text
  python3 - "$TMP/$1/${KT}system/changelog.md" "$2" <<'PY'
import sys
p, entry = sys.argv[1], sys.argv[2]
s = open(p).read()
s = s.replace("## Recent changes\n\n", "## Recent changes\n\n" + entry + "\n", 1)
open(p, "w").write(s)
PY
}

echo "7. both hosts prepend a changelog bullet → merged, both kept, origin's first"
fresh
prepend_entry mini "- 2026-09-08 — **mini: self-improve fix.** details"
g "$TMP/mini" add -A && g "$TMP/mini" commit -q -m "self-improve: changelog"
prepend_entry laptop "- 2026-09-08 — **laptop: some feature.** details"
g "$TMP/laptop" add -A && g "$TMP/laptop" commit -q -m "laptop: changelog" && g "$TMP/laptop" push -q origin main
out=$(run_sync 2>&1); rc=$?
check "exit 0"                        '[ "$rc" -eq 0 ]'
check "pushed"                        'g "$TMP/origin" log --oneline main | grep -q "self-improve: changelog"'
check "both bullets present"          'grep -q "mini: self-improve fix" "$TMP/mini/${KT}system/changelog.md" && grep -q "laptop: some feature" "$TMP/mini/${KT}system/changelog.md"'
check "origin entry first"            '[ "$(grep -n "laptop: some feature" "$TMP/mini/${KT}system/changelog.md" | cut -d: -f1)" -lt "$(grep -n "mini: self-improve fix" "$TMP/mini/${KT}system/changelog.md" | cut -d: -f1)" ]'
check "old entry kept once"           '[ "$(grep -c "old entry" "$TMP/mini/${KT}system/changelog.md")" -eq 1 ]'
check "no conflict markers"           '! grep -q "^<<<<<<<" "$TMP/mini/${KT}system/changelog.md"'

echo "8. both hosts edit the same existing sentence → still a real conflict"
fresh
sed -i.bak "s/Intro sentence./Intro sentence (mini)./" "$TMP/mini/${KT}system/changelog.md" && rm -f "$TMP/mini/${KT}system/changelog.md.bak"
g "$TMP/mini" add -A && g "$TMP/mini" commit -q -m "self-improve: intro"
sed -i.bak "s/Intro sentence./Intro sentence (laptop)./" "$TMP/laptop/${KT}system/changelog.md" && rm -f "$TMP/laptop/${KT}system/changelog.md.bak"
g "$TMP/laptop" add -A && g "$TMP/laptop" commit -q -m "laptop: intro" && g "$TMP/laptop" push -q origin main
before=$(g "$TMP/mini" rev-parse HEAD)
out=$(run_sync 2>&1); rc=$?
check "exit 1"                        '[ "$rc" -eq 1 ]'
check "says DIVERGED"                 'echo "$out" | grep -q DIVERGED'
check "HEAD unchanged"                '[ "$(g "$TMP/mini" rev-parse HEAD)" = "$before" ]'
check "no conflict markers"           '! grep -q "^<<<<<<<" "$TMP/mini/${KT}system/changelog.md"'

echo "9. the real repo routes the changelog to the merge driver"
# The changelog and its .gitattributes line are the installation's (a plain
# kernel checkout has neither), so this is checked where they exist.
if [ -f "$HERE/../system/changelog.md" ]; then
  check "changelog.md merge=changelog"  'grep -qx "system/changelog.md merge=changelog" "$HERE/../.gitattributes"'
else
  echo "  skip no system/changelog.md in this checkout"
fi

echo "10. the commit gates are wired on a host that is not, never overridden"
fresh
g "$TMP/mini" config --unset core.hooksPath 2>/dev/null
run_sync >/dev/null 2>&1
check "unset → githooks"        '[ "$(g "$TMP/mini" config --get core.hooksPath)" = "githooks" ]'
g "$TMP/mini" config core.hooksPath .elsewhere
out=$(run_sync 2>&1)
check "a deliberate value is kept"    '[ "$(g "$TMP/mini" config --get core.hooksPath)" = ".elsewhere" ]'
check "and named"                     'echo "$out" | grep -q "core.hooksPath is .\.elsewhere."'

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
