# Rain on your walks

Checks the forecast about half an hour before each of your regular outdoor walks
(a dog walk, a walk to work) and sends a short note when rain is likely during
the walk. A morning summary covers every walk of the day.

- **Needs:** `bin/apple-weather` (Apple WeatherKit).
- **Settings:** `agent/local/config/rain-walk.json`: the windows file, the rain
  threshold, and `schedules` (one entry per check, run times in the host's zone).
- **Command:** `bin/rain-walk-check --window <key> [--prewalk]`, `--summary`.
- **Turn off:** `jori plugin disable rain-walk` (or the control room's Plugins page).
