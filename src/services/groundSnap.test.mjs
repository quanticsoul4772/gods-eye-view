import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';

const groundFloor = {
  cachedMeshFloor: () => null,
  meshFloorPreferred: () => false,
  reportValidatedMeshFloorCell: () => {},
};

/** A viewer whose ground is the terrain globe, optionally under a 3D tileset. */
function makeViewer({ tileset = null } = {}) {
  const calls = { picks: 0, globe: 0 };
  const primitives = tileset ? [tileset] : [];
  return {
    calls,
    scene: {
      primitives: { length: primitives.length, get: (i) => primitives[i] },
      sampleHeight() {
        calls.picks += 1;
        return 1650;
      },
      globe: {
        getHeight() {
          calls.globe += 1;
          return 1600;
        },
      },
    },
  };
}

const atDenverAirport = Cesium.Cartesian3.fromDegrees(-104.6737, 39.8561, 0);

test('on the terrain globe alone, ground height comes from memory, not a pick render', () => {
  const viewer = makeViewer();
  const snap = createGroundSnap({ groundFloor });
  assert.equal(snap.heightFor(viewer, 'a1b2c3', atDenverAirport), 1600);
  assert.deepEqual(viewer.calls, { picks: 0, globe: 1 });
});

test('a 3D tileset is measured with a pick, since its skin sits off the terrain', () => {
  const viewer = makeViewer({ tileset: { show: true, tilesLoaded: true } });
  const snap = createGroundSnap({ groundFloor });
  assert.equal(snap.heightFor(viewer, 'a1b2c3', atDenverAirport), 1650);
  assert.deepEqual(viewer.calls, { picks: 1, globe: 0 });
});

test('an airport cluster gets four pick renders per 250 ms window, and a clock that stepped back opens a new one', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const viewer = makeViewer({ tileset: { show: true, tilesLoaded: true } });
  const snap = createGroundSnap({ groundFloor });
  const icaos = ['a00001', 'a00002', 'a00003', 'a00004', 'a00005', 'a00006'];
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(viewer.calls.picks, 4);
  t.mock.timers.setTime(1_000_000 - 60_000);
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(viewer.calls.picks, 6, 'the two denied aircraft sample in the new window');
});

test('a hidden tileset does not count as the ground', () => {
  const viewer = makeViewer({ tileset: { show: false, tilesLoaded: true } });
  const snap = createGroundSnap({ groundFloor });
  assert.equal(snap.heightFor(viewer, 'a1b2c3', atDenverAirport), 1600);
  assert.equal(viewer.calls.picks, 0);
});

test('terrain not loaded yet is a miss that backs off, and the answer is cached once it lands', () => {
  const viewer = makeViewer();
  let height;
  viewer.scene.globe.getHeight = () => {
    viewer.calls.globe += 1;
    return height;
  };
  const snap = createGroundSnap({ groundFloor });
  assert.equal(snap.heightFor(viewer, 'a1b2c3', atDenverAirport), null, 'no ground evidence yet');
  assert.equal(snap.heightFor(viewer, 'a1b2c3', atDenverAirport), null);
  assert.equal(viewer.calls.globe, 1, 'the retry waits out its backoff');
  height = 1600;
  const other = createGroundSnap({ groundFloor });
  assert.equal(other.heightFor(viewer, 'a1b2c3', atDenverAirport), 1600);
  assert.equal(other.heightFor(viewer, 'a1b2c3', atDenverAirport), 1600);
  assert.equal(viewer.calls.globe, 2, 'a cached snap answers without sampling again');
});
