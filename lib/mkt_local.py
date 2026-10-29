"""mkt_local — the app-marketing module's per-installation settings, for its
Python collectors (bin/aso-*, bin/mkt-ga4-lp-pull.py, bin/reddit-organic-oauth.py).

Everything product-specific — the app's store ids, the locales it ships in,
the site, the report ids, the credential file names — lives in
agent/local/config/marketing.json (read through lib/places_local.py, the
kernel's Python twin of lib/instance.cjs). With no such file the module is OFF:
`configured()` is False and every collector says so and exits 0.

The Node collectors read the same file with localConfig("marketing").
"""

import os
import sys

import places_local

# Generic defaults. A real installation fills these in marketing.json.
DEFAULTS = {
    "product": "",            # the product's name, as the jobs write it
    "ios_app_id": "",         # App Store numeric id
    "ios_bundle_id": "",
    "android_package": "",
    # locale -> [iTunes country, Play lang, Play country]
    "locales": {"en-US": ["us", "en", "us"]},
    "venv": "",               # a virtualenv with the collectors' pip deps (its bin/python3 runs them)
    "python": "",             # or the interpreter itself, when it is not a venv
    "user_agent": "",         # polite UA for the public store search APIs
    "localized_subtitle_ok": {},      # locale -> [confirmed-localized subtitles, lowercased]
    "subtitle_english_markers": [],   # tokens that mark an iOS subtitle as left in English
    "asa_meta_file": "asa-meta.json",       # under the install's secrets/
    "asa_key_file": "asa-private.pem",
    "reddit_oauth": {},
}


def config():
    return places_local.local_config("marketing", DEFAULTS)


def configured(cfg=None):
    """On only when the installation names an app."""
    cfg = cfg or config()
    return bool(cfg.get("ios_app_id") or cfg.get("android_package"))


def data_path(*parts):
    return places_local.data_path(*parts)


def secrets_path(*parts):
    return os.path.join(places_local.install_root(), "secrets", *parts)


_TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def bin_path(name):
    """A sibling kernel tool, in the tree this module runs from."""
    return os.path.join(_TOOLS, "bin", name)


def python(cfg=None):
    """The interpreter that has the collectors' pip deps: config `python`, else
    `<venv>/bin/python3`, else "" (use the current one)."""
    cfg = cfg or config()
    if cfg.get("python"):
        return os.path.expanduser(cfg["python"])
    if cfg.get("venv"):
        return os.path.join(os.path.expanduser(cfg["venv"]), "bin", "python3")
    return ""


def ensure_modules(*modules):
    """Import the collector's pip dependencies; when they are missing from this
    interpreter, re-exec under the configured one (`python` / `venv`) once."""
    try:
        for m in modules:
            __import__(m)
        return True
    except ImportError:
        py = python()
        if py and os.path.exists(py) and os.path.realpath(py) != os.path.realpath(sys.executable) \
                and not os.environ.get("MKT_REEXEC"):
            os.environ["MKT_REEXEC"] = "1"
            os.execv(py, [py] + sys.argv)
        raise
