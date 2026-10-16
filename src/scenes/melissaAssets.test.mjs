// The Hurricane Melissa scene ships its own files: each one must exist, stay
// small and pass the same checks the player applies when it loads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SCENE_RECIPES } from './recipes.js';
import { photoDimensions } from './dataPacks/presentation.js';
import { decodePackGeoJSON } from '../director/packs/geojson.js';
import { PACK_LIMITS } from '../director/packs/manifest.js';
import { createDefaultProject } from './project.js';
import { parseSceneDocument } from '../director/document.js';

const recipe = SCENE_RECIPES.find(({ id }) => id === 'hurricane-melissa-2025');
const file = (pack) =>
  new URL(`../../public/scene-assets/${pack.source.path}`, import.meta.url);

test('every Melissa pack file exists, decodes and stays within budget', () => {
  assert.ok(recipe, 'the Melissa recipe ships');
  let total = 0;
  for (const pack of recipe.dataPacks) {
    assert.equal(pack.source.adapter, 'assets', pack.id);
    const bytes = new Uint8Array(fs.readFileSync(file(pack)));
    total += bytes.length;
    assert.ok(bytes.length <= PACK_LIMITS.bytes, pack.id);
    if (pack.format === 'photo') {
      assert.ok(bytes.length <= 400 * 1024, `${pack.id} stays under 400 KB`);
      const { width, height } = photoDimensions('image/jpeg', bytes);
      assert.ok(Math.max(width, height) <= 1600, pack.id);
    } else {
      assert.equal(pack.format, 'geojson');
      const features = decodePackGeoJSON(bytes);
      assert.ok(features.length <= PACK_LIMITS.features, pack.id);
    }
  }
  assert.ok(total <= 4 * 1024 * 1024, 'the scene adds at most 4 MB');
});

test('the default project with Melissa is a valid scene document', () => {
  assert.doesNotThrow(() =>
    parseSceneDocument(JSON.stringify(createDefaultProject())),
  );
  // One photo card per shot: the card panel shows about one before it scrolls.
  const photos = new Set(
    recipe.dataPacks
      .filter(({ format }) => format === 'photo')
      .map(({ id }) => id),
  );
  for (const keyframe of recipe.cameraPath)
    assert.ok(
      (keyframe.dataPackIds || []).filter((id) => photos.has(id)).length <= 1,
      keyframe.title,
    );
});
