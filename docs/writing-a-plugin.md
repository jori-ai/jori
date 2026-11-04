# Writing a plugin

Every feature of Jori is a plugin: a folder with a `plugin.json` manifest and
everything the feature needs. A plugin can be turned on, turned off, installed
and removed without touching the rest of Jori. The design is in
`system/plugins.md`; this page is the how-to.

## 1. Create it

```bash
jori plugin new tide-check --title "Tide check"                  # a command, its test, settings, a README
jori plugin new tide-check --schedule "10 6 * * *"               # …and a daily schedule that runs the command
jori plugin new tide-check --job                                 # …and a playbook the ops agent runs
jori plugin new tide-check --local                               # this installation's own (private overlay)
```

This copies `plugins/_template/` to `plugins/tide-check/` (or
`agent/local/plugins/tide-check/` with `--local`):

```
plugins/tide-check/
  plugin.json             the manifest
  README.md               what it does, how to turn it on, its settings
  bin/tide-check          the command (node; reads its settings with localConfig)
  config.defaults.json    default settings, copied to agent/local/config/tide-check.json on first enable
  tests/tide-check.test.mjs
  jobs/tide-check.md      with --job: the playbook
```

A new plugin starts **off**. Nothing runs until you turn it on.

**Generic or local?** A plugin goes in `plugins/` when any installation could
use it as it is: no names, places, accounts or private paths in its files
(`bin/kernel-guard` checks this before a commit). When it is about this
installation's own people, businesses or accounts, use `--local`: it goes in
`agent/local/plugins/`, which is private and never published.

## 2. Fill in the manifest

```json
{
  "name": "tide-check",
  "title": "Tide check",
  "description": "Checks the tide before your beach days and tells you the best window.",
  "version": "0.1.0",
  "default": "disabled",
  "requires": { "plugins": [], "bins": ["bin/apple-weather"], "commands": ["curl"], "env": ["TIDES_API_KEY"] },
  "config": { "name": "tide-check" },
  "settings": ["places"],
  "schedules": [
    { "label": "tide-check", "cron": "10 6 * * *", "run": "{node} bin/tide-check", "log": "agent/logs/tide-check.log" }
  ],
  "launchd": [],
  "jobs": { "tide-check": { "routing": { "target": "ops-light", "model": "sonnet", "effort": "low" }, "task": { "description": "…" } } },
  "provides_bins": ["tide-check"],
  "services": [{ "name": "Tides API", "does": "Tide tables", "group": "Places and travel", "env": ["TIDES_"] }]
}
```

| Field | What it does |
|---|---|
| `name` | Lowercase letters, digits, dashes. Same as the folder. |
| `title`, `description` | What people see on the control room's Plugins page. Write them from the user's side. |
| `default` | `disabled` for anything a new installation should opt into; `enabled` only for what every installation needs. |
| `requires` | `plugins` that must be on first, `bins` (files in the install), `commands` (on PATH), `env` (`.env` keys). Turning the plugin on is refused while any is missing, and the Plugins page lists what is missing. |
| `config.name` | The plugin's settings file, `agent/local/config/<name>.json`. `config.defaults.json` seeds it. Add `"schedules": true` to let the installation keep its own schedule times in that file (a `schedules` list there), so personal times stay out of a published manifest. |
| `settings` | Other settings files that belong to this plugin, shown on its card. |
| `schedules` | Cron schedules. `run` is relative to the plugin (`bin/…`) and becomes a `cron-run --label <label>` line with `log` appended to; `command` is used verbatim instead. Placeholders: `{node}` (the installation's node), `{sysnode}`, `{sysbin}`, `{root}` (the install), `{home}`. `paused: "XPAUSE"` adds a line paused under that family. |
| `launchd` | `{ "label": "…", "file": "x.plist" }` renders `launchd/x.plist` (a template with `__JORI_HOME__`, `__JORI_TOOLS__`, `__HOME__`) into `~/Library/LaunchAgents`. Use launchd, not cron, for anything that runs `claude -p` (cron cannot read the Max sign-in). |
| `jobs` | Playbooks in the plugin's `jobs/` folder, with their routing (which agent, model, effort) and their task-registry entry. Dispatch with `jori dispatch <job>` or from a trigger. |
| `cron_tags` | Crontab lines your plugin's own code writes and removes (a one-off reminder), marked with a comment tag. The manager leaves them alone while the plugin is on and removes them when it is turned off. |
| `runtime/` | A folder with `manifest.json` + `index.mjs` adds MCP tools and skills to the agents while the plugin is on (`agent/plugins/loader.mjs`). |
| `services` | Outside services the plugin uses, for the control room's Services page. |
| `provides_bins` | Commands in `bin/`. They must not also exist in the core `bin/`. |
| `core` | Only for Jori's own upkeep: always on, cannot be turned off or removed. |
| `files`, `adopted_jobs` | Used while moving an existing feature in: files and playbooks it owns where they already are. A new plugin keeps everything in its own folder instead. |

## 3. Write the code

- **Settings:** read them with `localConfig("<name>", DEFAULTS)` from
  `lib/instance.cjs`; every key needs a default in code, and a sentence in
  `config.defaults.json`'s `_doc`. They appear on the plugin's card and can be
  edited in the control room.
- **Identity, time zone, ports, models:** `instance()`, `instanceValue("tz")`,
  `lib/ports.cjs`, `lib/models.cjs`. Never write a name, email, city, port or
  model id into code: `bin/control-scan` reports them.
- **Paths:** reach kernel code by path from the plugin
  (`path.join(__dirname, "..", "..", "..", "lib")`) and the install with
  `installTools()` from `lib/root.cjs`.
- **Messages to the user:** through `bin/jori-send-curl` (chat, questions, or
  the system channel for the plugin's own failures) and `email-send` for long
  output, following `agent/CLAUDE.md`.
- **Language:** a model decides what someone meant, never a regex
  (`agent/CLAUDE.md` Rule #0b; `bin/lint-no-language-regex` enforces it).

## 4. The rules

1. **Nothing outside the plugin names its files.** Other code that can use the
   plugin asks `lib/plugins.cjs` (`isEnabled(name)`, `pluginPath(name, …)`) and
   works without it. `jori plugin check` finds direct references.
2. **Never add the plugin's cron lines by hand.** Change the manifest and run
   `jori plugin sync` (the watchdog also syncs hourly on the production host).
3. **Turning it off must be safe.** It stops schedules, unloads agents and hides
   jobs; settings and data stay.

## 5. Test, turn on, commit

```bash
node --test plugins/tide-check/tests/      # CI runs plugins/*/tests/ too
jori plugin check                           # manifest, ownership, no outside references
jori plugin enable tide-check               # checks requires, seeds settings, installs schedules
jori plugin info tide-check
bin/jori-commit -m "…" --kernel -- plugins/tide-check/...   # a generic plugin (omit --kernel for --local)
```

Document it in the same change: the plugin's `README.md`, a line in
`system/changelog.md`, and anything other jobs must know in
`system/architecture.md` (`agent/CLAUDE.md` Rule #1).

## Turning off, removing, installing elsewhere

```bash
jori plugin disable tide-check              # stop it; settings and data stay
jori plugin remove tide-check               # delete its folder (add --purge-config for its settings file)
jori plugin install <folder|git-url> [--local]   # copy a plugin in from elsewhere and turn it on
```

Every change through the CLI or the control room's Plugins page is in the
control room's change history, with an undo.
