import test from 'node:test';
import assert from 'node:assert/strict';
import { lineSamplePoints } from './geometry.js';

const rounded = (points) =>
  points.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]);

test('a line is sampled at its ends and no more than 10° apart along it', () => {
  // 3° steps along the equator from 0° to 39°: the vertex before the
  // distance since the last sample would pass 10° is kept.
  const line = Array.from({ length: 14 }, (_, i) => [i * 3, 0]);
  assert.deepEqual(lineSamplePoints(line), [
    [0, 0],
    [9, 0],
    [18, 0],
    [27, 0],
    [36, 0],
    [39, 0],
  ]);
});

test('a long segment gets points along it, not only at its ends', () => {
  assert.deepEqual(
    rounded(
      lineSamplePoints([
        [0, 0],
        [50, 0],
      ]),
    ),
    [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
      [50, 0],
    ],
  );
});

test('short lines keep their vertices, and bad input samples nothing', () => {
  assert.deepEqual(
    lineSamplePoints([
      [1, 2],
      [3, 4],
    ]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.deepEqual(lineSamplePoints(undefined), []);
});
