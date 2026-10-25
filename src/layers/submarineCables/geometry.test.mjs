import test from 'node:test';
import assert from 'node:assert/strict';
import { lineSamplePoints } from './geometry.js';

test('a line is sampled at its ends and each vertex 10° past the last kept', () => {
  // 3° steps along the equator from 0° to 39°.
  const line = Array.from({ length: 14 }, (_, i) => [i * 3, 0]);
  assert.deepEqual(lineSamplePoints(line), [
    [0, 0],
    [12, 0],
    [24, 0],
    [36, 0],
    [39, 0],
  ]);
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
