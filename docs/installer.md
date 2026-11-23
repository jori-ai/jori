# Installer — 24/7 deployment

The quickstart runs Jori in the foreground of a terminal (`jori up`). For an always-on agent that survives reboots, run the process manager as a service and install the scheduled jobs.

Jori was built on macOS and runs on macOS, Linux and Windows (inside WSL 2); a Mac is not required. Two conventions are assumed throughout the kernel, so follow them unless you are ready to adapt code:

- the installation lives at **`~/Dev/jori`** (or wherever `JORI_HOME` points — set it in the service environment *and* in `.env`);
- Node is at **`/opt/homebrew/bin/node`** (Homebrew on Apple Silicon) when it exists; otherwise the kernel finds node on `PATH` or at `~/.local/bin/node`, where `site/install.sh` puts it on Linux and on a Mac without Homebrew. The service and the crontab lines it writes carry that directory in their `PATH`. On Linux the installer also links `/opt/homebrew/bin/node` for the few scripts that still name it.

## Which machine

| | Setup opens | Service | Stays on by itself when |
|---|---|---|---|
| Your Mac (laptop/desktop) | in its browser | launch agent `ai.jori.session` | — (a laptop sleeps) |
| Always-on Mac (Mac mini, cloud Mac) | from your computer, over Tailscale or an SSH tunnel | launch agent, in the auto-login desktop session | automatic login, `pmset sleep 0`, `pmset autorestart 1`, FileVault off |
| macOS VM | same | same | automatic login, sleep off |
| Linux VM | same | systemd user unit `jori.service` | `loginctl enable-linger`, cron |
| Rented server (cloud-init) | `https://<ip>.sslip.io` from getjori.ai/cloud, until setup finishes | same | same (the first-boot script turns them on) |
| Windows PC (WSL 2) | in the Windows browser | systemd user unit in the `Jori` WSL distro | the Windows Startup item `Jori`, PC sleep off when plugged in |

`jori setup` detects which one it is on (`lib/onboarding/host.mjs`: `system_profiler` model name and battery, `kern.hv_vmm_present` / `systemd-detect-virt`, `SSH_CONNECTION`, `tailscale status`), and the setup page's **Keep it running** step lists the checks with the command that fixes each. A launch agent needs a desktop session, so an always-on Mac must sign in by itself: over SSH alone, `launchctl bootstrap gui/<uid>` has no session to run in and setup says so instead of failing.

## macOS — launchd

**The short way:** `jori setup start` (or the **Start Jori** button on the `jori setup` page) does steps 1 and 2 below for this checkout: it writes `~/Library/LaunchAgents/ai.jori.session.plist` with this machine's node and paths, bootstraps it, and adds the starter jobs from `system/starter-jobs.json` to the crontab (tagged `# jori-starter`, each through `bin/cron-run`). It leaves a running service alone and skips any job whose `--label` is already scheduled. The rest of this section is what it does, by hand.

### 1. The process manager

The kernel ships launchd templates for its scheduled jobs (below) but not for the process manager itself, because its environment is host-specific. Save this as `~/Library/LaunchAgents/ai.jori.session.plist`, replacing `YOUR_JORI_HOME` with the absolute path of your checkout:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.jori.session</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>YOUR_JORI_HOME/agent/bin/process-manager.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>YOUR_JORI_HOME</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>JORI_HOME</key>
        <string>YOUR_JORI_HOME</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>YOUR_JORI_HOME/agent/logs/launchagent.log</string>
    <key>StandardErrorPath</key>
    <string>YOUR_JORI_HOME/agent/logs/launchagent.err.log</string>
</dict>
</plist>
```

The process manager loads `.env` itself and passes it to every child (supervisors, Claude sessions, MCP servers). It runs in your GUI session because some tools need UI permissions (Notes, Messages, AppleScript, Chrome automation).

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.jori.session.plist
launchctl print gui/$(id -u)/ai.jori.session | head -20   # state = running
./bin/jori status
```

### 2. Scheduled jobs

Scheduled work is registered in `system/tasks.json` (plus your own `agent/local/tasks.json`, merged by `lib/registry.cjs`). Two mechanisms run it:

- **launchd agents** for the long-running and ephemeral-Opus jobs. Templates live in `agent/launch-agents/`; `install.sh` renders their `__JORI_HOME__` / `__HOME__` placeholders and loads them:
  ```bash
  agent/launch-agents/install.sh --list                      # templates + install state
  agent/launch-agents/install.sh ai.claude.hum-sense         # install / refresh one
  agent/launch-agents/install.sh --uninstall ai.claude.hum-sense
  ```
  Never copy a template into `~/Library/LaunchAgents` by hand — launchd would run the literal placeholders.
- **cron** for the trigger scripts, wrapped in `bin/cron-run`, which records every run in `data/cron-runs.jsonl` (used by `jori doctor` and the boot catch-up). Start your crontab with the environment cron lacks:
  ```cron
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  JORI_HOME=/Users/you/Dev/jori
  */2 * * * * $JORI_HOME/bin/cron-run --label watchdog -- $JORI_HOME/agent/scripts/watchdog.sh
  ```
  `./bin/jori tasks` lists every task with its schedule and trigger script; `./bin/jori cron` shows the installed crontab against it, and `./bin/jori doctor` flags drift.

### 3. Host settings for an always-on Mac

- **Auto-login** (System Settings → Users & Groups): the LaunchAgent needs a GUI session.
- **No sleep**: `sudo pmset -a sleep 0 disksleep 0 displaysleep 180`.
- **FileVault** off if the host must come back unattended after a power cut (FileVault asks for a password at boot).
- **A stable hostname**: `sudo scutil --set HostName myhost`; register it in `system/hosts.json` (template: `examples/hosts.example.json`) so `jori whereami` knows the production host.

### Stop / restart

```bash
./bin/jori restart ops                               # rotate one agent's claude session (ops, ops-light, ops-haiku, chat)
./bin/jori restart chat
launchctl kickstart -k gui/$(id -u)/ai.jori.session  # restart the whole tree
```

## Linux — systemd (user unit)

The installer handles a Linux VM end to end without root where it can: Node 22 from nodejs.org (checksum-verified) into `~/.local/node`, Claude Code into `~/.local`, the `jori` command in `~/.local/bin`; with sudo it also installs git, cron and Ollama, links `/opt/homebrew/bin/node` and turns on lingering. `jori setup start` (or **Start** on the setup page) writes and enables the unit below. Tested on Ubuntu 26.04 (x86_64).

Linux is not a primary target: the macOS-only pieces (Keychain auth, `ioreg`, AppleScript tools, the iMessage channel) stay off. Jobs that macOS hands to an on-demand launchd agent run straight from cron here: `agent/scripts/lib/launchd-kick.sh` sees no launchd and runs the agent's program itself (`launchd-run-direct.mjs`, one copy at a time), because Claude Code keeps its login in a file cron can read, and the Node path convention above still applies (`sudo ln -s "$(command -v node)" /opt/homebrew/bin/node`). A user unit for the process manager:

```ini
# ~/.config/systemd/user/jori.service
[Unit]
Description=Jori
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Dev/jori
Environment=JORI_HOME=%h/Dev/jori
ExecStart=/opt/homebrew/bin/node %h/Dev/jori/agent/bin/process-manager.mjs
Restart=always
RestartSec=5
StandardOutput=append:%h/Dev/jori/agent/logs/systemd.log
StandardError=append:%h/Dev/jori/agent/logs/systemd.err.log

[Install]
WantedBy=default.target
```

```bash
loginctl enable-linger "$(whoami)"     # run without an open login session
systemctl --user daemon-reload
systemctl --user enable --now jori.service
journalctl --user -u jori.service -f
```

Schedule the trigger scripts from cron through `bin/cron-run` as above.

## Windows — WSL 2

`JoriSetup.exe` (NSIS, `apps/windows/JoriSetup.nsi`, built by `apps/windows/build.sh`) installs per user into `%LOCALAPPDATA%\Jori` and runs `site/install.ps1`, which:

1. turns on WSL with `wsl --install --no-distribution` when `wsl --status` fails (one UAC prompt; when Windows needs a restart it sets a `RunOnce` entry and resumes after sign-in);
2. downloads `ubuntu-noble-wsl-<arch>-wsl.rootfs.tar.gz` from cloud-images.ubuntu.com, checks it against `SHA256SUMS`, and `wsl --import`s it as the distro **Jori** under `%LOCALAPPDATA%\Jori\wsl` (its own distro, so a WSL Ubuntu you already use is untouched);
3. as root in the distro: a user named after the Windows account with passwordless sudo, `/etc/wsl.conf` with `systemd=true` and that default user, git/curl/cron/xz; then `wsl --terminate` so systemd starts;
4. runs `site/install.sh` as that user (the Linux path: Node in `~/.local/node`, Claude Code, Ollama, lingering, the node link);
5. adds a **Jori** item to the Windows Startup folder (`wscript keep-running.vbs`, a hidden `wsl.exe -d Jori --exec sleep infinity`; no administrator rights needed), because Windows stops a distro once nothing from Windows holds it; the systemd user unit `jori.service` then runs as on Linux;
6. adds Start-menu shortcuts and runs `jori setup`, which opens the Windows browser with `cmd.exe /c start` (WSL forwards `localhost`).

`jori setup` detects WSL (`lib/onboarding/host.mjs` `isWsl`) and adds two checks: the Startup item exists, and the PC does not sleep on mains power (`powercfg`). Uninstall (Settings → Apps → Jori) deletes the Startup item and shortcuts and asks before `wsl --unregister Jori`.

## A rented server — cloud-init

For an owner with no computer to keep on. getjori.ai/cloud (`site/cloud/index.html`) mints a 48-hex-digit token in the browser (kept in localStorage) and shows:

```yaml
#cloud-config
runcmd:
  - curl -fsSL https://getjori.ai/cloud-init.sh | JORI_SETUP_TOKEN=<token> bash
```

On first boot `site/cloud-init.sh` (root, Ubuntu 24.04 or Debian): installs git, cron and Caddy; serves `installing` at `https://<ip-with-dashes>.sslip.io/status` (CORS for getjori.ai, which polls it); creates the `jori` user with passwordless sudo and lingering; runs `site/install.sh` as it; then starts the system unit `jori-setup.service` running `jori setup --public-host <host>` with the token from `/var/lib/jori-cloud/token`, and points Caddy at the setup port. The setup server answers that Host name only from loopback (Caddy) and only with the token. When the owner presses **Finish**, the unit exits cleanly and `ExecStopPost` runs `/usr/local/sbin/jori-cloud-close`: Caddy's config is emptied and disabled and the token deleted, so nothing of Jori answers on the internet. Jori itself keeps running as the `jori` user's systemd unit; the app reaches it through Supabase.

## Verifying it's working

```bash
./bin/jori dispatch morning-digest
./bin/jori tail ops
```

A `connection refused` or "no healthy supervisor" means the process manager did not start the supervisors — check `agent/logs/ops-supervisor.log`.

## Updating

```bash
jori update            # pull (fast-forward only), install packages, restart the service
jori update --check    # just say how far behind this checkout is
```

The Mac app's **Update now** item runs the same command. By hand, it is:

```bash
cd ~/Dev/jori
git pull
./scripts/bootstrap.sh                                  # npm install + any new dirs
./bin/jori overlay sync                               # if you link a private overlay
launchctl kickstart -k gui/$(id -u)/ai.jori.session   # or: systemctl --user restart jori
agent/launch-agents/install.sh <label>…                 # re-render changed job templates
```

Playbook changes (`agent/ops-agent/jobs/*.md`, `agent/local/jobs/*.md`) and local rules (`agent/local/*.md`) need no restart: the supervisors read playbooks at dispatch and reload local rules when they change.

## Uninstall

```bash
# macOS
launchctl bootout gui/$(id -u)/ai.jori.session
rm ~/Library/LaunchAgents/ai.jori.session.plist
agent/launch-agents/install.sh --uninstall <label>…

# Linux
systemctl --user disable --now jori.service
rm ~/.config/systemd/user/jori.service
```

On Windows, uninstall Jori from Settings → Apps; it removes the Startup item and Start-menu items, and asks before deleting the `Jori` WSL distro.

Remove the Jori lines from your crontab. The checkout (and your `agent/local/`) is left untouched.
