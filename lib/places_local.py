"""places_local — instance identity and per-installation config for the Python
Places tools (bin/places, lib/places_*.py).

A minimal Python twin of lib/instance.cjs: the same files, the same layering
(the caller's generic default, then agent/local/instance.json or
agent/local/config/<name>.json, then JORI_* environment variables), and the
same JORI_LOCAL_DIR override for tests. Dependency-free, nothing at import.
"""

import json
import os

_LIB = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_LIB)

_INSTANCE_ENV = {
    "owner_name": "JORI_OWNER_NAME",
    "owner_id": "JORI_OWNER_ID",
    "owner_email": "JORI_OWNER_EMAIL",
    "tz": "JORI_TZ",
}


def install_root():
    """The installation (where state lives): JORI_HOME, else ~/Dev/jori."""
    return os.environ.get("JORI_HOME") or os.path.expanduser("~/Dev/jori")


def data_path(*parts):
    return os.path.join(install_root(), "data", *parts)


def local_dir():
    return os.environ.get("JORI_LOCAL_DIR") or os.path.join(_TOOLS, "agent", "local")


def _read(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None


def instance():
    out = {"owner_name": "the user", "owner_id": "", "owner_email": "", "tz": ""}
    f = _read(os.path.join(local_dir(), "instance.json")) or {}
    for k, env in _INSTANCE_ENV.items():
        if f.get(k) not in (None, ""):
            out[k] = f[k]
        if os.environ.get(env):
            out[k] = os.environ[env]
    if not out["owner_id"]:
        name = str(out["owner_name"] or "").lower()
        if name.startswith("the "):
            name = name[4:]
        out["owner_id"] = "".join(c if c.isalnum() else "_" for c in name).strip("_") or "user"
    return out


def local_config(name, defaults=None):
    """defaults shallow-merged with agent/local/config/<name>.json (keys starting
    with "_" skipped; extend_<key> appends to a default list)."""
    out = dict(defaults or {})
    f = _read(os.path.join(local_dir(), "config", f"{name}.json"))
    if not isinstance(f, dict):
        return out
    for k, v in f.items():
        if k.startswith("_"):
            continue
        if k.startswith("extend_"):
            base = k[len("extend_"):]
            cur = out.get(base) if isinstance(out.get(base), list) else []
            out[base] = cur + (v if isinstance(v, list) else [v])
        else:
            out[k] = v
    return out
