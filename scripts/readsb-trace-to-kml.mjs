import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

/**
 * Convert a readsb `trace_full_<hex>.json` (the adsb.lol globe_history format,
 * README-json.md "trace jsons") into a KML the geo file import can draw: one
 * dot per saved fix at its geometric height, joined by lines whose colour says
 * what the data does not show between or at those fixes.
 *
 * Heights are the trace's geometric altitude (feet above the WGS84 ellipsoid;
 * readsb may derive it from barometric altitude plus the reported difference),
 * written as KML `absolute`, which Cesium also reads as ellipsoid height.
 * Barometric altitude is a different reference, hundreds of metres away at
 * cruise depending on temperature, so a fix without a geometric altitude is
 * left out and the line breaks there instead of jumping between references.
 *
 * readsb does not save every position it hears: in steady flight it saves one
 * when something changes or its trace interval (20 s by default) passes. A
 * long step between saved fixes is therefore "no saved fix", not a lost
 * signal; readsb's own stale flag is the reception gap, drawn separately.
 */

const FEET = 0.3048;
/** ADS-B's largest vertical rate: the 9-bit field at full scale, "more than". */
export const RATE_LIMIT_FPM = 32640;
/** Seconds between saved fixes beyond which the stretch is called a gap:
 * longer than readsb's default 20 s trace interval. */
export const DEFAULT_GAP_SEC = 30;
/** Barometric altitude repeating while geometric height moves this far. */
const UNCHANGED_GEOM_FT = 100;

/** Line colours (KML aabbggrr) in display priority, highest first. */
export const SEGMENT_STYLES = Object.freeze([
  {
    flag: 'stale',
    color: 'ff00ffff',
    width: 2,
    label: 'reception gap (readsb stale)',
  },
  { flag: 'gap', color: 'ff9a9a9a', width: 2, label: 'no saved fix' },
  { flag: 'nic0', color: 'ff0000ff', width: 4, label: 'NIC 0' },
  {
    flag: 'baroUnchanged',
    color: 'ffff00ff',
    width: 4,
    label: 'baro unchanged, geometric moved',
  },
  {
    flag: 'rateLimit',
    color: 'ff0099ff',
    width: 4,
    label: 'vertical rate at limit',
  },
]);
const UNFLAGGED = {
  flag: 'unflagged',
  color: 'ffffffff',
  width: 3,
  label: 'no flag',
};

/** Position sources whose detail object can report NIC. */
const NIC_SOURCE = /^ads[br]/;

/**
 * Fixes from a parsed trace. NIC rides only on entries with a detail object,
 * so the last report is carried forward, until a stale fix or a position from
 * a source without NIC (MLAT, TIS-B) clears it.
 * @returns {{t: number, lat: number, lon: number, baro: number|null,
 *   geom: number|null, rate: number|null, geomRate: number|null,
 *   stale: boolean, newLeg: boolean, nic: number|null}[]}
 */
export function traceFixes(trace) {
  if (
    !trace ||
    !Number.isFinite(trace.timestamp) ||
    !Array.isArray(trace.trace)
  )
    throw new Error('Not a readsb trace: needs timestamp and trace[]');
  let nic = null;
  return trace.trace.map((entry) => {
    const [dt, lat, lon, alt, , , flags, rate, details, type, geom, geomRate] =
      entry;
    const stale = (flags & 1) > 0;
    if (stale || (typeof type === 'string' && !NIC_SOURCE.test(type)))
      nic = null;
    if (Number.isFinite(details?.nic)) nic = details.nic;
    // Flag 8 marks the altitude slot as geometric, not barometric.
    const baroSlot = flags & 8 ? null : alt;
    return {
      t: trace.timestamp + dt,
      lat,
      lon,
      baro: Number.isFinite(baroSlot) ? baroSlot : null,
      geom: Number.isFinite(geom)
        ? geom
        : flags & 8 && Number.isFinite(alt)
          ? alt
          : null,
      rate: Number.isFinite(rate) ? rate : null,
      geomRate: Number.isFinite(geomRate) ? geomRate : null,
      stale,
      newLeg: (flags & 2) > 0,
      nic,
    };
  });
}

/** What the stretch from fix `a` to fix `b` does not show, highest first. */
export function segmentFlags(a, b, gapSec = DEFAULT_GAP_SEC) {
  const flags = [];
  if (b.stale) flags.push('stale');
  const long = b.t - a.t > gapSec;
  if (long) flags.push('gap');
  if (b.nic === 0) flags.push('nic0');
  // Across a gap geometric height drifts with pressure at a held level.
  if (
    !long &&
    !b.stale &&
    a.baro !== null &&
    a.baro === b.baro &&
    a.geom !== null &&
    b.geom !== null &&
    Math.abs(b.geom - a.geom) >= UNCHANGED_GEOM_FT
  )
    flags.push('baroUnchanged');
  if (
    Math.abs(b.rate ?? 0) >= RATE_LIMIT_FPM ||
    Math.abs(b.geomRate ?? 0) >= RATE_LIMIT_FPM
  )
    flags.push('rateLimit');
  return flags;
}

/**
 * Runs of consecutive fixes that share one set of flags. A fix without a
 * geometric height, or one starting a new leg, ends the line there.
 * @returns {{flags: string[], fixes: object[]}[]}
 */
export function traceRuns(fixes, gapSec = DEFAULT_GAP_SEC) {
  const runs = [];
  let previous = null;
  for (const fix of fixes) {
    if (fix.geom === null) {
      previous = null;
      continue;
    }
    if (previous && !fix.newLeg) {
      const flags = segmentFlags(previous, fix, gapSec);
      const run = runs.at(-1);
      if (
        run &&
        run.fixes.at(-1) === previous &&
        run.flags.join() === flags.join()
      )
        run.fixes.push(fix);
      else runs.push({ flags, fixes: [previous, fix] });
    }
    previous = fix;
  }
  return runs;
}

const styleFor = (flags) =>
  SEGMENT_STYLES.find(({ flag }) => flags.includes(flag)) || UNFLAGGED;

const clock = (t) => new Date(t * 1000).toISOString().slice(11, 22) + 'Z';

const coordinate = (fix) =>
  `${fix.lon},${fix.lat},${Math.round(fix.geom * FEET * 10) / 10}`;

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

/** A small white disc as a PNG data URL, so fixes need no external icon. */
export function dotPngDataUrl(size = 9) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - centre, y - centre) <= size / 2 - 0.5;
      raw.fill(
        inside ? 255 : 0,
        y * (size * 4 + 1) + 1 + x * 4,
        y * (size * 4 + 1) + 5 + x * 4,
      );
    }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * The KML document and counts for one trace.
 * @returns {{kml: string, fixes: number, skipped: number, runs: number}}
 */
export function traceToKml(trace, { gapSec = DEFAULT_GAP_SEC } = {}) {
  const fixes = traceFixes(trace);
  const placed = fixes.filter((fix) => fix.geom !== null);
  if (!placed.length)
    throw new Error(
      'No fix has a geometric altitude (traces written before 2022 carry none).',
    );
  const runs = traceRuns(fixes, gapSec);
  const dot = dotPngDataUrl();
  const styles = [UNFLAGGED, ...SEGMENT_STYLES]
    .map(
      ({ flag, color, width }) =>
        `<Style id="line-${flag}"><LineStyle><color>${color}</color><width>${width}</width></LineStyle></Style>`,
    )
    .concat(
      ['ffffffff', 'ff0000ff'].map(
        (color, i) =>
          `<Style id="fix-${i ? 'nic0' : 'ok'}"><IconStyle><color>${color}</color><scale>0.2</scale><Icon><href>${dot}</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>`,
      ),
    );
  const lines = runs.map(({ flags, fixes: run }) => {
    const { flag } = styleFor(flags);
    const what = flags.length
      ? SEGMENT_STYLES.filter((s) => flags.includes(s.flag))
          .map((s) => s.label)
          .join('; ')
      : UNFLAGGED.label;
    return `<Placemark><name>${escapeXml(`${clock(run[0].t)}–${clock(run.at(-1).t)} ${what}`)}</name><styleUrl>#line-${flag}</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${run.map(coordinate).join(' ')}</coordinates></LineString></Placemark>`;
  });
  const points = placed.map((fix) => {
    const parts = [
      clock(fix.t),
      `geometric ${Math.round(fix.geom).toLocaleString('en-US')} ft`,
      fix.baro === null ? null : `baro ${fix.baro.toLocaleString('en-US')} ft`,
      fix.nic === null ? null : `NIC ${fix.nic}`,
    ].filter(Boolean);
    return `<Placemark><name>${escapeXml(parts.join(' · '))}</name><styleUrl>#fix-${fix.nic === 0 ? 'nic0' : 'ok'}</styleUrl><Point><altitudeMode>absolute</altitudeMode><coordinates>${coordinate(fix)}</coordinates></Point></Placemark>`;
  });
  const title = escapeXml(
    `${trace.r || trace.icao || 'trace'} ${new Date(trace.timestamp * 1000).toISOString().slice(0, 10)}`,
  );
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${title}</name>
${styles.join('\n')}
<Folder><name>Track</name>
${lines.join('\n')}
</Folder>
<Folder><name>Fixes</name>
${points.join('\n')}
</Folder>
</Document></kml>
`;
  return {
    kml,
    fixes: placed.length,
    skipped: fixes.length - placed.length,
    runs: runs.length,
  };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  try {
    const [input, output, ...rest] = process.argv.slice(2);
    let gapSec = DEFAULT_GAP_SEC;
    if (rest.length === 2 && rest[0] === '--gap') gapSec = Number(rest[1]);
    if (
      !input ||
      !output ||
      (rest.length && rest[0] !== '--gap') ||
      !(gapSec > 0)
    )
      throw new Error(
        'Usage: node scripts/readsb-trace-to-kml.mjs <trace_full.json> <out.kml> [--gap <seconds>]',
      );
    const trace = JSON.parse(await readFile(input, 'utf8'));
    const { kml, fixes, skipped, runs } = traceToKml(trace, { gapSec });
    await writeFile(output, kml);
    console.log(
      `${fixes} fixes, ${runs} line runs, ${skipped} fixes without geometric altitude left out.`,
    );
    console.log(
      'Lines: ' +
        [UNFLAGGED, ...SEGMENT_STYLES].map(({ label }) => label).join('; ') +
        ` (white, yellow, gray, red, magenta, orange, in that order; gap > ${gapSec} s). Red dots: NIC 0.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
