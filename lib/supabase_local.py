"""supabase_local — this installation's Supabase REST base and service key for
the Python tools, the twin of lib/instance.cjs supabaseUrl() and the Node
bins' .env read.

  supabase_url()   SUPABASE_URL, else https://<supabase_project>.supabase.co
                   (JORI_SUPABASE_PROJECT, else agent/local/instance.json
                   `supabase_project`), else "" (not configured)
  service_key()    SUPABASE_SERVICE_ROLE_KEY from the environment, else from
                   the installation's .env, else None (not configured)
  env_value(name)  the same lookup for any other variable
  home_tz()        the home zone: instance().tz (JORI_TZ / instance.json
                   `tz`), else the host's zone, else "UTC"
  rest_get(path_and_query, timeout)  GET <url>/rest/v1/<path_and_query> as
                   parsed JSON; raises RuntimeError when not configured

Dependency-free, nothing read at import, so a fresh install with no database
imports it cleanly and each caller decides what "not configured" means.
"""

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402


def supabase_url():
    if os.environ.get("SUPABASE_URL"):
        return os.environ["SUPABASE_URL"].rstrip("/")
    project = os.environ.get("JORI_SUPABASE_PROJECT")
    if not project:
        f = places_local._read(os.path.join(places_local.local_dir(), "instance.json")) or {}
        project = f.get("supabase_project") or ""
    return f"https://{project}.supabase.co" if project else ""


def home_tz():
    tz = places_local.instance().get("tz")
    if tz:
        return tz
    try:
        link = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in link:
            return link.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    return "UTC"


def env_file():
    return os.path.join(places_local.install_root(), ".env")


def env_value(name):
    """`name` from the environment, else from the installation's .env, else None."""
    if os.environ.get(name):
        return os.environ[name]
    try:
        with open(env_file()) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip("'\"") or None
    except OSError:
        return None
    return None


def service_key():
    return env_value("SUPABASE_SERVICE_ROLE_KEY")


def headers(key=None):
    key = key or service_key()
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def rest_get(path_and_query, timeout=10):
    base, key = supabase_url(), service_key()
    if not base or not key:
        raise RuntimeError("Supabase not configured (supabase_project / SUPABASE_SERVICE_ROLE_KEY)")
    req = urllib.request.Request(f"{base}/rest/v1/{path_and_query.lstrip('/')}", headers=headers(key))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())
