// fake-geo.mjs — synthetic coordinates for location tests.
//
// A test that used a real day's fixes keeps their geometry (the metres and
// bearings between points, so every distance threshold is tested the same)
// but not their place: each point is written as metres east / north of an
// obviously fake origin and rebuilt here. The offset is read as an azimuthal
// equidistant one (distance hypot(e, n) along bearing atan2(e, n)), so the
// distance from the origin is exact and distances between points match the
// original day's to well under a centimetre per kilometre.
//
//   import { at, ORIGIN, loadRows } from "./fixtures/fake-geo.mjs";
//   const p = at(120, -45);   // { lat, lon } 120 m east, 45 m south of ORIGIN
//
// A fixture file stores `e_m` / `n_m` in place of a coordinate pair; loadRows
// turns them back into the keys the code under test reads. The Python twin is
// tests/fixtures/fake_geo.py.

import fs from "node:fs";

export const ORIGIN = Object.freeze({ lat: 12.3456, lon: -65.4321 });

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** { lat, lon } `eastM` metres east and `northM` metres north of `origin`. */
export function at(eastM, northM, origin = ORIGIN) {
  const d = Math.hypot(eastM, northM) / R;
  if (d === 0) return { lat: origin.lat, lon: origin.lon };
  const brg = Math.atan2(eastM, northM);
  const la1 = rad(origin.lat), lo1 = rad(origin.lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
  const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lon: deg(lo2) };
}

/** [lat, lon] for `at(eastM, northM)`. */
export const pair = (eastM, northM, origin = ORIGIN) => { const p = at(eastM, northM, origin); return [p.lat, p.lon]; };

/**
 * Rows from a fixture whose points are `e_m` / `n_m`: each comes back with
 * `latKey` / `lonKey` (default latitude / longitude) and without the offsets.
 */
export function loadRows(file, { latKey = "latitude", lonKey = "longitude" } = {}) {
  return JSON.parse(fs.readFileSync(file, "utf8")).map((r) => {
    if (r.e_m == null || r.n_m == null) return r;
    const { e_m, n_m, ...rest } = r;
    const p = at(e_m, n_m);
    return { ...rest, [latKey]: p.lat, [lonKey]: p.lon };
  });
}
