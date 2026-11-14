"""home-devices: the heartbeat sweep over a synthetic roster (fake sites, MACs,
IPs and camera names; every subprocess is stubbed — nothing is probed, no
device is touched, no mail is sent).

Covers: off when no roster; DOWN only after DOWN_AFTER failed sweeps and UP on
the first good one; the down_after_min hold; a temporary down_after that lapses; ARP proof by the device's own or
an alt MAC; a device with no lease record found in the ARP table or at its last
good address (own MAC only), and "couldn't check" rather than DOWN when the
lease list itself is broken, while several devices failing at their addresses
still go DOWN together; a remote site's anchor gating the rest; camera
connection matched case-insensitively and the low-battery / recharged pair;
cloud checks "not judged" without a homectl; alerts to the instance owner
(alert_to overrides); the outage log (a row on DOWN, a completed row on UP, both
timed from the first missed sweep, nothing for a nap under the hold or a dry
run) and the `outages` report.

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
        self.leases = dict(LEASES)  # what the router's lease file holds
        self.neigh = []  # the router's `ip neigh` lines: "<ip> dev br-lan lladdr <mac> <STATE>"
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
                out = "".join(f"1700000000 {m} {ip} host{i} *\n" for i, (m, ip) in enumerate(self.leases.items()))
            elif cmd.startswith("ip neigh show dev"):
                out = "".join(line + "\n" for line in self.neigh)
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

    def test_down_after_lowers_the_bar_until_it_lapses(self):
        roster = json.loads(json.dumps(ROSTER))
        roster["devices"][1].update(down_after=1, down_after_until=(self.t + dt.timedelta(minutes=5)).isoformat())
        self.write("config/home-devices.json", roster)
        mod = self.load()
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)  # one miss inside the window is enough
        self.assertEqual(self.subjects(), ["Offline: Home Test lamp"])
        self.fake.lan["192.0.2.11"] = "ping"
        self.sweep(mod)
        self.sweep(mod)  # now past the window
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)
        self.sweep(mod)
        self.assertEqual(len(self.fake.emails), 2)  # Offline, Back online; back on three misses
        self.sweep(mod)
        self.assertEqual(self.subjects()[-1], "Offline: Home Test lamp")

    def test_arp_proof_by_alt_mac_and_wrong_mac(self):
        mod = self.load()
        self.fake.lan["192.0.2.12"] = "arp 02:00:00:00:00:a2"
        self.fake.lan["192.0.2.11"] = "arp 02:00:00:00:00:77"
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test extender client"], (True, "192.0.2.12 ARP"))
        self.assertEqual(res["Test lamp"], (False, "192.0.2.11 answered by another MAC 02:00:00:00:00:77"))

    def test_missing_lease_falls_back_to_the_arp_table(self):
        # dnsmasq restarted and lost two records; both devices are still on the LAN.
        mod = self.load()
        del self.fake.leases["02:00:00:00:00:01"]
        del self.fake.leases["02:00:00:00:00:02"]
        self.fake.lan["192.0.2.21"] = "ping"
        self.fake.lan["192.0.2.22"] = "ping"
        self.fake.neigh = [
            "192.0.2.21 dev br-lan lladdr 02:00:00:00:00:01 REACHABLE",
            "192.0.2.99 dev br-lan lladdr 02:00:00:00:00:a2 STALE",  # an older address of the extender
            "192.0.2.22 dev br-lan lladdr 02:00:00:00:00:a2 REACHABLE",  # the fresh one wins
            "fe80::1 dev br-lan lladdr 02:00:00:00:00:03 REACHABLE",  # IPv6 is no evidence
        ]
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test lamp"], (True, "192.0.2.21 ping (no lease record, from ARP table)"))
        self.assertEqual(res["Test extender client"], (True, "192.0.2.22 ping (no lease record, from ARP table)"))
        self.assertEqual(res["Test doorbell"], (True, "192.0.2.13 ping"))  # still has its lease

    def test_missing_lease_and_no_usable_arp_entry_is_still_down(self):
        mod = self.load()
        self.fake.neigh = ["192.0.2.31 dev br-lan lladdr 02:00:00:00:00:03 FAILED"]
        # One record missing at a time: a lease list missing two of these three
        # devices reads as broken (test_broken_lease_list_with_no_trace_is_not_judged).
        for mac, name in (("02:00:00:00:00:01", "Test lamp"), ("02:00:00:00:00:03", "Test doorbell")):
            self.fake.leases = dict(LEASES)
            del self.fake.leases[mac]
            self.assertEqual(mod.check_all(mod.roster_cfg())[name], (False, "no DHCP lease"))

    def test_missing_lease_with_a_dead_arp_entry_is_down(self):
        mod = self.load()
        del self.fake.leases["02:00:00:00:00:01"]
        self.fake.lan["192.0.2.41"] = "none"
        self.fake.neigh = ["192.0.2.41 dev br-lan lladdr 02:00:00:00:00:01 STALE"]
        res = mod.check_all(mod.roster_cfg())
        self.assertEqual(res["Test lamp"], (False, "192.0.2.41 no ping, no ARP (no lease record, from ARP table)"))

    def test_empty_lease_list_devices_answer_at_their_last_address(self):
        # dnsmasq restarted with an empty lease list and the ARP table has
        # nothing for them; each device still answers, with its own MAC (or the
        # extender's), at the address it had when last judged up.
        mod = self.load()
        self.sweep(mod)
        self.assertEqual(self.state()["devices"]["Test lamp"]["ip"], "192.0.2.11")
        self.fake.leases = {}
        self.fake.lan["192.0.2.11"] = "ping 02:00:00:00:00:01"
        self.fake.lan["192.0.2.12"] = "arp 02:00:00:00:00:a2"
        self.fake.lan["192.0.2.13"] = "arp 02:00:00:00:00:03"
        for _ in range(5):
            self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        devs = self.state()["devices"]
        for name in ("Test lamp", "Test extender client", "Test doorbell"):
            self.assertEqual((devs[name]["status"], devs[name]["fails"]), ("up", 0), name)
        self.assertEqual(devs["Test lamp"]["detail"], "192.0.2.11 ping (no lease record, at its last good address)")
        self.assertEqual(devs["Test extender client"]["detail"], "192.0.2.12 ARP (no lease record, at its last good address)")
        self.assertEqual(devs["Test doorbell"]["ip"], "192.0.2.13")

    def test_broken_lease_list_with_no_trace_is_not_judged(self):
        # A state file from before last good addresses were kept: the lamp had
        # missed one sweep. Then the lease list comes back empty and nothing
        # else knows where the devices are.
        os.makedirs(os.path.join(self.install, "data"))
        with open(os.path.join(self.install, "data", "home-devices-state.json"), "w") as f:
            json.dump({"devices": {"Test lamp": {"status": "up", "fails": 1, "failing_since": "2026-01-05T11:58:00+00:00",
                                                 "detail": "192.0.2.11 no ping, no ARP", "last_seen": "2026-01-05T11:56:00+00:00"}},
                       "pending": []}, f)
        mod = self.load()
        self.fake.leases = {}
        for _ in range(5):
            self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        devs = self.state()["devices"]
        want = "couldn't check: the router's lease list is missing 3 of 3 devices (DHCP restart?)"
        for name in ("Test lamp", "Test extender client", "Test doorbell"):
            self.assertEqual((devs[name]["status"], devs[name]["detail"]), ("up", want), name)
        self.assertEqual(devs["Test lamp"]["fails"], 1)  # not counted while not judged
        self.assertEqual(devs["Test router"]["detail"], "SSH OK")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            mod.cmd_status(None, mod.roster_cfg())
        line = next(ln for ln in out.getvalue().splitlines() if "Test lamp" in ln)
        self.assertEqual(line.split()[0], "??", line)
        self.assertIn(want, line)

    def test_intact_lease_list_several_silent_devices_still_go_down(self):
        # A real outage (an extender losing power) takes several devices down
        # at once; their leases are intact, so each is a miss as always.
        mod = self.load()
        for ip in LEASES.values():
            self.fake.lan[ip] = "none"
        self.sweep(mod, minutes=30)  # 30-minute steps clear the doorbell's 60-minute hold too
        self.sweep(mod, minutes=30)
        self.assertEqual(self.fake.emails, [])
        self.sweep(mod, minutes=30)
        self.assertEqual(self.subjects(), ["Offline: Home Test lamp; Home Test extender client; Home Test doorbell"])

    def test_one_missing_lease_is_not_a_broken_lease_list(self):
        mod = self.load()
        del self.fake.leases["02:00:00:00:00:01"]
        for _ in range(3):
            self.sweep(mod)
        self.assertEqual(self.subjects(), ["Offline: Home Test lamp"])
        self.assertEqual(self.state()["devices"]["Test lamp"]["detail"], "no DHCP lease")

    def test_long_down_devices_do_not_make_the_lease_list_look_broken(self):
        # Three devices gone for days have no leases; the list is otherwise
        # intact. The lamp, up until now, loses its lease with no trace: that is
        # one of the three devices we expect in the list, so it is a miss.
        gone = [{"site": "home", "name": f"Test gone {i}", "mac": f"02:00:00:00:00:0{i}"} for i in (4, 5, 6)]
        self.write("config/home-devices.json", {**ROSTER, "devices": ROSTER["devices"] + gone})
        os.makedirs(os.path.join(self.install, "data"))
        down = {"status": "down", "fails": 500, "since": "2026-01-01T00:00:00+00:00", "failing_since": "2026-01-01T00:00:00+00:00", "detail": "no DHCP lease"}
        with open(os.path.join(self.install, "data", "home-devices-state.json"), "w") as f:
            json.dump({"devices": {**{g["name"]: dict(down) for g in gone}, "Test lamp": {"status": "up", "fails": 0}}, "pending": []}, f)
        mod = self.load()
        del self.fake.leases["02:00:00:00:00:01"]
        self.sweep(mod)
        self.sweep(mod)
        self.assertEqual(self.fake.emails, [])
        self.sweep(mod)
        self.assertEqual(self.subjects(), ["Offline: Home Test lamp"])
        devs = self.state()["devices"]
        self.assertEqual((devs["Test lamp"]["status"], devs["Test lamp"]["detail"]), ("down", "no DHCP lease"))
        self.assertEqual({devs[g["name"]]["status"] for g in gone}, {"down"})

    def test_last_address_answered_by_another_mac_is_not_proof(self):
        mod = self.load()
        self.sweep(mod)  # all up: their addresses are remembered
        del self.fake.leases["02:00:00:00:00:01"]  # one of three missing: the lease list is fine
        moved = (False, "no DHCP lease (its last address 192.0.2.11 now answers with another MAC 02:00:00:00:00:77)")
        for answer in ("arp 02:00:00:00:00:77", "ping 02:00:00:00:00:77"):
            self.fake.lan["192.0.2.11"] = answer
            self.assertEqual(mod.check_all(mod.roster_cfg(), self.state())["Test lamp"], moved)
        # With the lease list broken, the same answer is "couldn't check", never up.
        self.fake.leases = {}
        self.fake.lan["192.0.2.12"] = "ping 02:00:00:00:00:02"
        self.fake.lan["192.0.2.13"] = "ping 02:00:00:00:00:03"
        res = mod.check_all(mod.roster_cfg(), self.state())
        self.assertEqual(res["Test lamp"], (None, "couldn't check: the router's lease list is missing 3 of 3 devices (DHCP restart?)"))
        self.assertEqual(res["Test doorbell"], (True, "192.0.2.13 ping (no lease record, at its last good address)"))
        # A ping there with no MAC shown proves something answers, not what.
        self.fake.lan["192.0.2.11"] = "ping"
        self.assertEqual(mod.check_all(mod.roster_cfg(), self.state())["Test lamp"],
                         (None, "couldn't check: something answers ping at its last address 192.0.2.11, but the router showed no MAC"))
        # Nothing answering there at all is a miss, as at a leased address.
        self.fake.lan["192.0.2.11"] = "none"
        self.assertEqual(mod.check_all(mod.roster_cfg(), self.state())["Test lamp"],
                         (False, "192.0.2.11 no ping, no ARP (no lease record, at its last good address)"))

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
        self.fake.leases.update({"02:00:00:00:00:99": "192.0.2.99", "02:00:00:00:00:55": "192.0.2.55"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            mod.cmd_unlisted(None, mod.roster_cfg())
        self.assertIn("02:00:00:00:00:55", out.getvalue())
        self.assertNotIn("02:00:00:00:00:99", out.getvalue())
        self.assertNotIn("02:00:00:00:00:01", out.getvalue())

    def outage_rows(self):
        try:
            with open(os.path.join(self.install, "data", "home-devices-outages.jsonl")) as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []

    def outages_report(self, mod, **kw):
        out = io.StringIO()
        args = type("A", (), {"device": kw.get("device"), "days": kw.get("days", 100000)})()
        with contextlib.redirect_stdout(out):
            mod.cmd_outages(args, mod.roster_cfg())
        return out.getvalue()

    def test_outage_log_rows_down_then_recovered_from_first_miss(self):
        mod = self.load()
        self.sweep(mod)  # 12:00 all up
        self.fake.lan["192.0.2.11"] = "none"
        for _ in range(3):  # first miss 12:02, DOWN at the third, 12:06
            self.sweep(mod)
        rows = self.outage_rows()
        self.assertEqual(rows, [{"device": "Test lamp", "site": "Home", "down_at": "2026-01-05T12:02:00+00:00",
                                 "up_at": None, "duration_seconds": None, "last_seen": "2026-01-05T12:00:00+00:00"}])
        self.sweep(mod)  # 12:08 still down: no new row
        self.assertEqual(len(self.outage_rows()), 1)
        self.fake.lan["192.0.2.11"] = "ping"
        self.sweep(mod)  # 12:10 back
        rows = self.outage_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1], {"device": "Test lamp", "site": "Home", "down_at": "2026-01-05T12:02:00+00:00",
                                   "up_at": "2026-01-05T12:10:00+00:00", "duration_seconds": 480,
                                   "last_seen": "2026-01-05T12:00:00+00:00"})

    def test_outage_log_uses_failing_since_under_the_lowered_bar(self):
        roster = json.loads(json.dumps(ROSTER))
        roster["devices"][1].update(down_after=1, down_after_until=(self.t + dt.timedelta(hours=1)).isoformat())
        self.write("config/home-devices.json", roster)
        mod = self.load()
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)  # one miss at 12:00 is a drop
        self.fake.lan["192.0.2.11"] = "ping"
        self.sweep(mod)  # back at 12:02
        rows = self.outage_rows()
        self.assertEqual([(r["down_at"], r["up_at"], r["duration_seconds"]) for r in rows],
                         [("2026-01-05T12:00:00+00:00", None, None),
                          ("2026-01-05T12:00:00+00:00", "2026-01-05T12:02:00+00:00", 120)])

    def test_outage_log_ignores_a_nap_under_the_hold_and_a_dry_run(self):
        mod = self.load()
        self.fake.lan["192.0.2.13"] = "none"
        for _ in range(5):  # under the doorbell's 60-minute hold
            self.sweep(mod)
        self.fake.lan["192.0.2.13"] = "ping"
        self.sweep(mod)
        self.assertEqual(self.outage_rows(), [])
        self.fake.lan["192.0.2.11"] = "none"
        self.sweep(mod)
        self.sweep(mod)
        with contextlib.redirect_stdout(io.StringIO()):
            mod.cmd_sweep(type("A", (), {"dry_run": True})(), mod.roster_cfg())  # the third miss, probed only
        self.assertEqual(self.outage_rows(), [])

    def test_outages_report_counts_median_longest_and_still_down(self):
        mod = self.load()
        path = os.path.join(self.install, "data", "home-devices-outages.jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        base = dt.datetime(2026, 1, 5, 0, 0, tzinfo=dt.timezone.utc)

        def row(dev, start_min, mins, last_seen=None):
            d = base + dt.timedelta(minutes=start_min)
            up = None if mins is None else (d + dt.timedelta(minutes=mins)).isoformat()
            return {"device": dev, "site": "Home", "down_at": d.isoformat(), "up_at": up,
                    "duration_seconds": None if mins is None else mins * 60, "last_seen": last_seen}

        rows = [row("Test lamp", 0, None), row("Test lamp", 0, 6),  # one drop: open row, then its recovered row
                row("Test lamp", 60, 10), row("Test lamp", 120, 20),
                row("Test lamp", 300, None),  # still down
                row("Test lock", 30, 4)]
        with open(path, "w") as f:
            f.write("not json\n" + "".join(json.dumps(r) + "\n" for r in rows))
        out = self.outages_report(mod)
        self.assertIn("Home Test lamp: 4 drops (1 still down)", out)
        self.assertIn("total 36m, median 10m, longest 20m", out)
        self.assertIn("still down (", out)
        self.assertIn("Home Test lock: 1 drop\n", out)
        only = self.outages_report(mod, device="lock")
        self.assertIn("Test lock", only)
        self.assertNotIn("Test lamp", only)
        self.assertIn("no drops logged", self.outages_report(mod, days=1))

    def test_outages_report_with_no_log(self):
        mod = self.load()
        self.assertIn("no drops logged", self.outages_report(mod))


if __name__ == "__main__":
    unittest.main()
