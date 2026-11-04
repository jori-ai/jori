# Plugins — every feature is a module you can install and remove

How to write one: **`docs/writing-a-plugin.md`** (`jori plugin new <name>` scaffolds it from `plugins/_template/`).

A **plugin** is one feature of Jori packaged as a directory: its commands, code,
job playbooks, schedules, settings, the keys and tools it needs, and its tests.
Turning a plugin off stops everything it runs and hides everything it
registers; removing it deletes the directory. Nothing outside a plugin names a
plugin's files, so the rest of Jori never breaks when one is gone.

```
plugins/<name>/                 a generic plugin (kernel, published with Jori)
agent/local/plugins/<name>/     this installation's own plugin (private overlay)

  plugin.json        the manifest (below) — the only required file
  bin/               commands; a schedule or a playbook runs them from here
  lib/               the plugin's own modules
  jobs/<job>.md      playbooks the supervisor dispatches
  launchd/*.plist    launchd templates (__JORI_HOME__ / __JORI_TOOLS__ / __HOME__)
  runtime/           MCP tools, skills, context hooks (the WP5 loader: manifest.json + index.mjs)
  config.defaults.json   defaults for agent/local/config/<config.name>.json
  tests/*.test.mjs   run with the kernel suite
  README.md
```

## The manifest (`plugin.json`)

```json
{
  "name": "rain-walk",
  "title": "Rain on your walks",
  "description": "Checks the forecast before each regular walk and says when rain overlaps it.",
  "version": "1.0.0",
  "default": "enabled",
  "requires": { "plugins": [], "bins": ["bin/apple-weather"], "env": [], "commands": [] },
  "config": { "name": "rain-walk" },
  "schedules": [
    { "label": "rain-walk-morning", "cron": "30 7 * * *", "run": "bin/rain-walk-check --window morning --prewalk", "log": "agent/logs/rain-walk.log" }
  ],
  "launchd": [],
  "jobs": { "<job>": { "routing": { "target": "ops", "model": "sonnet" }, "task": { "description": "…" } } },
  "services": [],
  "provides_bins": ["rain-walk-check"]
}
```

- A schedule has `run` (built into a `cron-run` line, relative to the plugin)
  or `command` (used verbatim: an adopted line's exact command, with `{root}`,
  `{home}`, `{node}`, `{sysnode}` and `{sysbin}` filled in). `paused` keeps a
  `#XPAUSE#` prefix on a line the manager adds.
- `cron_tags`: lines another tool writes for this plugin (a daily reminder
  scheduler); the manager never adds them, and removes them while the plugin is off.
- `launchd` entries are rendered from `file`, or `adopt: true` for an agent
  already installed: off boots it out and parks the plist
  (`<label>.plist.plugin-off`), on restores it.
- `files`: files the plugin owns where they already are (not yet moved into its
  directory); `remove --with-files` deletes them. `adopted_jobs`: playbooks in
  the core jobs directory that belong to it; while it is off they are refused
  and leave the registries.
- `core: true`: always on; cannot be turned off or removed.
- `run` is relative to the plugin directory; `{root}` is the install
  (`~/Dev/jori`) and `{node}` the node binary. A schedule line is installed as
  `<cron> <root>/bin/cron-run --label <label> -- <command> # jori-plugin:<name>`;
  the trailing marker is how the manager finds its own lines.
- `requires.bins` are files that must exist (relative to the install),
  `requires.commands` programs on PATH, `requires.env` `.env` keys,
  `requires.plugins` other plugins that must be enabled first.
- `jobs.<job>.routing` joins the merged `job-routing` registry and
  `jobs.<job>.task` the `tasks` registry, only while the plugin is enabled.
- `services` adds entries to the control room's service catalog.

## State and layers

`agent/local/plugins.json` holds this installation's choices:
`{ "enabled": { "<name>": true|false } }`. A plugin not listed follows its
manifest's `default`. Everything reads the state through `lib/plugins.cjs`.

| What | Where a plugin's part goes while enabled |
|---|---|
| playbooks | `resolveJobFile()` (supervisor) looks in enabled plugins' `jobs/` after the kernel and `_ext/` |
| routing, tasks | `lib/registry.cjs` merges kernel → enabled plugins → `agent/local/` |
| schedules | crontab lines tagged `# jori-plugin:<name>`, written only through `bin/crontab-safe` |
| launchd agents | rendered from `launchd/` into `~/Library/LaunchAgents` and bootstrapped |
| runtime tools / skills | the WP5 loader in `tools-mcp` loads `runtime/` of enabled plugins |
| settings | `localConfig(config.name, defaults)`; `config.defaults.json` seeds the local file on first enable |
| control room | Plugins page; Feature settings groups a plugin's settings under it |

## Lifecycle (`jori plugin …`, and the control room's Plugins page)

- `list` / `info <name>` — what is installed, on or off, what it needs and provides.
- `enable <name>` — checks `requires` (refuses with the list of what is missing),
  seeds settings, installs schedules and launchd agents, records the state.
- `disable <name>` — removes its crontab lines, boots out and removes its launchd
  agents, records the state. Settings and data stay.
- `install <path|git-url> [--local]` — copies the plugin into `plugins/`
  (or `agent/local/plugins/` with `--local`), validates it, enables it.
- `remove <name> [--purge-config]` — disable, then delete the directory
  (and with `--purge-config` its local settings file).
- `sync` — makes the machine match the state: adds missing schedule lines and
  agents for enabled plugins, removes those of disabled or removed ones. A
  line's time is left alone if it exists (cron-tz-sync and the control room
  retime lines in place). Run by `jori-sync` after a pull.
- `check` — manifests valid, no file claimed by two plugins, nothing outside a
  plugin imports a plugin's files, schedules match. Fails the pre-commit hook
  on a manifest error.

Every change from the CLI or the control room is recorded in the control room's
change history with an undo.

## Rules

1. **Nothing outside a plugin names a plugin's files.** Kernel code that can use
   a plugin when it is there asks `lib/plugins.cjs` (`isEnabled`, `pluginPath`)
   or uses `optionalBin`, and works without it. `jori plugin check` enforces it.
2. **A plugin owns its schedule lines.** Never add a plugin's cron line by hand:
   change the manifest and run `jori plugin sync`.
3. **Personal plugins live in the overlay** (`agent/local/plugins/`), generic ones
   in `plugins/`; kernel-guard treats `plugins/` like any kernel directory.
4. **Disabling is always safe** and reversible; removing deletes code, never data.

## Migration

Done for schedules on 2026-11-04: every crontab line and launchd agent on the
host belongs to a plugin (53: 22 generic in `plugins/`, 31 this installation's
own in `agent/local/plugins/`, `core-upkeep` marked core). Each line was adopted
byte-for-byte (only the marker added; verified against a backup of the crontab),
paused lines stayed paused. Generic plugins default to off; this installation's
state turns them on. What remains is moving each plugin's `files` from the core
folders into its own directory, one plugin at a time; the control room's
Plugins page lists any schedule no plugin owns ("Not a plugin yet").
