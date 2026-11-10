# Relationships (role plugin)

The people in the CEO's life: staying in touch, birthdays and occasions.

A team role (system/org.md): it owns the jobs listed under `role.jobs` in plugin.json (an installation adds its own in agent/local/config/org.json), signs what they send, and appends `specialization.md` to each of their playbooks at dispatch. Name it in org.json (`names`). Turn on: `jori plugin enable role-relationships`.
