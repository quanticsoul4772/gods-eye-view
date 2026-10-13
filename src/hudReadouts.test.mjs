import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  GSD_PER_METRE_RANGE,
  aisIdleText,
  bandForStyle,
  formatRange,
  gsdFromRangeM,
  headingDeg,
  niirsFromGsd,
  offNadirDeg,
  slantRangeFromAltitudeM,
  stableHudIds,
  sunElevationDeg,
} from './hudReadouts.js';

test('GSD scales with slant range and has a floor', () => {
  assert.equal(gsdFromRangeM(1000), 1000 * GSD_PER_METRE_RANGE);
  assert.equal(gsdFromRangeM(2000), 2 * gsdFromRangeM(1000));
  assert.equal(gsdFromRangeM(0), 0.01);
  assert.equal(gsdFromRangeM(Number.NaN), 0.01);
});

test('slant range doubles at 60° off nadir and stays finite near the horizon', () => {
  assert.ok(Math.abs(slantRangeFromAltitudeM(1000, 0) - 1000) < 1e-9);
  assert.ok(Math.abs(slantRangeFromAltitudeM(1000, 60) - 2000) < 1e-6);
  const horizon = slantRangeFromAltitudeM(1000, 90);
  assert.ok(Number.isFinite(horizon));
  assert.equal(horizon, slantRangeFromAltitudeM(1000, 85));
  assert.equal(slantRangeFromAltitudeM(-50, 0), 0);
});

test('NIIRS falls as GSD grows and stays on the 0–9 scale', () => {
  assert.ok(niirsFromGsd(0.25) > niirsFromGsd(1));
  assert.equal(niirsFromGsd(0.0001), 9);
  assert.equal(niirsFromGsd(1e6), 0);
});

test('off-nadir is 0 straight down and 90 at the horizon', () => {
  assert.equal(offNadirDeg(-Math.PI / 2), 0);
  assert.ok(Math.abs(offNadirDeg(0) - 90) < 1e-9);
  assert.ok(Math.abs(offNadirDeg(-Math.PI / 6) - 60) < 1e-9);
});

test('band follows the render style', () => {
  assert.equal(bandForStyle('thermal'), 'IR');
  assert.equal(bandForStyle('surveillance'), 'NV');
  assert.equal(bandForStyle('normal'), 'PAN');
  assert.equal(bandForStyle('crt'), 'PAN');
});

test('heading wraps to 0–359', () => {
  assert.equal(headingDeg(0), 0);
  assert.equal(headingDeg(Math.PI), 180);
  assert.equal(headingDeg(2 * Math.PI), 0);
  assert.equal(headingDeg(-Math.PI / 2), 270);
});

test('range prints metres below 1 km, one decimal below 100 km', () => {
  assert.equal(formatRange(850.4), '850m');
  assert.equal(formatRange(12_400), '12.4km');
  assert.equal(formatRange(250_000), '250km');
  assert.equal(formatRange(Number.NaN), '--');
});

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

test('HUD designators persist across reloads', () => {
  const storage = memoryStorage();
  const first = stableHudIds(storage, () => 0.5);
  assert.deepEqual(first, { missionId: 'KH11-4100', sensorId: 'OPS-4150' });
  assert.deepEqual(
    stableHudIds(storage, () => 0),
    first,
  );
});

test('malformed saved designators are replaced', () => {
  const storage = memoryStorage();
  storage.setItem('gev:hud-ids:v1', '{"missionId":"x","sensorId":"OPS-4100"}');
  assert.deepEqual(
    stableHudIds(storage, () => 0),
    {
      missionId: 'KH11-4000',
      sensorId: 'OPS-4100',
    },
  );
  storage.setItem('gev:hud-ids:v1', 'not json');
  assert.equal(stableHudIds(storage, () => 0).missionId, 'KH11-4000');
});

test('blocked or missing storage still yields designators', () => {
  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  assert.match(stableHudIds(blocked).missionId, /^KH11-\d{4}$/);
  assert.match(stableHudIds(null).sensorId, /^OPS-\d{4}$/);
});

test('AIS idle line says what is there', () => {
  assert.equal(aisIdleText({ enabled: false, count: 5 }), 'AIS: --');
  assert.equal(
    aisIdleText({ enabled: true, count: 0 }),
    'AIS: no vessels in feed',
  );
  assert.equal(
    aisIdleText({ enabled: true, count: 12 }),
    'AIS: 12 vessels · click one',
  );
});

test('sun is high at the subsolar point and below the horizon opposite it', () => {
  // June solstice, 12:00 UTC: the sun is near overhead at 23.4°N 0°E.
  const time = Cesium.JulianDate.fromIso8601('2026-06-21T12:00:00Z');
  const noon = sunElevationDeg(Cesium.Cartesian3.fromDegrees(0, 0), time);
  const midnight = sunElevationDeg(Cesium.Cartesian3.fromDegrees(180, 0), time);
  const subsolar = sunElevationDeg(
    Cesium.Cartesian3.fromDegrees(0, 23.4),
    time,
  );
  assert.ok(Math.abs(noon - 66.6) < 1.5, `noon ${noon}`);
  assert.ok(Math.abs(midnight + 66.6) < 1.5, `midnight ${midnight}`);
  assert.ok(subsolar > 87, `subsolar ${subsolar}`);
  assert.equal(sunElevationDeg(null, time), null);
});
