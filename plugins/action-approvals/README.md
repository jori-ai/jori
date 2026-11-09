# Approvals for plugin actions

Lets any plugin put a Face ID check in front of an action. The plugin declares
the action in its `plugin.json`, files a request with `bin/approval request`,
and the action runs only after you approve the card on your paired phone.

- **Turn on:** on by default. The poller exits at once while no enabled plugin
  declares an approval, so it costs nothing until one does.
- **Pairing:** the same paired device key as purchases (`purchase pair`, then
  Approvals → Pair in the app).
- **Schema:** `system/migrations/0180_action_approvals.sql`.
- **How to use it in a plugin:** `docs/writing-a-plugin.md`, "Actions that need
  your approval".
- **Tests:** `node --test tests/action-approval.test.mjs`.
