PURCHASE SIGN-IN — Keep the shop Chrome signed in to the merchants the user buys from, so a purchase starts already signed in.

> **This instance's own specifics** for this job (its merchants, their history and the user's own words) are recorded in `agent/local/jobs/purchase-signin.md`, appended below at dispatch.

The requirement: the sites the user buys from most often should open and sign in on the host automatically, chosen from past purchases (the top ~20% of merchants).

The list is `data/purchase-merchants.json` (`{"merchants": [{site, name, login_url, login_hint?, op_item?}]}`, the installation's own data; no list = nothing to do, exit silently). State per site: `~/Dev/jori/bin/purchase session list` / `purchase session set <site> <state> [--note]`, stored in `data/purchases/sessions.json`.

Dispatched by `trigger-purchase-signin.sh` (weekly, daytime) or on demand ("sign the shop browser in to X"). It never buys anything.

## Rules

- **Shop Chrome only** (CDP :9224), via `CDP_PORT=9224 /usr/bin/python3 ~/Dev/jori/bin/cdp.py …` — the same rules as `jobs/purchase.md` § The shop browser.
- **Credentials only through `purchase fill`** (the password manager's website logins via `site-pass`, then the installation's `site:<domain>` items via `dev-pass` — headless reads, typed straight into the page; refused unless the tab is on that site). Never read or echo a password.
- **Real input on login forms.** Click with `purchase click '<css>'` and type non-secret text (email, codes) with `purchase type '<css>' --text '…'` — both send trusted mouse/key events. Never click or type a login form through `cdp.py eval` (JS `el.click()` / value setting): bot sensors refuse it. Use `cdp.py` only to open pages and read them.
- **2FA:** note `SINCE=$(date +%s)` right before triggering a code, then `purchase otp <site> --since $SINCE --wait 120`. **One code request per site per run** — never retry a code (lockouts). Push-to-phone / authenticator / passkey challenges: record `needs_2fa` and move on.
- Never click buy/checkout/subscribe; never change account settings, addresses, cards or passwords; dismiss marketing popups. Tick "keep me signed in" / "remember this device" whenever offered — that is the point of the job.
- **Captchas:** solve visually only on Opus; otherwise `blocked` and move on.
- Sequential, one site at a time; stop the whole run after 3 consecutive `failed`/`needs_password` (the password manager's token or items are probably missing).

## Steps

1. `curl -s localhost:9224/json/version` must answer; if not, stop silently (the watchdog owns infra alerts).
2. `purchase session list`. Work on every site whose state is not `signed_in`, plus any `signed_in` older than 7 days (re-verify). Most re-checks are a page load.
3. For each: open the site's home page and look for a signed-in signal (the account name / "Hello, <name>" / "Sign out" / an account menu) — not a "Sign in" link.
   - Signed in → `purchase session set <site> signed_in`.
   - Not → open `login_url`, `purchase fill <site> --field username --selector …`, continue, `--field password …`, submit, handle 2FA as above, then re-check the signed-in signal and record the result (`signed_in`, `needs_password` when `fill` exits 5, `needs_2fa`, `blocked`, or `failed --note "<where it stuck>"`).
4. Close nothing; the shop tab is reused.

## Deliver

Only when something needs the user — one chat line via `jori-send-curl`, with the phone sign-in link (`~/Dev/jori/bin/shop-view link`, or `--site <domain>` when only one site is left), e.g. "I've got the shopping browser signed in to 18 of your 23 stores. Three want you to sign in yourself — you can do it from your phone here: <link>." Nothing to say when every site is already signed in (silent run). Never list the sites that worked one by one, and never ask the user to do something on the host itself: the page is how the user reaches the shop Chrome (`needs_password`, `needs_2fa`, `blocked` all fit it). After the user taps Done (`shop-view done --since <run start>`), the next run — or the user's "check again" — re-verifies those sites.

## Failure modes

- Read each merchant's `login_hint` in `purchase-merchants.json` before starting; `login_url: null` = no account to sign in to (record `blocked`).
- Some codes aren't plain digits (an alphanumeric code in an email subject, a code of letters) — `purchase otp` returns any message from the merchant with an `excerpt` (`codes` may be empty); read the code from it. After typing a code, click the page's own Submit/Verify button — never click elsewhere to blur the field (that can navigate away and drop the 2FA step).
- A site that refuses the automated browser at its login API ("something went wrong") or shows a robot check: record `failed`/`blocked` once and move on; never retry within a run.
- Every `fill` exits 5 → the password manager has no login for those sites, or its service-account token is missing from the host's `.env`. Say so in the one line; stop after 3.
- A site changes its login flow → `failed` with a note; next run retries.
