import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createState } from './state.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { createRendering } from './rendering.js';
import { createVehicles } from './vehicles.js';
import { createSelection } from './selection.js';
import { createQueries } from './queries.js';
import { createControls } from './controls.js';
import { MAX_TOTAL_VEHICLES } from './policy.js';
import {
  decodeLayerStateParams,
  encodeLayerStateParams,
  createDefaultLayerState,
} from '../../data/layerState.js';

const KA = { lat: 49.0094, lon: 8.4044 };
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function fakeCollection() {
  const items = [];
  return {
    show: false,
    get length() {
      return items.length;
    },
    get: (i) => items[i],
    add(options) {
      const billboard = { ...options, show: true };
      items.push(billboard);
      return billboard;
    },
  };
}

function fakeViewer({ lat, lon, height = 4000, globeShown = false }) {
  return {
    camera: {
      positionCartographic: {
        latitude: Cesium.Math.toRadians(lat),
        longitude: Cesium.Math.toRadians(lon),
        height,
      },
      computeViewRectangle: () => undefined,
    },
    scene: {
      globe: { show: globeShown, getHeight: () => 112 },
      primitives: { add() {}, remove() {} },
      canvas: {},
    },
    entities: { add: (entity) => entity, remove() {} },
  };
}

const system = (over = {}) => ({
  id: 'gbfs-nextbike-ka-vehicles',
  name: 'KVV.nextbike',
  provider: 'nextbike',
  centerLat: KA.lat,
  centerLon: KA.lon,
  loadRadiusKm: 15,
  formFactors: ['bicycle'],
  attribution: 'nextbike',
  license: 'CC0-1.0',
  licenseUrl: null,
  ...over,
});
const vehicle = (lat, lon, formFactor = 'bicycle') => ({
  lat,
  lon,
  formFactor,
  propulsion: 'human',
  reportedAt: Date.now() - 120_000,
});

function harness({
  systems = [system()],
  vehicles = { 'gbfs-nextbike-ka-vehicles': [vehicle(49.01, 8.405)] },
  mode = 'vehicles',
  ground = null,
  camera = { ...KA },
  failVehicles = false,
  systemsSource = null,
  vehiclesSource = null,
} = {}) {
  const calls = { stations: 0, vehicles: [] };
  const credits = [];
  const source = {
    getStations: async () => {
      calls.stations += 1;
      throw new Error('stations must not be fetched for vehicle systems');
    },
    getVehicleSystems: systemsSource || (async () => systems),
    getVehicles: async (id, options) => {
      calls.vehicles.push(id);
      if (vehiclesSource) return vehiclesSource(id, options);
      if (failVehicles) throw new Error('upstream down');
      return { system: id, vehicles: vehicles[id] || [], expiresInS: 60 };
    },
  };
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    render: { governorRequestRender() {} },
    sprites: {
      registerSpriteCollection() {},
      unregisterSpriteCollection() {},
      restoreSpriteOrder() {},
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    credits: {
      registerDynamicCredit: (_viewer, credit) => credits.push(credit),
      gbfsSystemCredit: (s) => ({ key: `gbfs-${s.id}`, name: s.city }),
    },
    ground,
  };
  const state = createState({ services });
  state._cities = new Map();
  const parts = {};
  const context = { state, services, parts, source };
  parts.ingestion = createIngestion(context);
  parts.model = createModel(context);
  parts.viewport = createViewport(context);
  parts.rendering = createRendering(context);
  parts.vehicles = createVehicles(context);
  parts.selection = createSelection(context);
  parts.queries = createQueries(context);
  parts.controls = createControls(context);
  state._viewer = fakeViewer(camera);
  state._vehicleCollection = fakeCollection();
  state._pointCollection = { show: true };
  state._enabled = true;
  state._mode = mode;
  async function start() {
    parts.vehicles.sync();
    await flush();
    await parts.viewport.runProximityCheck();
    await flush();
  }
  return {
    state,
    parts,
    calls,
    credits,
    start,
    controls: parts.controls.methods,
  };
}

test('Vehicles mode activates and polls vehicle systems with no station city in range', async () => {
  const app = harness();
  await app.start();
  assert.equal(
    app.calls.stations,
    0,
    'vehicle systems never reach getStations',
  );
  assert.deepEqual(app.calls.vehicles, ['gbfs-nextbike-ka-vehicles']);
  assert.equal(app.state._vehicleRenderMap.size, 1);
  assert.equal(app.state._vehicleCollection.show, true);
  assert.equal(app.controls.getStats().count, 1);
  assert.equal(app.credits.length, 1, 'credited on first load');
  // Not yet expired: the update tick fetches nothing.
  await app.parts.ingestion.methods.update();
  assert.equal(app.calls.vehicles.length, 1);
  app.state._vehicleSnapshots.get('gbfs-nextbike-ka-vehicles').expiresAt = 0;
  await app.parts.ingestion.methods.update();
  await flush();
  assert.equal(app.calls.vehicles.length, 2, 'expired snapshot refetched');
  assert.equal(app.credits.length, 1, 'credited once');
});

test('vehicles wait for their own lower altitude gate', async () => {
  const app = harness({ camera: { ...KA, height: 30_000 } });
  await app.start();
  assert.equal(app.calls.vehicles.length, 0);
  const stats = app.controls.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.match(stats.statusMessage, /^Fly below 15 km/);
});

test("one pool: one operator's overlapping feeds drawn once, other operators kept, nearest first", async () => {
  const shared = [vehicle(49.01, 8.405), vehicle(49.02, 8.41, 'cargo_bicycle')];
  const donkey = 'stables.donkey.bike';
  const app = harness({
    systems: [
      // The real overlapping entries: one feed host, different provider names.
      system({
        id: 'gbfs-donkey-bayern-vehicles',
        provider: 'Donkey Republic Bayern Komplett',
        feedHost: donkey,
      }),
      system({
        id: 'gbfs-donkey-kelheim-vehicles',
        provider: 'Donkey Kelheim',
        feedHost: donkey,
      }),
      system({
        id: 'gbfs-lime-ka-vehicles',
        provider: 'Lime',
        feedHost: 'data.lime.bike',
      }),
    ],
    vehicles: {
      'gbfs-donkey-bayern-vehicles': shared,
      'gbfs-donkey-kelheim-vehicles': shared,
      // Same spot, different operator: a real second vehicle.
      'gbfs-lime-ka-vehicles': [vehicle(49.01, 8.405)],
    },
  });
  await app.start();
  assert.equal(app.state._vehicleRenderMap.size, 3);
  const operators = [...app.state._vehicleRenderMap.values()].map(
    (r) => r.operator,
  );
  assert.equal(operators.filter((o) => o === 'Lime').length, 1);
  assert.equal(operators.filter((o) => o.startsWith('Donkey')).length, 2);
  // Two bikes parked together in ONE feed both stay.
  app.state._vehicleSnapshots
    .get('gbfs-lime-ka-vehicles')
    .vehicles.push(vehicle(49.01, 8.405));
  app.parts.vehicles.rebuild();
  assert.equal(app.state._vehicleRenderMap.size, 4);
});

test('the cap keeps the vehicles nearest the camera', async () => {
  const many = Array.from({ length: MAX_TOTAL_VEHICLES + 50 }, (_, i) =>
    vehicle(KA.lat + i * 0.00001, KA.lon),
  );
  const app = harness({ vehicles: { 'gbfs-nextbike-ka-vehicles': many } });
  await app.start();
  assert.equal(app.state._vehicleRenderMap.size, MAX_TOTAL_VEHICLES);
  const farthest = Math.max(
    ...[...app.state._vehicleRenderMap.values()].map((r) => r.lat),
  );
  assert.ok(farthest < many.at(-1).lat, 'the farthest are the ones left out');
});

test('with the globe hidden, vehicles stand on the 3D-tiles ground floor', async () => {
  const warmed = [];
  const app = harness({
    ground: {
      cachedGroundFloor: () => 300,
      warmGroundFloor: (points) => warmed.push(...points),
    },
  });
  await app.start();
  const [record] = app.state._vehicleRenderMap.values();
  const { height } = Cesium.Cartographic.fromCartesian(record.point.position);
  assert.ok(Math.abs(height - 301.5) < 0.01, `height ${height}`);
  assert.equal(warmed.length, 0, 'nothing to warm when the floor is known');
});

test('selection follows the same parked vehicle across a rebuild and clears when it is gone', async () => {
  const app = harness({
    vehicles: {
      'gbfs-nextbike-ka-vehicles': [
        vehicle(49.02, 8.41),
        vehicle(49.01, 8.405),
      ],
    },
  });
  await app.start();
  const target = [...app.state._vehicleRenderMap.values()].find(
    (r) => r.lat === 49.02,
  );
  app.parts.selection._selectStation(target.key);
  assert.equal(app.state._selectedKey, target.key);
  const snapshot = app.state._vehicleSnapshots.get('gbfs-nextbike-ka-vehicles');
  snapshot.vehicles.unshift(vehicle(49.0095, 8.4045)); // a nearer vehicle shifts indexes
  app.parts.vehicles.rebuild();
  const now = app.state._vehicleRenderMap.get(app.state._selectedKey);
  assert.equal(now.lat, 49.02, 'still the same vehicle');
  snapshot.vehicles = snapshot.vehicles.filter((v) => v.lat !== 49.02);
  app.parts.vehicles.rebuild();
  assert.equal(app.state._selectedKey, null);
});

test('a vehicle feed failure is its own error, never the stations error', async () => {
  const app = harness({ mode: 'both', failVehicles: true });
  const warn = test.mock.method(console, 'warn', () => {});
  try {
    await app.start();
  } finally {
    warn.mock.restore();
  }
  assert.equal(app.state._error, null);
  assert.equal(app.state._vehicleError, 'Shared vehicle feed error');
  app.state._mode = 'vehicles';
  assert.equal(app.controls.getStats().error, 'Shared vehicle feed error');
});

test('switching mode tears down the part the new mode leaves out', async () => {
  const app = harness({ mode: 'both' });
  await app.start();
  assert.equal(app.state._vehicleRenderMap.size, 1);
  assert.equal(app.controls.setParams({ mode: 'stations' }), true);
  await flush();
  assert.equal(app.state._vehicleRenderMap.size, 0);
  assert.equal(app.state._vehicleCollection.show, false);
  assert.equal(app.state._pointCollection.show, true);
  assert.equal(app.controls.setParams({ mode: 'vehicles' }), true);
  await flush();
  assert.equal(app.state._pointCollection.show, false);
  assert.equal(app.controls.setParams({ mode: 'everything' }), false);
  assert.deepEqual(app.controls.getParams(), { mode: 'vehicles' });
  const chips = app.controls.getRowControls().chips;
  assert.deepEqual(
    chips.map((c) => [c.label, c.active]),
    [
      ['Stations', false],
      ['Vehicles', true],
      ['Both', false],
    ],
  );
});

test('detection and analyst rows include vehicles, with no vendor id', async () => {
  const app = harness();
  await app.start();
  const contacts = app.parts.queries.collectDetectableStations({});
  assert.equal(contacts.length, 1);
  assert.match(contacts[0].id, /Bike · nextbike/);
  const [row] = app.controls.getAnalystRecords();
  assert.equal(row.kind, 'vehicle');
  assert.equal(row.id, 'Bike · nextbike');
});

test('the mode rides in the layer URL; old links mean stations', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['bikeshare'];
  state.options.bikeshare = { mode: 'vehicles' };
  const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  assert.match(params.get('lo') || '', /b\.m\.v/);
  assert.equal(
    decodeLayerStateParams(params).options.bikeshare.mode,
    'vehicles',
  );
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('v=2&l=b')).options.bikeshare
      .mode,
    'stations',
  );
});

test('a failed system list is retried, not final', async () => {
  let attempt = 0;
  const warn = test.mock.method(console, 'warn', () => {});
  try {
    const app = harness({
      systemsSource: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('503');
        return [system()];
      },
    });
    await app.start();
    assert.equal(app.state._vehicleSystemsReady, false);
    assert.equal(
      app.controls.getStats().error,
      'Shared vehicle systems unavailable',
    );
    // Within the retry wait, a camera move does not ask again.
    await app.parts.viewport.runProximityCheck();
    await flush();
    assert.equal(attempt, 1);
    app.state._vehicleSystemsRetryAt = Date.now() - 1;
    await app.parts.viewport.runProximityCheck();
    await flush();
    assert.equal(attempt, 2);
    assert.equal(app.state._vehicleSystemsReady, true);
    assert.equal(app.state._vehicleRenderMap.size, 1);
    assert.equal(app.controls.getStats().error, undefined);
  } finally {
    warn.mock.restore();
  }
});

test('a snapshot expiring before the next tick is halfway is fetched on this tick', async () => {
  const app = harness();
  await app.start();
  const snapshot = app.state._vehicleSnapshots.get('gbfs-nextbike-ka-vehicles');
  // A 60 s feed fetched on the last tick expires a moment after this one.
  snapshot.expiresAt = Date.now() + 2_000;
  await app.parts.ingestion.methods.update();
  await flush();
  assert.equal(app.calls.vehicles.length, 2);
});

test('a settled camera re-picks the nearest vehicles without new data', async () => {
  const app = harness({
    vehicles: {
      'gbfs-nextbike-ka-vehicles': [vehicle(49.0, 8.4), vehicle(49.03, 8.4)],
    },
    camera: { lat: 49.0, lon: 8.4 },
  });
  await app.start();
  assert.equal(app.state._vehicleRenderMap.get('veh:0').lat, 49.0);
  app.state._viewer = fakeViewer({ lat: 49.03, lon: 8.4 });
  await app.parts.viewport.runProximityCheck();
  await flush();
  assert.equal(app.calls.vehicles.length, 1, 'no refetch needed');
  assert.equal(app.state._vehicleRenderMap.get('veh:0').lat, 49.03);
});

test('Vehicles → Stations inside the station hysteresis band keeps the station gate', async () => {
  const app = harness({ camera: { ...KA, height: 30_000 } });
  await app.start();
  assert.equal(app.state._altitudeGateEnabled, true, 'gate opened below 48 km');
  app.state._viewer = fakeViewer({ ...KA, height: 50_000 });
  await app.parts.viewport.runProximityCheck();
  assert.equal(
    app.state._altitudeGateEnabled,
    true,
    'still open inside the band',
  );
  app.controls.setParams({ mode: 'stations' });
  await flush();
  assert.equal(app.state._altitudeGateEnabled, true);
});

test('leaving stations drops their old error with them', async () => {
  const app = harness({ mode: 'stations' });
  app.state._error = 'GBFS fetch error';
  app.controls.setParams({ mode: 'vehicles' });
  await flush();
  assert.equal(app.state._error, null);
  app.controls.setParams({ mode: 'stations' });
  await flush();
  assert.equal(app.controls.getStats().error, undefined);
});

test('a fetch abandoned by disable does not end the loading of the next enable', async () => {
  const pending = [];
  const app = harness({
    vehiclesSource: (id, { signal }) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  });
  await app.start();
  assert.equal(app.state._loadingOps, 1);
  // Disable (as lifecycle does: vehicles first, then the count is reset).
  app.parts.vehicles.disable();
  app.state._loadingOps = 0;
  app.state._loading = false;
  // Enable again before the aborted fetch has settled.
  app.state._enabled = true;
  await app.start();
  assert.equal(app.state._loadingOps, 1, 'the new fetch is loading');
  await flush();
  assert.equal(app.state._loadingOps, 1, 'the old fetch did not end it');
  assert.equal(app.state._loading, true);
});

test('bike-share stats say what the count is of in each mode', async () => {
  const app = harness({ mode: 'stations' });
  assert.equal(app.controls.getStats().countOf, 'stations');
  app.state._mode = 'vehicles';
  assert.equal(app.controls.getStats().countOf, 'shared vehicles');
  app.state._mode = 'both';
  assert.equal(app.controls.getStats().countOf, 'stations and shared vehicles');
});
