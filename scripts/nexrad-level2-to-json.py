#!/usr/bin/env python3
"""Decode the reflectivity of one NEXRAD Level II volume (Archive II, the
unidata-nexrad-level2 AWS files) near a point into JSON for
scripts/nexrad-to-kml.mjs.

Format (ICD for the RDA/RPG, Archive II): a 24-byte volume header, then
records of a 4-byte big-endian length (negative for the last) and a bzip2
stream. Decompressed, each message is a 12-byte CTM header, a 16-byte message
header (size in halfwords, type, date, time) and its body. Message 31 is one
radial: azimuth, elevation, collection time and pointers to data blocks; the
"REF" block holds reflectivity gates as raw words, dBZ = (raw - offset) / scale,
raw 0 below threshold and raw 1 range folded. Other messages occupy fixed
2432-byte frames.

Only radials whose azimuth points at the circle and gates whose slant range
can reach it are kept. Ranges are slant ranges from the antenna.

Output: {"format": 1, "site": {"id", "lat", "lon", "heightM", "feedhornM"},
         "volume": NAME, "center": [lat, lon], "radiusKm",
         "sweeps": [{"elevationNumber", "elevationDeg", "radials": [
             {"t", "az", "el", "azSpacing", "firstGateM", "gateM",
              "gate0", "ref": [dBZ or null, ...]}]}]}
"ref" starts at gate index "gate0"; null is below threshold, "RF" range folded.
"dopplerCut" marks the Doppler half of a split cut: a sweep with velocity at
the elevation of the sweep just before it, which had none. Its reflectivity
repeats the surveillance half's with range folding. Times are Unix seconds.

usage:
  python -I scripts/nexrad-level2-to-json.py VOLUME --center LAT,LON --radius-km KM --out OUT.json
Requires: numpy.
"""
import argparse
import bz2
import json
import math
from pathlib import Path
import struct

import numpy as np

EARTH_KM = 6371.0088
FRAME = 2432
CTM = 12
MESSAGE_HEADER = 16


def records(data):
    """Decompressed message bytes of each Archive II record."""
    at = 24
    while at + 4 <= len(data):
        (size,) = struct.unpack('>i', data[at:at + 4])
        at += 4
        size = abs(size)
        if size == 0 or at + size > len(data):
            break
        yield bz2.decompress(data[at:at + size])
        at += size


def messages(block):
    at = 0
    while at + CTM + MESSAGE_HEADER <= len(block):
        header = block[at + CTM:at + CTM + MESSAGE_HEADER]
        halfwords, _, kind, _, julian, ms, _, _ = struct.unpack('>HBBHHIHH', header)
        if kind == 31:
            length = CTM + halfwords * 2
            yield kind, julian, ms, block[at + CTM + MESSAGE_HEADER:at + length]
            at += length
        else:
            at += FRAME


def radial(body):
    """Fields of one message 31 body, with its data blocks by name."""
    (site, ms, julian, az_number, az, compression, _, length, az_res, status,
     elevation_number, cut, el, blanking, indexing, count) = struct.unpack('>4sIHHfBBHBBBBfBBH', body[:32])
    pointers = struct.unpack(f'>{count}I', body[32:32 + 4 * count])
    blocks = {}
    for pointer in pointers:
        name = body[pointer + 1:pointer + 4].decode('ascii', 'replace')
        blocks[name] = pointer
    return {
        'site': site.decode('ascii'),
        't': (julian - 1) * 86400 + ms / 1000,
        'az': az,
        'azSpacing': azimuth_spacing(az_res),
        'el': el,
        'elevationNumber': elevation_number,
        'status': status,
        'blocks': blocks,
    }


def azimuth_spacing(code):
    if code not in (1, 2):
        raise ValueError(f'Unknown azimuth resolution code {code}')
    return 0.5 if code == 1 else 1.0


def volume_block(body, pointer):
    lat, lon, height, feedhorn = struct.unpack('>ffhH', body[pointer + 8:pointer + 20])
    return {'lat': lat, 'lon': lon, 'heightM': height, 'feedhornM': feedhorn}


def moment(body, pointer):
    (gates, first, spacing, _, _, _, word, scale, offset) = struct.unpack('>HhhhhBBff', body[pointer + 8:pointer + 28])
    if word != 8:
        raise ValueError(f'Unsupported reflectivity word size {word}')
    raw = np.frombuffer(body, dtype='u1', count=gates, offset=pointer + 28)
    return first, spacing, raw, scale, offset


def bearing_distance(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    distance = 2 * EARTH_KM * math.asin(math.sqrt(a))
    bearing = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                      math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)))
    return bearing % 360, distance


def angle_off(a, b):
    return abs((a - b + 180) % 360 - 180)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('volume')
    parser.add_argument('--center', required=True)
    parser.add_argument('--radius-km', type=float, required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    lat0, lon0 = (float(v) for v in args.center.split(','))
    if not (args.radius_km > 0 and -90 <= lat0 <= 90 and -180 <= lon0 <= 180):
        raise SystemExit('Invalid --center or --radius-km')
    data = Path(args.volume).read_bytes()
    if not data.startswith(b'AR2V'):
        raise SystemExit('Not an Archive II volume (no AR2V header)')

    site, sweeps, window = None, {}, None
    for block in records(data):
        for kind, _, _, body in messages(block):
            r = radial(body)
            if site is None:
                if 'VOL' not in r['blocks']:
                    continue
                site = {'id': r['site'], **volume_block(body, r['blocks']['VOL'])}
                bearing, distance = bearing_distance(site['lat'], site['lon'], lat0, lon0)
                if args.radius_km >= distance:
                    raise SystemExit('The circle contains the radar; choose a point farther away')
                half = math.degrees(math.asin(args.radius_km / distance))
                # Slant range exceeds ground range, by 6.4 % at 19.5°; allow 10 %.
                window = (bearing, half, (distance - args.radius_km) * 1000, (distance + args.radius_km) * 1000 * 1.1)
            if 'REF' not in r['blocks']:
                continue
            bearing, half, near, far = window
            if angle_off(r['az'], bearing) > half + r['azSpacing']:
                continue
            first, spacing, raw, scale, offset = moment(body, r['blocks']['REF'])
            g0 = max(0, int(math.floor((near - first) / spacing)))
            g1 = min(len(raw), int(math.ceil((far - first) / spacing)) + 1)
            if g1 <= g0:
                continue
            values = [None if v == 0 else 'RF' if v == 1 else round((float(v) - offset) / scale, 1) for v in raw[g0:g1]]
            sweep = sweeps.setdefault(r['elevationNumber'], {'elevationNumber': r['elevationNumber'], 'angles': [], 'radials': [],
                                                             'velocity': 'VEL' in r['blocks']})
            sweep['angles'].append(r['el'])
            sweep['radials'].append({'t': round(r['t'], 3), 'az': round(r['az'], 3), 'el': round(r['el'], 3),
                                     'azSpacing': r['azSpacing'], 'firstGateM': first, 'gateM': spacing,
                                     'gate0': g0, 'ref': values})
    if site is None:
        raise SystemExit('No volume block found')
    out_sweeps = []
    previous = None
    for number in sorted(sweeps):
        sweep = sweeps[number]
        angle = round(float(np.median(sweep['angles'])), 2)
        doppler = bool(sweep['velocity'] and previous and not previous['velocity']
                       and abs(previous['angle'] - angle) < 0.15)
        out_sweeps.append({'elevationNumber': number, 'elevationDeg': angle, 'dopplerCut': doppler,
                           'radials': sorted(sweep['radials'], key=lambda r: r['t'])})
        previous = {'velocity': sweep['velocity'], 'angle': angle}
    out = {'format': 1, 'site': site, 'volume': Path(args.volume).name, 'center': [lat0, lon0],
           'radiusKm': args.radius_km, 'sweeps': out_sweeps}
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')))
    print(f"{site['id']}: {len(out_sweeps)} sweeps, {sum(len(s['radials']) for s in out_sweeps)} radials near the circle.")


if __name__ == '__main__':
    main()
