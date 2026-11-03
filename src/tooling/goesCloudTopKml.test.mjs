import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bandColor,
  cloudTopOver,
  cloudTopThrough,
  cloudTopToKml,
  insideQuad,
  navigate,
  offsetKm,
  pixelAt,
  pixelCorners,
  scanAngles,
  sightRuns,
  styleFor,
} from '../../scripts/goes-cloud-top-to-kml.mjs';

const PROJ = {
  heightM: 35786023,
  a: 6378137,
  b: 6356752.31414,
  lon0: -75,
};

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? ''} ${actual} not within ${tolerance} of ${expected}`,
  );

const KM_LAT = 110.574;

// A 3x3 block of 10 km pixels centred on the ground point (26.7, -80.2).
const grid = (heights = () => 14000, dqf = () => 0) => {
  const [x0, y0] = scanAngles(PROJ, 26.7, -80.2, 0);
  const d = 0.00028;
  const pixels = [];
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      pixels.push([x0 + j * d, y0 - i * d, heights(i, j), dqf(i, j)]);
  return {
    format: 1,
    platform: 'G19',
    scene: 'CONUS',
    start: 1793555177.6,
    end: 1793555334.9,
    projection: PROJ,
    dx: d,
    dy: d,
    pixels,
  };
};

test('navigation inverts scan angles at the ground and at height', () => {
  for (const [lat, lon] of [
    [26.7, -80.2],
    [45, -100],
    [-10, -60],
  ])
    for (const h of [0, 14000]) {
      const [x, y] = scanAngles(PROJ, lat, lon, h);
      const [nlat, nlon] = navigate(PROJ, x, y, h);
      close((nlat - lat) * KM_LAT * 1000, 0, 1, `lat ${lat} h ${h}`);
      close(
        (nlon - lon) * 111320 * Math.cos((lat * Math.PI) / 180),
        0,
        1,
        `lon ${lon} h ${h}`,
      );
    }
});

test('navigation reproduces the GOES-R PUG worked example', () => {
  const [lat, lon] = navigate(PROJ, -0.024052, 0.09534, 0);
  close(lat, 33.846162, 1e-6);
  close(lon, -84.690932, 1e-6);
  const [x, y] = scanAngles(PROJ, 33.846162, -84.690932, 0);
  close(x, -0.024052, 1e-8);
  close(y, 0.09534, 1e-8);
});

test('a line of sight past the earth misses', () => {
  assert.equal(navigate(PROJ, 0.2, 0, 0), null);
});

test('a cloud top over a point appears farther from the satellite on the ground grid', () => {
  // Seen from 75°W over the equator, a top above Florida lands north and west.
  const [x, y] = scanAngles(PROJ, 26.7, -80.2, 14000);
  const [lat, lon] = navigate(PROJ, x, y, 0);
  assert.ok(lat > 26.7 && lon < -80.2, `${lat}, ${lon}`);
  const km = Math.hypot(
    (lat - 26.7) * KM_LAT,
    (lon + 80.2) * 111.32 * Math.cos((26.7 * Math.PI) / 180),
  );
  assert.ok(km > 7 && km < 11, `${km} km`);
});

test('a pixel is found by its footprint and refused outside the block', () => {
  const data = grid((i, j) => 14000 + 100 * (3 * i + j));
  const [x, y] = data.pixels[4];
  assert.equal(pixelAt(data, x, y), data.pixels[4]);
  assert.equal(pixelAt(data, x + 0.00013, y - 0.00013), data.pixels[4]);
  assert.equal(pixelAt(data, x + 0.00015, y), data.pixels[5]);
  assert.equal(pixelAt(data, x + 0.001, y), null);
});

test('the cloud top through a point is the pixel its 3D position appears in', () => {
  const data = grid((i, j) => 14000 + 100 * (3 * i + j));
  // The point at the grid centre's ground position, seen at 0 m, is the centre.
  assert.equal(cloudTopThrough(data, 26.7, -80.2, 0).heightM, 14000);
  // At 15 km it appears about 9 km away on the ground grid, mostly north (the
  // westward part is under half a pixel here): the pixel north of the centre,
  // not east of it.
  const high = cloudTopThrough(data, 26.7, -80.2, 15000);
  const [cx, cy] = data.pixels[4];
  assert.ok(
    high.pixel[1] > cy && high.pixel[0] <= cx,
    JSON.stringify(high.pixel),
  );
  assert.equal(cloudTopThrough(data, 30, -80.2, 0), null);
});

test('pixel corners are placed at the pixel height, south-east of the ground grid', () => {
  const data = grid();
  const ground = pixelCorners(data, [...data.pixels[4].slice(0, 2), 0]);
  const high = pixelCorners(data, data.pixels[4]);
  const mean = (cs, k) => cs.reduce((s, c) => s + c[k], 0) / cs.length;
  close(mean(ground, 0), 26.7, 0.001);
  close(mean(ground, 1), -80.2, 0.001);
  assert.ok(mean(high, 0) < mean(ground, 0));
  assert.ok(mean(high, 1) > mean(ground, 1));
});

test('height bands and quality pick the style', () => {
  assert.equal(styleFor(14692, 0), 'h8');
  assert.equal(styleFor(3000, 0), 'h0');
  assert.equal(styleFor(19000, 0), 'h11');
  assert.equal(styleFor(14692, 1), 'poor');
  assert.equal(styleFor(14692, null), 'poor');
  assert.equal(bandColor(0), 'ccff7828');
  assert.equal(bandColor(11), 'ccffffff');
});

test('the KML draws pixels with heights at their height and names their quality', () => {
  const data = grid(
    (i, j) => (i === 1 && j === 1 ? null : 14692),
    (i, j) => (i === -1 && j === -1 ? 4 : i === 1 && j === 1 ? 3 : 0),
  );
  const { kml, drawn, noHeight } = cloudTopToKml(data);
  assert.equal(drawn, 8);
  assert.equal(noHeight, 1);
  assert.match(kml, /<altitudeMode>absolute<\/altitudeMode>/);
  assert.match(kml, /,14692 /);
  assert.match(
    kml,
    /cloud top 14,692 m · good · scan 17:46:17Z–17:48:54Z<\/name><styleUrl>#h8</,
  );
  assert.match(
    kml,
    /cloud top 14,692 m · opaque retrieval · [^<]+<\/name><styleUrl>#poor</,
  );
  assert.match(kml, /<name>G19 CONUS cloud top 17:46:17Z–17:48:54Z<\/name>/);
});

test('a point inside a placed quad is found, one outside is not', () => {
  const quad = [
    [26, -81],
    [26, -80],
    [27, -80],
    [27, -81],
  ];
  assert.equal(insideQuad(quad, 26.5, -80.5), true);
  assert.equal(insideQuad([...quad].reverse(), 26.5, -80.5), true);
  assert.equal(insideQuad(quad, 27.5, -80.5), false);
});

test('the top overhead is the placed pixel over the point, not its ground cell', () => {
  const data = grid((i, j) => 14000 + 100 * (3 * i + j));
  const centre = pixelCorners(data, data.pixels[4]);
  const lat = centre.reduce((sum, c) => sum + c[0], 0) / 4;
  const lon = centre.reduce((sum, c) => sum + c[1], 0) / 4;
  assert.equal(cloudTopOver(data, lat, lon).pixel, data.pixels[4]);
  assert.equal(cloudTopOver(data, 40, -80), null);
  assert.equal(
    cloudTopOver(
      grid(() => null),
      lat,
      lon,
    ),
    null,
  );
});

test('offsets are great-circle km with a bearing', () => {
  const { km, bearing } = offsetKm(26.7, -80.2, 26.7 + 1 / 111.2, -80.2);
  close(km, 1, 0.01);
  close(bearing, 0, 1e-6);
});

test('sight runs group points looking through one pixel and break at gaps', () => {
  const data = grid((i, j) => 14000 + 100 * (3 * i + j));
  const point = (t, lat, lon, ft) => ({ t, lat, lon, geom: ft });
  const runs = sightRuns(data, [
    point(1, 26.7, -80.2, 0),
    point(2, 26.7, -80.2, 0),
    point(40, 26.7, -80.2, 0),
    point(41, 26.7, -80.2, 36000),
    point(42, 32, -80.2, 0),
  ]);
  assert.equal(runs.length, 4);
  assert.deepEqual([runs[0].first, runs[0].last], [1, 2]);
  assert.equal(runs[0].pixel, data.pixels[4]);
  assert.equal(runs[0].offsets.length, 2);
  assert.equal(runs[1].first, 40, 'a 38 s step starts a new run');
  close(runs[2].highM, 36000 * 0.3048, 1e-9);
  assert.equal(runs[3].pixel, null);
  assert.deepEqual(runs[3].over, []);
});

test('non-cloud-top input and an empty surface are refused', () => {
  assert.throws(() => cloudTopToKml({ format: 1 }), /Not cloud-top JSON/);
  assert.throws(() => cloudTopToKml(grid(() => null)), /No cloud-top heights/);
});
