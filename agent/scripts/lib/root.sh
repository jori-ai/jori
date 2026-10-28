# root.sh — source to learn where the kernel lives (the shell twin of
# lib/root.cjs; read that file's header for the why).
#
# Sets (plain shell variables, not exported):
#   JORI_ROOT           the checkout this script runs from. An exported
#                          JORI_ROOT wins (tests point it at a sandbox), then
#                          JORI_HOME, then this file's own location.
#   JORI_TOOLS          the kernel tree in that checkout (lib/, bin/, agent/, ...)
#   JORI_INSTALL        the installation under the operator's HOME
#                          (JORI_HOME, else ~/Dev/jori)
#   JORI_INSTALL_TOOLS  the kernel tree in the installation
#   JORI_KERNEL_SUBDIR  the kernel tree's directory under a repo root ("" when
#                          the kernel is the repo root), for a caller that was
#                          handed some other root
#   JORI_NODE           the node binary: an exported JORI_NODE wins, then
#                          `command -v node`, then the usual Homebrew / /usr/local
#                          paths (cron's bare PATH has no node); "" when none
#
# Join paths below the kernel tree onto JORI_TOOLS / JORI_INSTALL_TOOLS
# ("$JORI_TOOLS/bin/foo"), never "$JORI_ROOT/tools/...": that spelling
# is the same in every layout. The layout itself (the kernel's directory under
# the repo root) is read from root.cjs's KERNEL_SUBDIR line, so it is written
# down once. Safe to source twice.

_jori_root_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This file sits in <kernel>/agent/scripts/lib/ in every layout.
_jori_root_code_tools="$(cd "$_jori_root_lib/../../.." && pwd)"
_jori_root_sub="$(sed -n 's/^const KERNEL_SUBDIR = "\([^"]*\)";.*/\1/p' "$_jori_root_code_tools/lib/root.cjs" 2>/dev/null | head -1)"
if [ -n "$_jori_root_sub" ]; then
  _jori_root_code_root="$(cd "$_jori_root_code_tools/$(printf '%s' "$_jori_root_sub" | sed 's#[^/][^/]*#..#g')" && pwd)"
else
  _jori_root_code_root="$_jori_root_code_tools"
fi
if [ -n "${JORI_ROOT:-}" ]; then
  JORI_TOOLS="$JORI_ROOT${_jori_root_sub:+/$_jori_root_sub}"
elif [ -n "${JORI_HOME:-}" ]; then
  JORI_ROOT="$JORI_HOME"
  JORI_TOOLS="$JORI_HOME${_jori_root_sub:+/$_jori_root_sub}"
else
  JORI_ROOT="$_jori_root_code_root"
  JORI_TOOLS="$_jori_root_code_tools"
fi
JORI_INSTALL="${JORI_HOME:-$HOME/Dev/jori}"
JORI_INSTALL_TOOLS="$JORI_INSTALL${_jori_root_sub:+/$_jori_root_sub}"
JORI_KERNEL_SUBDIR="$_jori_root_sub"
if [ -z "${JORI_NODE:-}" ]; then
  JORI_NODE="$(command -v node 2>/dev/null || true)"
  for _jori_root_n in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$JORI_NODE" ] && break
    [ -x "$_jori_root_n" ] && JORI_NODE="$_jori_root_n"
  done
  unset _jori_root_n
fi
unset _jori_root_lib _jori_root_code_tools _jori_root_code_root _jori_root_sub
