#!/bin/bash
# Jori installer — https://getjori.ai/install.sh
#
#   curl -fsSL https://getjori.ai/install.sh | bash
#
# Installs what Jori needs on a Mac (Homebrew, Node.js, git, Ollama, Claude
# Code), puts Jori in ~/Dev/jori, then opens the setup page in your browser
# (`jori setup`), which signs you in to Claude and starts Jori.
#
# Re-running it updates an existing checkout (fast-forward only, never over
# local changes) and reopens setup. Nothing is installed that is already there.
#
# Environment:
#   JORI_HOME=<dir>       where to put Jori (default ~/Dev/jori)
#   JORI_REPO=<git url>   what to clone (default https://github.com/jori-ai/jori.git)
#   JORI_NO_OLLAMA=1      skip Ollama (memory search stays off until you add it)
#   JORI_NO_SETUP=1       install only; run `jori setup` yourself later
#   JORI_NO_LINK=1        don't put a `jori` symlink in Homebrew's bin

set -euo pipefail

# kernel-closure-ok: the installer runs before any checkout exists, so it names the default location itself
JORI_HOME="${JORI_HOME:-$HOME/Dev/jori}"
JORI_REPO="${JORI_REPO:-https://github.com/jori-ai/jori.git}"

if [[ -t 1 ]]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; D=; G=; Y=; R=; N=; fi
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n  %s✘ %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

# Piped through `curl | bash`, stdin is this script: prompts read the terminal.
# From the Mac app or CI there is no terminal at all: test that it opens.
TTY=/dev/tty
{ : < "$TTY"; } 2>/dev/null || TTY=/dev/null

printf '\n%sInstalling Jori%s %s→ %s%s\n' "$B" "$N" "$D" "$JORI_HOME" "$N"

case "$(uname -s)" in
  Darwin) ;;
  Linux) warn "Jori is built for macOS. On Linux the Mac-only parts (launchd, Keychain, Messages) stay off; install Node 22.5+, git and Claude Code yourself, then run this again." ;;
  *) die "Jori runs on macOS (and, partly, Linux)." ;;
esac

# ── Homebrew ───────────────────────────────────────────────────────────────
brew_env() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$("$b" shellenv)" && return 0; done
  return 1
}
if [[ $(uname -s) == Darwin ]]; then
  step "Homebrew"
  if command -v brew >/dev/null 2>&1 || brew_env; then
    ok "installed"
  else
    [[ $TTY == /dev/tty ]] || die "Homebrew needs your Mac password, so install it from Terminal: curl -fsSL https://getjori.ai/install.sh | bash"
    note "Homebrew installs the tools below. It asks for your Mac password once."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < "$TTY"
    brew_env || die "Homebrew didn't finish installing. Run this installer again."
    ok "installed"
  fi
fi

# ── Node.js + git ──────────────────────────────────────────────────────────
step "Node.js and git"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  local maj=${v%%.*} rest=${v#*.}; local min=${rest%%.*}
  (( maj > 22 || (maj == 22 && min >= 5) ))
}
if node_ok; then ok "Node $(node -v)"; else
  command -v brew >/dev/null 2>&1 || die "Install Node.js 22.5 or newer from https://nodejs.org, then run this again."
  brew install node >/dev/null && ok "Node $(node -v)"
  node_ok || die "Node $(node -v) is older than 22.5. Update it (brew upgrade node) and run this again."
fi
if command -v git >/dev/null 2>&1; then ok "git"; else
  command -v brew >/dev/null 2>&1 && brew install git >/dev/null && ok "git" || die "Install git, then run this again."
fi

# ── Claude Code ────────────────────────────────────────────────────────────
step "Claude Code"
if command -v claude >/dev/null 2>&1 || [[ -x $HOME/.local/bin/claude ]]; then
  ok "installed"
else
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || die "Couldn't install Claude Code. Try: npm install -g @anthropic-ai/claude-code"
  ok "installed"
fi
note "You'll sign in on the setup page."

# ── Ollama (memory search) ─────────────────────────────────────────────────
if [[ ${JORI_NO_OLLAMA:-} != 1 && $(uname -s) == Darwin ]]; then
  step "Memory search (Ollama)"
  if ! command -v ollama >/dev/null 2>&1; then brew install ollama >/dev/null && ok "installed"; else ok "installed"; fi
  if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    brew services start ollama >/dev/null 2>&1 || (nohup ollama serve >/dev/null 2>&1 &)
    for _ in $(seq 1 20); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
  fi
  if curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q nomic-embed-text; then ok "model ready"
  else
    # ~270 MB; finishes in the background while setup carries on.
    nohup ollama pull nomic-embed-text >/dev/null 2>&1 &
    note "downloading its model in the background"
  fi
fi

# ── Jori ───────────────────────────────────────────────────────────────────
step "Jori"
if [[ -d $JORI_HOME/.git ]]; then
  if [[ -z $(git -C "$JORI_HOME" status --porcelain --untracked-files=no) ]]; then
    git -C "$JORI_HOME" pull --ff-only --quiet && ok "updated $JORI_HOME" || warn "couldn't fast-forward $JORI_HOME; kept it as it is"
  else
    warn "$JORI_HOME has local changes; not updating it"
  fi
elif [[ -e $JORI_HOME && -n $(ls -A "$JORI_HOME" 2>/dev/null) ]]; then
  die "$JORI_HOME exists and isn't a Jori checkout. Move it, or set JORI_HOME to another folder."
else
  mkdir -p "$(dirname "$JORI_HOME")"
  git clone --quiet "$JORI_REPO" "$JORI_HOME" && ok "downloaded to $JORI_HOME"
fi

note "installing its packages (a minute or two)…"
"$JORI_HOME/scripts/bootstrap.sh" --quiet >/dev/null || die "Setup of Jori's packages failed. Run $JORI_HOME/scripts/bootstrap.sh to see why."
ok "packages installed"

# `jori` on PATH, when a Homebrew bin dir is writable and nothing is there yet.
[[ ${JORI_NO_LINK:-} == 1 ]] || for d in /opt/homebrew/bin /usr/local/bin; do
  if [[ -d $d && -w $d ]]; then
    if [[ ! -e $d/jori ]]; then ln -s "$JORI_HOME/bin/jori" "$d/jori" && ok "the jori command is ready"; fi
    break
  fi
done

if [[ ${JORI_NO_SETUP:-} == 1 ]]; then
  printf '\n%sInstalled.%s Run %sjori setup%s to finish.\n\n' "$B" "$N" "$B" "$N"
  exit 0
fi

step "Setup"
note "Opening the setup page in your browser…"
export JORI_HOME
exec "$JORI_HOME/bin/jori" setup < "$TTY"
