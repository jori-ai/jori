# Installer — 24/7 deployment

The quickstart runs Jori in the foreground of a terminal (`jori up`). For an always-on agent that survives reboots, run the process manager as a service and install the scheduled jobs.

Jori is built and run on macOS. Two conventions are assumed throughout the kernel, so follow them unless you are ready to adapt code:

- the installation lives at **`~/Dev/jori`** (or wherever `JORI_HOME` points — set it in the service environment *and* in `.env`);
- Node is at **`/opt/homebrew/bin/node`** (Homebrew on Apple Silicon): the process manager starts its children with that path, and the cron-facing bins use it as their shebang because cron's `PATH` has no Homebrew. On another layout, symlink your `node` there.

## macOS — launchd

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
./bin/jori restart ops                               # rotate one agent's claude session
./bin/jori restart chat
launchctl kickstart -k gui/$(id -u)/ai.jori.session  # restart the whole tree
```

## Linux — systemd (user unit)

Linux is not a primary target: the macOS-only pieces (launchd jobs, Keychain auth, `ioreg`, AppleScript tools) stay off, and the Node path convention above still applies (`sudo ln -s "$(command -v node)" /opt/homebrew/bin/node`). A user unit for the process manager:

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

## Verifying it's working

```bash
./bin/jori dispatch morning-digest
./bin/jori tail ops
```

A `connection refused` or "no healthy supervisor" means the process manager did not start the supervisors — check `agent/logs/ops-supervisor.log`.

## Updating

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

Remove the Jori lines from your crontab. The checkout (and your `agent/local/`) is left untouched.
