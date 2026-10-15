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
} = {}) {
  const calls = { stations: 0, vehicles: [] };
  const credits = [];
  const source = {
    getStations: async () => {
      calls.stations += 1;
      throw new Error('stations must not be fetched for vehicle systems');
    },
    getVehicleSystems: async () => systems,
    getVehicles: async (id) => {
      calls.vehicles.push(id);
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

test('one pool: same-operator duplicates drawn once, other operators kept, nearest first', async () => {
  const shared = [vehicle(49.01, 8.405), vehicle(49.02, 8.41, 'cargo_bicycle')];
  const app = harness({
    systems: [
      system({ id: 'gbfs-donkey-bayern-vehicles', provider: 'Donkey' }),
      system({ id: 'gbfs-donkey-kelheim-vehicles', provider: 'Donkey' }),
      system({ id: 'gbfs-lime-ka-vehicles', provider: 'Lime' }),
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
  assert.deepEqual(operators.sort(), ['Donkey', 'Donkey', 'Lime']);
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
