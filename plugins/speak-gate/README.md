# speak-gate — think before you speak

One gate for every message to the user: is it true, could the assistant have answered it itself, is it asked well, is it worth their attention. The judge is `bin/speak-gate.mjs` (kernel), a read-only research session across every source. Design: `system/speak-gate.md`.

Since 2026-11-11 the gate is **live** (`lib/speak-gate-live.mjs`, see `system/speak-gate.md` § Live). This plugin runs the **safety-net shadow pass**: `ai.claude.speak-gate-shadow` (launchd, every 5 minutes) judges each message that reached the app since the last pass without a live review and files the verdict in `jori_gate_reviews`; the app shows it under the message for the user to grade. Nothing is held.

- Enable: `jori plugin enable speak-gate` (installs the launchd job).
- Log: `agent/logs/speak-gate-shadow.log`; state: `data/speak-gate-shadow.json`.
