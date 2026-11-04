"""ports — Python reader for the local port registry in lib/ports.cjs.

The defaults are read out of lib/ports.cjs itself (its PORTS table), so there
is no second copy of a number. Same layering as the node module: the default,
then agent/local/config/ports.json, then JORI_PORT_<NAME>.

    from ports import port
    port("ops_health")   # 9093
"""

import os
import re

from places_local import local_config

_PORTS_CJS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ports.cjs")
_ROW = re.compile(r"^\s*([a-z_][a-z0-9_]*)\s*:\s*\[\s*(\d+)\s*,", re.M)


def defaults():
    with open(_PORTS_CJS) as fh:
        text = fh.read()
    start = text.index("const PORTS = {")
    end = text.index("};", start)
    return {name: int(n) for name, n in _ROW.findall(text[start:end])}


def port(name):
    table = defaults()
    if name not in table:
        raise KeyError(f"unknown port name: {name}")
    n = table[name]
    local = local_config("ports", {})
    if isinstance(local.get(name), int) and not isinstance(local.get(name), bool):
        n = local[name]
    env = os.environ.get(f"JORI_PORT_{name.upper()}", "")
    if env.isdigit():
        n = int(env)
    return n
