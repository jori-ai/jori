"""overpass_client: sticky last-good mirror, backoff, deadline, all-in-backoff fallback.

Mirrors are fake URLs and urlopen is patched: no network. Health, log and
config files live in a temp dir.
Run: python3 tests/overpass-mirrors.test.py
"""
import json, os, socket, sys, tempfile, time, unittest, urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import overpass_client as oc

A, B, C = "https://a/api", "https://b/api", "https://c/api"


class Resp:
    def __init__(self, body): self.body = body
    def read(self): return json.dumps(self.body).encode()
    def __enter__(self): return self
    def __exit__(self, *a): return False


class OverpassClientTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        cfg = os.path.join(d, "cfg.json")
        json.dump({"endpoints": [A, B, C], "per_mirror_s": 5, "skip_failed_min": 2,
                   "skip_refused_min": 30, "skip_failed_max_min": 120}, open(cfg, "w"))
        self.p = [mock.patch.object(oc, "_CONFIG", cfg),
                  mock.patch.object(oc, "_HEALTH", os.path.join(d, "h.json")),
                  mock.patch.object(oc, "_LOG", os.path.join(d, "log.jsonl"))]
        for p in self.p: p.start()
        self.calls = []

    def tearDown(self):
        for p in self.p: p.stop()

    def opener(self, behaviour):
        def urlopen(req, timeout):
            self.calls.append((req.full_url, timeout))
            b = behaviour[req.full_url]
            if isinstance(b, Exception): raise b
            return Resp(b)
        return mock.patch("urllib.request.urlopen", side_effect=urlopen)

    def test_refused_primary_falls_through_and_backs_off(self):
        refused = urllib.error.URLError(ConnectionRefusedError(61, "refused"))
        with self.opener({A: refused, B: {"elements": [1]}, C: {"elements": []}}):
            self.assertEqual(oc.post("q")["elements"], [1])
            self.assertEqual([u for u, _ in self.calls], [A, B])
            self.calls.clear()
            oc.post("q")  # A in backoff, B sticky
            self.assertEqual([u for u, _ in self.calls], [B])
        h = json.load(open(oc._HEALTH))
        self.assertGreater(h[A]["skip_until"], time.time() + 29 * 60)
        self.assertIn("_last_success", h)

    def test_busy_backoff_doubles(self):
        busy = urllib.error.URLError(socket.timeout("timed out"))
        with self.opener({A: busy, B: busy, C: busy}):
            with self.assertRaises(RuntimeError): oc.post("q")
            first = json.load(open(oc._HEALTH))[A]["skip_until"]
            with self.assertRaises(RuntimeError): oc.post("q")  # all in backoff → all retried
        h = json.load(open(oc._HEALTH))
        self.assertEqual(h[A]["fails"], 2)
        self.assertGreater(h[A]["skip_until"] - first, 60)
        self.assertIn("_all_failed_since", h)

    def test_success_clears_record(self):
        busy = urllib.error.HTTPError(A, 429, "busy", {}, None)
        with self.opener({A: busy, B: {"elements": []}, C: {"elements": []}}):
            oc.post("q")
        with mock.patch.object(oc, "endpoints", return_value=[A]), \
                self.opener({A: {"elements": []}}):
            oc.post("q")
        self.assertNotIn("fails", json.load(open(oc._HEALTH))[A])

    def test_deadline_caps_each_attempt(self):
        with self.opener({A: {"elements": []}}), mock.patch.object(oc, "endpoints", return_value=[A]):
            oc.post("q", timeout_s=3)
        self.assertLessEqual(self.calls[0][1], 3)

    def test_non_overpass_body_is_a_failure(self):
        with self.opener({A: {"error": "x"}, B: {"elements": [2]}, C: {"elements": []}}):
            self.assertEqual(oc.post("q")["elements"], [2])


if __name__ == "__main__":
    unittest.main()
