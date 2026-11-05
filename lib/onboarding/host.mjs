// onboarding/host.mjs — what kind of machine Jori is being installed on, and
// whether it will stay on by itself.
//
// Jori runs on three kinds of host:
//   - a Mac someone uses (a laptop or desktop): setup opens in its browser;
//   - an always-on Mac (a Mac mini in a closet, a cloud Mac): reached over SSH
//     or Tailscale, so setup is opened from another computer;
//   - a virtual machine: a macOS VM (Tart, UTM, Parallels, a cloud Mac VM) or
//     a Linux VM (any cloud provider), where the service is a systemd user unit.
// Every check here is read-only and needs no administrator password; the fix
// for each is a command the owner runs (some need sudo).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./core.mjs";

const PRODUCT = "Jori"; // control-scan-ok: the software's name

// kernel-closure-ok: the macOS node path a few kernel scripts still name; on Linux setup links it.
const LEGACY_NODE = "/opt/homebrew/bin/node";
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ── what this machine is ───────────────────────────────────────────────────

/** `system_profiler SPHardwareDataType` → its "Model Name" ("Mac mini", "MacBook Air", ...). */
export function parseModelName(text) {
  const m = String(text || "").match(/Model Name:\s*(.+)/); // lang-regex-ok: system_profiler's fixed label
  return m ? m[1].trim() : null;
}

/** A laptop runs on a battery; an always-on Mac does not. */
export async function hasBattery() {
  const r = await run("pmset", ["-g", "batt"], { timeout: 3000 });
  return /InternalBattery/.test(r.stdout); // lang-regex-ok: pmset's fixed battery label
}

export async function isVirtual() {
  if (process.platform === "darwin") {
    const r = await run("sysctl", ["-n", "kern.hv_vmm_present"], { timeout: 3000 });
    return r.ok && r.stdout.trim() === "1";
  }
  const r = await run("systemd-detect-virt", ["--vm"], { timeout: 3000 });
  if (r.ok && r.stdout.trim() && r.stdout.trim() !== "none") return true;
  try { return /\bhypervisor\b/.test(fs.readFileSync("/proc/cpuinfo", "utf8")); } catch { return false; } // lang-regex-ok: a cpu flag
}

/** Tailscale's own view of this machine: { dns, ip } or null. */
export async function tailscale() {
  const bins = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"];
  for (const b of bins) {
    if (b.includes("/") && !exists(b)) continue;
    const r = await run(b, ["status", "--json"], { timeout: 4000 });
    if (!r.ok) continue;
    try {
      const self = JSON.parse(r.stdout).Self || {};
      const ip = (self.TailscaleIPs || []).find((a) => a.includes(".")) || null;
      if (ip) return { dns: String(self.DNSName || "").replace(/\.$/, "") || null, ip };
    } catch { /* not this one */ }
  }
  return null;
}

/** Is there a logged-in desktop session (macOS: the gui/<uid> launchd domain)? */
export async function hasGuiSession() {
  if (process.platform !== "darwin") return false;
  const r = await run("launchctl", ["print", `gui/${process.getuid()}`], { timeout: 4000 });
  return r.ok;
}

/** The name other machines on the network know this one by. */
export async function localHostname() {
  if (process.platform === "darwin") {
    const r = await run("scutil", ["--get", "LocalHostName"], { timeout: 3000 });
    if (r.ok && r.stdout.trim()) return r.stdout.trim() + ".local";
  }
  return os.hostname();
}

export function overSsh(env = process.env) {
  return !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

export async function hostProfile() {
  const vm = await isVirtual();
  let kind, model = null;
  let laptop = false;
  if (process.platform === "darwin") {
    const r = await run("system_profiler", ["SPHardwareDataType"], { timeout: 8000 });
    model = parseModelName(r.stdout);
    laptop = !vm && (await hasBattery());
    kind = vm ? "macOS virtual machine" : model || "Mac";
  } else {
    kind = vm ? "Linux virtual machine" : "Linux";
  }
  const [ts, gui] = await Promise.all([tailscale(), hasGuiSession()]);
  return {
    os: process.platform,
    kind,
    model,
    vm,
    laptop,
    remote: overSsh(),
    gui,
    hostname: await localHostname(),
    user: os.userInfo().username,
    tailscale: ts,
  };
}

// ── will it stay on? ───────────────────────────────────────────────────────

/** `pmset -g` → { sleep, autorestart, ... } as numbers. */
export function parsePmset(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\w+)\s+(\d+)/); // lang-regex-ok: pmset's "key value" table
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** `loginctl show-user` → whether lingering is on. */
export function parseLinger(text) {
  return /^Linger=yes$/m.test(String(text || "")); // lang-regex-ok: loginctl's key=value output
}

/**
 * The always-on checks for this host: [{ id, name, ok, warn, detail, fix }].
 * `fix` is the command that fixes it (null when there is nothing to run).
 * A laptop gets none of the power checks: it is expected to sleep.
 */
export async function alwaysOnChecks(profile) {
  const p = profile || (await hostProfile());
  const user = p.user;
  const checks = [];
  const add = (c) => checks.push({ warn: false, fix: null, ...c });
  if (p.os === "darwin") {
    const laptop = !!p.laptop;
    const pm = parsePmset((await run("pmset", ["-g"], { timeout: 4000 })).stdout);
    const auto = (await run("defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], { timeout: 3000 })).stdout.trim();
    add({
      id: "session", name: "Signed in to the desktop", ok: p.gui,
      detail: p.gui ? "The service has a desktop session to run in" : "Nobody is signed in on this Mac's screen, so the service has nowhere to run. Turn on automatic login, then restart.",
      fix: p.gui ? null : `sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser ${user}   # then set the password in System Settings → Users & Groups → Automatically log in`,
    });
    if (!laptop) {
      add({
        id: "autologin", name: "Signs in by itself after a restart", ok: auto === user,
        detail: auto === user ? `Automatic login is on for ${user}` : auto ? `Automatic login is on for ${auto}, not ${user}` : "After a restart this Mac waits at the login screen and Jori stays off", // control-scan-ok: the software's name
        fix: auto === user ? null : "System Settings → Users & Groups → Automatically log in as: " + user,
      });
      add({
        id: "sleep", name: "Never sleeps", ok: pm.sleep === 0,
        detail: pm.sleep === 0 ? "System sleep is off" : `Sleeps after ${pm.sleep} minutes idle, which stops Jori`, // control-scan-ok: the software's name
        fix: pm.sleep === 0 ? null : "sudo pmset -a sleep 0 disksleep 0",
      });
      if (!p.vm) {
        add({
          id: "autorestart", name: "Starts again after a power cut", ok: pm.autorestart === 1,
          detail: pm.autorestart === 1 ? "Restarts by itself when power comes back" : "Stays off after a power cut until someone presses the button",
          fix: pm.autorestart === 1 ? null : "sudo pmset -a autorestart 1",
        });
        const fv = (await run("fdesetup", ["status"], { timeout: 4000 })).stdout;
        const fvOn = /FileVault is On/.test(fv); // lang-regex-ok: fdesetup's fixed status line
        add({
          id: "filevault", name: "Comes back without a password", ok: !fvOn, warn: fvOn,
          detail: fvOn ? "FileVault is on: after a restart the Mac waits for its password, so it can't come back unattended. Fine if someone is always nearby." : "FileVault is off, so a restart needs no one at the keyboard",
          fix: fvOn ? "System Settings → Privacy & Security → FileVault → Turn Off (only if this Mac is somewhere safe)" : null,
        });
      }
    }
  } else if (!hasSystemd()) {
    add({
      id: "systemd", name: "A service manager", ok: false, warn: true,
      detail: "No systemd here (a container or a minimal VM): Jori runs with `jori up` under whatever keeps processes running on this machine", // control-scan-ok: the software's name
      fix: "jori up   # under a container restart policy, tmux or supervisord",
    });
  } else {
    const linger = parseLinger((await run("loginctl", ["show-user", user, "-p", "Linger"], { timeout: 4000 })).stdout);
    add({
      id: "linger", name: "Keeps running after you log out", ok: linger,
      detail: linger ? "systemd keeps your services running with no one logged in" : "Without lingering, systemd stops Jori when your last SSH session ends", // control-scan-ok: the software's name
      fix: linger ? null : `sudo loginctl enable-linger ${user}`,
    });
    const sd = await run("systemctl", ["--user", "is-system-running"], { timeout: 4000 });
    const sdUp = /running|degraded/.test(sd.stdout); // lang-regex-ok: systemctl's state word
    add({
      id: "systemd", name: "A systemd user session", ok: sdUp,
      detail: sdUp ? "Available" : "systemctl --user isn't answering; log in over SSH (not su) so a user session starts",
      fix: null,
    });
  }
  if (p.os !== "darwin") {
    add({
      id: "cron", name: "cron for the scheduled jobs", ok: !!(await run("sh", ["-c", "command -v crontab"])).stdout.trim(),
      detail: "Runs the recurring jobs", fix: "sudo apt-get install -y cron   # or: sudo dnf install -y cronie && sudo systemctl enable --now crond",
    });
    const nodeLink = exists(LEGACY_NODE);
    add({
      id: "nodelink", name: "node where Jori's scripts look for it", ok: nodeLink, warn: !nodeLink, // control-scan-ok: the software's name
      detail: nodeLink ? `${LEGACY_NODE} is there` : `A few scripts call ${LEGACY_NODE} (the macOS path); without a link there they fail`,
      fix: nodeLink ? null : `sudo mkdir -p ${path.dirname(LEGACY_NODE)} && sudo ln -sf "${process.execPath}" ${LEGACY_NODE}`,
    });
    }
  return checks;
}

// ── systemd (Linux) ────────────────────────────────────────────────────────

export const SYSTEMD_UNIT = "jori.service";

export function systemdUnitPath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

export function renderSystemdUnit({ base, node, claudeBin = null, home = os.homedir() }) {
  const pathDirs = [...new Set([path.dirname(node), claudeBin && path.dirname(claudeBin), path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean))].join(":");
  return `# ${PRODUCT} — written by \`jori setup\` (lib/onboarding/host.mjs). docs/installer.md § Linux.
[Unit]
Description=Jori
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${base}
Environment=JORI_HOME=${base}
Environment=PATH=${pathDirs}
ExecStart=${node} ${path.join(base, "agent", "bin", "process-manager.mjs")}
Restart=always
RestartSec=5
StandardOutput=append:${path.join(base, "agent", "logs", "systemd.log")}
StandardError=append:${path.join(base, "agent", "logs", "systemd.err.log")}

[Install]
WantedBy=default.target
`;
}

export async function systemdStatus() {
  const r = await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { timeout: 4000 });
  return { installed: exists(systemdUnitPath()), running: r.stdout.trim() === "active" };
}

export function hasSystemd() {
  return exists("/run/systemd/system");
}

export async function installSystemd({ base, node, claudeBin }) {
  if (!hasSystemd()) return { ok: false, message: "This machine doesn't run systemd, so Jori can't install itself as a service. Run `jori up` under your own supervisor (a container restart policy, tmux, supervisord) and the starter jobs still go into cron." }; // control-scan-ok: the software's name
  const file = systemdUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(base, "agent", "logs"), { recursive: true });
  fs.writeFileSync(file, renderSystemdUnit({ base, node, claudeBin }));
  const steps = [["daemon-reload"], ["enable", "--now", SYSTEMD_UNIT]];
  for (const s of steps) {
    const r = await run("systemctl", ["--user", ...s], { timeout: 20000 });
    if (!r.ok) return { ok: false, message: `systemctl --user ${s.join(" ")} failed: ${r.stderr.trim()}` };
  }
  return { ok: true, message: "Started" };
}
