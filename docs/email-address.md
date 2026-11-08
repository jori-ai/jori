# The assistant's own email address

Optional. Without one, the assistant reads your mail and sends through your own
mailbox (Gmail), and nothing here applies. With one, people can email the
assistant directly, and its mail comes from that address.

## What you need

- **A domain on Cloudflare.** Adding a domain is free, and so is Email Routing.
  Mail to the address is routed to the email worker (`cf-email-worker/`), which
  posts it to the host's `/email-inbound` endpoint.
- **An smtp2go account.** The free plan is enough. The assistant sends through
  it (`bin/email-send`) once your domain is verified there.

You don't need a mail server or a mailbox.

## Setting it up

Open the control room → **Email address** (the setup page's "Ways to reach you"
step links there). Enter the address, a Cloudflare API token and an smtp2go API
key, then press **Check and switch**. It checks each step in order and stops at
the first one that needs you:

| Check | What it needs |
|---|---|
| Domain on Cloudflare | the token can see the zone (Zone Read) |
| Email Routing | turned on for the zone; it tries to turn it on itself, otherwise the dashboard does it (it adds the MX records) |
| Email worker | `cf-email-worker` deployed (`wrangler deploy`, then the secrets `WEBHOOK_URL` and `INBOUND_SECRET`); checked only if the token can read workers |
| Routing rule | adds `<address> → worker` (Email Routing Rules Edit) |
| Sending domain | the domain verified at smtp2go; it adds the domain and, if the token has DNS Edit, creates the two CNAME records, otherwise lists them for you |

Each check is a read or an add that does nothing the second time, so fix what
it reports and press the button again. A key is saved to `.env` on the host only
once its service accepts it, and it is never shown again. The address switches
only once mail can both arrive and leave.

Code: `lib/email-setup.mjs` (the checks), `lib/control/actions.mjs`
`email.setup` / `email.off` (save and switch). Settings:
`agent/local/config/email-routing.json` (`provider`, `zone_id`, `worker`,
`token_env`), plus `.env` `CLOUDFLARE_EMAIL_ROUTING_TOKEN` and
`SMTP2GO_API_KEY`.

## Changing it later

A new address, like a new name, takes care of itself
(`bin/identity-propagate`). The old address goes into `agent_email_aliases`, so
mail to it still counts as the assistant's own. When `email-routing.json` is
set, the new address gets its routing rule automatically. The service restarts,
and you get one message listing what was done and anything left to do. **Use my
mailbox instead** on the same page clears the address.
