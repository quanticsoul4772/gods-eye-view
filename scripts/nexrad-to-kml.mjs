import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { traceFixes } from './readsb-trace-to-kml.mjs';
import { aircraftAt } from './glm-to-kml.mjs';

/**
 * Draw the NEXRAD beam cells (JSON from scripts/nexrad-level2-to-json.py)
 * along an aircraft track as a KML curtain at their true heights, and report
 * for each sweep what the beam measured where the aircraft was when the beam
 * passed it.
 *
 * What the data supports, and what this draws:
 * - A gate is one beam volume, 250 m deep along the beam; the beam is 0.95°
 *   wide, about 2 km at 120 km. Each cell is drawn as a vertical rectangle
 *   at the gate's centre range, from the beam's lower to upper half-power
 *   edge, and across the radial spacing (0.5° or 1°), not the beamwidth.
 * - Heights use the standard 4/3-earth refraction model; real refraction can
 *   bend the beam higher or lower. They are above mean sea level (antenna
 *   height plus beam height), drawn as KML absolute; the geoid offset (tens of
 *   metres) is small against a 2 km beam.
 * - A volume is not a snapshot: each sweep is a different minute. Cells are
 *   named with their own sweep time.
 * - Reflectivity is precipitation-sized echo. A low value is "no strong rain
 *   or hail measured", not clear air: ice-crystal cloud near storm tops
 *   returns little. Grey cells were sampled with no echo above threshold;
 *   purple cells were range folded. Only the gate under or over each track
 *   point is drawn, per sweep; between tilts at a point, nothing was sampled.
 * - The Doppler half of each split cut repeats the surveillance half's
 *   reflectivity with range folding; it is left out.
 */

const EARTH_M = 6371008.8;
const EFFECTIVE_EARTH_M = (4 / 3) * EARTH_M;
export const BEAMWIDTH_DEG = 0.95;
const FEET = 0.3048;
const RAD = Math.PI / 180;

/** Beam height (m above the antenna) at a slant range and elevation. */
export function beamHeightM(slantM, elDeg) {
  const R = EFFECTIVE_EARTH_M;
  return (
    Math.sqrt(slantM ** 2 + R ** 2 + 2 * slantM * R * Math.sin(elDeg * RAD)) - R
  );
}

/** Ground distance (m) under a beam point at a slant range and elevation. */
export function groundRangeM(slantM, elDeg) {
  const R = EFFECTIVE_EARTH_M;
  const h = beamHeightM(slantM, elDeg);
  return R * Math.asin((slantM * Math.cos(elDeg * RAD)) / (R + h));
}

/** Slant range (m) whose ground distance is `groundM` at an elevation. */
export function slantRangeM(groundM, elDeg) {
  let slant = groundM / Math.cos(elDeg * RAD);
  for (let i = 0; i < 6; i++)
    slant += (groundM - groundRangeM(slant, elDeg)) / Math.cos(elDeg * RAD);
  return slant;
}

/** Initial bearing (deg) and distance (m) from one point to another. */
export function bearingDistance(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const a =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distance = 2 * EARTH_M * Math.asin(Math.sqrt(a));
  const bearing =
    Math.atan2(
      Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
    ) / RAD;
  return { bearing: (bearing + 360) % 360, distance };
}

/** The point `distanceM` from a start along an initial bearing. */
export function destination(lat, lon, bearingDeg, distanceM) {
  const d = distanceM / EARTH_M;
  const b = bearingDeg * RAD;
  const p1 = lat * RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    lon * RAD +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
}

const angleOff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * The radial of a sweep nearest an azimuth, within one radial spacing (radial
 * centres are not evenly spaced, so half a spacing leaves gaps), or null.
 */
export function radialAt(sweep, azimuth) {
  let best = null;
  for (const radial of sweep.radials) {
    const off = angleOff(radial.az, azimuth);
    if (off <= radial.azSpacing + 1e-9 && (!best || off < best.off))
      best = { radial, off };
  }
  return best?.radial ?? null;
}

/** Sweeps that carry their own reflectivity: Doppler halves of split cuts left out. */
export const reflectivitySweeps = (sweeps) =>
  sweeps.filter((sweep) => !sweep.dopplerCut);

/** The gate of a radial at a slant range: {index, dbz} or null outside it. */
export function gateAt(radial, slantM) {
  const index = Math.round((slantM - radial.firstGateM) / radial.gateM);
  const at = index - radial.gate0;
  if (at < 0 || at >= radial.ref.length) return null;
  return { index, dbz: radial.ref[at] };
}

/** Where a beam of a sweep meets a point: its gate and its vertical extent. */
export function beamAtPoint(site, sweep, radial, lat, lon) {
  const { bearing, distance } = bearingDistance(site.lat, site.lon, lat, lon);
  const antennaM = site.heightM + site.feedhornM;
  const slant = slantRangeM(distance, radial.el);
  return {
    bearing,
    groundM: distance,
    slantM: slant,
    gate: gateAt(radial, slant),
    centreM: antennaM + beamHeightM(slant, radial.el),
    bottomM:
      antennaM +
      beamHeightM(
        slantRangeM(distance, radial.el - BEAMWIDTH_DEG / 2),
        radial.el - BEAMWIDTH_DEG / 2,
      ),
    topM:
      antennaM +
      beamHeightM(
        slantRangeM(distance, radial.el + BEAMWIDTH_DEG / 2),
        radial.el + BEAMWIDTH_DEG / 2,
      ),
  };
}

/**
 * For one sweep, the aircraft when the beam passed its azimuth (found by
 * iterating radial time and aircraft bearing), and what the beam measured
 * there. Otherwise {missing: 'position'} when the aircraft's position is
 * unknown at that time, or {missing: 'outside'} when no decoded radial points
 * at it.
 */
export function sweepAtAircraft(site, sweep, fixes) {
  const times = sweep.radials.map((r) => r.t);
  let t = times[Math.floor(times.length / 2)];
  let radial = null;
  let jet = null;
  for (let i = 0; i < 4; i++) {
    jet = aircraftAt(fixes, t);
    if (!jet) return { missing: 'position' };
    const { bearing } = bearingDistance(site.lat, site.lon, jet.lat, jet.lon);
    const next = radialAt(sweep, bearing);
    if (!next) return { missing: 'outside' };
    if (next === radial) break;
    radial = next;
    t = radial.t;
  }
  jet = aircraftAt(fixes, radial.t);
  if (!jet) return { missing: 'position' };
  const beam = beamAtPoint(site, sweep, radial, jet.lat, jet.lon);
  if (!beam.gate) return { missing: 'outside' };
  const jetM = jet.geomFt * FEET;
  return {
    elevationNumber: sweep.elevationNumber,
    elevationDeg: radial.el,
    t: radial.t,
    jet,
    jetM,
    beam,
    inside: jetM >= beam.bottomM && jetM <= beam.topM,
  };
}

/**
 * Per sweep, the track points where its beam spanned the aircraft's altitude
 * over that point, whenever the beam passed: the dBZ there and the beam time
 * minus the aircraft time. Sweeps that never did are left out.
 */
export function sampledAtAltitude(site, sweeps, points) {
  const out = [];
  for (const sweep of sweeps) {
    const hits = [];
    for (const point of points) {
      const { bearing } = bearingDistance(
        site.lat,
        site.lon,
        point.lat,
        point.lon,
      );
      const radial = radialAt(sweep, bearing);
      if (!radial) continue;
      const beam = beamAtPoint(site, sweep, radial, point.lat, point.lon);
      const altitudeM = point.geom * FEET;
      if (!beam.gate || altitudeM < beam.bottomM || altitudeM > beam.topM)
        continue;
      hits.push({ point, dbz: beam.gate.dbz, dt: radial.t - point.t });
    }
    if (hits.length) out.push({ sweep, hits });
  }
  return out;
}

/** Cells of every sweep under or over the given track points, deduplicated. */
export function curtainCells(site, sweeps, points) {
  const cells = new Map();
  for (const sweep of sweeps)
    for (const point of points) {
      const { bearing } = bearingDistance(
        site.lat,
        site.lon,
        point.lat,
        point.lon,
      );
      const radial = radialAt(sweep, bearing);
      if (!radial) continue;
      const beam = beamAtPoint(site, sweep, radial, point.lat, point.lon);
      if (!beam.gate) continue;
      const key = `${sweep.elevationNumber}:${radial.az}:${beam.gate.index}`;
      if (!cells.has(key)) cells.set(key, { sweep, radial, gate: beam.gate });
    }
  return [...cells.values()];
}

/** NWS-style reflectivity colours (KML aabbggrr), by lower bound in dBZ. */
const PALETTE = [
  [65, 'ffff00ff'],
  [60, 'ff0000c0'],
  [55, 'ff0000ff'],
  [50, 'ff0045ff'],
  [45, 'ff008cff'],
  [40, 'ff00d7ff'],
  [35, 'ff00ffff'],
  [30, 'ff009000'],
  [25, 'ff00c800'],
  [20, 'ff00ff00'],
  [10, 'ffe6b400'],
  [-Infinity, 'ffffe6b4'],
];

/** Style id for a gate value: "noecho" for null, "folded" for range folded, else its palette band. */
export function styleFor(dbz) {
  if (dbz === null) return 'noecho';
  if (dbz === 'RF') return 'folded';
  const band = PALETTE.findIndex(([low]) => dbz >= low);
  return `z${band}`;
}

/** A gate value in words. */
export const describeGate = (dbz) =>
  dbz === null ? 'no echo' : dbz === 'RF' ? 'range folded' : `${dbz} dBZ`;

const clock = (t) => new Date(t * 1000).toISOString().slice(11, 22) + 'Z';

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

/** The vertical rectangle of one gate across its beam, as a KML ring. */
export function cellRing(site, radial, gateIndex) {
  const antennaM = site.heightM + site.feedhornM;
  const slant = radial.firstGateM + gateIndex * radial.gateM;
  const lo = radial.el - BEAMWIDTH_DEG / 2;
  const hi = radial.el + BEAMWIDTH_DEG / 2;
  const ground = groundRangeM(slant, radial.el);
  const bottom = antennaM + beamHeightM(slant, lo);
  const top = antennaM + beamHeightM(slant, hi);
  const left = destination(
    site.lat,
    site.lon,
    radial.az - radial.azSpacing / 2,
    ground,
  );
  const right = destination(
    site.lat,
    site.lon,
    radial.az + radial.azSpacing / 2,
    ground,
  );
  const at = ([lat, lon], h) =>
    `${lon.toFixed(5)},${lat.toFixed(5)},${Math.round(h)}`;
  return {
    bottom,
    top,
    ring: [
      at(left, bottom),
      at(right, bottom),
      at(right, top),
      at(left, top),
      at(left, bottom),
    ].join(' '),
  };
}

/**
 * The KML curtain and counts for the cells under or over the given track
 * points.
 * @returns {{kml: string, cells: number, echo: number, folded: number}}
 */
export function nexradToKml(nexrad, points) {
  if (nexrad?.format !== 1 || !nexrad.site || !Array.isArray(nexrad.sweeps))
    throw new Error('Not NEXRAD JSON from scripts/nexrad-level2-to-json.py');
  const cells = curtainCells(
    nexrad.site,
    reflectivitySweeps(nexrad.sweeps),
    points,
  );
  if (!cells.length) throw new Error('No beam cells along those points.');
  const styles = [
    `<Style id="noecho"><LineStyle><color>66ffffff</color><width>1</width></LineStyle><PolyStyle><color>22ffffff</color></PolyStyle></Style>`,
    `<Style id="folded"><LineStyle><color>ff800080</color><width>1</width></LineStyle><PolyStyle><color>66800080</color></PolyStyle></Style>`,
    ...PALETTE.map(
      ([, color], i) =>
        `<Style id="z${i}"><LineStyle><color>${color}</color><width>1</width></LineStyle><PolyStyle><color>aa${color.slice(2)}</color></PolyStyle></Style>`,
    ),
  ];
  const placemarks = cells.map(({ sweep, radial, gate }) => {
    const { ring, bottom, top } = cellRing(nexrad.site, radial, gate.index);
    const value = describeGate(gate.dbz);
    const name = `${radial.el.toFixed(2)}° ${clock(radial.t)} · ${value} · beam ${(bottom / 1000).toFixed(1)}–${(top / 1000).toFixed(1)} km`;
    return `<Placemark><name>${escapeXml(name)}</name><styleUrl>#${styleFor(gate.dbz)}</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  });
  const times = cells.map(({ radial }) => radial.t);
  const title = escapeXml(
    `${nexrad.site.id} ${clock(Math.min(...times))}–${clock(Math.max(...times))}`,
  );
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${title}</name>
${styles.join('\n')}
${placemarks.join('\n')}
</Document></kml>
`;
  return {
    kml,
    cells: cells.length,
    echo: cells.filter(({ gate }) => typeof gate.dbz === 'number').length,
    folded: cells.filter(({ gate }) => gate.dbz === 'RF').length,
  };
}

const option = (args, name) => {
  const at = args.indexOf(name);
  if (at < 0) return [args, null];
  if (!args[at + 1]) throw new Error(`${name} needs a value`);
  return [args.filter((_, i) => i !== at && i !== at + 1), args[at + 1]];
};

const isoSeconds = (text, name) => {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(text))
    throw new Error(`${name} needs a time zone (Z or ±hh:mm): ${text}`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${name} is not a date: ${text}`);
  return ms / 1000;
};

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  try {
    let args = process.argv.slice(2);
    let tracePath, fromText, toText;
    [args, tracePath] = option(args, '--trace');
    [args, fromText] = option(args, '--from');
    [args, toText] = option(args, '--to');
    const [input, output, ...rest] = args;
    if (!input || !output || !tracePath || rest.length)
      throw new Error(
        'Usage: node scripts/nexrad-to-kml.mjs <nexrad.json> <out.kml> --trace <trace_full.json> [--from ISO] [--to ISO]',
      );
    const from = fromText ? isoSeconds(fromText, '--from') : -Infinity;
    const to = toText ? isoSeconds(toText, '--to') : Infinity;
    const nexrad = JSON.parse(await readFile(input, 'utf8'));
    const fixes = traceFixes(JSON.parse(await readFile(tracePath, 'utf8')));
    const points = fixes.filter(
      (fix) => fix.geom !== null && fix.t >= from && fix.t <= to,
    );
    if (!points.length) throw new Error('No aircraft fixes in that window.');
    const { kml, cells, echo, folded } = nexradToKml(nexrad, points);
    await writeFile(output, kml);
    console.log(
      `${cells} beam cells under or over ${points.length} fixes: ${echo} with echo, ${folded} range folded (purple), ${cells - echo - folded} sampled with no echo above threshold (grey).`,
    );
    console.log(
      'Per sweep, the beam where the aircraft was when the beam passed its azimuth (a low dBZ means no strong rain or hail measured, not clear air):',
    );
    const sweeps = reflectivitySweeps(nexrad.sweeps);
    for (const sweep of sweeps) {
      const row = sweepAtAircraft(nexrad.site, sweep, fixes);
      if (row.missing) {
        const when = `${clock(sweep.radials[0].t)}–${clock(sweep.radials.at(-1).t)}`;
        console.log(
          `  ${sweep.elevationDeg.toFixed(2)}° ${when}: ${row.missing === 'position' ? 'no aircraft position with a geometric altitude when the beam passed' : 'no decoded radial pointed at the aircraft'}`,
        );
        continue;
      }
      const { beam } = row;
      const where = row.inside
        ? 'inside the beam'
        : row.jetM > beam.topM
          ? `${((row.jetM - beam.topM) / 1000).toFixed(1)} km above the beam`
          : `${((beam.bottomM - row.jetM) / 1000).toFixed(1)} km below the beam`;
      console.log(
        `  ${row.elevationDeg.toFixed(2)}° ${clock(row.t)}: aircraft ${(row.jetM / 1000).toFixed(1)} km, beam ${(beam.bottomM / 1000).toFixed(1)}–${(beam.topM / 1000).toFixed(1)} km at ${(beam.groundM / 1000).toFixed(0)} km range, ${where}; beam measured ${describeGate(beam.gate.dbz)} there`,
      );
    }
    const spans = sampledAtAltitude(nexrad.site, sweeps, points);
    console.log(
      spans.length
        ? "Sweeps whose beam spanned the aircraft's altitude over its track points, whenever the beam passed (negative: the beam passed first):"
        : "No sweep's beam spanned the aircraft's altitude over its track points.",
    );
    for (const { sweep, hits } of spans) {
      const values = hits
        .map((hit) => hit.dbz)
        .filter((v) => typeof v === 'number');
      const quiet = hits.filter((hit) => hit.dbz === null).length;
      const foldedHits = hits.filter((hit) => hit.dbz === 'RF').length;
      const dts = hits.map((hit) => hit.dt);
      const range = values.length
        ? `${Math.min(...values)}–${Math.max(...values)} dBZ`
        : 'no dBZ values';
      console.log(
        `  ${sweep.elevationDeg.toFixed(2)}° ${clock(sweep.radials[0].t)}: ${hits.length} points ${clock(hits[0].point.t)}–${clock(hits.at(-1).point.t)}, ${range} (${quiet} no echo, ${foldedHits} range folded), beam time minus aircraft time ${Math.round(Math.min(...dts))} to ${Math.round(Math.max(...dts))} s`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
