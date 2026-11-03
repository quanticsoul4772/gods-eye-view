import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { traceFixes } from './readsb-trace-to-kml.mjs';

/**
 * Draw GOES ABI cloud-top heights (JSON from scripts/goes-acha-to-json.py) as
 * a KML surface placed where each top is, and optionally report the cloud
 * tops above an aircraft: the drawn top directly overhead, and the top along
 * the satellite's line of sight through the aircraft, which lies on the
 * satellite side of it.
 *
 * What the data supports, and what this draws:
 * - A pixel is one ABI footprint (10 km at nadir for CONUS, 4 km for a
 *   mesoscale sector) with one retrieved cloud-top height. The height comes
 *   from the retrieved cloud-top temperature looked up in a model profile;
 *   its accuracy requirement is for clouds with 11 µm emissivity above 0.8,
 *   and infrared comes from somewhat inside a cloud, so a physical top can be
 *   higher.
 * - Only good-quality pixels carry a height in these files. A pixel without
 *   one may be clear sky or a failed retrieval; the file does not tell them
 *   apart.
 * - The file's grid is navigated to the ground, so a top kilometres up sits
 *   kilometres away from its grid position. Each pixel's corners are placed
 *   where their lines of sight reach the pixel's height (on the ellipsoid
 *   raised by that height, within a metre of that height above it here). The
 *   squares are drawn flat at that height.
 * - Heights are from the model profile, about sea level; KML absolute is
 *   ellipsoid height, tens of metres apart here.
 * - The file covers a scan window (minutes for CONUS); the time of each row
 *   is not in the file.
 */

const FEET = 0.3048;
const RAD = Math.PI / 180;

/** Fixed-grid scan angles [x, y] (rad) of a point at height h (m). */
export function scanAngles(proj, lat, lon, h) {
  const { a, b } = proj;
  const H = proj.heightM + a;
  const e2 = 1 - (b * b) / (a * a);
  const phi = lat * RAD;
  const dlam = (lon - proj.lon0) * RAD;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const X = (N + h) * Math.cos(phi) * Math.cos(dlam);
  const Y = (N + h) * Math.cos(phi) * Math.sin(dlam);
  const Z = (N * (1 - e2) + h) * Math.sin(phi);
  const sx = H - X;
  const sy = -Y;
  const sz = Z;
  return [Math.asin(-sy / Math.hypot(sx, sy, sz)), Math.atan(sz / sx)];
}

/**
 * [lat, lon] where the line of sight at scan angles (x, y) meets the
 * ellipsoid raised by h metres, or null if it misses (GOES-R PUG navigation
 * with the raised semi-axes).
 */
export function navigate(proj, x, y, h) {
  const A = proj.a + h;
  const B = proj.b + h;
  const H = proj.heightM + proj.a;
  const qa =
    Math.sin(x) ** 2 +
    Math.cos(x) ** 2 *
      (Math.cos(y) ** 2 + ((A * A) / (B * B)) * Math.sin(y) ** 2);
  const qb = -2 * H * Math.cos(x) * Math.cos(y);
  const qc = H * H - A * A;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const rs = (-qb - Math.sqrt(disc)) / (2 * qa);
  const sx = rs * Math.cos(x) * Math.cos(y);
  const sy = -rs * Math.sin(x);
  const sz = rs * Math.cos(x) * Math.sin(y);
  const lat =
    Math.atan(((A * A) / (B * B)) * (sz / Math.hypot(H - sx, sy))) / RAD;
  const lon = proj.lon0 - Math.atan(sy / (H - sx)) / RAD;
  return [lat, lon];
}

/** Corners [lat, lon] of a pixel placed at its own height, or null. */
export function pixelCorners(data, [x, y, heightM]) {
  const hx = data.dx / 2;
  const hy = data.dy / 2;
  const corners = [
    [x - hx, y - hy],
    [x + hx, y - hy],
    [x + hx, y + hy],
    [x - hx, y + hy],
  ].map(([cx, cy]) => navigate(data.projection, cx, cy, heightM));
  return corners.some((c) => c === null) ? null : corners;
}

/** The pixel whose footprint holds scan angles (x, y), or null. */
export function pixelAt(data, x, y) {
  let best = null;
  for (const pixel of data.pixels) {
    const ox = Math.abs(pixel[0] - x);
    const oy = Math.abs(pixel[1] - y);
    if (ox <= data.dx / 2 + 1e-12 && oy <= data.dy / 2 + 1e-12) {
      const score = ox + oy;
      if (!best || score < best.score) best = { pixel, score };
    }
  }
  return best?.pixel ?? null;
}

/**
 * The cloud top along the satellite's line of sight through a point at
 * height h: the pixel that point appears in. Null outside the decoded block.
 */
export function cloudTopThrough(data, lat, lon, h) {
  const [x, y] = scanAngles(data.projection, lat, lon, h);
  const pixel = pixelAt(data, x, y);
  return pixel ? { heightM: pixel[2], dqf: pixel[3], pixel } : null;
}

/** DQF values, after the file's flag_meanings. */
const QUALITY = [
  'good',
  'marginal',
  'retrieval attempted',
  'bad',
  'opaque retrieval',
];

/** Style id: h0 below 7 km, then 1 km bands to h11 at 17 km and above; "poor" for any flag but good. */
export function styleFor(heightM, dqf) {
  if (dqf !== 0) return 'poor';
  return `h${Math.max(0, Math.min(11, Math.floor(heightM / 1000) - 6))}`;
}

const hex = (n) => Math.round(n).toString(16).padStart(2, '0');

/** Band colour (KML aabbggrr): blue low to white high. */
export function bandColor(band) {
  const f = band / 11;
  return `cc${hex(255)}${hex(120 + 135 * f)}${hex(40 + 215 * f)}`;
}

const clock = (t) => new Date(t * 1000).toISOString().slice(11, 19) + 'Z';

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

/**
 * The KML surface and counts.
 * @returns {{kml: string, drawn: number, noHeight: number}}
 */
export function cloudTopToKml(data) {
  if (data?.format !== 1 || !data.projection || !Array.isArray(data.pixels))
    throw new Error('Not cloud-top JSON from scripts/goes-acha-to-json.py');
  const window = `${clock(data.start)}–${clock(data.end)}`;
  const styles = [
    `<Style id="poor"><LineStyle><color>ff808080</color><width>1</width></LineStyle><PolyStyle><color>66808080</color></PolyStyle></Style>`,
    ...Array.from(
      { length: 12 },
      (_, i) =>
        `<Style id="h${i}"><LineStyle><color>55ffffff</color><width>1</width></LineStyle><PolyStyle><color>${bandColor(i)}</color></PolyStyle></Style>`,
    ),
  ];
  let noHeight = 0;
  const placemarks = [];
  for (const pixel of data.pixels) {
    const [, , heightM, dqf] = pixel;
    if (heightM === null) {
      noHeight += 1;
      continue;
    }
    const corners = pixelCorners(data, pixel);
    if (!corners) continue;
    const ring = [...corners, corners[0]]
      .map(([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)},${heightM}`)
      .join(' ');
    const quality = QUALITY[dqf] ?? 'no flag';
    const name = `cloud top ${heightM.toLocaleString('en-US')} m · ${quality} · scan ${window}`;
    placemarks.push(
      `<Placemark><name>${escapeXml(name)}</name><styleUrl>#${styleFor(heightM, dqf)}</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`,
    );
  }
  if (!placemarks.length) throw new Error('No cloud-top heights to draw.');
  const title = escapeXml(`${data.platform} ${data.scene} cloud top ${window}`);
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${title}</name>
${styles.join('\n')}
${placemarks.join('\n')}
</Document></kml>
`;
  return { kml, drawn: placemarks.length, noHeight };
}

/** Whether [lat, lon] lies inside a convex quad of [lat, lon] corners. */
export function insideQuad(corners, lat, lon) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [aLat, aLon] = corners[i];
    const [bLat, bLon] = corners[(i + 1) % 4];
    const cross = (bLon - aLon) * (lat - aLat) - (bLat - aLat) * (lon - aLon);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** The drawn cloud top directly over a point: the placed pixel holding it, or null. */
export function cloudTopOver(data, lat, lon) {
  for (const pixel of data.pixels) {
    if (pixel[2] === null) continue;
    const corners = pixelCorners(data, pixel);
    if (corners && insideQuad(corners, lat, lon))
      return { heightM: pixel[2], dqf: pixel[3], pixel };
  }
  return null;
}

/** Horizontal km and initial bearing (deg) from one point to another. */
export function offsetKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const a =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * 6371.0088 * Math.asin(Math.sqrt(a));
  const bearing =
    Math.atan2(
      Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
    ) / RAD;
  return { km, bearing: (bearing + 360) % 360 };
}

/**
 * Runs of consecutive track points (a new run after a step over 30 s) that
 * look through the same pixel. Each keeps the aircraft's altitude range, the
 * line-of-sight pixel and how far from the aircraft its top lies, and the
 * range of drawn tops directly overhead.
 */
export function sightRuns(data, points) {
  const runs = [];
  let previous = null;
  for (const point of points) {
    const altitudeM = point.geom * FEET;
    const top = cloudTopThrough(data, point.lat, point.lon, altitudeM);
    const pixel = top?.pixel ?? null;
    let offset = null;
    if (pixel && pixel[2] !== null) {
      const at = navigate(data.projection, pixel[0], pixel[1], pixel[2]);
      if (at) offset = offsetKm(point.lat, point.lon, at[0], at[1]);
    }
    const over = cloudTopOver(data, point.lat, point.lon)?.heightM ?? null;
    const run = runs.at(-1);
    const joined =
      run && run.pixel === pixel && previous && point.t - previous.t <= 30;
    if (joined) {
      run.last = point.t;
      run.lowM = Math.min(run.lowM, altitudeM);
      run.highM = Math.max(run.highM, altitudeM);
      if (offset) run.offsets.push(offset);
      if (over !== null) run.over.push(over);
    } else
      runs.push({
        pixel,
        first: point.t,
        last: point.t,
        lowM: altitudeM,
        highM: altitudeM,
        offsets: offset ? [offset] : [],
        over: over === null ? [] : [over],
      });
    previous = point;
  }
  return runs;
}

const compass = (bearing) =>
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];

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
    if (!input || !output || rest.length)
      throw new Error(
        'Usage: node scripts/goes-cloud-top-to-kml.mjs <cloud-top.json> <out.kml> [--trace <trace_full.json> [--from ISO] [--to ISO]]',
      );
    const data = JSON.parse(await readFile(input, 'utf8'));
    const { kml, drawn, noHeight } = cloudTopToKml(data);
    await writeFile(output, kml);
    console.log(
      `${drawn} cloud-top pixels drawn at their height (${noHeight} without a height left out), scan ${clock(data.start)}–${clock(data.end)}.`,
    );
    if (tracePath) {
      const from = fromText ? isoSeconds(fromText, '--from') : -Infinity;
      const to = toText ? isoSeconds(toText, '--to') : Infinity;
      const fixes = traceFixes(JSON.parse(await readFile(tracePath, 'utf8')));
      const points = fixes.filter(
        (fix) => fix.geom !== null && fix.t >= from && fix.t <= to,
      );
      if (!points.length) throw new Error('No aircraft fixes in that window.');
      console.log(
        `Cloud tops above the aircraft (scan ${clock(data.start)}–${clock(data.end)}; row times are not in the file). "Overhead" is the drawn top over the aircraft; "line of sight" is the top of the pixel the aircraft appears in (the line of sight reaches it on the satellite side; the distance given is to the pixel centre, up to half a pixel diagonal away):`,
      );
      const km = (m) => (m / 1000).toFixed(1);
      for (const run of sightRuns(data, points)) {
        const when = `${clock(run.first)}–${clock(run.last)}`;
        const aircraft = `aircraft ${km(run.lowM)}–${km(run.highM)} km`;
        const over = run.over.length
          ? `overhead ${km(Math.min(...run.over))}–${km(Math.max(...run.over))} km`
          : 'no drawn top overhead';
        if (!run.pixel) {
          console.log(
            `  ${when}: ${aircraft}; ${over}; line of sight outside the decoded pixels`,
          );
          continue;
        }
        const [, , heightM, dqf] = run.pixel;
        if (heightM === null) {
          console.log(
            `  ${when}: ${aircraft}; ${over}; line of sight: no height (clear sky or no retrieval; flag ${QUALITY[dqf] ?? 'none'})`,
          );
          continue;
        }
        const kms = run.offsets.map((o) => o.km);
        const where = run.offsets.length
          ? `, ${Math.min(...kms).toFixed(0)}–${Math.max(...kms).toFixed(0)} km ${compass(run.offsets[0].bearing)} of the aircraft`
          : '';
        console.log(
          `  ${when}: ${aircraft}; ${over}; line of sight ${km(heightM)} km (${QUALITY[dqf] ?? 'no flag'})${where}, ${km(heightM - run.highM)}–${km(heightM - run.lowM)} km higher`,
        );
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
