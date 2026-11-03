import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import {
  DEFAULT_GAP_SEC,
  RATE_LIMIT_FPM,
  dotPngDataUrl,
  segmentFlags,
  traceFixes,
  traceRuns,
  traceToKml,
} from '../../scripts/readsb-trace-to-kml.mjs';

// [dt, lat, lon, alt, gs, track, flags, rate, details, type, geom, geomRate]
const entry = (
  dt,
  alt,
  geom,
  {
    flags = 0,
    rate = 0,
    geomRate = 0,
    details = null,
    type = 'adsb_icao',
  } = {},
) => [
  dt,
  26.7 + dt / 1e4,
  -80.1,
  alt,
  450,
  100,
  flags,
  rate,
  details,
  type,
  geom,
  geomRate,
];

const trace = (entries) => ({
  icao: 'a9ab17',
  r: 'N722BD',
  timestamp: 1793491200,
  trace: entries,
});

const base = {
  t: 0,
  baro: 9000,
  geom: 10000,
  rate: -5000,
  geomRate: -5000,
  stale: false,
  newLeg: false,
  nic: 9,
};

test('NIC is carried forward from the entries that report it', () => {
  const fixes = traceFixes(
    trace([
      entry(0, 35000, 36950, { details: { nic: 9 } }),
      entry(1, 35000, 36950),
      entry(2, 35000, 36950, { details: { nic: 0 } }),
      entry(3, 35000, 36950),
    ]),
  );
  assert.deepEqual(
    fixes.map((fix) => fix.nic),
    [9, 9, 0, 0],
  );
});

test('a stale fix or a source without NIC clears the carried NIC', () => {
  const fixes = traceFixes(
    trace([
      entry(0, 35000, 36950, { details: { nic: 0 } }),
      entry(1, 35000, 36950, { type: 'mlat' }),
      entry(2, 35000, 36950, { details: { nic: 0 } }),
      entry(30, 35000, 36950, { flags: 1 }),
      entry(31, 35000, 36950, { type: 'adsr_icao', details: { nic: 8 } }),
    ]),
  );
  assert.deepEqual(
    fixes.map((fix) => fix.nic),
    [0, null, 0, null, 8],
  );
});

test('trace flags are read from their bits', () => {
  const [plain, stale, leg, geometric] = traceFixes(
    trace([
      entry(0, 35000, 36950),
      entry(1, 35000, 36950, { flags: 1 }),
      entry(2, 35000, 36950, { flags: 2 }),
      entry(3, 36950, null, { flags: 8 }),
    ]),
  );
  assert.deepEqual(
    [plain.stale, plain.newLeg, stale.stale, leg.newLeg],
    [false, false, true, true],
  );
  assert.equal(geometric.baro, null);
  assert.equal(geometric.geom, 36950);
});

test('the geometric rate is read from its own slot', () => {
  const [fix] = traceFixes(
    trace([entry(0, 9000, 10000, { rate: -100, geomRate: -RATE_LIMIT_FPM })]),
  );
  assert.equal(fix.rate, -100);
  assert.equal(fix.geomRate, -RATE_LIMIT_FPM);
  assert.deepEqual(segmentFlags(base, { ...fix, t: 1, nic: 9 }), ['rateLimit']);
});

test('each kind of missing data is flagged on its own stretch', () => {
  const next = { ...base, t: 1, baro: 8900, geom: 9900 };
  assert.deepEqual(segmentFlags(base, next), []);
  assert.deepEqual(segmentFlags(base, { ...next, t: DEFAULT_GAP_SEC + 1 }), [
    'gap',
  ]);
  assert.deepEqual(segmentFlags(base, { ...next, stale: true }), ['stale']);
  assert.deepEqual(segmentFlags(base, { ...next, nic: 0 }), ['nic0']);
  assert.deepEqual(segmentFlags(base, { ...next, baro: 9000 }), [
    'baroUnchanged',
  ]);
  assert.deepEqual(segmentFlags(base, { ...next, rate: -RATE_LIMIT_FPM }), [
    'rateLimit',
  ]);
  assert.deepEqual(
    segmentFlags(base, {
      ...next,
      baro: 9000,
      nic: 0,
      rate: -RATE_LIMIT_FPM,
    }),
    ['nic0', 'baroUnchanged', 'rateLimit'],
  );
});

test('a step within readsb’s 20 s trace interval is not a gap', () => {
  assert.deepEqual(
    segmentFlags(base, { ...base, t: 19.6, baro: 8900, geom: 9900 }),
    [],
  );
});

test('a held baro altitude is not flagged across a gap or for small drift', () => {
  const cruise = { ...base, baro: 35000, geom: 36950 };
  assert.deepEqual(segmentFlags(cruise, { ...cruise, t: 5, geom: 36975 }), []);
  assert.deepEqual(
    segmentFlags(cruise, { ...cruise, t: 600, geom: 37075, stale: true }),
    ['stale', 'gap'],
  );
});

test('runs merge equal flags and break at missing heights and new legs', () => {
  const runs = traceRuns(
    traceFixes(
      trace([
        entry(0, 35000, 36950),
        entry(1, 34900, 36850),
        entry(2, 34800, 36750),
        entry(40, 34700, 36650),
        entry(41, 34600, null),
        entry(42, 34500, 36450),
        entry(43, 34400, 36350),
        entry(7200, 34000, 35950, { flags: 2 }),
        entry(7201, 33900, 35850),
      ]),
    ),
  );
  assert.deepEqual(
    runs.map(({ flags, fixes }) => [flags.join(), fixes.map((f) => f.geom)]),
    [
      ['', [36950, 36850, 36750]],
      ['gap', [36750, 36650]],
      ['', [36450, 36350]],
      ['', [35950, 35850]],
    ],
  );
});

test('the KML places fixes at geometric ellipsoid height and styles each run', () => {
  const { kml, fixes, skipped, runs } = traceToKml(
    trace([
      entry(0, 'ground', null),
      entry(100, 9000, 10000, { details: { nic: 9 } }),
      entry(101, 8750, 9500),
      entry(102, 8750, 9200),
      entry(103, 8750, 9000, { rate: -RATE_LIMIT_FPM, details: { nic: 0 } }),
    ]),
  );
  assert.equal(fixes, 4);
  assert.equal(skipped, 1);
  assert.equal(runs, 3);
  assert.match(
    kml,
    /<altitudeMode>absolute<\/altitudeMode><coordinates>-80\.1,26\.71,3048<\/coordinates>/,
  );
  assert.match(kml, /no flag<\/name><styleUrl>#line-unflagged/);
  assert.match(
    kml,
    /baro unchanged, geometric moved<\/name><styleUrl>#line-baroUnchanged/,
  );
  assert.match(
    kml,
    /NIC 0; baro unchanged, geometric moved; vertical rate at limit<\/name><styleUrl>#line-nic0/,
  );
  assert.match(
    kml,
    /geometric 9,000 ft · baro 8,750 ft · NIC 0<\/name><styleUrl>#fix-nic0/,
  );
  assert.match(kml, /<name>N722BD 2026-11-01<\/name>/);
});

test('names are escaped for XML', () => {
  const { kml } = traceToKml({
    ...trace([entry(0, 100, 200), entry(1, 100, 300)]),
    r: 'A<&>',
  });
  assert.match(kml, /<name>A&lt;&amp;&gt; /);
});

test('a non-trace input is refused', () => {
  assert.throws(() => traceToKml({ ac: [] }), /Not a readsb trace/);
});

test('a trace without geometric altitudes is refused, not written empty', () => {
  const old = trace([
    [0, 30, -97, 35000, 450, 0, 0, 0, null],
    [1, 30.01, -97, 35000, 450, 0, 0, 0, null],
  ]);
  assert.throws(() => traceToKml(old), /before 2022/);
});

test('the fix icon is a decodable PNG data URL', () => {
  const url = dotPngDataUrl();
  assert.match(url, /^data:image\/png;base64,/);
  const png = Buffer.from(url.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 9);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(pixels.length, (9 * 4 + 1) * 9);
  // The centre pixel is opaque white, a corner is transparent.
  const at = (x, y) => y * (9 * 4 + 1) + 1 + x * 4;
  assert.equal(pixels[at(4, 4) + 3], 255);
  assert.equal(pixels[at(0, 0) + 3], 0);
});
