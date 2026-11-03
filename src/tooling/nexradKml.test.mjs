import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEAMWIDTH_DEG,
  beamAtPoint,
  beamHeightM,
  bearingDistance,
  describeGate,
  destination,
  gateAt,
  groundRangeM,
  nexradToKml,
  radialAt,
  reflectivitySweeps,
  sampledAtAltitude,
  slantRangeM,
  styleFor,
  sweepAtAircraft,
} from '../../scripts/nexrad-to-kml.mjs';

const T0 = 1793555220; // 2026-11-01T17:47:00Z
const SITE = { id: 'KTST', lat: 25.6, lon: -80.4, heightM: 4, feedhornM: 29 };

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? ''} ${actual} not within ${tolerance} of ${expected}`,
  );

// A sweep of 1° radials pointing north-ish, 250 m gates from 2 km.
const sweep = (el, t, values = () => 20, n = 600) => ({
  elevationNumber: 1,
  elevationDeg: el,
  radials: [-2, -1, 0, 1, 2].map((az, i) => ({
    t: t + i * 0.1,
    az: (az + 360) % 360,
    el,
    azSpacing: 1,
    firstGateM: 2000,
    gateM: 250,
    gate0: 0,
    ref: Array.from({ length: n }, (_, g) => values(g, az)),
  })),
});

const fix = (t, lat, lon, geomFt) => ({
  t,
  lat,
  lon,
  baro: null,
  geom: geomFt,
  rate: 0,
  geomRate: 0,
  stale: false,
  newLeg: false,
  nic: 9,
});

test('beam height follows the 4/3-earth model', () => {
  // r sin(0.5°) + r² / (2 · 4/3 · R) at 100 km: 0.873 km + 0.589 km.
  close(beamHeightM(100000, 0.5), 1461, 2);
  close(beamHeightM(0, 3), 0, 1e-6);
  assert.ok(beamHeightM(120000, 5.1) > beamHeightM(120000, 3.96));
});

test('slant range inverts ground range', () => {
  for (const el of [0.5, 5.1, 19.5])
    for (const ground of [10000, 123000]) {
      const slant = slantRangeM(ground, el);
      close(groundRangeM(slant, el), ground, 0.01, `el ${el}`);
      assert.ok(slant >= ground);
    }
});

test('destination and bearing invert each other', () => {
  const [lat, lon] = destination(25.6, -80.4, 10, 123000);
  const { bearing, distance } = bearingDistance(25.6, -80.4, lat, lon);
  close(bearing, 10, 1e-6);
  close(distance, 123000, 1e-3);
});

test('the radial nearest an azimuth wraps through north', () => {
  const s = sweep(0.5, T0);
  assert.equal(radialAt(s, 359.7).az, 0);
  assert.equal(radialAt(s, 358.6).az, 359);
  assert.equal(radialAt(s, 1.4).az, 1);
  assert.equal(radialAt(s, 10), null);
});

test('unevenly spaced radials leave no azimuth between them unmatched', () => {
  const radial = (az) => ({
    t: T0,
    az,
    el: 0.5,
    azSpacing: 0.5,
    firstGateM: 2000,
    gateM: 250,
    gate0: 0,
    ref: [1],
  });
  const s = {
    elevationNumber: 1,
    elevationDeg: 0.5,
    radials: [radial(1.208), radial(1.769)],
  };
  assert.equal(radialAt(s, 1.46).az, 1.208);
  assert.equal(radialAt(s, 1.51).az, 1.769);
  assert.equal(radialAt(s, 2.4), null);
});

test('Doppler halves of split cuts are left out of the reflectivity sweeps', () => {
  const sweeps = [
    { elevationNumber: 1, dopplerCut: false },
    { elevationNumber: 2, dopplerCut: true },
    { elevationNumber: 3, dopplerCut: false },
  ];
  assert.deepEqual(
    reflectivitySweeps(sweeps).map((s) => s.elevationNumber),
    [1, 3],
  );
});

test('the aircraft is placed where it was when the beam reached its bearing', () => {
  // Radials at 358..2° 0.1 s apart; the aircraft flies east across them.
  const s = sweep(5.1, T0);
  const [lat, lonWest] = destination(SITE.lat, SITE.lon, -2, 120000);
  const [, lonEast] = destination(SITE.lat, SITE.lon, 2, 120000);
  const fixes = [
    fix(T0 - 1, lat, lonWest, 35000),
    fix(T0 + 1.4, lat, lonEast, 35000),
  ];
  const row = sweepAtAircraft(SITE, s, fixes);
  assert.ok(!row.missing);
  close(row.beam.bearing, ((row.t - (T0 - 1)) / 2.4) * 4 - 2, 0.6);
});

test('a gate is found by slant range and refused outside the decoded ones', () => {
  const radial = { firstGateM: 2000, gateM: 250, gate0: 10, ref: [5, null, 7] };
  assert.deepEqual(gateAt(radial, 2000 + 10 * 250), { index: 10, dbz: 5 });
  assert.deepEqual(gateAt(radial, 2000 + 11 * 250 + 100), {
    index: 11,
    dbz: null,
  });
  assert.equal(gateAt(radial, 2000 + 9 * 250), null);
  assert.equal(gateAt(radial, 2000 + 13 * 250), null);
});

test('a beam point has its gate and a half-power extent about the centre', () => {
  const s = sweep(5.1, T0);
  const [lat, lon] = destination(SITE.lat, SITE.lon, 0, 120000);
  const beam = beamAtPoint(SITE, s, radialAt(s, 0), lat, lon);
  close(beam.groundM, 120000, 1e-3);
  assert.ok(beam.bottomM < beam.centreM && beam.centreM < beam.topM);
  // About 2 km tall at 120 km for a 0.95° beam.
  close(beam.topM - beam.bottomM, 120000 * BEAMWIDTH_DEG * (Math.PI / 180), 60);
  assert.equal(beam.gate.index, Math.round((beam.slantM - 2000) / 250));
});

test('a sweep reports where the aircraft was when the beam passed it', () => {
  const [lat, lon] = destination(SITE.lat, SITE.lon, 0, 120000);
  const s = sweep(5.1, T0);
  const beam = beamAtPoint(SITE, s, radialAt(s, 0), lat, lon);
  const insideFt = beam.centreM / 0.3048;
  const fixes = [
    fix(T0 - 10, lat, lon, insideFt),
    fix(T0 + 10, lat, lon, insideFt),
  ];
  const row = sweepAtAircraft(SITE, s, fixes);
  assert.equal(row.inside, true);
  assert.equal(row.t, T0 + 0.2, 'the radial at azimuth 0, not the sweep start');
  assert.equal(row.beam.gate.dbz, 20);
  const high = sweepAtAircraft(
    SITE,
    s,
    fixes.map((f) => ({ ...f, geom: insideFt + 10000 })),
  );
  assert.equal(high.inside, false);
  assert.ok(high.jetM > high.beam.topM);
});

test('a sweep says why it has no aircraft row', () => {
  const [lat, lon] = destination(SITE.lat, SITE.lon, 0, 120000);
  const s = sweep(5.1, T0);
  assert.deepEqual(
    sweepAtAircraft(SITE, s, [
      fix(T0 + 60, lat, lon, 35000),
      fix(T0 + 70, lat, lon, 35000),
    ]),
    {
      missing: 'position',
    },
  );
  const [eastLat, eastLon] = destination(SITE.lat, SITE.lon, 90, 120000);
  assert.deepEqual(
    sweepAtAircraft(SITE, s, [
      fix(T0 - 10, eastLat, eastLon, 35000),
      fix(T0 + 10, eastLat, eastLon, 35000),
    ]),
    { missing: 'outside' },
  );
});

test('altitude sampling keeps only points the beam spanned, with signed time', () => {
  const s = sweep(5.1, T0, (g) => (g % 2 ? null : 30));
  const [lat, lon] = destination(SITE.lat, SITE.lon, 0, 120000);
  const beam = beamAtPoint(SITE, s, radialAt(s, 0), lat, lon);
  const inside = beam.centreM / 0.3048;
  const [result] = sampledAtAltitude(
    SITE,
    [s],
    [fix(T0 - 100, lat, lon, inside), fix(T0 + 50, lat, lon, inside + 20000)],
  );
  assert.equal(result.hits.length, 1);
  close(result.hits[0].dt, 100.2, 1e-6);
  assert.deepEqual(
    sampledAtAltitude(SITE, [s], [fix(T0, lat, lon, inside + 20000)]),
    [],
  );
});

test('reflectivity bands follow the palette; no echo and range folded have their own', () => {
  assert.equal(styleFor(null), 'noecho');
  assert.equal(styleFor('RF'), 'folded');
  assert.equal(styleFor(70), 'z0');
  assert.equal(styleFor(53.5), 'z3');
  assert.equal(styleFor(12.5), 'z10');
  assert.equal(styleFor(-5), 'z11');
  assert.deepEqual([null, 'RF', 12.5].map(describeGate), [
    'no echo',
    'range folded',
    '12.5 dBZ',
  ]);
});

test('the KML curtain draws each gate once, at its beam heights and time', () => {
  const [farLat, farLon] = destination(SITE.lat, SITE.lon, 0, 120000);
  const [nearLat, nearLon] = destination(SITE.lat, SITE.lon, 0, 110000);
  const probe = sweep(5.1, T0);
  const gateOf = (lat, lon) =>
    beamAtPoint(SITE, probe, radialAt(probe, 0), lat, lon).gate.index;
  const far = gateOf(farLat, farLon);
  const near = gateOf(nearLat, nearLon);
  const s = sweep(5.1, T0, (g) => (g === far ? null : g === near ? 'RF' : 25));
  const nexrad = {
    format: 1,
    site: SITE,
    sweeps: [s, { ...s, elevationNumber: 2, dopplerCut: true }],
  };
  const points = [
    fix(T0, farLat, farLon, 35000),
    fix(T0 + 1, farLat, farLon, 35000),
    fix(T0 + 2, nearLat, nearLon, 35000),
  ];
  const { kml, cells, echo, folded } = nexradToKml(nexrad, points);
  assert.deepEqual(
    [cells, echo, folded],
    [2, 0, 1],
    'the Doppler copy is not drawn',
  );
  assert.match(kml, /<altitudeMode>absolute<\/altitudeMode>/);
  assert.match(
    kml,
    /5\.10° 17:47:00\.20Z · no echo · beam \d+\.\d–\d+\.\d km<\/name><styleUrl>#noecho/,
  );
  assert.match(
    kml,
    /5\.10° 17:47:00\.20Z · range folded · beam [^<]+<\/name><styleUrl>#folded/,
  );
  assert.match(kml, /<name>KTST 17:47:00\.20Z–17:47:00\.20Z<\/name>/);
});

test('non-NEXRAD input and an empty curtain are refused', () => {
  assert.throws(() => nexradToKml({ format: 1 }, []), /Not NEXRAD JSON/);
  assert.throws(
    () =>
      nexradToKml({ format: 1, site: SITE, sweeps: [sweep(5.1, T0)] }, [
        fix(T0, 30, -70, 1),
      ]),
    /No beam cells/,
  );
});
