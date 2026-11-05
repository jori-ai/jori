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
  Linux) note "Linux: the service runs under systemd; the Mac-only parts (Messages, Photos, Find My, AppleScript) stay off." ;;
  *) die "Jori runs on macOS (and, partly, Linux)." ;;
esac

OS="$(uname -s)"
# sudo without a prompt, or with one when there is a terminal to type into.
can_sudo() { [[ $(id -u) == 0 ]] || sudo -n true 2>/dev/null || { [[ $TTY == /dev/tty ]] && command -v sudo >/dev/null 2>&1; }; }
as_root() { if [[ $(id -u) == 0 ]]; then "$@"; else sudo "$@" < "$TTY"; fi; }
pkg_install() {  # Linux: apt / dnf / yum / apk / pacman
  if command -v apt-get >/dev/null; then as_root apt-get update -qq && as_root apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null; then as_root dnf install -y -q "$@"
  elif command -v yum >/dev/null; then as_root yum install -y -q "$@"
  elif command -v apk >/dev/null; then as_root apk add -q "$@"
  elif command -v pacman >/dev/null; then as_root pacman -S --noconfirm --needed "$@"
  else return 1; fi
}
# Linux: the official Node.js build into ~/.local/node, checked against
# nodejs.org's published SHA-256 sums. No root needed.
install_node_linux() {
  local arch; case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "No Node.js build for $(uname -m); install Node 22.5+ yourself." ;; esac
  local base=https://nodejs.org/dist/latest-v22.x sums file tmp
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || die "Couldn't reach nodejs.org."
  file=$(printf '%s\n' "$sums" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}')
  [[ -n $file ]] || die "nodejs.org lists no linux-$arch build."
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "Couldn't download $file."
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --status) || die "$file didn't match its published checksum; nothing was installed."
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node" "$HOME/.local/bin"
  tar -xJf "$tmp/$file" -C "$HOME/.local/node" --strip-components=1 && rm -rf "$tmp"
  for b in node npm npx; do ln -sf "$HOME/.local/node/bin/$b" "$HOME/.local/bin/$b"; done
  export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
}
[[ $OS == Linux ]] && export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"

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
if node_ok; then ok "Node $(node -v)"
elif [[ $OS == Linux ]]; then
  install_node_linux && node_ok && ok "Node $(node -v) in ~/.local/node" || die "Node didn't install."
else
  command -v brew >/dev/null 2>&1 || die "Install Node.js 22.5 or newer from https://nodejs.org, then run this again."
  brew install node >/dev/null && ok "Node $(node -v)"
  node_ok || die "Node $(node -v) is older than 22.5. Update it (brew upgrade node) and run this again."
fi
if command -v git >/dev/null 2>&1; then ok "git"
elif [[ $OS == Linux ]]; then
  can_sudo && pkg_install git >/dev/null && ok "git" || die "Install git (sudo apt-get install git), then run this again."
else
  command -v brew >/dev/null 2>&1 && brew install git >/dev/null && ok "git" || die "Install git, then run this again."
fi
if [[ $OS == Linux ]] && ! command -v crontab >/dev/null 2>&1; then
  if can_sudo && { pkg_install cron >/dev/null 2>&1 || pkg_install cronie >/dev/null 2>&1; }; then
    as_root systemctl enable --now cron >/dev/null 2>&1 || as_root systemctl enable --now crond >/dev/null 2>&1 || true
    ok "cron"
  else
    warn "cron isn't installed, so scheduled jobs won't run. Install it: sudo apt-get install cron"
  fi
fi

# ── Claude Code ────────────────────────────────────────────────────────────
step "Claude Code"
if command -v claude >/dev/null 2>&1 || [[ -x $HOME/.local/bin/claude ]]; then
  ok "installed"
else
  # Into ~/.local when npm's global folder isn't writable (Linux, a system node).
  prefix=(); [[ -w "$(npm config get prefix 2>/dev/null)/lib" ]] || prefix=(--prefix "$HOME/.local")
  npm install -g "${prefix[@]}" @anthropic-ai/claude-code >/dev/null 2>&1 || die "Couldn't install Claude Code. Try: npm install -g @anthropic-ai/claude-code"
  ok "installed"
fi
note "You'll sign in on the setup page."

# ── Ollama (memory search) ─────────────────────────────────────────────────
if [[ ${JORI_NO_OLLAMA:-} != 1 && $OS == Linux ]]; then
  step "Memory search (Ollama)"
  if command -v ollama >/dev/null 2>&1; then ok "installed"
  elif can_sudo; then
    # To a file first: as_root reads the terminal, so it can't take a pipe.
    oi=$(mktemp) && curl -fsSL https://ollama.com/install.sh -o "$oi" && as_root sh "$oi" >/dev/null 2>&1 && ok "installed" || warn "Ollama didn't install; memory search stays off. Later: curl -fsSL https://ollama.com/install.sh | sh"
    rm -f "$oi"
  else
    note "skipped (needs sudo). Later: curl -fsSL https://ollama.com/install.sh | sh"
  fi
  command -v ollama >/dev/null 2>&1 && { nohup ollama pull nomic-embed-text >/dev/null 2>&1 & note "downloading its model in the background"; }
fi
if [[ ${JORI_NO_OLLAMA:-} != 1 && $OS == Darwin ]]; then
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

if [[ $OS == Linux ]]; then
  # A few kernel scripts call the macOS node path.
  # kernel-closure-ok: the path those scripts name; this links it on Linux
  LEGACY_NODE=/opt/homebrew/bin/node
  if [[ ! -x $LEGACY_NODE ]]; then
    if can_sudo && as_root mkdir -p "${LEGACY_NODE%/*}" && as_root ln -sf "$(command -v node)" "$LEGACY_NODE"; then ok "node linked at $LEGACY_NODE"
    else warn "Some scripts expect $LEGACY_NODE. Later: sudo mkdir -p ${LEGACY_NODE%/*} && sudo ln -sf $(command -v node) $LEGACY_NODE"; fi
  fi
  # Keep the systemd user service running with nobody logged in.
  if [[ ! -d /run/systemd/system ]]; then
    warn "This machine doesn't run systemd, so Jori can't install itself as a service. Run it with \`jori up\` under your own supervisor (a container restart policy, tmux, supervisord)."
  elif ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null || { can_sudo && as_root loginctl enable-linger "$(id -un)"; }; then ok "Jori keeps running after you log out"
    else warn "Without lingering, Jori stops when you log out. Later: sudo loginctl enable-linger $(id -un)"; fi
  fi
  mkdir -p "$HOME/.local/bin"
  [[ ${JORI_NO_LINK:-} == 1 ]] || { ln -sf "$JORI_HOME/bin/jori" "$HOME/.local/bin/jori" && ok "the jori command is in ~/.local/bin"; }
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) note "Add ~/.local/bin to your PATH (most distributions do this at your next login)." ;; esac
fi

# `jori` on PATH, when a Homebrew bin dir is writable and nothing is there yet.
[[ ${JORI_NO_LINK:-} == 1 || $OS == Linux ]] || for d in /opt/homebrew/bin /usr/local/bin; do
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
