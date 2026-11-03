#!/usr/bin/env python3
"""Decode GOES GLM L2 LCFA granules (OR_GLM-L2-LCFA_*.nc) into one JSON file of
the events, groups and flashes inside a circle and time window, for
scripts/glm-to-kml.mjs.

The granules are netCDF-4 (HDF5). Packed variables carry _Unsigned, scale_factor
and add_offset; times are offsets from the base in each variable's units
("seconds since 2026-11-01 17:44:00.000"). Event, group and flash ids are unique
only within one granule, so ids are written as "<granule index>:<id>".

Event positions are where GLM's line of sight meets its lightning ellipsoid (an
assumed cloud-top surface), not ground positions; this script does not move them.

Output: {"format": 1, "platform": "G19", "granules": [names],
         "window": {"start", "end", "lat", "lon", "radiusKm"},
         "events": [[t, lat, lon, energyJ, groupId], ...],
         "groups": {groupId: {"t", "areaM2", "energyJ", "quality", "flash", "events"}},
         "flashes": {flashId: {"tFirst", "tLast", "areaM2", "energyJ", "quality"}}}
Times are Unix seconds. Groups and flashes are kept when any of their events is.

usage:
  python -I scripts/glm-lcfa-to-json.py GRANULE.nc [...] --center LAT,LON --radius-km KM
      [--start ISO --end ISO] --out OUT.json
Requires: h5py, numpy.
"""
import argparse
from datetime import datetime, timezone
import json
import math
import re
from pathlib import Path

import h5py
import numpy as np

EARTH_KM = 6371.0088


def unpack(var):
    raw = var[()]
    if var.attrs.get('_Unsigned', b'') in (b'true', 'true') and raw.dtype.kind == 'i':
        raw = raw.view(raw.dtype.str.replace('i', 'u'))
    out = raw.astype('float64')
    fill = var.attrs.get('_FillValue')
    if fill is not None:
        fill = np.asarray(fill).astype(raw.dtype)
        out[raw == fill] = np.nan
    valid = var.attrs.get('valid_range')
    if valid is not None:
        low, high = np.asarray(valid).astype(raw.dtype).ravel()[:2]
        out[(raw < low) | (raw > high)] = np.nan
    scale = var.attrs.get('scale_factor')
    offset = var.attrs.get('add_offset')
    if scale is not None:
        out *= float(np.asarray(scale).ravel()[0])
    if offset is not None:
        out += float(np.asarray(offset).ravel()[0])
    return out


def ids(var):
    raw = var[()]
    if var.attrs.get('_Unsigned', b'') in (b'true', 'true') and raw.dtype.kind == 'i':
        raw = raw.view(raw.dtype.str.replace('i', 'u'))
    return raw.astype('int64')


def times(var):
    units = var.attrs['units']
    units = units.decode() if isinstance(units, bytes) else units
    match = re.fullmatch(r'seconds since (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)', units)
    if not match:
        raise ValueError(f'Unexpected time units: {units}')
    base = datetime.fromisoformat(match[1]).replace(tzinfo=timezone.utc).timestamp()
    return base + unpack(var)


def distance_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(a))


def iso_seconds(text):
    moment = datetime.fromisoformat(text.replace('Z', '+00:00'))
    if moment.tzinfo is None:
        raise SystemExit(f'Time needs a zone (Z or +hh:mm): {text}')
    return moment.timestamp()


def flags(var):
    """Integer flags as a list, with the declared fill value as None."""
    raw = var[()]
    fill = var.attrs.get('_FillValue')
    missing = np.zeros(raw.shape, bool) if fill is None else raw == np.asarray(fill).astype(raw.dtype).ravel()[0]
    values = ids(var)
    return [None if gone else int(v) for v, gone in zip(values, missing)]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('granules', nargs='+')
    parser.add_argument('--center', required=True)
    parser.add_argument('--radius-km', type=float, required=True)
    parser.add_argument('--start')
    parser.add_argument('--end')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    lat0, lon0 = (float(v) for v in args.center.split(','))
    start = iso_seconds(args.start) if args.start else -math.inf
    end = iso_seconds(args.end) if args.end else math.inf
    if not (args.radius_km > 0 and -90 <= lat0 <= 90 and -180 <= lon0 <= 180 and start < end):
        raise SystemExit('Invalid --center, --radius-km or time window')

    events, groups, flashes, names, platforms = [], {}, {}, [], set()
    for index, path in enumerate(sorted(args.granules)):
        with h5py.File(path, 'r') as f:
            names.append(Path(path).name)
            platforms.add(f.attrs['platform_ID'].decode())
            if int(f['event_count'][()]) == 0:
                continue
            e_t = times(f['event_time_offset'])
            e_lat, e_lon = unpack(f['event_lat']), unpack(f['event_lon'])
            keep = (distance_km(lat0, lon0, e_lat, e_lon) <= args.radius_km) & (e_t >= start) & (e_t <= end)
            if not keep.any():
                continue
            e_energy, e_group = unpack(f['event_energy']), ids(f['event_parent_group_id'])
            g_id, g_flash = ids(f['group_id']), ids(f['group_parent_flash_id'])
            g_t, g_area = times(f['group_time_offset']), unpack(f['group_area'])
            g_energy, g_quality = unpack(f['group_energy']), flags(f['group_quality_flag'])
            g_events = dict(zip(*np.unique(e_group, return_counts=True)))
            f_id = ids(f['flash_id'])
            f_first, f_last = times(f['flash_time_offset_of_first_event']), times(f['flash_time_offset_of_last_event'])
            f_area, f_energy, f_quality = unpack(f['flash_area']), unpack(f['flash_energy']), flags(f['flash_quality_flag'])
            g_row = {int(g): i for i, g in enumerate(g_id)}
            f_row = {int(fl): i for i, fl in enumerate(f_id)}
            for i in np.nonzero(keep)[0]:
                group = int(e_group[i])
                events.append([round(float(e_t[i]), 4), round(float(e_lat[i]), 5), round(float(e_lon[i]), 5),
                               None if math.isnan(e_energy[i]) else float(e_energy[i]), f'{index}:{group}'])
                key = f'{index}:{group}'
                if key in groups:
                    continue
                g = g_row[group]
                flash = int(g_flash[g])
                groups[key] = {'t': round(float(g_t[g]), 4),
                               'areaM2': None if math.isnan(g_area[g]) else float(g_area[g]),
                               'energyJ': None if math.isnan(g_energy[g]) else float(g_energy[g]),
                               'quality': g_quality[g], 'flash': f'{index}:{flash}',
                               'events': int(g_events[group])}
                fkey = f'{index}:{flash}'
                if fkey not in flashes:
                    r = f_row[flash]
                    flashes[fkey] = {'tFirst': round(float(f_first[r]), 4), 'tLast': round(float(f_last[r]), 4),
                                     'areaM2': None if math.isnan(f_area[r]) else float(f_area[r]),
                                     'energyJ': None if math.isnan(f_energy[r]) else float(f_energy[r]),
                                     'quality': f_quality[r]}
    if len(platforms) > 1:
        raise SystemExit(f'Granules from more than one satellite: {sorted(platforms)}')
    events.sort(key=lambda e: e[0])
    out = {'format': 1, 'platform': platforms.pop() if platforms else None, 'granules': names,
           'window': {'start': args.start, 'end': args.end, 'lat': lat0, 'lon': lon0, 'radiusKm': args.radius_km},
           'events': events, 'groups': groups, 'flashes': flashes}
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')))
    print(f'{len(events)} events, {len(groups)} groups, {len(flashes)} flashes from {len(names)} granules.')


if __name__ == '__main__':
    main()
