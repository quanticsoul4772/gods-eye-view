// Empty-tile refinement fix: Cesium's real base traversal on a fake tile tree
// shaped like the Google tileset's stuck centre (no network, no WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  emptyTileRefinementEnabled,
  installEmptyTileRefinementFix,
} from './tileRefinement.js';

const TARGET_SSE = 16;

function fakeTileset() {
  const priority = () => ({
    distance: 0,
    depth: 0,
    foveatedFactor: 0,
    reverseScreenSpaceError: 0,
  });
  return {
    root: null,
    memoryAdjustedScreenSpaceError: TARGET_SSE,
    debugFreezeFrame: false,
    loadSiblings: false,
    foveatedTimeDelay: 0.2,
    _requestedTiles: [],
    _selectedTiles: [],
    _selectedTilesToStyle: [],
    _emptyTiles: [],
    _minimumPriority: priority(),
    _maximumPriority: priority(),
    _statistics: { visited: 0, numberOfTilesCulledWithChildrenUnion: 0 },
    _cache: { touch() {} },
    _cullRequestsWhileMoving: false,
  };
}

function fakeTile(tileset, name, sse, kind, parent, loaded = true) {
  const tile = {
    name,
    tileset,
    parent,
    children: [],
    refine: Cesium.Cesium3DTileRefine.REPLACE,
    hasEmptyContent: kind === 'empty',
    hasTilesetContent: kind === 'external',
    hasImplicitContent: false,
    hasRenderableContent: kind === 'content',
    contentExpired: false,
    priorityDeferred: false,
    _visible: true,
    _inRequestVolume: true,
    _screenSpaceError: sse,
    _foveatedFactor: 0,
    _distanceToCamera: 1,
    _depth: 0,
    _priorityReverseScreenSpaceError: 0,
    _selectedFrame: 0,
    content: { featurePropertiesDirty: false },
    get isVisible() {
      return this._visible && this._inRequestVolume;
    },
    get contentAvailable() {
      return kind === 'content' && loaded;
    },
    get hasUnloadedRenderableContent() {
      return kind === 'content' && !loaded;
    },
    updateVisibility() {},
    updateExpiration() {},
    updatePriority() {},
    getScreenSpaceError() {
      return sse;
    },
    contentVisibility() {
      return Cesium.Intersect.INSIDE;
    },
  };
  parent?.children.push(tile);
  return tile;
}

/**
 * Renderable parent (error 164) → external-tileset tile → the sub-tileset's
 * content-less root, already under the target (error 14) → content children.
 */
function stuckCentre({ secondChildLoaded = true } = {}) {
  const tileset = fakeTileset();
  const parent = fakeTile(tileset, 'parent', 164, 'content', undefined);
  const external = fakeTile(tileset, 'external', 164, 'external', parent);
  const emptyRoot = fakeTile(tileset, 'emptyRoot', 14, 'empty', external);
  fakeTile(tileset, 'child-a', 10, 'content', emptyRoot);
  fakeTile(tileset, 'child-b', 10, 'content', emptyRoot, secondChildLoaded);
  tileset.root = parent;
  return tileset;
}

let frameNumber = 10;
function selected(tileset) {
  frameNumber += 1;
  Cesium.Cesium3DTilesetBaseTraversal.selectTiles(tileset, {
    frameNumber,
    camera: { timeSinceMoved: 99 },
  });
  return tileset._selectedTiles.map((tile) => tile.name).sort();
}

test("Cesium's own rule keeps the parent of a low-error empty tile coarse", () => {
  installEmptyTileRefinementFix(Cesium, stuckCentre()); // a different tileset
  assert.deepEqual(selected(stuckCentre()), ['parent']);
});

test('a registered tileset refines through the empty tile to its content', () => {
  const tileset = stuckCentre();
  assert.equal(installEmptyTileRefinementFix(Cesium, tileset), true);
  assert.deepEqual(selected(tileset), ['child-a', 'child-b']);
});

test('the parent stays drawn until every child below the empty tile has loaded', () => {
  const tileset = stuckCentre({ secondChildLoaded: false });
  installEmptyTileRefinementFix(Cesium, tileset);
  assert.deepEqual(selected(tileset), ['parent']);
  assert.ok(tileset._requestedTiles.some((tile) => tile.name === 'child-b'));
});

test('installing again wraps once; disabled or missing pieces do nothing', () => {
  const traversal = Cesium.Cesium3DTilesetTraversal;
  installEmptyTileRefinementFix(Cesium, stuckCentre());
  const wrapped = traversal.canTraverse;
  installEmptyTileRefinementFix(Cesium, stuckCentre());
  assert.equal(traversal.canTraverse, wrapped);
  assert.equal(
    installEmptyTileRefinementFix(Cesium, stuckCentre(), { enabled: false }),
    false,
  );
  assert.equal(installEmptyTileRefinementFix(Cesium, null), false);
  assert.equal(installEmptyTileRefinementFix({}, stuckCentre()), false);
});

test('?refineFix=0 turns the fix off', () => {
  assert.equal(emptyTileRefinementEnabled('?refineFix=0'), false);
  assert.equal(emptyTileRefinementEnabled(''), true);
  assert.equal(emptyTileRefinementEnabled(undefined), true);
});
