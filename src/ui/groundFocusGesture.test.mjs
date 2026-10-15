// Double-click ground focus: which double-clicks act, with fake picks and a
// fake event handler (no WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  bindGroundFocusGesture,
  isPlainGroundAt,
} from './groundFocusGesture.js';

const ground = { name: 'google-tiles' };
const at = new Cesium.Cartesian2(400, 300);

test('plain ground is the tileset with no app id, or nothing at all', () => {
  const scene = (picks) => ({ drillPick: () => picks });
  const deps = { getGroundTileset: () => ground, hitTestOverlay: () => null };
  assert.equal(isPlainGroundAt(scene([]), at, deps), true, 'keyless globe');
  assert.equal(
    isPlainGroundAt(scene([{ primitive: ground, content: {} }]), at, deps),
    true,
  );
  // An aircraft billboard on top of the tiles.
  assert.equal(
    isPlainGroundAt(
      scene([{ primitive: {}, id: 'a1b2c3' }, { primitive: ground }]),
      at,
      deps,
    ),
    false,
  );
  // A marker drawn inside the tiles still shows up in the drill.
  assert.equal(
    isPlainGroundAt(
      scene([{ primitive: ground }, { primitive: {}, id: 'launch-7' }]),
      at,
      deps,
    ),
    false,
  );
  // A vessel card painted on the overlay canvas.
  assert.equal(
    isPlainGroundAt(scene([{ primitive: ground }]), at, {
      ...deps,
      hitTestOverlay: () => ({ entryId: 'vessel' }),
    }),
    false,
  );
  // Tiles hidden (another map shown): a tileset pick is not that map's ground.
  assert.equal(
    isPlainGroundAt(scene([{ primitive: ground }]), at, {
      ...deps,
      getGroundTileset: () => null,
    }),
    false,
  );
});

function rig() {
  const canvas = new EventTarget();
  const state = {
    free: true,
    generation: 1,
    selection: null,
    ground: true,
    time: 0,
    focused: [],
  };
  let action = null;
  let destroyed = false;
  const viewer = { scene: { canvas, tweens: [] }, trackedEntity: undefined };
  const gesture = bindGroundFocusGesture({
    viewer,
    focusAt: (position) => state.focused.push(position),
    isGroundAt: () => state.ground,
    isPointerFree: () => state.free,
    readNavigationGeneration: () => state.generation,
    readSelection: () => state.selection,
    now: () => state.time,
    createHandler: () => ({
      setInputAction(fn, type) {
        assert.equal(type, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        action = fn;
      },
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true;
      },
    }),
  });
  /** Two presses; `between` runs after the first, as its click would. */
  const doubleClick = (between = () => {}) => {
    canvas.dispatchEvent(new Event('pointerdown'));
    between();
    state.time += 150;
    canvas.dispatchEvent(new Event('pointerdown'));
    state.time += 150;
    action({ position: at });
  };
  return { state, viewer, gesture, doubleClick, isDestroyed: () => destroyed };
}

test('a double-click on plain ground focuses there', () => {
  const { state, doubleClick } = rig();
  doubleClick();
  assert.deepEqual(state.focused, [at]);
});

test('not on a marker, the sky or anything that is not plain ground', () => {
  const { state, doubleClick } = rig();
  state.ground = false;
  doubleClick();
  assert.deepEqual(state.focused, []);
});

test('a first click that selects or flies to something wins', () => {
  const { state, doubleClick } = rig();
  // Selecting a vessel or fire starts a navigation.
  doubleClick(() => state.generation++);
  // Selecting a marker or radio station changes the selection.
  doubleClick(() => (state.selection = 'alpr-9@1700000000000'));
  // Selecting the same marker again is still a new selection.
  doubleClick(() => (state.selection = 'alpr-9@1700000000500'));
  assert.deepEqual(state.focused, []);
});

test('a first click on the ground that stops following still focuses', () => {
  const { state, doubleClick } = rig();
  state.selection = 'flight-abc@1';
  doubleClick(() => (state.selection = null));
  assert.deepEqual(state.focused, [at]);
});

test('a tool holding the pointer at either press keeps the double-click', () => {
  const { state, doubleClick } = rig();
  // Directions releases its claim after placing the first click's endpoint.
  state.free = false;
  doubleClick(() => (state.free = true));
  assert.deepEqual(state.focused, []);
});

test('no focus while following, mid-flight, or from stale presses', () => {
  const { state, viewer, doubleClick } = rig();
  viewer.trackedEntity = {};
  doubleClick();
  viewer.trackedEntity = undefined;
  viewer.scene.tweens = [{}];
  doubleClick();
  viewer.scene.tweens = [];
  doubleClick(() => (state.time += 2000));
  assert.deepEqual(state.focused, []);
});

test('destroy removes the handler and the press listener', () => {
  const { state, gesture, doubleClick, isDestroyed } = rig();
  gesture.destroy();
  assert.equal(isDestroyed(), true);
  // Presses after destroy are not recorded, so a late event cannot focus.
  doubleClick();
  assert.deepEqual(state.focused, []);
});
