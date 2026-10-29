"""home-devices: the heartbeat sweep over a synthetic roster (fake sites, MACs,
IPs and camera names; every subprocess is stubbed — nothing is probed, no
device is touched, no mail is sent).

Covers: off when no roster; DOWN only after DOWN_AFTER failed sweeps and UP on
the first good one; the down_after_min hold; ARP proof by the device's own or
an alt MAC; a remote site's anchor gating the rest; camera connection matched
case-insensitively and the low-battery / recharged pair; cloud checks "not
judged" without a homectl; alerts to the instance owner (alert_to overrides).

Run: python3 tests/home-devices.test.py
"""
import contextlib
import datetime as dt
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "bin", "home-devices")

ROSTER = {
    "lock_cloud_script": "fake-lock.py",
    "ring_battery_alert_pct": 25,
    "sites": {
        "home": {"label": "Home", "kind": "router", "router_ssh": "root@192.0.2.1", "router_ip": "192.0.2.1", "ring_prefix": "hm "},
        "cabin": {"label": "Cabin", "kind": "remote", "ring_prefix": "cb ", "unreachable_cause": "Cause is one of: the cabin's internet or its gateway."},
    },
    "devices": [
        {"site": "home", "name": "Test router", "check": "router"},
        {"site": "home", "name": "Test lamp", "mac": "02:00:00:00:00:01"},
        {"site": "home", "name": "Test extender client", "mac": "02:00:00:00:00:02", "alt_macs": ["02:00:00:00:00:a2"]},
        {"site": "home", "name": "Test doorbell", "mac": "02:00:00:00:00:03", "down_after_min": 60},
        {"site": "home", "name": "Test lock", "check": "lock_cloud"},
        {"site": "cabin", "name": "Test anchor", "check": "remote", "anchor": True, "ip": "198.51.100.5", "ports": [443]},
        {"site": "cabin", "name": "Test switch", "check": "remote", "ip": "198.51.100.36", "ports": [80]},
        {"site": "cabin", "name": "Test camera", "check": "ring", "ring_name": "cb porch"},
    ],
    "ignore": {"02:00:00:00:00:99": "a phone"},
}
LEASES = {"02:00:00:00:00:01": "192.0.2.11", "02:00:00:00:00:02": "192.0.2.12", "02:00:00:00:00:03": "192.0.2.13"}


class Fake:
    """Stands in for subprocess.run: the router, ping, nc, the homectl python and email-send."""

    def __init__(self):
        self.lan = {ip: "ping" for ip in LEASES.values()}  # ip -> "ping" | "arp <mac>" | "none"
        self.remote_up = {"198.51.100.5": True, "198.51.100.36": True}
        self.ring = {"CB Porch": {"conn": "online", "battery": 80}}
        self.lock = True
        self.ssh_ok = True
        self.emails = []
        self.calls = []

    def __call__(self, argv, input=None, capture_output=False, text=False, timeout=None, cwd=None, errors=None):
        self.calls.append(argv)
        out, rc = "", 0
        exe = os.path.basename(argv[0])
        if exe == "ssh":
            cmd = argv[-1]
            if not self.ssh_ok:
                return Res(255, "", "ssh: connect timed out")
            if "dhcp.leases" in cmd:
                out = "".join(f"1700000000 {m} {ip} host{i} *\n" for i, (m, ip) in enumerate(LEASES.items()))
            else:
                out = "".join(f"{ip} {self.lan[ip]}\n" for ip in (input or "").split())
        elif exe == "ping":
            rc = 0 if self.remote_up.get(argv[-1], argv[-1] == "192.0.2.1") else 1
        elif exe == "nc":
            rc = 1
        elif exe == "python":
            code = argv[2]
            if "RingClient" in code:
                out = json.dumps(self.ring)
            else:
                out = json.dumps(self.lock)
        elif exe == "email-send":
            self.emails.append(argv)
        else:
            raise AssertionError(f"unexpected subprocess {argv}")
        return Res(rc, out, "")


class Res:
    def __init__(self, rc, out, err):
        self.returncode, self.stdout, self.stderr = rc, out, err


class HomeDevicesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.local = os.path.join(self.tmp, "local")
        self.install = os.path.join(self.tmp, "install")
        os.makedirs(os.path.join(self.local, "config"))
        os.makedirs(os.path.join(self.install, "bin"))
        # A homectl venv: bin/homectl -> <tree>/.venv/bin/homectl, python beside it.
        venv = os.path.join(self.tmp, "hc", ".venv", "bin")
        os.makedirs(venv)
        for f in ("homectl", "python"):
            open(os.path.join(venv, f), "w").close()
        os.symlink(os.path.join(venv, "homectl"), os.path.join(self.install, "bin", "homectl"))
        self.env = {k: os.environ.get(k) for k in ("JORI_HOME", "JORI_LOCAL_DIR", "HOMECTL_BIN", "JORI_OWNER_EMAIL", "JORI_TZ", "JORI_HOST", "JORI_HOST_LABEL", "HOME_DEVICES_EMAIL_SEND")}
        for k in self.env:
            os.environ.pop(k, None)
        os.environ["JORI_HOME"] = self.install
        os.environ["JORI_LOCAL_DIR"] = self.local
        os.environ["HOME_DEVICES_EMAIL_SEND"] = os.path.join(self.install, "bin", "email-send")
        self.write("instance.json", {"owner_email": "owner@example.com", "tz": "UTC", "host": "test-host", "host_label": "the test host"})
        self.write("config/home-devices.json", ROSTER)
        self.fake = Fake()
        self.t = dt.datetime(2026, 1, 5, 12, 0, tzinfo=dt.timezone.utc)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def write(self, rel, data):
        with open(os.path.join(self.local, rel), "w") as f:
            json.dump(data, f)

    def load(self):
        loader = importlib.machinery.SourceFileLoader("home_devices_under_test", SCRIPT)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        mod.subprocess.run = self.fake  # the module's own reference to subprocess
        mod.now_iso = lambda: self.t.isoformat(timespec="seconds")
        return mod

    def sweep(self, mod, minutes=2):
        mod.RING["data"] = "unfetched"
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            mod.cmd_sweep(type("A", (), {"dry_run": False})(), mod.roster_cfg())
        self.t += dt.timedelta(minutes=minutes)
        return out.getvalue()

    def state(self):
        with open(os.path.join(self.install, "data", "home-devices-state.json")) as f:
            return json.load(f)

    def subjects(self):
        return [a[a.index("--subject") + 1] for a in self.fake.emails]

    def test_off_without_roster(self):
        os.remove(os.path.join(self.local, "config", "home-devices.json"))
        mod = self.load()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            for cmd in ("sweep", "status", "unlisted"):
                sys.argv = ["home-devices", cmd]
                mod.main()
        self.assertEqual(out.getvalue().count("no home devices configured"), 3)
        self.assertEqual(self.fake.calls, [])

    def test_all_up_sends_nothing_and_writes_state(self):
        mod = self.load()
        self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        state = self.state()
        self.assertEqual({k: v["status"] for k, v in state["devices"].items()}, {d["name"]: "up" for d in ROSTER["devices"]})
        self.assertEqual(state["devices"]["Test lock"]["detail"], "cloud: connected")
        self.assertEqual(state["devices"]["Test camera"]["detail"], "Ring: online")

    def test_down_after_three_misses_then_back_up(self):
        mod = self.load()
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)
        self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        self.sweep(mod)
        self.assertEqual(self.subjects(), ["Offline: Home Test lamp"])
        argv = self.fake.emails[0]
        self.assertEqual(argv[argv.index("--to") + 1], "owner@example.com")
        body = argv[argv.index("--body") + 1]
        self.assertIn("Checked from the test host every 2 minutes", body)
        self.assertIn("Current view: ssh test-host ", body)
        self.fake.lan["192.0.2.11"] = "ping"
        self.sweep(mod)
        self.assertEqual(self.subjects()[-1], "Back online: Home Test lamp")

    def test_alert_to_overrides_owner(self):
        self.write("config/home-devices.json", {**ROSTER, "alert_to": "alerts@example.com"})
        mod = self.load()
        self.fake.lan["192.0.2.11"] = "none"
        for _ in range(3):
            self.sweep(mod)
        argv = self.fake.emails[0]
        self.assertEqual(argv[argv.index("--to") + 1], "alerts@example.com")

    def test_hold_suppresses_a_short_nap(self):
        mod = self.load()
        self.fake.lan["192.0.2.13"] = "none"
        for _ in range(5):  # 10 minutes of misses, under the 60-minute hold
            self.sweep(mod)
        self.fake.lan["192.0.2.13"] = "ping"
        self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        self.fake.lan["192.0.2.13"] = "none"
        for _ in range(3):
            self.sweep(mod, minutes=30)
        self.assertEqual(self.subjects(), ["Offline: Home Test doorbell"])

    def test_arp_proof_by_alt_mac_and_wrong_mac(self):
        mod = self.load()
        self.fake.lan["192.0.2.12"] = "arp 02:00:00:00:00:a2"
        self.fake.lan["192.0.2.11"] = "arp 02:00:00:00:00:77"
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test extender client"], (True, "192.0.2.12 ARP"))
        self.assertEqual(res["Test lamp"], (False, "192.0.2.11 answered by another MAC 02:00:00:00:00:77"))

    def test_router_unreachable_judges_nothing_behind_it(self):
        mod = self.load()
        self.fake.ssh_ok = False
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test router"], (True, "answers ping, SSH failed"))
        self.assertEqual(res["Test lamp"], (None, "router unreachable, not judged"))

    def test_remote_anchor_down_gates_the_site(self):
        mod = self.load()
        self.fake.remote_up["198.51.100.5"] = False
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test anchor"][0], False)
        self.assertEqual(res["Test switch"], (None, "site unreachable, not judged"))
        for _ in range(3):
            self.sweep(mod)
        self.assertEqual(self.subjects(), ["Offline: Cabin UNREACHABLE (Test anchor not answering)"])
        body = self.fake.emails[0][self.fake.emails[0].index("--body") + 1]
        self.assertIn("Cause is one of: the cabin's internet or its gateway.", body)

    def test_camera_offline_and_battery_pair(self):
        mod = self.load()
        self.fake.ring = {"CB Porch": {"conn": "offline", "battery": 20}}
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test camera"], (False, "Ring: offline"))
        mod.RING["data"] = "unfetched"
        self.sweep(mod)
        self.assertEqual(self.subjects(), ["Low battery: Cabin CB Porch 20%"])
        self.fake.ring = {"CB Porch": {"conn": "online", "battery": 27}}
        self.sweep(mod)
        self.assertEqual(len(self.fake.emails), 1)  # 27 < 25 + 5: not yet "recharged"
        self.fake.ring = {"CB Porch": {"conn": "online", "battery": 31}}
        self.sweep(mod)
        self.assertEqual(self.subjects()[-1], "Recharged: Cabin CB Porch")

    def test_cloud_checks_not_judged_without_homectl(self):
        os.remove(os.path.join(self.install, "bin", "homectl"))
        mod = self.load()
        self.assertEqual(mod.homectl_env(mod.roster_cfg()), (None, None))
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test lock"], (None, "cloud API unavailable"))
        self.assertEqual(res["Test camera"], (None, "Ring cloud unavailable"))

    def test_homectl_env_from_symlink(self):
        mod = self.load()
        py, cwd = mod.homectl_env(mod.roster_cfg())
        self.assertEqual(py, os.path.join(self.tmp, "hc", ".venv", "bin", "python"))
        self.assertEqual(cwd, os.path.join(self.tmp, "hc"))

    def test_no_recipient_prints_and_clears(self):
        self.write("instance.json", {"tz": "UTC"})
        mod = self.load()
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)
        self.sweep(mod)
        out = self.sweep(mod)
        self.assertIn("no alert recipient", out)
        self.assertEqual(self.fake.emails, [])
        state = self.state()
        self.assertEqual(state["pending"], [])

    def test_unlisted_skips_roster_and_ignored(self):
        mod = self.load()
        global LEASES
        saved = dict(LEASES)
        LEASES.update({"02:00:00:00:00:99": "192.0.2.99", "02:00:00:00:00:55": "192.0.2.55"})
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                mod.cmd_unlisted(None, mod.roster_cfg())
        finally:
            LEASES.clear()
            LEASES.update(saved)
        self.assertIn("02:00:00:00:00:55", out.getvalue())
        self.assertNotIn("02:00:00:00:00:99", out.getvalue())
        self.assertNotIn("02:00:00:00:00:01", out.getvalue())


if __name__ == "__main__":
    unittest.main()
