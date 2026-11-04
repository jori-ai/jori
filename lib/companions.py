"""companions — the Python twin of lib/companions.js: who can be "with" the
user in the location log, and under which name.

  agent/local/config/companion-names.json
    self     the user's own names, never a companion (instance owner_name
             always counts too)
    aliases  Apple Photos face-tag / free-text name -> canonical companion name
  data/known-companions.json  {"names": [...]}
    the people the assistant already knows

Both are private and absent in a fresh install: every tag is kept as written
and nobody is a known companion. Dependency-free, nothing read at import.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402


def companion_names():
    """{"self": [...], "aliases": {...}}, read per call."""
    cfg = places_local.local_config("companion-names", {"self": [], "aliases": {}})
    self_names = [n for n in (cfg.get("self") or []) if n]
    owner = places_local.instance().get("owner_name")
    if owner and owner not in self_names:
        self_names.append(owner)
    aliases = cfg.get("aliases") if isinstance(cfg.get("aliases"), dict) else {}
    return {"self": self_names, "aliases": aliases}


def canonical_name(name, names=None):
    """The canonical companion name for a tag, or None for the user themself."""
    names = names or companion_names()
    if not name or name in names["self"]:
        return None
    return names["aliases"].get(name, name)


def known_companions_file():
    return places_local.data_path("known-companions.json")


def known_companions(path=None):
    """The names in data/known-companions.json ([] when absent or unreadable)."""
    d = places_local._read(path or known_companions_file())
    if isinstance(d, list):
        return d
    if isinstance(d, dict) and isinstance(d.get("names"), list):
        return d["names"]
    return []
