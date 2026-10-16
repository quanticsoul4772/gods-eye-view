# FIRMS static-source mask

Known solar farms and industrial heat sources, used by the server
(`server/providers/firmsStaticMask.js`) to annotate NASA FIRMS **VIIRS**
detections that are probably not fires: daytime sun glint on solar farms, and
kilns, steel works and gas flares at any time. Detections are annotated, never
removed; the Active Fires layer draws them grey (a chip hides them), and the
assistant tools leave them out and say how many.

## Sources (CC BY 4.0)

- **Solar footprints:** Song R., Feng Y. (2026), *Global Facility-Level Solar
  Photovoltaic Inventory with Energy Generation and Loss Estimates*, v1.0.0,
  [doi:10.5281/zenodo.18794231](https://doi.org/10.5281/zenodo.18794231)
  ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
  File `global_pv_facility_inventory.parquet`, 324,840,097 bytes,
  md5 `987ba41d05961ec0334ef9ca6dd4513f`,
  sha256 `c4ebaf24cdcd6dcaafcb7425e8c616fdb509b2bba26a0d3cb28ea151fba4894d`.
  Plants built to 2024 (its "2017" means 2017 or earlier).
- **Industrial heat sources:** Ma C. (2024), *Global remote industrial heat
  sources dataset* V3.0,
  [doi:10.5281/zenodo.10570342](https://doi.org/10.5281/zenodo.10570342)
  ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). File
  `Global Remote Industrial Heat Sources DatasetV3.0_20240126.rar`,
  3,875,102 bytes, md5 `6cbcfdafcf08df719d69c5abc23f906f`,
  sha256 `9f7730c851f4a295bf60ed3d6df7c5b3c48bfd4e8f822a01b81084d373b30026`.
  Sites active 2012–2021; no longer updated. The dataset asks that its papers
  be cited: Ma et al. 2018 (*Sustainability* 10:4419) and 2022 (*Remote
  Sensing* 14:835).

## Changes made (CC BY 4.0 requires noting them)

- **Solar:** footprints exploded into parts, parts within 500 m merged into
  sites, sites under 5 ha dropped: 24,339 sites, id `pv:<smallest PV_ID>`.
- **Industrial:** GIHS `Type = 0` only (verified industrial; types 1 and 2 are
  mostly recurring real-fire hotspots), minus 9 sites on active volcanoes
  (Kīlauea ×4, Etna ×2, Masaya ×2, Villarrica), whose heat is real and must
  stay visible: 23,222 sites, id `gihs:<record index>`. The exclusion list,
  with a reason for each, is `EXCLUDE_GIHS` in the build script.
- **Geometry:** each site becomes its bounding box grown by 1 km, rounded
  outward to 4 decimals.

## Format

`mask.json` is `{format: 1, cellDeg, escalation, rows}`; rows are
`[kind, west, south, east, north, siteId]`, kind 0 = solar, 1 = industrial
(47,561 rows, 2,310,712 bytes; SHA-256 in [`mask.sha256`](mask.sha256)).
`escalation` holds thresholds measured on FIRMS VIIRS data (7-day files to
2026-10-16, 24 h files, and the US August 2025 archive): a solar site seen
again 45 min to 24 h later, an industrial detection of at least 41.05 MW, or
15+ pixels at one industrial site in one pass, still looks like a real fire
and stays a fire.

Measured on that data: Moapa (NV) solar glint 24/24 flagged; detections
inside real fire areas flagged 190/146,859 (0.13 %; 0 of 34,049 in the 2025
US replay's fire perimeters); 5.5–7.1 % of all VIIRS detections flagged.
MODIS is not annotated: its larger pixels fall outside the 1 km buffer.

## Rebuild

Maintainer tool; requires Python with `duckdb` (spatial extension),
`shapely>=2`, `numpy` and `scipy`, and a libarchive `tar` for the `.rar`:

```sh
python -I scripts/build-firms-static-mask.py --download --work /tmp/firms-mask --out src/data/local_data/firms_static_mask
python -I scripts/build-firms-static-mask.py --download --work /tmp/firms-mask --out src/data/local_data/firms_static_mask --verify
```

Rebuild yearly, or when solar or industrial sites start appearing as
unflagged glint: the solar inventory stops at 2024 and the industrial one at
2021. The escalation thresholds are constants in the script, measured once;
re-measure them when the inputs change.
