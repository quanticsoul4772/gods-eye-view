// Tile detail modes: Fast centre sets Cesium's skip-LOD and foveation
// values; Standard puts back whatever the tileset had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTileDetailMode,
  normalizeTileDetailMode,
} from './tilesetTuning.js';

const cesiumDefaults = () => ({
  skipLevelOfDetail: false,
  foveatedConeSize: 0.1,
  foveatedTimeDelay: 0.2,
  isDestroyed: () => false,
});

test('Fast centre turns on skip-LOD with a narrow, patient cone', () => {
  const tileset = cesiumDefaults();
  let renders = 0;
  assert.equal(
    applyTileDetailMode(tileset, 'fast-centre', () => renders++),
    true,
  );
  assert.equal(tileset.skipLevelOfDetail, true);
  assert.equal(tileset.foveatedConeSize, 0.08);
  assert.equal(tileset.foveatedTimeDelay, 0.5);
  assert.equal(renders, 1);
});

test('Standard restores the values the tileset started with', () => {
  const tileset = { ...cesiumDefaults(), foveatedConeSize: 0.3 };
  applyTileDetailMode(tileset, 'fast-centre');
  applyTileDetailMode(tileset, 'fast-centre');
  applyTileDetailMode(tileset, 'standard');
  assert.equal(tileset.skipLevelOfDetail, false);
  assert.equal(tileset.foveatedConeSize, 0.3);
  assert.equal(tileset.foveatedTimeDelay, 0.2);
});

test('no tileset (keyless globe) or a destroyed one is left alone', () => {
  assert.equal(applyTileDetailMode(null, 'fast-centre'), false);
  const destroyed = { ...cesiumDefaults(), isDestroyed: () => true };
  assert.equal(applyTileDetailMode(destroyed, 'fast-centre'), false);
  assert.equal(destroyed.skipLevelOfDetail, false);
});

test('unknown modes mean Standard', () => {
  assert.equal(normalizeTileDetailMode('fast-centre'), 'fast-centre');
  assert.equal(normalizeTileDetailMode('turbo'), 'standard');
  assert.equal(normalizeTileDetailMode(undefined), 'standard');
});
