import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { traceFixes } from './readsb-trace-to-kml.mjs';
import {
  cloudTopOver,
  navigate,
  offsetKm,
  scanAngles,
} from './goes-cloud-top-to-kml.mjs';

/**
 * Draw GLM lightning events (JSON from scripts/glm-lcfa-to-json.py) as a KML
 * for the geo file import, and optionally measure how far each lit pixel was
 * from an aircraft (a readsb trace) at the moment it lit.
 *
 * What the data supports, and what this draws:
 * - An event is one GLM pixel, about 8 km across here, that saw light during
 *   one 2 ms frame. It says light left the cloud top somewhere in that pixel,
 *   not where the channel ran.
 * - The pixel's area is the group's area divided by its event count (every
 *   event in a group is a distinct pixel of the same frame). Each event is
 *   drawn as a north-up square of that area around its position; GLM's real
 *   pixel outline is not drawn.
 * - One pixel's reported position moves by about one packing step (0.002°,
 *   about 0.2 km) from frame to frame, so positions closer than a quarter of
 *   the side are drawn as one pixel.
 * - GLM places events where its line of sight meets the lightning ellipsoid.
 *   The values used are GOES-16's since October 2018 (glmtools revision 1):
 *   14 km above the WGS84 equator, 6 km above the poles. The granules do not
 *   state theirs; the same ellipsoid is assumed for later satellites. The
 *   squares sit at that height. Where the real cloud top is higher or lower,
 *   the position is off by parallax; --cloud-top re-places each event along
 *   its line of sight at a measured GOES cloud top instead (itself a
 *   retrieval, see scripts/goes-cloud-top-to-kml.mjs).
 */

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;
const FEET = 0.3048;
const TIME_BUCKETS = 12;

/** Lightning ellipsoid height (m) at a geodetic latitude, to first order. */
export function lightningEllipsoidHeight(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  return 14000 * Math.cos(lat) ** 2 + 6000 * Math.sin(lat) ** 2;
}

/** Side (km) of the square with one pixel's area, from its group. */
export function pixelSideKm(group) {
  if (!(group?.areaM2 > 0) || !(group.events > 0)) return null;
  return Math.sqrt(group.areaM2 / group.events) / 1000;
}

/** Corners [lon, lat] of a north-up square of `sideKm` around a point. */
export function squareCorners(lat, lon, sideKm) {
  const dLat = sideKm / 2 / KM_PER_DEG_LAT;
  const dLon =
    sideKm / 2 / (KM_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

/** Horizontal km from a point to the nearest edge of a square (0 inside). */
export function distanceToSquareKm(lat, lon, square) {
  const dy = Math.abs(lat - square.lat) * KM_PER_DEG_LAT;
  const dx =
    Math.abs(lon - square.lon) *
    KM_PER_DEG_LON_EQUATOR *
    Math.cos((square.lat * Math.PI) / 180);
  const half = square.sideKm / 2;
  return Math.hypot(Math.max(dx - half, 0), Math.max(dy - half, 0));
}

/**
 * The aircraft at time `t`, linearly between the fixes with a geometric
 * height either side, or null outside them, across a step longer than
 * `maxStepSec`, or across a stale fix or new leg (with or without a height).
 */
export function aircraftAt(fixes, t, maxStepSec = 30) {
  let a = null;
  let broken = false;
  for (const b of fixes) {
    if (b.stale || b.newLeg) broken = true;
    if (b.geom === null) continue;
    if (t === b.t)
      return { lat: b.lat, lon: b.lon, geomFt: b.geom, stepSec: 0 };
    if (a && t > a.t && t < b.t) {
      if (broken || b.t - a.t > maxStepSec) return null;
      const f = (t - a.t) / (b.t - a.t);
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        geomFt: a.geom + (b.geom - a.geom) * f,
        stepSec: b.t - a.t,
      };
    }
    a = b;
    broken = false;
  }
  return null;
}

/** A square's height: its measured cloud top when corrected, else the lightning ellipsoid. */
export const squareHeightM = (square) =>
  square.heightM ?? lightningEllipsoidHeight(square.lat);

/**
 * Re-place squares along their lines of sight at the measured cloud top
 * (cloud-top JSON from scripts/goes-acha-to-json.py) instead of the lightning
 * ellipsoid. The line of sight is taken from the cloud-top file's fixed grid
 * (the nominal satellite position). The height is found by following the
 * line to the drawn top over each trial point, until it changes by under
 * 10 m. Squares with no top over them keep the ellipsoid.
 * @returns {{squares: object[], moved: number, kept: number}}
 */
export function toCloudTop(squares, cloudTop) {
  const proj = cloudTop.projection;
  let moved = 0;
  const out = squares.map((square) => {
    const [x, y] = scanAngles(
      proj,
      square.lat,
      square.lon,
      lightningEllipsoidHeight(square.lat),
    );
    let h = lightningEllipsoidHeight(square.lat);
    let at = null;
    for (let i = 0; i < 6; i++) {
      const point = navigate(proj, x, y, h);
      const top = point && cloudTopOver(cloudTop, point[0], point[1]);
      if (!top) break;
      at = navigate(proj, x, y, top.heightM);
      if (Math.abs(top.heightM - h) < 10) {
        h = top.heightM;
        break;
      }
      h = top.heightM;
    }
    if (!at) return square;
    moved += 1;
    const shift = offsetKm(square.lat, square.lon, at[0], at[1]);
    return {
      ...square,
      lat: at[0],
      lon: at[1],
      heightM: h,
      shiftKm: shift.km,
      shiftBearing: shift.bearing,
    };
  });
  return { squares: out, moved, kept: squares.length - moved };
}

/** Events with their pixel squares; events whose group gives no area are dropped. */
export function eventSquares(glm) {
  if (glm?.format !== 1 || !Array.isArray(glm.events) || !glm.groups)
    throw new Error('Not GLM JSON from scripts/glm-lcfa-to-json.py');
  const squares = [];
  let dropped = 0;
  for (const [t, lat, lon, energyJ, groupId] of glm.events) {
    const group = glm.groups[groupId];
    const sideKm = pixelSideKm(group);
    if (sideKm === null) {
      dropped += 1;
      continue;
    }
    squares.push({
      t,
      lat,
      lon,
      energyJ,
      groupId,
      flashId: group.flash,
      sideKm,
    });
  }
  return { squares, dropped };
}

/**
 * For each group lit while the aircraft's position is known, the nearest of
 * its pixel squares to the aircraft at the group's time.
 */
export function groupDistances(squares, fixes) {
  const byGroup = new Map();
  for (const square of squares) {
    const list = byGroup.get(square.groupId) || [];
    list.push(square);
    byGroup.set(square.groupId, list);
  }
  const out = [];
  for (const [groupId, list] of byGroup) {
    const t = list[0].t;
    const jet = aircraftAt(fixes, t);
    if (!jet) continue;
    const km = Math.min(
      ...list.map((square) => distanceToSquareKm(jet.lat, jet.lon, square)),
    );
    out.push({
      groupId,
      flashId: list[0].flashId,
      t,
      km,
      jet,
      pixelHeightM: squareHeightM(list[0]),
      sideKm: list[0].sideKm,
    });
  }
  return out.sort((a, b) => a.km - b.km || a.t - b.t);
}

/** The nearest group of each flash, nearest flashes first. */
export function nearestPerFlash(rows) {
  const best = new Map();
  for (const row of rows) {
    const seen = best.get(row.flashId);
    if (!seen || row.km < seen.km || (row.km === seen.km && row.t < seen.t))
      best.set(row.flashId, row);
  }
  return [...best.values()].sort((a, b) => a.km - b.km || a.t - b.t);
}

const clock = (t) => new Date(t * 1000).toISOString().slice(11, 22) + 'Z';

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

const hex = (n) => Math.round(n).toString(16).padStart(2, '0');

/** Fill colour (KML aabbggrr) for a time bucket: cyan early to magenta late. */
export function bucketColor(bucket, buckets = TIME_BUCKETS) {
  const f = buckets > 1 ? bucket / (buckets - 1) : 0;
  const r = 255 * f;
  const g = 200 * (1 - f);
  return `99${hex(255)}${hex(g)}${hex(r)}`;
}

/**
 * Squares lit within [from, to] (Unix seconds), one per pixel: repeated
 * events in one pixel would otherwise stack into an opaque block. Positions
 * within a quarter side of a pixel's first position, on both axes, are that
 * pixel. Each pixel keeps its first and last time, event count and flashes.
 */
export function litPixels(squares, from = -Infinity, to = Infinity) {
  const pixels = [];
  const samePixel = (pixel, square) =>
    Math.abs(square.lat - pixel.lat) * KM_PER_DEG_LAT < pixel.sideKm / 4 &&
    Math.abs(square.lon - pixel.lon) *
      KM_PER_DEG_LON_EQUATOR *
      Math.cos((pixel.lat * Math.PI) / 180) <
      pixel.sideKm / 4;
  for (const square of [...squares].sort((x, y) => x.t - y.t)) {
    if (square.t < from || square.t > to) continue;
    const pixel = pixels.find((candidate) => samePixel(candidate, square));
    if (!pixel)
      pixels.push({
        lat: square.lat,
        lon: square.lon,
        sideKm: square.sideKm,
        heightM: square.heightM,
        first: square.t,
        last: square.t,
        events: 1,
        flashes: new Set([square.flashId]),
      });
    else {
      pixel.first = Math.min(pixel.first, square.t);
      pixel.last = Math.max(pixel.last, square.t);
      pixel.events += 1;
      pixel.flashes.add(square.flashId);
    }
  }
  return pixels;
}

/**
 * The KML document and counts, for events within [from, to].
 * @returns {{kml: string, pixels: number, events: number, dropped: number,
 *   start: number, end: number}}
 */
export function glmToKml(
  glm,
  { from = -Infinity, to = Infinity, cloudTop = null } = {},
) {
  const decoded = eventSquares(glm);
  const { dropped } = decoded;
  const corrected = cloudTop
    ? toCloudTop(decoded.squares, cloudTop)
    : { squares: decoded.squares, moved: 0, kept: decoded.squares.length };
  const pixels = litPixels(corrected.squares, from, to);
  if (!pixels.length) throw new Error('No GLM events to draw.');
  const start = pixels[0].first;
  const end = Math.max(...pixels.map((pixel) => pixel.last));
  const span = Math.max(end - start, 1e-9);
  const bucketOf = (t) =>
    Math.min(TIME_BUCKETS - 1, Math.floor(((t - start) / span) * TIME_BUCKETS));
  const styles = Array.from(
    { length: TIME_BUCKETS },
    (_, i) =>
      `<Style id="t${i}"><LineStyle><color>ffffffff</color><width>1</width></LineStyle><PolyStyle><color>${bucketColor(i)}</color></PolyStyle></Style>`,
  );
  const placemarks = pixels.map((pixel) => {
    const height = Math.round(squareHeightM(pixel));
    const ring = squareCorners(pixel.lat, pixel.lon, pixel.sideKm)
      .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)},${height}`)
      .join(' ');
    const when =
      pixel.first === pixel.last
        ? clock(pixel.first)
        : `${clock(pixel.first)}–${clock(pixel.last)}`;
    const name = `${when} GLM pixel · ${pixel.events} event${pixel.events === 1 ? '' : 's'} · ${pixel.flashes.size} flash${pixel.flashes.size === 1 ? '' : 'es'}`;
    return `<Placemark><name>${escapeXml(name)}</name><styleUrl>#t${bucketOf(pixel.first)}</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  });
  const title = escapeXml(
    `GLM ${glm.platform || ''} ${clock(start)}–${clock(end)}`.replace(
      /\s+/g,
      ' ',
    ),
  );
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${title}</name>
${styles.join('\n')}
${placemarks.join('\n')}
</Document></kml>
`;
  return {
    kml,
    pixels: pixels.length,
    events: pixels.reduce((sum, pixel) => sum + pixel.events, 0),
    dropped,
    start,
    end,
    moved: corrected.moved,
    kept: corrected.kept,
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
    let cloudTopPath;
    [args, cloudTopPath] = option(args, '--cloud-top');
    const [input, output, ...rest] = args;
    if (!input || !output || rest.length)
      throw new Error(
        'Usage: node scripts/glm-to-kml.mjs <glm.json> <out.kml> [--from ISO] [--to ISO] [--trace <trace_full.json>] [--cloud-top <cloud-top.json>]',
      );
    const from = fromText ? isoSeconds(fromText, '--from') : -Infinity;
    const to = toText ? isoSeconds(toText, '--to') : Infinity;
    const glm = JSON.parse(await readFile(input, 'utf8'));
    const cloudTop = cloudTopPath
      ? JSON.parse(await readFile(cloudTopPath, 'utf8'))
      : null;
    const { kml, pixels, events, dropped, start, end } = glmToKml(glm, {
      from,
      to,
      cloudTop,
    });
    await writeFile(output, kml);
    console.log(
      `${pixels} lit GLM pixels from ${events} events (${dropped} events without a group area left out), ${clock(start)}–${clock(end)}, coloured by first time, cyan early to magenta late.`,
    );
    let squares = eventSquares(glm).squares.filter(
      (square) => square.t >= from && square.t <= to,
    );
    if (cloudTop) {
      const corrected = toCloudTop(squares, cloudTop);
      squares = corrected.squares;
      const shifts = squares.filter((square) => square.shiftKm !== undefined);
      const mean = (key) =>
        shifts.reduce((sum, square) => sum + square[key], 0) / shifts.length;
      const sum = (f) =>
        shifts.reduce(
          (total, square) => total + f((square.shiftBearing * Math.PI) / 180),
          0,
        );
      const bearing =
        ((Math.atan2(sum(Math.sin), sum(Math.cos)) * 180) / Math.PI + 360) %
        360;
      console.log(
        `${corrected.moved} events in the window re-placed at the measured cloud top along their lines of sight, ${corrected.kept} left on the lightning ellipsoid (no top over them)${shifts.length ? `; mean shift ${mean('shiftKm').toFixed(1)} km towards ${Math.round(bearing)}°, mean height ${Math.round(mean('heightM'))} m` : ''}.`,
      );
    }
    if (tracePath) {
      const fixes = traceFixes(JSON.parse(await readFile(tracePath, 'utf8')));
      const rows = nearestPerFlash(groupDistances(squares, fixes));
      const height = cloudTop
        ? 'at the measured cloud top where there is one'
        : 'at the assumed ellipsoid height';
      if (!rows.length)
        console.log("No GLM flash lit while the aircraft's position is known.");
      else {
        console.log(
          `${rows.length} GLM flashes lit while the aircraft's position is known. Per flash, horizontal distance from the aircraft to the nearest north-up square of one pixel's area (about ${rows[0].sideKm.toFixed(1)} km) ${height}; 0 km means inside a square. Sub-kilometre distances are within GLM's frame-to-frame position jitter (about 0.2 km) and the parallax of any height error:`,
        );
        for (const row of rows.slice(0, 10))
          console.log(
            `  ${clock(row.t)} flash ${row.flashId}: ${row.km.toFixed(1)} km; aircraft ${Math.round(row.jet.geomFt * FEET)} m geometric, pixel at ${Math.round(row.pixelHeightM)} m; aircraft position interpolated across a ${row.jet.stepSec.toFixed(1)} s step`,
          );
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
