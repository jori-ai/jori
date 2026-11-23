# Website sign-ins: logging, causes, and keeping them

Jori signs in to websites in its automation Chromes (each a LaunchAgent with
`--remote-debugging-port` and its own `--user-data-dir`). The goal is that a
sign-in made once survives Chrome restarts, Chrome updates, reboots and
keychain changes, and that every sign-in that still fails is recorded with its
cause and reaches someone who can fix it.

## The layers, in the order they act

1. **The session itself.** `bin/site-login` ticks a "remember me / keep me
   signed in" box when the form has one, so the site issues a persistent
   cookie and not one that ends with the browser.
2. **The session vault** (`bin/chrome-session-vault`). Every 15 minutes
   (`chrome-cdp-watch.sh`) it reads each running automation Chrome's saved
   cookies over CDP and keeps an encrypted copy. If a Chrome suddenly holds
   under half of what the vault has (vault of at least 50 cookies), the jar
   was wiped. Chrome on macOS does this when a relaunch cannot use its
   keychain key ("Chrome Safe Storage"), for example after a major-version
   update applied on relaunch. The Chrome log then shows `Failed to decrypt
   token`. The vault then puts back every unexpired cookie that is missing,
   logs a `cookie_jar_wiped` row plus one `session_restored` row per site, and
   pages the system channel. A restart of the same version keeps cookies; the
   vault is for the cases that do not.
3. **Restore before retyping.** When `site-login` (and `aa-balance`) find a
   site signed out, they first run `chrome-session-vault restore --port N
   --site <domain>`, and only type the saved password if that does not bring
   the session back. A restored session meets no captcha and no one-time code.
4. **Automatic sign-in** with the saved login (`site-pass` Logins vault, then
   `dev-pass`). A credential read that times out is retried once. A page whose
   address is a sign-in path is never reported as signed in.
5. **The log and the alert** (below).

## The sign-in log

`data/site-login-log.jsonl`, one JSON object per line, written only through
`lib/login-log.cjs` (`record()`), or `bin/login-log record` from shell or Python:

```
bin/login-log record <site> <status> [--detail TEXT] [--source NAME] [--port N]
```

| field | meaning |
|---|---|
| `ts`, `site`, `port` | when, which site (registrable domain), which Chrome |
| `status` | `signed_in` `already_signed_in` `session_restored` `token_renewed` (success); `bad_credentials` `no_credentials` `needs_2fa` `captcha` `no_login_form` `still_signed_out` `error` (failed sign-in); `signed_out` `cookie_jar_wiped` (observations) |
| `detail` | what the page or tool showed; never a credential |
| `source` | the script or job that wrote it |
| `cause` | derived: `password_rejected`, `no_saved_login`, `one_time_code`, `credential_store_timeout`, `credential_store_token_missing`, `robot_check`, `login_page_changed`, `login_not_sticking`, `session_lost`, `cookie_jar_wiped`, `chrome_down`, `page_error`, … (`CAUSES` in `lib/login-log.cjs`, each with a plain-words why and fix) |
| `needs_user` | only the user can fix it (a password, a code, a missing login) |
| `attempt` | `false` for observations; a reader that backs off after a refused password (`amazon-order-detail`) skips those rows |

Anything that signs in on its own, not only through `site-login` (a token
renewal, a direct reader), writes its outcomes here too. Then a failure is
visible in the same report and alert.

`bin/login-log report [--days 14] [--all] [--json]` lists each site with its latest
outcome, last success, failure count, causes and the fix.

## Alerts

`bin/login-log watch` (every 15 min from `chrome-cdp-watch.sh`, 09:00–22:00 in
the user's time zone) sends one alert per site per cause when a site's latest
outcome is a failure:

- needs the user → chat, intent `login-alert` (one batched message);
- anything else → the system channel, intent `login-failure`, to be root-caused.

A site that signs in again is reported once as recovered (system channel).
State: `data/login-watch-state.json`.

## Vault storage

`secrets/chrome-sessions/<profile dir>.vault` (and `.prev`), AES-256-GCM, key
`CHROME_SESSION_VAULT_KEY` in `.env` (created by the first sweep). Files are
0600 in a 0700 directory. Plaintext cookies never touch disk and are never
printed. Losing the key loses only the backup. Session-only cookies are not
kept.

`bin/chrome-session-vault status` shows live vs vault counts per Chrome;
`restore --port N [--site D]` puts the vault back by hand.
