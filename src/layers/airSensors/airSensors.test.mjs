import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSensorCommunity, sensorTimestampMs } from './records.js';
import {
  AIR_SENSORS_OVERLAY_SOURCE_ID,
  READING_QUALITY,
  aggregateCells,
  bandIndexOf,
  expandReadings,
  readingsAreStale,
  worstInView,
} from './model.js';
import { createAirSensorsSource } from './source.js';
import { createAirSensorsLayer } from './index.js';
import { buildSensorCard, legendEntries } from './cards.js';
import { airSensorsProxy } from '../../../server/providers/airSensors.js';
import { airSensorFeedCredit } from '../../data/dataCredits.js';
import {
  SOURCE_TOPICS,
  domainsOfTopic,
  formatOfDomain,
  isWorldwideReference,
} from '../../data/sourceDomains.js';

const NOW = Date.UTC(2026, 9, 16, 23, 5, 0);
const ts = (minutesAgo) =>
  new Date(NOW - minutesAgo * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

let nextId = 1;
const pmRecord = ({
  p1 = 12,
  p2 = 7,
  lat = '52.52',
  lon = '13.40',
  indoor = 0,
  minutesAgo = 10,
  locationId = nextId,
  type = 'SDS011',
} = {}) => ({
  timestamp: ts(minutesAgo),
  location: {
    id: locationId,
    latitude: lat,
    longitude: lon,
    indoor,
    country: 'DE',
  },
  sensor: { id: nextId++, sensor_type: { name: type } },
  sensordatavalues: [
    ...(p1 === null ? [] : [{ value_type: 'P1', value: String(p1) }]),
    ...(p2 === null ? [] : [{ value_type: 'P2', value: String(p2) }]),
  ],
});
const humidityRecord = (locationId, rh) => ({
  timestamp: ts(10),
  location: {
    id: locationId,
    latitude: '52.52',
    longitude: '13.40',
    indoor: 0,
    country: 'DE',
  },
  sensor: { id: nextId++, sensor_type: { name: 'DHT22' } },
  sensordatavalues: [
    { value_type: 'temperature', value: '9.1' },
    { value_type: 'humidity', value: String(rh) },
  ],
});

test('timestamps are UTC without a zone', () => {
  assert.equal(
    sensorTimestampMs('2026-10-16 22:59:16'),
    Date.UTC(2026, 9, 16, 22, 59, 16),
  );
  assert.equal(sensorTimestampMs('2026-10-16T22:59:16'), null);
  assert.equal(sensorTimestampMs(undefined), null);
});

test('records: indoor, out-of-range, inverted, all-zero and old rows dropped; humidity joined by location', () => {
  const kept = pmRecord({ p1: 20, p2: 9, locationId: 900 });
  const payload = [
    kept,
    humidityRecord(900, 88),
    pmRecord({ indoor: 1 }),
    pmRecord({ indoor: '1' }),
    pmRecord({ p1: 999.9, p2: 999.9 }),
    pmRecord({ p1: -1, p2: 3 }),
    pmRecord({ p1: 5, p2: 30 }),
    pmRecord({ p1: 0, p2: 0 }),
    pmRecord({ minutesAgo: 4 * 60 }),
    pmRecord({ lat: '', lon: '13.4' }),
    pmRecord({ p1: 'x', p2: null }),
    pmRecord({ p1: 11, p2: null }),
  ];
  const result = normalizeSensorCommunity(payload, { now: NOW });
  assert.deepEqual(result.dropped, {
    indoor: 2,
    position: 1,
    range: 2,
    inverted: 1,
    zero: 1,
    old: 1,
  });
  assert.equal(result.rows.length, 2, 'the kept sensor and the PM10-only one');
  const [row] = result.rows;
  assert.deepEqual(row.slice(0, 6), [
    kept.sensor.id,
    52.52,
    13.4,
    9,
    20,
    sensorTimestampMs(kept.timestamp),
  ]);
  assert.equal(result.types[row[6]], 'SDS011');
  assert.equal(row[8], 'DE');
  assert.equal(row[9], 88, 'humidity from the DHT22 at the same location');
  assert.equal(normalizeSensorCommunity({ error: 'x' }), null);
});

test('records: implausible or far-above-neighbours readings are unconfirmed, lone high ones isolated; none dropped', () => {
  const near = (dLat, p2) =>
    pmRecord({ p1: p2 + 5, p2, lat: String(48.1 + dLat), lon: '11.58' });
  const result = normalizeSensorCommunity(
    [
      near(0, 120),
      near(0.01, 8),
      near(0.02, 9),
      near(-0.01, 10),
      near(0.5, 200),
      near(-0.5, 520),
    ],
    { now: NOW },
  );
  const flags = result.rows.map((row) => row[7]);
  assert.deepEqual(
    flags,
    [1, 0, 0, 0, 2, 1],
    'far above its neighbours: unconfirmed; alone: isolated; over 500 alone: unconfirmed',
  );
});

test('records: over 500 is kept as real when the sensors around it agree (smoke), not when alone (fog)', () => {
  const at = (lat, lon, p2) =>
    pmRecord({ p1: p2 + 20, p2, lat: String(lat), lon: String(lon) });
  const smoke = normalizeSensorCommunity(
    [
      at(39.0, -121.0, 600),
      at(39.01, -121.0, 250),
      at(39.02, -121.0, 300),
      at(39.0, -121.02, 350),
    ],
    { now: NOW },
  );
  assert.deepEqual(
    smoke.rows.map((row) => row[7]),
    [0, 0, 0, 0],
    'a 600 among 250–350 is smoke: ranked, not greyed',
  );
  const fog = normalizeSensorCommunity(
    [
      at(52.0, 5.0, 600),
      at(52.01, 5.0, 12),
      at(52.02, 5.0, 15),
      at(52.0, 5.02, 10),
    ],
    { now: NOW },
  );
  assert.equal(fog.rows[0][7], 1, 'a 600 among clean sensors is a fault');
});

test('bands: EEA 1-hour limits, rounded to integers, the worse of PM2.5 and PM10', () => {
  assert.equal(bandIndexOf(5.49, null), 0);
  assert.equal(bandIndexOf(5.5, null), 1);
  assert.equal(bandIndexOf(15, null), 1);
  assert.equal(bandIndexOf(16, null), 2);
  assert.equal(bandIndexOf(140, null), 4);
  assert.equal(bandIndexOf(141, null), 5);
  assert.equal(bandIndexOf(3, 50), 2, 'PM10 worse than PM2.5');
  assert.equal(bandIndexOf(null, 14), 0);
  assert.equal(bandIndexOf(null, null), -1);
});

const payloadOf = (rows) => ({
  rows,
  types: ['SDS011'],
  sources: [
    {
      id: 'sensor-community-pm-1h',
      attribution: 'Sensor.Community',
      licenceUrl: 'https://opendatacommons.org/licenses/dbcl/1-0/',
    },
  ],
});

test('readings expand from compact rows; rankings skip unconfirmed readings; cells use the median', () => {
  const readings = expandReadings(
    payloadOf([
      [1, 48.1, 11.5, 8, 12, NOW - 600_000, 0, 0, 'DE', 80, 0],
      [2, 48.11, 11.51, 300, 320, NOW - 600_000, 0, 1, 'DE', null, 0],
      [3, 48.12, 11.52, 20, 30, NOW - 600_000, 0, 0, 'DE', null, 0],
      [4, null, 11.5, 8, 12, NOW, 0, 0, null, null, 0],
    ]),
  );
  assert.equal(readings.length, 3);
  assert.equal(readings[0].id, 'sc:1');
  assert.equal(readings[1].unconfirmed, true);
  assert.deepEqual(
    worstInView(readings, null, 5).map((r) => r.id),
    ['sc:3', 'sc:1'],
  );
  assert.deepEqual(
    worstInView(
      readings,
      { west: 11.505, south: 48, east: 12, north: 49 },
      5,
    ).map((r) => r.id),
    ['sc:3'],
  );
  const [cell] = aggregateCells(readings);
  assert.equal(cell.count, 3);
  assert.equal(
    cell.pm25,
    14,
    'median of the confirmed 8 and 20; the faulty 300 is left out',
  );
  assert.equal(cell.band, 1);
  assert.equal(readingsAreStale(readings, NOW), false);
  assert.equal(readingsAreStale(readings, NOW + 3 * 3600_000), true);
  assert.equal(readingsAreStale([], NOW), true);
});

test('card: band, PM values, sensor, humidity warning, caveat; legend lists the PM2.5 limits', () => {
  const [reading] = expandReadings(
    payloadOf([
      [7, 48.1, 11.5, 23.4, 31, NOW - 20 * 60_000, 0, 0, 'DE', 88, 0],
    ]),
  );
  const card = buildSensorCard(reading, NOW, { interactive: true });
  assert.equal(card.title, 'AIR · Moderate');
  assert.match(
    card.details[0],
    /PM2\.5 23 µg\/m³ \(1-h mean\) · PM10 31 µg\/m³/,
  );
  assert.match(card.details[1], /Sensor #7 · DE · SDS011 · measured 20m ago/);
  assert.match(card.details.join('\n'), /Humidity 88% · may read high/);
  assert.match(
    card.details.join('\n'),
    /not an official monitor · EEA index bands, PM only/,
  );
  assert.equal(card.interactive, true);
  const legend = legendEntries();
  assert.equal(legend.length, 6);
  assert.equal(legend[0].label, 'Good · PM2.5 ≤5');
  assert.equal(legend[5].label, 'Extremely poor · PM2.5 >140');
});

test('credit: Sensor.Community with its licence link and the ODbL', () => {
  const credit = airSensorFeedCredit({
    id: 'sensor-community-pm-1h',
    attribution: 'Sensor.Community (contents DbCL 1.0, database per ODbL 1.0)',
    licenseUrl: 'https://opendatacommons.org/licenses/dbcl/1-0/',
  });
  assert.equal(credit.key, 'air-sensors-sensor-community-pm-1h');
  assert.match(credit.html, /^Air quality \(Sensor\.Community/);
  assert.match(
    credit.html,
    /href="https:\/\/opendatacommons\.org\/licenses\/dbcl\/1-0\/"/,
  );
  assert.match(credit.html, /ODbL 1\.0<\/a>$/);
});

function installProxy(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (route, h) => (handler = h) } });
  return async (url = '/') => {
    const res = {
      headers: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method: 'GET', headers: {}, socket: {} }, res);
    return res;
  };
}

const ENTRY = {
  id: 'sensor-community-pm-1h',
  access: {
    url: 'https://data.sensor.community/static/v2/data.1h.json',
    headers: {},
  },
  licence: {
    attribution: 'Sensor.Community',
    url: 'https://opendatacommons.org/licenses/dbcl/1-0/',
  },
};

test('proxy: sends a contact User-Agent, serves compact rows, serves stale on failure, 503 without a source', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  const seen = [];
  let fail = false;
  const request = installProxy(
    airSensorsProxy({
      now: () => clock,
      directory: {
        usable: (domain) => (domain === 'airquality.sensors' ? [ENTRY] : []),
        ready: async () => {},
      },
      directoryFetch: async (url, init) => {
        seen.push({ url, ua: init.headers['User-Agent'] });
        if (fail) return new Response('down', { status: 502 });
        return new Response(
          JSON.stringify([
            pmRecord({ p1: 10, p2: 6 }),
            pmRecord({ indoor: 1 }),
          ]),
        );
      },
    }),
  );
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.body.rows.length, 1);
  assert.deepEqual(first.body.types, ['SDS011']);
  assert.equal(first.body.sources[0].attribution, 'Sensor.Community');
  assert.match(seen[0].ua, /^gods-eye-view-air-sensors\/1\.0 \(\+https:\/\//);
  await request();
  assert.equal(seen.length, 1, 'cached for 20 minutes');
  clock += 21 * 60_000;
  fail = true;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');

  const empty = installProxy(
    airSensorsProxy({
      directory: { usable: () => [] },
      directoryFetch: async () => assert.fail('no fetch'),
    }),
  );
  const none = await empty();
  assert.equal(none.status, 503);
  assert.deepEqual(none.body, { error: 'no_source' });
});

test('proxy: a redirect is a failure', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = installProxy(
    airSensorsProxy({
      directory: { usable: () => [ENTRY] },
      directoryFetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/' },
        }),
    }),
  );
  assert.equal((await request()).status, 502);
});

test('source: 503 means no verified source yet; malformed snapshots throw', async () => {
  const respond = (status, body) =>
    createAirSensorsSource({
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    });
  await assert.rejects(
    respond(503, { error: 'no_source' }).getSnapshot(),
    /No verified air-sensor source yet/,
  );
  await assert.rejects(
    respond(200, { rows: 'x' }).getSnapshot(),
    /Malformed air-sensor snapshot/,
  );
  const ok = await respond(200, {
    ...payloadOf([[1, 48, 11, 4, 9, NOW, 0, 0, 'DE', null, 0]]),
    stale: true,
  }).getSnapshot();
  assert.equal(ok.readings.length, 1);
  assert.equal(ok.stale, true);
});

function layerHarness(snapshot) {
  const primitives = [];
  const overlay = [];
  const credited = [];
  const viewer = {
    scene: {
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          primitives.splice(primitives.indexOf(value), 1);
        },
      },
      requestRender() {},
    },
    camera: {
      positionCartographic: { height: 200_000 },
      computeViewRectangle: () => null,
    },
  };
  const layer = createAirSensorsLayer({
    source: { getSnapshot: async () => snapshot },
    overlayHost: {
      setEntries: (...args) => overlay.push(args),
      setVisible() {},
      clearSource() {},
    },
    credits: {
      registerDynamicCredit: (v, credit) => credited.push(credit.key),
      airSensorFeedCredit,
    },
  });
  layer.init(viewer);
  return { layer, viewer, primitives, overlay, credited };
}

test('layer: points when zoomed in, cells far out, credit once, records carry the caveat', async () => {
  const snapshot = {
    readings: expandReadings(
      payloadOf([
        // The layer judges staleness on the real clock.
        [1, 48.1, 11.5, 8, 12, Date.now() - 600_000, 0, 0, 'DE', null, 0],
        [2, 48.2, 11.6, 60, 70, Date.now() - 600_000, 0, 0, 'DE', null, 0],
      ]),
    ),
    sources: payloadOf([]).sources,
    stale: false,
  };
  const { layer, viewer, primitives, overlay, credited } =
    layerHarness(snapshot);
  assert.equal(
    primitives.length,
    2,
    'a point collection and a cell collection',
  );
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(await layer.update(), true);
  assert.deepEqual(
    credited,
    ['air-sensors-sensor-community-pm-1h'],
    'credited once',
  );
  const [points, cells] = primitives;
  assert.equal(points.length, 2);
  assert.equal(points.show, true);
  assert.equal(cells.show, false);
  const labels = overlay
    .filter(([id]) => id === AIR_SENSORS_OVERLAY_SOURCE_ID)
    .at(-1)[1];
  assert.equal(labels[0].title, 'PM2.5 60 µg/m³', 'worst first');
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().stale, false);
  const records = layer.getAnalystRecords();
  assert.equal(records[0].band, 'poor');
  assert.equal(records[0].quality, READING_QUALITY);
  const card = layer.getRowControls();
  assert.equal(card.legend.length, 6);
  assert.match(card.summary.coverage, /Mostly Europe/);
  assert.equal(card.list.items[0].lead, 'PM2.5 60 µg/m³');

  viewer.camera.positionCartographic.height = 5_000_000;
  layer.disable();
  layer.enable();
  assert.equal(points.show, false);
  assert.equal(cells.show, true);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), [], 'nothing while off');
  layer.destroy(viewer);
  assert.equal(primitives.length, 0);
});

test('layer: a stale proxy snapshot is reported stale', async () => {
  const { layer } = layerHarness({
    readings: expandReadings(
      payloadOf([[1, 48.1, 11.5, 8, 12, NOW, 0, 0, 'DE', null, 0]]),
    ),
    sources: [],
    stale: true,
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  assert.match(layer.getRowControls().summary.status, /unreachable/);
});

test('directory domain: shown under the environment topic, worldwide', () => {
  assert.ok(SOURCE_TOPICS.includes('environment'));
  assert.deepEqual(domainsOfTopic('environment'), ['airquality.sensors']);
  assert.equal(formatOfDomain('airquality.sensors'), 'json.sensor-community');
  assert.equal(isWorldwideReference('airquality.sensors'), true);
});
