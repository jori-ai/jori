# Customer Success (role plugin)

Onboarding, health checks and follow-ups with customers.

A team role (system/org.md): it owns the jobs listed under `role.jobs` in plugin.json (an installation adds its own in agent/local/config/org.json), signs what they send, and appends `specialization.md` to each of their playbooks at dispatch. Name it in org.json (`names`). Turn on: `jori plugin enable role-customer-success`.
