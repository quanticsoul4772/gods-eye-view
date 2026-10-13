import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  aisIdleText,
  bandForStyle,
  formatRange,
  gsdFromRangeM,
  headingDeg,
  niirsFromGsd,
  offNadirDeg,
  slantRangeFromAltitudeM,
  sunElevationDeg,
} from './hudReadouts.js';

test('GSD is the ground one rendered pixel covers at the view centre', () => {
  // 60° vertical field of view, 900 px tall, 1 km away: the 1,155 m the view
  // spans there over 900 pixels.
  const fovy = Math.PI / 3;
  const gsd = gsdFromRangeM(1000, fovy, 900);
  assert.ok(Math.abs(gsd - (2000 * Math.tan(Math.PI / 6)) / 900) < 1e-12);
  assert.ok(Math.abs(gsd - 1.283) < 0.001, `gsd ${gsd}`);
  // Twice as far, or half as many pixels, is twice as coarse.
  assert.ok(Math.abs(gsdFromRangeM(2000, fovy, 900) - 2 * gsd) < 1e-12);
  assert.ok(Math.abs(gsdFromRangeM(1000, fovy, 450) - 2 * gsd) < 1e-12);
  assert.equal(gsdFromRangeM(0, fovy, 900), 0.01);
});

test('GSD is unknown without pixels or a range', () => {
  assert.equal(gsdFromRangeM(1000, Math.PI / 3, 0), null);
  assert.equal(gsdFromRangeM(Number.NaN, Math.PI / 3, 900), null);
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
