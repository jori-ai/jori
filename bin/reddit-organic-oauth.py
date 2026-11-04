#!/usr/bin/env python3
"""
reddit-organic-oauth.py — one-shot OAuth helper for the marketing module's
Reddit app (the account the outreach jobs comment as).

Runs the authorization_code + duration=permanent dance for a Reddit web app:
  1. Opens consent URL in browser (you authorize as the configured account)
  2. Catches the redirect to http://localhost:8080/callback
  3. Exchanges the code for an access_token + refresh_token
  4. Prints the refresh_token and stores it in 1Password under the configured
     item title

Everything account-specific is in agent/local/config/marketing.json
`reddit_oauth`: client_id_ref / client_secret_ref (1Password secret references
to the app's id and secret), refresh_item_title, vault, user_agent, scopes. Without
them this exits 1 and says what is missing.

Requirements:
  - Reddit app already registered at https://www.reddit.com/prefs/apps as a "web app"
    with redirect URI http://localhost:8080/callback
  - Client ID + secret stored in 1Password at the configured references
  - `op` CLI signed in
  - You logged into reddit.com as the outreach account in your default browser

Run by hand from your own Mac with the sandbox disabled (op needs filesystem access):
  reddit-organic-oauth.py
"""

import http.server
import json
import os
import secrets
import socketserver
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser

_BIN = os.path.dirname(os.path.realpath(globals().get("__file__") or sys.argv[0]))
sys.path.insert(0, os.path.join(os.path.dirname(_BIN), "lib"))
import mkt_local  # noqa: E402

# One Reddit web app per Reddit identity can serve both the Ads API and the
# organic API — scopes differ at OAuth grant time and refresh tokens are
# scope-bound, so the organic refresh token is stored as its own item.
_RO = mkt_local.config().get("reddit_oauth") or {}
CLIENT_ID_REF = _RO.get("client_id_ref", "")
CLIENT_SECRET_REF = _RO.get("client_secret_ref", "")
REFRESH_ITEM_TITLE = _RO.get("refresh_item_title", "")
VAULT = _RO.get("vault", "Dev")
REDIRECT_URI = "http://localhost:8080/callback"
SCOPES = _RO.get("scopes", "identity read submit edit history")
USER_AGENT = _RO.get("user_agent", "outreach-oauth/1.0")
PORT = 8080

received = {}


def op_read(ref):
    out = subprocess.run(
        ["op", "read", ref], capture_output=True, text=True, check=True
    )
    return out.stdout.strip()


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        received["code"] = params.get("code", [None])[0]
        received["state"] = params.get("state", [None])[0]
        received["error"] = params.get("error", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        if received["error"]:
            self.wfile.write(
                f"<h1>OAuth error: {received['error']}</h1>".encode()
            )
        else:
            self.wfile.write(
                b"<h1>OAuth code received.</h1><p>You can close this tab.</p>"
            )

    def log_message(self, format, *args):
        pass  # suppress default logging


def main():
    if not (CLIENT_ID_REF and CLIENT_SECRET_REF and REFRESH_ITEM_TITLE):
        print("reddit-organic-oauth: not configured — set agent/local/config/marketing.json "
              "reddit_oauth.{client_id_ref,client_secret_ref,refresh_item_title}", file=sys.stderr)
        sys.exit(1)
    print("Reading Reddit client credentials from 1Password...")
    try:
        client_id = op_read(CLIENT_ID_REF)
        client_secret = op_read(CLIENT_SECRET_REF)
    except subprocess.CalledProcessError as e:
        print(f"FAILED reading from 1Password: {e.stderr}", file=sys.stderr)
        print(
            "Make sure the app is registered and credentials are stored in 1Password as:",
            file=sys.stderr,
        )
        print(f"  {CLIENT_ID_REF}", file=sys.stderr)
        print(f"  {CLIENT_SECRET_REF}", file=sys.stderr)
        sys.exit(1)

    state = secrets.token_urlsafe(16)
    consent_url = (
        "https://www.reddit.com/api/v1/authorize?"
        + urllib.parse.urlencode(
            {
                "client_id": client_id,
                "response_type": "code",
                "state": state,
                "redirect_uri": REDIRECT_URI,
                "duration": "permanent",
                "scope": SCOPES,
            }
        )
    )

    print()
    print("Opening Reddit consent URL in your browser...")
    print("  ", consent_url)
    print()
    print(f"Listening for callback on {REDIRECT_URI} ...")
    print("(Press Ctrl+C to abort)")

    webbrowser.open(consent_url)

    with socketserver.TCPServer(("127.0.0.1", PORT), CallbackHandler) as httpd:
        httpd.handle_request()  # blocks until /callback hit once

    if received.get("error"):
        print(f"Reddit returned error: {received['error']}", file=sys.stderr)
        sys.exit(2)
    if not received.get("code"):
        print("No code in callback", file=sys.stderr)
        sys.exit(2)
    if received.get("state") != state:
        print(
            f"State mismatch (CSRF): expected {state}, got {received.get('state')}",
            file=sys.stderr,
        )
        sys.exit(2)

    code = received["code"]
    print(f"Got code: {code[:8]}... exchanging for refresh_token via curl...")

    # Use curl rather than urllib for the exchange — Reddit's token endpoint
    # returns 403 on urllib requests (probably bot fingerprinting on the
    # python-urllib UA chain even when Authorization+User-Agent headers are
    # explicitly set). curl works (same pattern as Reddit Ads OAuth in 2026-05).
    curl_proc = subprocess.run(
        [
            "curl",
            "-s",
            "-S",
            "-w",
            "\n__HTTP__:%{http_code}",
            "-X",
            "POST",
            "-u",
            f"{client_id}:{client_secret}",
            "-A",
            USER_AGENT,
            "--data-urlencode",
            "grant_type=authorization_code",
            "--data-urlencode",
            f"code={code}",
            "--data-urlencode",
            f"redirect_uri={REDIRECT_URI}",
            "https://www.reddit.com/api/v1/access_token",
        ],
        capture_output=True,
        text=True,
    )

    raw = curl_proc.stdout
    if "__HTTP__:" in raw:
        body_text, _, status = raw.rpartition("__HTTP__:")
        status = status.strip()
    else:
        body_text, status = raw, "?"

    if status != "200":
        print(
            f"Token exchange failed: HTTP {status} — {body_text.strip()}",
            file=sys.stderr,
        )
        sys.exit(3)

    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        print(f"Token endpoint returned non-JSON: {body_text!r}", file=sys.stderr)
        sys.exit(3)

    if "refresh_token" not in payload:
        print(f"No refresh_token in response: {payload}", file=sys.stderr)
        print(
            "Did you request duration=permanent? Did you grant all scopes?",
            file=sys.stderr,
        )
        sys.exit(3)

    refresh_token = payload["refresh_token"]
    access_token = payload.get("access_token", "<not shown>")
    scope_granted = payload.get("scope", "")

    print()
    print("SUCCESS")
    print(f"  scope granted:  {scope_granted}")
    print(f"  access_token:   {access_token[:16]}... (24h TTL, ignore)")
    print(f"  refresh_token:  {refresh_token[:16]}... (permanent, will store)")
    print()

    print("Storing refresh_token in 1Password...")
    # Try update first, create if missing
    create = subprocess.run(
        [
            "op",
            "item",
            "create",
            "--category",
            "password",
            "--vault",
            VAULT,
            "--title",
            REFRESH_ITEM_TITLE,
            f"password={refresh_token}",
        ],
        capture_output=True,
        text=True,
    )
    if create.returncode != 0 and "already exists" in (create.stderr or ""):
        edit = subprocess.run(
            [
                "op",
                "item",
                "edit",
                REFRESH_ITEM_TITLE,
                f"password={refresh_token}",
            ],
            capture_output=True,
            text=True,
        )
        if edit.returncode != 0:
            print(
                f"Refresh stored locally only; 1P edit failed: {edit.stderr}",
                file=sys.stderr,
            )
            print(f"\nManual save needed. refresh_token:\n  {refresh_token}")
            sys.exit(4)
        print(f"  updated 1Password item: {REFRESH_ITEM_TITLE}")
    elif create.returncode != 0:
        print(
            f"1P create failed: {create.stderr}",
            file=sys.stderr,
        )
        print(f"\nManual save needed. refresh_token:\n  {refresh_token}")
        sys.exit(4)
    else:
        print(f"  created 1Password item: {REFRESH_ITEM_TITLE}")

    print()
    print("Done. Verify by reading the item's password field with `op read`")
    print(f"  (vault {VAULT}, item {REFRESH_ITEM_TITLE}).")
    print()
    print("The Reddit outreach jobs read this credential from the item's `credential` field.")
    print("If 1Password stored it as `password`, add a `credential` field with the same value,")
    print("OR update the playbooks to read `password`. (1Password item templates vary.)")


if __name__ == "__main__":
    main()
