"""Build the FIRMS static-source mask (app pack format) for the Active Fires layer.

Sources (pinned, CC BY 4.0):
  solar      Song R., Feng Y. (2026) Global Facility-Level Solar Photovoltaic Inventory v1.0.0,
             doi:10.5281/zenodo.18794231, file global_pv_facility_inventory.parquet
  industrial Ma C. (2024) Global remote industrial heat sources dataset V3.0, doi:10.5281/zenodo.10570342,
             file 'Global Remote Industrial Heat Sources DatasetV3.0_20240126.rar'

Build rules (Step 0 option 5ha_b1000_box):
  solar      MultiPolygons exploded into parts (after make_valid); parts within 500 m merged into sites
             (single linkage, exact distance in a local km frame); sites with footprint area >= 5 ha kept;
             siteId "pv:<smallest PV_ID in the site>".
  industrial GIHS Type = 0 minus EXCLUDE_GIHS (volcanoes); siteId "gihs:<record index>".
  geometry   one box per site = bounding box grown by 1 km (lat +- 1/110.574 deg; lon +- 1/(111.320 cos(poleward
             edge latitude)) deg), rounded outward to 4 decimals; boxes crossing the antimeridian are split.
  lookup     a point is in a box when w <= lon <= e and s <= lat <= n; industrial first, solar only when
             daynight != 'N'.
  escalation measured in Step 0 on FIRMS VIIRS files (7d to 2026-10-16, 24h, saved 2026-10-15/16, US Aug 2025):
             industrialFrpMin = 99.5th percentile of FRP of flagged industrial VIIRS detections (7d);
             industrialPassPixels = smallest K with <= 2 % of flagged industrial detections in passes of >= K
             pixels at one site (7d) and total escalation <= 5 % of flagged in all four datasets;
             solar recurrence: another detection at the same site 45 min .. 24 h apart.

Audit input (not shipped): Smithsonian Institution Global Volcanism Program, Volcanoes of the World, Holocene
volcano list (GeoJSON fetched keyless from the GVP WFS at webservices.volcano.si.edu; fields Volcano_Name,
Volcano_Number, Last_Eruption_Year, Point geometry).
--audit-volcanoes PATH lists every GIHS Type-0 site not in EXCLUDE_GIHS whose bounding box lies within 5 km of a
volcano with Last_Eruption_Year >= 1950 and exits 1 if there is any; EXCLUDE_GIHS was built from that audit.

Output: OUT/mask.json  {"format":1,"cellDeg":0.01,"escalation":{...},"rows":[[kind,w,s,e,n,"siteId"],...]}
        OUT/mask.sha256  '<sha256>  mask.json'

usage:
  python -I scripts/build-firms-static-mask.py --solar PARQUET --gihs-rar RAR --work DIR --out src/data/local_data/firms_static_mask
  python -I scripts/build-firms-static-mask.py --download --work DIR --out src/data/local_data/firms_static_mask      (fetches the pinned files, md5-checked)
  python -I scripts/build-firms-static-mask.py --gihs-rar RAR --work DIR --audit-volcanoes GVP.geojson
  add --verify to rebuild and compare with the existing OUT/mask.sha256 (nothing is written; exit 1 on mismatch)
Requires: duckdb (spatial extension), shapely>=2, numpy, scipy. GIHS .rar is extracted with libarchive tar (Windows tar.exe, or bsdtar; override with TAR).
"""
import argparse, hashlib, os, shutil, subprocess, sys, time, urllib.request

import duckdb
import numpy as np
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

SOLAR_URL = 'https://zenodo.org/api/records/18794231/files/global_pv_facility_inventory.parquet/content'
SOLAR_MD5 = '987ba41d05961ec0334ef9ca6dd4513f'
GIHS_URL = 'https://zenodo.org/api/records/10570342/files/Global%20Remote%20Industrial%20Heat%20Sources%20DatasetV3.0_20240126.rar/content'
GIHS_MD5 = '6cbcfdafcf08df719d69c5abc23f906f'
# libarchive tar opens .rar (GNU tar cannot): Windows' tar.exe, or bsdtar elsewhere.
TAR = os.environ.get('TAR') or (
    r'C:\Windows\System32\tar.exe' if os.name == 'nt' else (shutil.which('bsdtar') or 'bsdtar')
)

KM_LAT = 110.574
KM_LON = 111.320
MERGE_KM = 0.5
SOLAR_MIN_KM2 = 0.05  # 5 ha
BUFFER_KM = 1.0
ESCALATION = {'solarRecurrenceMs': 2700000, 'industrialFrpMin': 41.01, 'industrialPassPixels': 15}

# GIHS Type-0 records that are volcanoes, not industrial heat sources (key = record index = OGC_FID).
EXCLUDE_GIHS = {
    23619: 'Kilauea summit, Halemaumau crater (volcano, not industrial)',
    23620: 'Kilauea summit caldera (volcano, not industrial)',
    23621: 'Kilauea East Rift Zone, Puu Oo vent (volcano, not industrial)',
    23618: 'Kilauea lower East Rift Zone, Pahoa/Leilani lava 2014-2018 (volcano, not industrial)',
    2657: 'Etna summit craters (volcano, not industrial)',
    2688: 'Etna summit/upper flank (volcano, not industrial)',
    24220: 'Masaya, Santiago crater lava lake (volcano, not industrial)',
    24221: 'Masaya, Santiago crater lava lake (volcano, not industrial)',
    19706: 'Villarrica summit lava lake (volcano, not industrial)',
    # Audit 2026-10-16 against the Smithsonian GVP Holocene list: Type-0 sites within 5 km (bbox distance) of a
    # volcano with Last_Eruption_Year >= 1950. Reason format: '<volcano> (GVP <number>, last eruption <year>)'.
    30: 'Bristol Island (GVP 390080, last eruption 2016)',
    365: 'Krakatau (GVP 262000, last eruption 2024)',
    728: 'Tara, Batu (GVP 264260, last eruption 2015)',
    729: 'Tara, Batu (GVP 264260, last eruption 2015)',
    730: 'Tara, Batu (GVP 264260, last eruption 2015)',
    756: 'Suwanosejima (GVP 282030, last eruption 2026)',
    765: 'Kikai (GVP 282060, last eruption 2025)',
    811: 'Nishinoshima (GVP 284096, last eruption 2023)',
    813: 'Ioto (GVP 284120, last eruption 2025)',
    814: 'Ioto (GVP 284120, last eruption 2025)',
    826: 'Kadovar (GVP 251002, last eruption 2023)',
    827: 'Kadovar (GVP 251002, last eruption 2023)',
    830: 'Manam (GVP 251020, last eruption 2026)',
    831: 'Manam (GVP 251020, last eruption 2026)',
    838: 'Chirpoi (GVP 290150, last eruption 2016)',
    843: 'Chirinkotan (GVP 290260, last eruption 2022)',
    844: 'Stromboli (GVP 211040, last eruption 2026)',
    847: 'Tinakula (GVP 256010, last eruption 2024)',
    976: 'Whakaari/White Island (GVP 241040, last eruption 2026)',
    1517: 'Barren Island (GVP 260010, last eruption 2026)',
    1518: 'Barren Island (GVP 260010, last eruption 2026)',
    1519: 'Barren Island (GVP 260010, last eruption 2026)',
    1636: 'Tofua (GVP 243060, last eruption 2026)',
    1707: 'Manam (GVP 251020, last eruption 2026)',
    1873: 'Bagana (GVP 255020, last eruption 2026)',
    1879: 'Yasur (GVP 257100, last eruption 2026)',
    2694: 'Stromboli (GVP 211040, last eruption 2026)',
    2712: 'Bezymianny (GVP 300250, last eruption 2025)',
    2716: 'Sheveluch (GVP 300270, last eruption 2026)',
    8218: 'Lengai, Ol Doinyo (GVP 222120, last eruption 2026)',
    8300: 'Nabro (GVP 221101, last eruption 2012)',
    8301: 'Nabro (GVP 221101, last eruption 2012)',
    9129: 'Suwanosejima (GVP 282030, last eruption 2026)',
    9152: 'Kuchinoerabujima (GVP 282050, last eruption 2020)',
    9153: 'Aira (GVP 282080, last eruption 2026)',
    9177: 'Asosan (GVP 282110, last eruption 2021)',
    9225: 'Asamayama (GVP 283110, last eruption 2019)',
    9250: 'Nishinoshima (GVP 284096, last eruption 2023)',
    19423: 'Lascar (GVP 355100, last eruption 2026)',
    19695: 'Sabancaya (GVP 354006, last eruption 2026)',
    19704: 'Chillan, Nevados de (GVP 357070, last eruption 2022)',
    19705: 'Copahue (GVP 357090, last eruption 2024)',
    19752: 'Chaiten (GVP 358041, last eruption 2011)',
    19852: 'Ruiz, Nevado del (GVP 351020, last eruption 2026)',
    19925: 'Reventador (GVP 352010, last eruption 2026)',
    19927: 'Galeras (GVP 351080, last eruption 2014)',
    19931: 'Sangay (GVP 352090, last eruption 2026)',
    20183: 'Barren Island (GVP 260010, last eruption 2026)',
    22069: 'Colima (GVP 341040, last eruption 2019)',
    23623: 'Veniaminof (GVP 312070, last eruption 2021)',
    23624: 'Shishaldin (GVP 311360, last eruption 2023)',
    23626: 'Cleveland (GVP 311240, last eruption 2020)',
    24072: 'Turrialba (GVP 345070, last eruption 2022)',
    24176: 'Momotombo (GVP 344090, last eruption 2016)',
    24378: 'Fuego (GVP 342090, last eruption 2026) / Acatenango (GVP 342080, last eruption 1972)',
    24380: 'Pacaya (GVP 342110, last eruption 2021)',
}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def digests(path):
    md5, sha = hashlib.md5(), hashlib.sha256()
    with open(path, 'rb') as f:
        for ch in iter(lambda: f.read(1 << 20), b''):
            md5.update(ch)
            sha.update(ch)
    return md5.hexdigest(), sha.hexdigest()


def download(url, path, md5):
    if not os.path.exists(path):
        log('download', url)
        tmp = path + '.part'
        urllib.request.urlretrieve(url, tmp)  # Zenodo ignores range requests; fetch the whole file
        os.replace(tmp, path)
    got = digests(path)[0]
    if got != md5:
        raise SystemExit(f'md5 mismatch for {path}: {got} != {md5}')
    return path


def to_local_km(geoms, lat0, lon0):
    coords, idx = shapely.get_coordinates(geoms, return_index=True)
    la0, lo0 = np.asarray(lat0, float)[idx], np.asarray(lon0, float)[idx]
    dlon = (coords[:, 0] - lo0 + 180.0) % 360.0 - 180.0
    xy = np.c_[dlon * KM_LON * np.cos(np.radians(la0)), (coords[:, 1] - la0) * KM_LAT]
    return shapely.set_coordinates(shapely.transform(np.asarray(geoms, dtype=object), lambda c: c), xy)


def grow(w, s, e, n, km):
    dlat = km / KM_LAT
    s2, n2 = s - dlat, n + dlat
    latmax = np.minimum(np.maximum(np.abs(s2), np.abs(n2)), 89.0)
    dlon = km / (KM_LON * np.cos(np.radians(latmax)))
    return w - dlon, s2, e + dlon, n2


def centroids(g):
    c = shapely.centroid(g)
    return shapely.get_y(c), shapely.get_x(c)


def solar_sites(con, path):
    df = con.execute(f"SELECT PV_ID, ST_AsWKB(geometry) AS g FROM read_parquet('{path}') ORDER BY PV_ID").fetchnumpy()
    ids = np.asarray(df['PV_ID'], np.int64)
    geoms = shapely.make_valid(shapely.from_wkb(np.array([bytes(x) for x in df['g']], dtype=object)))
    parts, pidx = shapely.get_parts(geoms, return_index=True)
    keep = (~shapely.is_empty(parts)) & (shapely.get_type_id(parts) == 3)
    pid, parts = ids[pidx[keep]], parts[keep]
    log('solar facilities', len(ids), 'polygon parts', len(parts))
    # merge parts within MERGE_KM
    n = len(parts)
    clat, clon = centroids(parts)
    bb = shapely.bounds(parts)
    w, s, e, nn = grow(bb[:, 0], bb[:, 1], bb[:, 2], bb[:, 3], MERGE_KM)
    tree = shapely.STRtree(shapely.box(bb[:, 0], bb[:, 1], bb[:, 2], bb[:, 3]))
    a, b = tree.query(shapely.box(w, s, e, nn))
    m = a < b
    a, b = a[m], b[m]
    kx = KM_LON * np.cos(np.radians(np.maximum(np.abs(bb[a, 1]), np.abs(bb[a, 3]))))
    gx = np.maximum(0, np.maximum(bb[a, 0] - bb[b, 2], bb[b, 0] - bb[a, 2])) * kx
    gy = np.maximum(0, np.maximum(bb[a, 1] - bb[b, 3], bb[b, 1] - bb[a, 3])) * KM_LAT
    m = np.hypot(gx, gy) <= MERGE_KM * 1.01
    a, b = a[m], b[m]
    d = np.empty(len(a))
    for k in range(0, len(a), 200000):
        sl = slice(k, k + 200000)
        d[sl] = shapely.distance(to_local_km(parts[a[sl]], clat[a[sl]], clon[a[sl]]), to_local_km(parts[b[sl]], clat[a[sl]], clon[a[sl]]))
    m = d <= MERGE_KM
    _, lab = connected_components(coo_matrix((np.ones(int(m.sum())), (a[m], b[m])), shape=(n, n)), directed=False)
    # sites: footprint union, smallest PV_ID, area in a local km frame
    order = np.argsort(lab, kind='stable')
    lab, pid, parts = lab[order], pid[order], parts[order]
    starts = np.r_[0, np.nonzero(lab[1:] != lab[:-1])[0] + 1]
    ends = np.r_[starts[1:], len(lab)]
    foot = np.empty(len(starts), dtype=object)
    sid = np.empty(len(starts), np.int64)
    for k, (s0, e0) in enumerate(zip(starts, ends)):
        foot[k] = parts[s0] if e0 - s0 == 1 else shapely.union_all(parts[s0:e0])
        sid[k] = pid[s0:e0].min()
    fl, fo = centroids(foot)
    area = shapely.area(to_local_km(foot, fl, fo))
    keep = area >= SOLAR_MIN_KM2
    log('solar sites', len(sid), '>= 5 ha', int(keep.sum()))
    return sid[keep], shapely.bounds(foot[keep])


def gihs_sites(con, rar, work):
    x = os.path.join(work, 'gihs_x')
    if not os.path.isdir(x):
        os.makedirs(x)
        subprocess.run([TAR, '-xf', rar, '-C', x], check=True)
    shp = [os.path.join(r, f) for r, _, fs in os.walk(x) for f in fs if f.lower().endswith('.shp')][0]
    rows = con.execute(f"SELECT OGC_FID, Type, ST_AsWKB(geom) FROM ST_Read('{shp}')").fetchall()
    fid = np.array([int(r[0]) for r in rows])
    assert (fid == np.arange(len(fid))).all(), 'GIHS record order changed'
    typ = np.array([int(r[1]) for r in rows])
    geo = shapely.from_wkb(np.array([bytes(r[2]) for r in rows], dtype=object))
    for k, why in EXCLUDE_GIHS.items():
        assert typ[k] == 0, k
        log('exclude gihs', k, [round(float(v), 4) for v in shapely.bounds(geo[k])], why)
    m = typ == 0
    m[list(EXCLUDE_GIHS)] = False
    gid = np.nonzero(m)[0].astype(np.int64)
    log('gihs polygons', len(typ), 'type0', int((typ == 0).sum()), 'used', len(gid))
    return gid, shapely.bounds(shapely.make_valid(geo[m]))


def audit_volcanoes(con, rar, work, gvp_path, radius_km=5.0, min_year=1950):
    """Return non-excluded GIHS Type-0 sites whose bbox is within radius_km of a volcano erupting since min_year."""
    import json, math
    volc = []
    for f in json.load(open(gvp_path, encoding='utf-8'))['features']:
        p = f['properties']
        y = p.get('Last_Eruption_Year')
        if y is None or y < min_year or not f.get('geometry'):
            continue
        lon, lat = f['geometry']['coordinates'][:2]
        volc.append((p.get('Volcano_Name'), p.get('Volcano_Number'), y, lat, lon))
    x = os.path.join(work, 'gihs_x')
    if not os.path.isdir(x):
        os.makedirs(x)
        subprocess.run([TAR, '-xf', rar, '-C', x], check=True)
    shp = [os.path.join(r, f) for r, _, fs in os.walk(x) for f in fs if f.lower().endswith('.shp')][0]
    rows = con.execute(f"SELECT Type, ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom) FROM ST_Read('{shp}')").fetchall()
    hits = []
    for idx, (typ, w, s, e, n) in enumerate(rows):
        if int(typ) != 0 or idx in EXCLUDE_GIHS:
            continue
        for name, number, year, lat, lon in volc:
            clat = min(max(lat, s), n)
            dlon = 0.0 if w <= lon <= e else min(abs((lon - w + 180) % 360 - 180), abs((lon - e + 180) % 360 - 180))
            d = math.hypot(dlon * KM_LON * math.cos(math.radians(lat)), (lat - clat) * KM_LAT)
            if d <= radius_km:
                hits.append((idx, name, number, year, round(d, 2), [round(v, 4) for v in (w, s, e, n)]))
    log('audit: volcanoes active since', min_year, len(volc), '; type-0 sites checked',
        sum(1 for r in rows if int(r[0]) == 0) - len(EXCLUDE_GIHS), '; hits', len(hits))
    for h in hits:
        print('  gihs', h[0], h[1], '(GVP', h[2], ', last eruption', h[3], ')', h[4], 'km, bbox', h[5])
    return hits


def box_rows(kind, ids, bb):
    w, s, e, n = grow(bb[:, 0], bb[:, 1], bb[:, 2], bb[:, 3], BUFFER_KM)
    w, s = np.floor(w * 1e4) / 1e4, np.floor(s * 1e4) / 1e4
    e, n = np.ceil(e * 1e4) / 1e4, np.ceil(n * 1e4) / 1e4
    rows = []
    for i in range(len(ids)):
        if w[i] < -180:
            rows += [[kind, round(w[i] + 360, 4), s[i], 180.0, n[i], int(ids[i])], [kind, -180.0, s[i], e[i], n[i], int(ids[i])]]
        elif e[i] > 180:
            rows += [[kind, w[i], s[i], 180.0, n[i], int(ids[i])], [kind, -180.0, s[i], round(e[i] - 360, 4), n[i], int(ids[i])]]
        else:
            rows.append([kind, float(w[i]), float(s[i]), float(e[i]), float(n[i]), int(ids[i])])
    return rows


def num(x):
    t = f'{float(x):.4f}'.rstrip('0').rstrip('.')
    return '0' if t == '-0' else t


def pack(rows):
    rows = sorted(rows, key=lambda r: (r[0], r[1:]))
    out = []
    for r in rows:
        sid = f'"pv:{r[5]}"' if r[0] == 0 else f'"gihs:{r[5]}"'
        out.append('[' + ','.join([str(r[0])] + [num(v) for v in r[1:5]] + [sid]) + ']')
    esc = ('{"solarRecurrenceMs":%d,"industrialFrpMin":%s,"industrialPassPixels":%d}'
           % (ESCALATION['solarRecurrenceMs'], num(ESCALATION['industrialFrpMin']), ESCALATION['industrialPassPixels']))
    return ('{"format":1,"cellDeg":0.01,"escalation":' + esc + ',"rows":[' + ','.join(out) + ']}').encode()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--solar')
    ap.add_argument('--gihs-rar')
    ap.add_argument('--download', action='store_true', help='download the pinned Zenodo files into WORK (md5-checked)')
    ap.add_argument('--work', required=True)
    ap.add_argument('--out')
    ap.add_argument('--audit-volcanoes', metavar='GVP_GEOJSON', help='audit GIHS Type-0 sites against GVP volcanoes; exit 1 on any hit')
    ap.add_argument('--verify', action='store_true', help='rebuild and compare with OUT/mask.sha256; writes nothing')
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    if a.download:
        a.solar = download(SOLAR_URL, os.path.join(a.work, 'global_pv_facility_inventory.parquet'), SOLAR_MD5)
        a.gihs_rar = download(GIHS_URL, os.path.join(a.work, 'gihs.rar'), GIHS_MD5)
    if a.audit_volcanoes:
        if not a.gihs_rar:
            ap.error('--audit-volcanoes needs --gihs-rar or --download')
        if digests(a.gihs_rar)[0] != GIHS_MD5:
            raise SystemExit(f'md5 mismatch for {a.gihs_rar}')
        con = duckdb.connect()
        con.execute('INSTALL spatial; LOAD spatial')
        sys.exit(1 if audit_volcanoes(con, a.gihs_rar, a.work, a.audit_volcanoes) else 0)
    if not (a.solar and a.gihs_rar and a.out):
        ap.error('give --solar and --gihs-rar (or --download) and --out')
    for p, want in ((a.solar, SOLAR_MD5), (a.gihs_rar, GIHS_MD5)):
        md5, sha = digests(p)
        log('input', os.path.basename(p), 'md5', md5, 'sha256', sha)
        if md5 != want:
            raise SystemExit(f'md5 mismatch for {p}: {md5} != {want}')
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial')
    sid, sbb = solar_sites(con, a.solar)
    gid, gbb = gihs_sites(con, a.gihs_rar, a.work)
    b = pack(box_rows(0, sid, sbb) + box_rows(1, gid, gbb))
    sha = hashlib.sha256(b).hexdigest()
    log('mask', len(b), 'bytes; solar rows', len(sid), 'industrial rows', len(gid), 'sha256', sha)
    shafile = os.path.join(a.out, 'mask.sha256')
    if a.verify:
        want = open(shafile).read().split()[0]
        print('verify', 'OK' if want == sha else f'MISMATCH (expected {want})')
        sys.exit(0 if want == sha else 1)
    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, 'mask.json'), 'wb').write(b)
    with open(shafile, 'w', newline='\n') as f:
        f.write(f'{sha}  mask.json\n')


if __name__ == '__main__':
    main()
