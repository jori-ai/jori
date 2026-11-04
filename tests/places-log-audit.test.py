"""places-log-audit.test.py — the Python call-log writer records the same audit
fields as lib/places-log.js (2026-10-20): who called (job / hum lane /
tick / session / process basenames, never arguments), what was asked, the SKU
and its list price, and refused calls while the budget cap is on.

Run: python3 tests/places-log-audit.test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
sys.path.insert(0, LIB)
import places_log  # noqa: E402


def _run(code, env_extra):
    env = {**os.environ, **env_extra}
    subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {LIB!r}); {code}"],
                   env=env, check=False, capture_output=True, text=True)


class AuditFields(unittest.TestCase):
    def test_price_and_sku(self):
        self.assertAlmostEqual(places_log.price_for("searchText", "enterprise_atmosphere"), 0.04)
        self.assertEqual(places_log.price_for("searchText", "essentials"), 0)
        self.assertEqual(places_log.sku_for("searchNearby", "enterprise"), "Places API Nearby Search Enterprise")
        self.assertEqual(places_log.sku_for("photoMedia", "photo"), "Places API Place Details Photos")

    def test_chain_never_records_arguments(self):
        ps = "\n".join([
            "   10     1 /usr/sbin/cron",
            "   20    10 env GOOGLE_PLACES_API_KEY=AIzaSECRET node /x/hum-harvest-all.mjs",
            "   30    20 /usr/bin/python3 /x/tools/bin/places at 1,2 coffee --key AIzaSECRET",
        ])
        chain = places_log.chain_from_ps(ps, 30)
        self.assertEqual(chain, "python3 places < env node")
        self.assertNotIn("SECRET", chain)

    def test_line_fields(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "calls.jsonl")
            env = {"PLACES_LOG_FILE": f, "JORI_JOB": "trigger-hum", "HUM_LANE": "nearby", "HUM_TICK_ID": "t-1"}
            _run("import places_log as p; p.log_call('places','searchText',mask='places.reviews',query='cafe',lat=12.345612,lon=-65.432112,radius=400)", env)
            _run("import places_log as p; p.log_call('places','searchText',mask='places.reviews',cached=True)", env)
            lines = [json.loads(x) for x in open(f)]
        live, cached = lines
        self.assertEqual(live["sku"], "Places API Text Search Enterprise + Atmosphere")
        self.assertEqual(live["est_usd"], 0.04)
        self.assertEqual((live["query"], live["lat"], live["lon"], live["radius"]), ("cafe", 12.3456, -65.4321, 400))
        self.assertEqual((live["job"], live["hum_lane"], live["tick"]), ("trigger-hum", "nearby", "t-1"))
        self.assertEqual(cached["est_usd"], 0)

    def test_guard_logs_a_refused_call(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "calls.jsonl")
            code = ("import places_guard as g; g.places_block_reason = lambda: 'over cap'; "
                    "g.assert_places_allowed('places', 'searchText', mask='places.reviews', query='bar')")
            _run(code, {"PLACES_LOG_FILE": f})
            lines = [json.loads(x) for x in open(f)]
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0]["blocked"])
        self.assertEqual(lines[0]["query"], "bar")
        self.assertEqual(lines[0]["est_usd"], 0)




class ClientGates(unittest.TestCase):
    """places_client.py — the Python door. Same gates as places-client.js."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pclient-py-")
        self._env = dict(os.environ)
        self.policy = {"allowed_hosts": [__import__("socket").gethostname().split(".")[0]],
                       "monthly_ceiling_usd": 0.10, "assumed_free_per_month": {"Places API Nearby Search Pro": 1},
                       "daily_live_caps": {"enterprise": {"location-segment": 1}}}
        self._write_policy()
        os.environ.update({"PLACES_POLICY_FILE": os.path.join(self.d, "policy.json"),
                           "PLACES_LEDGER_FILE": os.path.join(self.d, "ledger.json"),
                           "PLACES_BUDGET_STATE_FILE": os.path.join(self.d, "state.json"),
                           "PLACES_LOG_FILE": os.path.join(self.d, "calls.jsonl"),
                           "PLACES_TIER_COUNTS_FILE": os.path.join(self.d, "counts.json")})
        os.environ.pop("PLACES_LANE", None)
        import places_client
        self.pc = places_client

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def _write_policy(self):
        with open(os.path.join(self.d, "policy.json"), "w") as f:
            json.dump(self.policy, f)

    def test_free_allowance_then_list_price_then_ceiling(self):
        pf = self.pc.preflight
        self.assertEqual(pf("findme", "searchNearby", "pro")["cost"], 0)          # inside the assumed allowance
        self.assertEqual(pf("findme", "searchNearby", "pro")["cost"], 0.032)
        self.assertEqual(pf("findme", "searchNearby", "pro")["cost"], 0.032)
        with self.assertRaises(self.pc.PlacesRefused) as cm:                      # 0.064 + 0.04 > 0.10
            pf("x", "searchNearby", "enterprise_atmosphere")
        self.assertEqual(cm.exception.code, 5)
        with open(os.environ["PLACES_LEDGER_FILE"]) as f:
            led = json.load(f)
        self.assertEqual(led["skus"]["Places API Nearby Search Pro"]["calls"], 3)
        self.assertAlmostEqual(led["total_usd"], 0.064)

    def test_fail_closed(self):
        with open(os.environ["PLACES_LEDGER_FILE"], "w") as f:
            f.write("{broken")
        with self.assertRaises(self.pc.PlacesRefused) as cm:
            self.pc.preflight("x", "searchNearby", "pro")
        self.assertEqual(cm.exception.code, 6)
        self.policy["allowed_hosts"] = ["not-this-machine"]
        self._write_policy()
        os.unlink(os.environ["PLACES_LEDGER_FILE"])
        with self.assertRaises(self.pc.PlacesRefused) as cm:
            self.pc.preflight("x", "searchNearby", "pro")
        self.assertEqual(cm.exception.code, 6)

    def test_tier_opt_in_and_daily_cap(self):
        with self.assertRaises(self.pc.PlacesRefused) as cm:
            self.pc.preflight("places", "searchText", "enterprise")              # untagged: no opt-in
        self.assertEqual(cm.exception.code, 4)
        import places_guard
        places_guard.count_tier_call("location-segment", "enterprise")
        with self.assertRaises(self.pc.PlacesRefused) as cm:                      # cap 1, already used
            self.pc.preflight("location-segment", "searchText", "enterprise")
        self.assertEqual(cm.exception.code, 4)

    def test_refusal_is_logged_and_nothing_is_sent(self):
        sent = []
        real = self.pc.urllib.request.urlopen
        self.pc.urllib.request.urlopen = lambda *a, **k: sent.append(1)
        try:
            with self.assertRaises(self.pc.PlacesRefused):
                self.pc.post("places", "places:searchText", {"textQuery": "x"}, "places.reviews", "searchText",
                             api_key="k", query="x")
        finally:
            self.pc.urllib.request.urlopen = real
        self.assertEqual(sent, [])
        with open(os.environ["PLACES_LOG_FILE"]) as f:
            line = json.loads(f.read().strip().splitlines()[-1])
        self.assertTrue(line["blocked"])
        self.assertTrue(line["note"].startswith("refused 4"))


if __name__ == "__main__":
    unittest.main()
