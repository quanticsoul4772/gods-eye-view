#!/usr/bin/env python3
"""Decode the cloud-top height of one GOES ABI L2 ACHA file (ABI-L2-ACHAC,
-ACHAF or -ACHAM, netCDF-4) around a point into JSON for
scripts/goes-cloud-top-to-kml.mjs.

Each pixel keeps its fixed-grid scan angles (x, y in radians), its height and
its quality flag. Pixel positions are left as scan angles: the file's grid is
navigated to the ground, so a cloud top kilometres up appears displaced from
the point it is over, and the KML script places it along its line of sight.

The window is the block of pixels whose scan angles lie within the circle's
angular size of the centre's scan angles at the ground and at 20 km, so tops
seen from the side are included.

Output: {"format": 1, "platform", "scene", "file", "start", "end",
         "projection": {"heightM", "a", "b", "lon0"},
         "dx", "dy", "pixels": [[x, y, heightM or null, dqf or null], ...]}
dqf after the file's flag_meanings: 0 good, 1 marginal, 2 retrieval attempted,
3 bad, 4 opaque retrieval. Heights are geopotential metres from the
retrieval's model profile; null is no height, which in these files goes with
every flag but good and covers clear sky as well as failed retrievals. Times
are Unix seconds.

usage:
  python -I scripts/goes-acha-to-json.py FILE.nc --center LAT,LON --radius-km KM --out OUT.json
Requires: Python 3.11+, h5py, numpy.
"""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path

import h5py
import numpy as np


def unpack(var):
    raw = var[()]
    out = raw.astype('float64')
    fill = var.attrs.get('_FillValue')
    if fill is not None:
        out[raw == np.asarray(fill).astype(raw.dtype).ravel()[0]] = np.nan
    valid = var.attrs.get('valid_range')
    if valid is not None:
        low, high = np.asarray(valid).astype(raw.dtype).ravel()[:2]
        out[(raw < low) | (raw > high)] = np.nan
    scale, offset = var.attrs.get('scale_factor'), var.attrs.get('add_offset')
    if scale is not None:
        out *= float(np.asarray(scale).ravel()[0])
    if offset is not None:
        out += float(np.asarray(offset).ravel()[0])
    return out


def projection(f):
    p = f['goes_imager_projection'].attrs
    one = lambda name: float(np.asarray(p[name]).ravel()[0])
    sweep = p['sweep_angle_axis']
    if (sweep.decode() if isinstance(sweep, bytes) else sweep) != 'x':
        raise SystemExit('Only the GOES-R x sweep axis is supported')
    return {'heightM': one('perspective_point_height'), 'a': one('semi_major_axis'),
            'b': one('semi_minor_axis'), 'lon0': one('longitude_of_projection_origin')}


def scan_angles(proj, lat, lon, h):
    """Fixed-grid scan angles of a point at height h (m) above the ellipsoid."""
    a, b = proj['a'], proj['b']
    H = proj['heightM'] + a
    e2 = 1 - b * b / (a * a)
    phi, dlam = math.radians(lat), math.radians(lon - proj['lon0'])
    N = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    X = (N + h) * math.cos(phi) * math.cos(dlam)
    Y = (N + h) * math.cos(phi) * math.sin(dlam)
    Z = (N * (1 - e2) + h) * math.sin(phi)
    sx, sy, sz = H - X, -Y, Z
    return math.asin(-sy / math.sqrt(sx * sx + sy * sy + sz * sz)), math.atan(sz / sx)


def iso(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('file')
    parser.add_argument('--center', required=True)
    parser.add_argument('--radius-km', type=float, required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    lat0, lon0 = (float(v) for v in args.center.split(','))
    if not (args.radius_km > 0 and -90 <= lat0 <= 90 and -180 <= lon0 <= 180):
        raise SystemExit('Invalid --center or --radius-km')
    with h5py.File(args.file, 'r') as f:
        if 'HT' not in f:
            raise SystemExit('Not an ABI L2 cloud-top height (ACHA) file: no HT variable')
        proj = projection(f)
        xs, ys = unpack(f['x']), unpack(f['y'])
        dx, dy = abs(xs[1] - xs[0]), abs(ys[1] - ys[0])
        half = args.radius_km * 1000 / proj['heightM']
        corners = [scan_angles(proj, lat0, lon0, h) for h in (0, 20000)]
        x_lo, x_hi = min(c[0] for c in corners) - half, max(c[0] for c in corners) + half
        y_lo, y_hi = min(c[1] for c in corners) - half, max(c[1] for c in corners) + half
        cols = np.nonzero((xs >= x_lo) & (xs <= x_hi))[0]
        rows = np.nonzero((ys >= y_lo) & (ys <= y_hi))[0]
        if not len(cols) or not len(rows):
            raise SystemExit('The circle is outside this file\'s scene')
        ht = unpack(f['HT'])
        dqf_raw = f['DQF'][()]
        dqf_fill = f['DQF'].attrs.get('_FillValue')
        dqf_fill = None if dqf_fill is None else int(np.asarray(dqf_fill).ravel()[0])
        pixels = []
        for i in rows:
            for j in cols:
                h = ht[i, j]
                q = int(dqf_raw[i, j])
                pixels.append([round(float(xs[j]), 7), round(float(ys[i]), 7),
                               None if math.isnan(h) else round(float(h)),
                               None if q == dqf_fill else q])
        scene = f.attrs.get('scene_id', b'')
        out = {'format': 1, 'platform': f.attrs['platform_ID'].decode(),
               'scene': scene.decode() if isinstance(scene, bytes) else scene,
               'file': Path(args.file).name,
               'start': iso(f.attrs['time_coverage_start'].decode()),
               'end': iso(f.attrs['time_coverage_end'].decode()),
               'projection': proj, 'dx': dx, 'dy': dy, 'pixels': pixels}
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')))
    print(f"{out['platform']} {out['scene']}: {len(pixels)} pixels, "
          f"{sum(p[2] is not None for p in pixels)} with a cloud-top height.")


if __name__ == '__main__':
    main()
