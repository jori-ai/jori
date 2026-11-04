# __TITLE__

What it does, for whom, and when it speaks up.

- **Turn on:** `jori plugin enable __NAME__` (or the control room's Plugins page).
- **Settings:** `agent/local/config/__NAME__.json` (defaults in `config.defaults.json`).
- **Needs:** nothing yet. List keys, programs and other plugins in `plugin.json` `requires`.
- **Command:** `plugins/__NAME__/bin/__NAME__ [--dry-run]`.
- **Tests:** `node --test plugins/__NAME__/tests/`.
