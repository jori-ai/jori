# speak-gate — think before you speak

One gate for every message to the user: is it true, could the assistant have answered it itself, is it asked well, is it worth their attention. The judge is `bin/speak-gate.mjs` (kernel), a read-only research session across every source. Design: `system/speak-gate.md`.

Since 2026-11-11 the gate is **live** (`lib/speak-gate-live.mjs`, see `system/speak-gate.md` § Live). This plugin runs the **safety-net shadow pass**: `ai.claude.speak-gate-shadow` (launchd, every 5 minutes) judges each message that reached the app since the last pass without a live review and files the verdict in `jori_gate_reviews`; the app shows it under the message for the user to grade. Nothing is held.

- **Nightly audit (2026-11-13, one week):** `ai.claude.speak-gate-audit` (launchd, 01:50) runs `bin/speak-gate-audit.mjs`: an Opus session re-checks every live gate decision of the day that ended, writes its grade on each `jori_gate_reviews` row (`audit_*`, migration 0189) and keeps the gate's lessons in `data/speak-gate-lessons.json`, which the gate reads into every judgment. Ends itself after 7 nights with one summary email. Log `agent/logs/speak-gate-audit.log`; state `data/speak-gate-audit.json`; pause `data/.speak-gate-audit-pause`. See `system/speak-gate.md` § Nightly audit.
- The app no longer shows gate lines or asks for grades (2026-11-13).
- Enable: `jori plugin enable speak-gate` (installs the launchd jobs).
- Log: `agent/logs/speak-gate-shadow.log`; state: `data/speak-gate-shadow.json`.
