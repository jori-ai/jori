#!/usr/bin/env python3
"""global_decay_drop keys on signal_per_ping and needs >= 4 delivered pings
in the 3d window (hum-i-20261018-04). Run: python3 tests/hum-metrics-collect-signal-per-ping.test.py"""
import importlib.machinery, importlib.util, os, unittest
from datetime import date

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_l = importlib.machinery.SourceFileLoader("hmc_spp", os.path.join(ROOT, "bin", "hum-metrics-collect"))
_s = importlib.util.spec_from_loader("hmc_spp", _l)
m = importlib.util.module_from_spec(_s)
_l.exec_module(m)


def row(d, raw, pings, **kw):
    r = {"date": d, "signal_score_raw": raw, "pings_delivered": pings,
         "signal_per_surfaced": 1.0, "surface_rate": 0.1, "ticks": 5, "lane_yield": {}}
    r.update(kw)
    return r


def prior(n=7):
    return [row(date(2026, 10, 10 - i).isoformat(), 4.0, 4) for i in range(n)]


class T(unittest.TestCase):
    def drops(self, today, daily):
        return [e for e in m.detect_decay({"daily": daily}, today) if e["type"] == "global_decay_drop"]

    def test_pooled_rolling(self):
        r = m.compute_rolling([row("2026-10-18", 1.0, 1), row("2026-10-17", 9.0, 9)],
                              date(2026, 10, 18), 3)
        self.assertEqual(r["signal_per_ping"], 1.0)
        self.assertEqual(r["pings_delivered"], 10)

    def test_small_n_does_not_fire(self):
        daily = prior() + [row("2026-10-17", 0.0, 1), row("2026-10-16", 0.0, 1)]
        self.assertEqual(self.drops(row("2026-10-18", 0.0, 1), daily), [])

    def test_fires_with_enough_pings(self):
        daily = prior() + [row("2026-10-17", 0.0, 2), row("2026-10-16", 0.0, 2)]
        ev = self.drops(row("2026-10-18", 0.0, 1), daily)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["metric"], "signal_per_ping")
        self.assertEqual(ev[0]["pings_3d"], 5)

    def test_legacy_rows_not_computable(self):
        legacy = [{"date": f"2026-10-{d:02d}", "signal_per_surfaced": 2.0, "surface_rate": 0.1}
                  for d in range(3, 18)]
        today = {"date": "2026-10-18", "signal_per_surfaced": 0.0, "surface_rate": 0.1, "ticks": 1, "lane_yield": {}}
        self.assertEqual(self.drops(today, legacy), [])


if __name__ == "__main__":
    unittest.main()
