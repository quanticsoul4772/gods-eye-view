import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aircraftAt,
  bucketColor,
  distanceToSquareKm,
  eventSquares,
  glmToKml,
  groupDistances,
  lightningEllipsoidHeight,
  litPixels,
  nearestPerFlash,
  pixelSideKm,
  squareCorners,
  squareHeightM,
  toCloudTop,
} from '../../scripts/glm-to-kml.mjs';

const T0 = 1793555220; // 2026-11-01T17:47:00Z

const glm = (events, groups) => ({
  format: 1,
  platform: 'G19',
  granules: [],
  window: {},
  events,
  groups,
  flashes: {},
});

const fix = (t, lat, lon, geom, extra = {}) => ({
  t,
  lat,
  lon,
  baro: null,
  geom,
  rate: 0,
  geomRate: 0,
  stale: false,
  newLeg: false,
  nic: 9,
  ...extra,
});

test('the lightning ellipsoid is 14 km at the equator and 6 km at the poles', () => {
  assert.equal(Math.round(lightningEllipsoidHeight(0)), 14000);
  assert.equal(Math.round(lightningEllipsoidHeight(90)), 6000);
  assert.equal(Math.round(lightningEllipsoidHeight(-90)), 6000);
  // About 12.4 km over Palm Beach.
  assert.equal(Math.round(lightningEllipsoidHeight(26.7) / 100), 124);
});

test('a pixel side comes from its group area over its event count', () => {
  assert.equal(pixelSideKm({ areaM2: 4 * 64e6, events: 4 }), 8);
  assert.equal(pixelSideKm({ areaM2: null, events: 4 }), null);
  assert.equal(pixelSideKm({ areaM2: 64e6, events: 0 }), null);
  assert.equal(pixelSideKm(undefined), null);
});

test('a square is closed, north-up and the given size on the ground', () => {
  const corners = squareCorners(26.7, -80.2, 8);
  assert.equal(corners.length, 5);
  assert.deepEqual(corners[0], corners[4]);
  const [[w, s], [e], [, n]] = corners;
  assert.ok(Math.abs((n - s) * 110.574 - 8) < 1e-9);
  assert.ok(
    Math.abs((e - w) * 111.32 * Math.cos((26.7 * Math.PI) / 180) - 8) < 1e-9,
  );
});

test('distance to a square is 0 inside and to the nearest edge outside', () => {
  const square = { lat: 26.7, lon: -80.2, sideKm: 8 };
  assert.equal(distanceToSquareKm(26.7, -80.2, square), 0);
  assert.equal(distanceToSquareKm(26.7 + 3.9 / 110.574, -80.2, square), 0);
  const north = distanceToSquareKm(26.7 + 6 / 110.574, -80.2, square);
  assert.ok(Math.abs(north - 2) < 1e-9);
  const kmLon = 111.32 * Math.cos((26.7 * Math.PI) / 180);
  const corner = distanceToSquareKm(
    26.7 + 7 / 110.574,
    -80.2 + 8 / kmLon,
    square,
  );
  assert.ok(Math.abs(corner - 5) < 1e-9);
});

test('the aircraft is interpolated between fixes and unknown across gaps', () => {
  const fixes = [
    fix(T0, 26.7, -80.2, 36000),
    fix(T0 + 10, 26.8, -80.0, 37000),
    fix(T0 + 50, 26.9, -79.9, 37000),
    fix(T0 + 51, 26.9, -79.9, 37000, { stale: true }),
  ];
  const mid = aircraftAt(fixes, T0 + 5);
  assert.ok(Math.abs(mid.lat - 26.75) < 1e-9);
  assert.ok(Math.abs(mid.lon + 80.1) < 1e-9);
  assert.equal(mid.geomFt, 36500);
  assert.equal(mid.stepSec, 10);
  assert.equal(aircraftAt(fixes, T0 - 1), null);
  assert.equal(aircraftAt(fixes, T0 + 30), null, 'a 40 s step is not bridged');
  assert.equal(aircraftAt(fixes, T0 + 50.5), null, 'nor a stale fix');
  assert.equal(aircraftAt([fix(T0, 26.7, -80.2, null)], T0), null);
});

test('events without a group area are left out and counted', () => {
  const { squares, dropped } = eventSquares(
    glm(
      [
        [T0, 26.7, -80.2, 1e-15, '0:1'],
        [T0, 26.8, -80.2, 1e-15, '0:2'],
      ],
      {
        '0:1': { areaM2: 64e6, events: 1, flash: '0:9' },
        '0:2': { areaM2: null, events: 1, flash: '0:9' },
      },
    ),
  );
  assert.equal(squares.length, 1);
  assert.equal(squares[0].sideKm, 8);
  assert.equal(squares[0].flashId, '0:9');
  assert.equal(dropped, 1);
});

test('each flash reports its group nearest the aircraft at that time', () => {
  const fixes = [fix(T0, 26.7, -80.2, 36000), fix(T0 + 10, 26.7, -80.1, 36000)];
  const { squares } = eventSquares(
    glm(
      [
        [T0 + 1, 26.7, -80.19, null, '0:1'],
        [T0 + 2, 26.9, -80.18, null, '0:2'],
        [T0 + 3, 27.5, -80.17, null, '0:3'],
        [T0 + 20, 26.7, -80.0, null, '0:4'],
      ],
      {
        '0:1': { areaM2: 64e6, events: 1, flash: '0:7' },
        '0:2': { areaM2: 64e6, events: 1, flash: '0:7' },
        '0:3': { areaM2: 64e6, events: 1, flash: '0:8' },
        '0:4': { areaM2: 64e6, events: 1, flash: '0:9' },
      },
    ),
  );
  const rows = groupDistances(squares, fixes);
  assert.deepEqual(
    rows.map((row) => row.groupId),
    ['0:1', '0:2', '0:3'],
    'a group lit after the last fix has no aircraft position',
  );
  assert.equal(rows[0].km, 0);
  assert.deepEqual(
    nearestPerFlash(rows).map((row) => [row.flashId, row.groupId]),
    [
      ['0:7', '0:1'],
      ['0:8', '0:3'],
    ],
  );
});

test('the KML draws each lit pixel once, at the lightning ellipsoid height', () => {
  const { kml, pixels, events, dropped, start, end } = glmToKml(
    glm(
      [
        [T0, 0, -80.2, 2e-15, '0:1'],
        [T0 + 30, 0, -80.2, null, '0:2'],
        [T0 + 60, 0, -80.1, null, '0:2'],
      ],
      {
        '0:1': { areaM2: 64e6, events: 1, flash: '0:8' },
        '0:2': { areaM2: 2 * 64e6, events: 2, flash: '0:9' },
      },
    ),
  );
  assert.equal(pixels, 2);
  assert.equal(events, 3);
  assert.equal(dropped, 0);
  assert.equal([start, end].join(), [T0, T0 + 60].join());
  assert.match(kml, /<altitudeMode>absolute<\/altitudeMode>/);
  assert.match(kml, /,14000 /);
  assert.match(
    kml,
    /17:47:00.00Z–17:47:30.00Z GLM pixel · 2 events · 2 flashes<\/name><styleUrl>#t0</,
  );
  assert.match(
    kml,
    /17:48:00.00Z GLM pixel · 1 event · 1 flash<\/name><styleUrl>#t11</,
  );
  assert.equal(kml.match(/<Placemark>/g).length, 2);
  assert.match(kml, /<name>GLM G19 17:47:00.00Z–17:48:00.00Z<\/name>/);
});

test('a time window keeps only the events inside it', () => {
  const data = glm(
    [
      [T0, 26.7, -80.2, null, '0:1'],
      [T0 + 30, 26.7, -80.1, null, '0:1'],
      [T0 + 60, 26.7, -80.0, null, '0:1'],
    ],
    { '0:1': { areaM2: 3 * 64e6, events: 3, flash: '0:9' } },
  );
  const { pixels, start, end } = glmToKml(data, {
    from: T0 + 10,
    to: T0 + 60,
  });
  assert.equal(pixels, 2);
  assert.equal([start, end].join(), [T0 + 30, T0 + 60].join());
  assert.throws(
    () => glmToKml(data, { from: T0 + 100, to: T0 + 200 }),
    /No GLM events/,
  );
});

test('lit pixels merge repeats of one position and keep their span', () => {
  const squares = [
    { t: T0 + 5, lat: 26.7, lon: -80.2, sideKm: 8, flashId: '0:1' },
    { t: T0, lat: 26.7, lon: -80.2, sideKm: 8, flashId: '0:2' },
    { t: T0 + 2, lat: 26.78, lon: -80.2, sideKm: 8, flashId: '0:1' },
  ];
  const [first, second] = litPixels(squares);
  assert.deepEqual(
    [first.first, first.last, first.events, first.flashes.size],
    [T0, T0 + 5, 2, 2],
  );
  assert.deepEqual([second.first, second.events], [T0 + 2, 1]);
});

test('time colours run from cyan to magenta and stay translucent', () => {
  assert.equal(bucketColor(0), '99ffc800');
  assert.equal(bucketColor(11), '99ff00ff');
});

test('non-GLM input and empty windows are refused', () => {
  assert.throws(() => glmToKml({ events: [] }), /Not GLM JSON/);
  assert.throws(() => glmToKml(glm([], {})), /No GLM events/);
});

test('a stale fix or new leg without a height still breaks the aircraft position', () => {
  const fixes = [
    fix(T0, 26, -80, 35000),
    fix(T0 + 5, 27, -81, null, { stale: true, newLeg: true }),
    fix(T0 + 10, 26.1, -80.1, 35000),
  ];
  assert.equal(aircraftAt(fixes, T0 + 5), null);
  assert.equal(aircraftAt(fixes, T0 + 7), null);
});

test('an aircraft exactly at a fix time is that fix, even after a gap', () => {
  const fixes = [fix(T0, 26, -80, 35000), fix(T0 + 100, 26.5, -80.5, 34000)];
  assert.deepEqual(aircraftAt(fixes, T0 + 100), {
    lat: 26.5,
    lon: -80.5,
    geomFt: 34000,
    stepSec: 0,
  });
});

test('one pixel reported a packing step apart is still one pixel', () => {
  const step = 0.00203128;
  const squares = [
    { t: T0, lat: 26.7, lon: -80.2, sideKm: 8.2, flashId: '0:1' },
    {
      t: T0 + 1,
      lat: 26.7 + step,
      lon: -80.2 - step,
      sideKm: 8.2,
      flashId: '0:2',
    },
    { t: T0 + 2, lat: 26.7 + 0.0737, lon: -80.2, sideKm: 8.2, flashId: '0:2' },
  ];
  const pixels = litPixels(squares);
  assert.equal(pixels.length, 2);
  assert.deepEqual(
    [pixels[0].events, pixels[0].flashes.size, pixels[1].events],
    [2, 2, 1],
  );
});

// A 3x3 block of 10 km cloud-top pixels around (26.7, -80.2), all at one height.
const cloudTops = async (heightM) => {
  const { scanAngles } =
    await import('../../scripts/goes-cloud-top-to-kml.mjs');
  const projection = {
    heightM: 35786023,
    a: 6378137,
    b: 6356752.31414,
    lon0: -75,
  };
  const [x0, y0] = scanAngles(projection, 26.7, -80.2, heightM ?? 0);
  const d = 0.00028;
  const pixels = [];
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      pixels.push([x0 + j * d, y0 - i * d, heightM, heightM === null ? 3 : 0]);
  return {
    format: 1,
    platform: 'G19',
    scene: 'CONUS',
    start: T0,
    end: T0 + 150,
    projection,
    dx: d,
    dy: d,
    pixels,
  };
};

test('squares are re-placed at the measured cloud top along their lines of sight', async () => {
  const square = {
    t: T0,
    lat: 26.7,
    lon: -80.2,
    sideKm: 8,
    flashId: '0:1',
    groupId: '0:1',
    energyJ: null,
  };
  const { squares, moved, kept } = toCloudTop([square], await cloudTops(14500));
  assert.deepEqual([moved, kept], [1, 0]);
  const [placed] = squares;
  assert.equal(placed.heightM, 14500);
  // 2.1 km above the ellipsoid, seen about 32° off vertical: about 1.3 km
  // towards the satellite, south-south-east.
  assert.ok(placed.shiftKm > 1 && placed.shiftKm < 1.7, `${placed.shiftKm}`);
  assert.ok(
    placed.shiftBearing > 150 && placed.shiftBearing < 190,
    `${placed.shiftBearing}`,
  );
  assert.ok(placed.lat < 26.7 && placed.lon > -80.2);
  assert.equal(squareHeightM(placed), 14500);
});

test('squares with no measured top over them stay on the lightning ellipsoid', async () => {
  const square = {
    t: T0,
    lat: 26.7,
    lon: -80.2,
    sideKm: 8,
    flashId: '0:1',
    groupId: '0:1',
    energyJ: null,
  };
  const { squares, moved, kept } = toCloudTop([square], await cloudTops(null));
  assert.deepEqual([moved, kept], [0, 1]);
  assert.equal(squares[0], square);
  assert.equal(
    Math.round(squareHeightM(square)),
    Math.round(lightningEllipsoidHeight(26.7)),
  );
});

test('the KML draws corrected pixels at their cloud-top height', async () => {
  const { kml, moved } = glmToKml(
    glm([[T0, 26.7, -80.2, null, '0:1']], {
      '0:1': { areaM2: 64e6, events: 1, flash: '0:9' },
    }),
    { cloudTop: await cloudTops(14500) },
  );
  assert.equal(moved, 1);
  assert.match(kml, /,14500 /);
  assert.doesNotMatch(kml, /,12385 /);
});
