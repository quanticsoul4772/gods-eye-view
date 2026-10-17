import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { weatherProductFor, weatherWindow } from './atmosphere.js';
import { resolveArea } from '../area.js';

const CONUS = { west: -130, south: 20, east: -60, north: 55 };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const weatherMaps = (snapshot = {}) => ({
  requests: [],
  async getSnapshot({ product }) {
    return {
      schemaVersion: 1,
      product,
      title: 'MRMS radar',
      coverage: 'Contiguous United States',
      source: 'NOAA nowCOAST',
      attribution: 'NOAA',
      bounds: CONUS,
      times: ['2026-10-01T19:00:00.000Z'],
      latest: '2026-10-01T19:00:00.000Z',
      ...snapshot,
    };
  },
  async getImage(request) {
    this.requests.push(request);
    return { contentType: 'image/png', bytes: PNG };
  },
});

test('weather windows are 2:1, snapped to 0.25° and kept inside the bounds', () => {
  const austin = weatherWindow(
    {
      center: { lat: 30.27, lon: -97.74, radiusKm: 50 },
      west: -98.3,
      east: -97.2,
      south: 29.8,
      north: 30.7,
    },
    CONUS,
  );
  assert.deepEqual(austin, {
    west: -99.25,
    south: 29.5,
    east: -96.25,
    north: 31,
  });
  const edge = weatherWindow(
    {
      center: { lat: 21, lon: -129, radiusKm: 200 },
      west: -131,
      east: -127,
      south: 19,
      north: 23,
    },
    CONUS,
  );
  assert.equal(edge.west, -130);
  assert.equal(edge.south, 20);
  assert.equal((edge.east - edge.west) / (edge.north - edge.south), 2);
  assert.equal(
    weatherWindow(
      { bbox: true, west: -180, east: 180, south: -80, north: 80 },
      CONUS,
    ),
    null,
  );
});

test('weather maps return the latest frame as an image over the area', async () => {
  const maps = weatherMaps();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: maps },
  });
  const result = await catalog.call('get_weather_map', {
    map: 'radar',
    area: { lat: 30.27, lon: -97.74, radius_km: 50 },
  });
  assert.equal(
    result.summary,
    'MRMS radar at 2026-10-01T19:00:00.000Z over 50 km around 30.270, -97.740.',
  );
  assert.deepEqual(result.images, [
    { mimeType: 'image/png', data: 'iVBORw==' },
  ]);
  assert.deepEqual(maps.requests[0], {
    product: 'radar',
    time: '2026-10-01T19:00:00.000Z',
    size: { width: 1024, height: 512 },
    bbox: { west: -99.25, south: 29.5, east: -96.25, north: 31 },
    signal: undefined,
  });
  const whole = await catalog.call('get_weather_map', { map: 'satellite' });
  assert.equal(maps.requests[1].product, 'clouds-regional');
  assert.equal(maps.requests[1].bbox, null);
  assert.deepEqual(whole.data.box, CONUS);
  await assert.rejects(
    catalog.call('get_weather_map', {
      map: 'radar',
      area: { lat: 51.5, lon: -0.1, radius_km: 50 },
    }),
    /outside the radar map's coverage: Contiguous United States/,
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: weatherMaps({ unavailable: true }) },
  });
  await assert.rejects(
    down.call('get_weather_map', { map: 'lightning' }),
    (error) => error.code === 'unavailable',
  );
});

test('wind is sampled from the model grid at the location', async () => {
  // A 1° global grid where every cell blows 10 m/s toward the east (from the west).
  const nx = 360;
  const ny = 181;
  const u = new Float32Array(nx * ny).fill(10);
  const v = new Float32Array(nx * ny).fill(0);
  const wind = {
    requested: [],
    async getSnapshot({ model }) {
      this.requested.push(model);
      return {
        model,
        cycle: '2026-10-01T12:00:00Z',
        level: '10 m above ground',
        grid: { nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1 },
        u,
        v,
      };
    },
  };
  const catalog = composeCatalog({ tools: coreTools, services: { wind } });
  const result = await catalog.call('get_wind', {
    location: { lat: 30.27, lon: -97.74 },
    model: 'ifs',
  });
  assert.equal(
    result.summary,
    'Wind at 30.2700, -97.7400: 36 km/h from the W.',
  );
  assert.equal(result.data.speed_mps, 10);
  assert.equal(result.data.from, 'W');
  assert.deepEqual(wind.requested, ['ifs']);
  u.fill(0);
  const calm = await catalog.call('get_wind', { location: { lat: 0, lon: 0 } });
  assert.equal(calm.summary, 'Wind at 0.0000, 0.0000: 0 km/h, calm.');
  assert.equal(calm.data.calm, true);
  const down = composeCatalog({
    tools: coreTools,
    services: { wind: { getSnapshot: async () => ({ unavailable: true }) } },
  });
  await assert.rejects(
    down.call('get_wind', { location: { lat: 0, lon: 0 } }),
    (error) => error.code === 'unavailable',
  );
});

test('a weather window that cannot cover the area falls back to the whole map', async () => {
  const world = { west: -180, south: -90, east: 180, north: 90 };
  // 100 km around 179.8° crosses the antimeridian.
  const dateline = await resolveArea({ lat: 0, lon: 179.8, radius_km: 100 });
  assert.equal(weatherWindow(dateline, world), null);
  // Near a product edge the window moves inside and still covers the area.
  const conus = { west: -130, south: 20, east: -60, north: 55 };
  const edge = await resolveArea({ lat: 40, lon: -129.5, radius_km: 50 });
  const box = weatherWindow(edge, conus);
  assert.ok(box);
  assert.ok(box.west <= Math.max(edge.west, conus.west));
  assert.ok(box.east >= edge.east);
  assert.ok(box.south <= edge.south && box.north >= edge.north);
});

test('lightning: EUMETSAT where only it covers the area (Europe, Africa), NOAA elsewhere and over their overlap', () => {
  const box = (lat, lon) => ({
    west: lon - 1,
    south: lat - 1,
    east: lon + 1,
    north: lat + 1,
    label: 'x',
  });
  assert.equal(
    weatherProductFor('lightning', box(48, 11)),
    'lightning-eu',
    'Munich',
  );
  assert.equal(
    weatherProductFor('lightning', box(6, 3)),
    'lightning-eu',
    'Lagos',
  );
  assert.equal(
    weatherProductFor('lightning', box(30, -90)),
    'lightning',
    'Gulf of Mexico',
  );
  assert.equal(
    weatherProductFor('lightning', box(10, -40)),
    'lightning',
    'mid-Atlantic overlap stays NOAA',
  );
  assert.equal(
    weatherProductFor('lightning', box(20, 80)),
    'lightning',
    'India: neither covers it; NOAA reports the gap',
  );
  assert.equal(weatherProductFor('lightning', null), 'lightning');
  assert.equal(weatherProductFor('radar', box(48, 11)), 'radar');
});

test('lightning where neither NOAA nor EUMETSAT covers the area is refused, not an empty map', async () => {
  const maps = weatherMaps({
    bounds: { west: -180, south: -25, east: 180, north: 80 },
    coverage: 'Pacific and Americas',
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: maps },
  });
  await assert.rejects(
    catalog.call('get_weather_map', {
      map: 'lightning',
      area: { lat: 19.1, lon: 72.9, radius_km: 50 },
    }),
    /outside the lightning map's coverage/,
    'Mumbai: NOAA advertises a global box but has no data from 0° to 110°E',
  );
  assert.equal(maps.requests.length, 0);
});

test('radar_north_america maps to ECCC precipitation type over its data box', async () => {
  const maps = weatherMaps({
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    dataBounds: { west: -171, south: 16, east: -49, north: 72 },
    coverage: 'Canada and the United States',
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: maps },
  });
  const result = await catalog.call('get_weather_map', {
    map: 'radar_north_america',
    area: { lat: 43.65, lon: -79.38, radius_km: 50 },
  });
  assert.equal(maps.requests[0].product, 'radar-ca');
  assert.ok(maps.requests[0].bbox, 'a window around Toronto');
  assert.equal(result.data.map, 'radar_north_america');
  await assert.rejects(
    catalog.call('get_weather_map', {
      map: 'radar_north_america',
      area: { lat: 51.5, lon: -0.1, radius_km: 50 },
    }),
    /outside the radar_north_america map's coverage/,
  );
});

test('weather windows always hold the whole area: Toronto, and far north where an area is wider than tall', async () => {
  for (const [lat, lon] of [
    [43.65, -79.38],
    [65, -147],
  ]) {
    const area = await resolveArea({ lat, lon, radius_km: 50 });
    const box = weatherWindow(area, {
      west: -171,
      south: 16,
      east: -49,
      north: 72,
    });
    assert.ok(box, `${lat},${lon}`);
    assert.ok(
      box.west <= area.west &&
        box.east >= area.east &&
        box.south <= area.south &&
        box.north >= area.north,
      JSON.stringify({ box, area }),
    );
    assert.equal((box.east - box.west) / (box.north - box.south), 2);
  }
});

test('weather windows hold the whole area at every snap phase (latitude sweep)', async () => {
  const bounds = { west: -171, south: 16, east: -49, north: 68 };
  for (const radius of [50, 200, 800])
    for (let lat = 20; lat <= 60; lat += 0.037) {
      const area = await resolveArea({ lat, lon: -95.123, radius_km: radius });
      const box = weatherWindow(area, bounds);
      assert.ok(box, `${radius} km at ${lat.toFixed(3)}`);
      // The part of the area inside the product must be in the window.
      assert.ok(
        box.west <= Math.max(area.west, bounds.west) &&
          box.east >= Math.min(area.east, bounds.east) &&
          box.south <= Math.max(area.south, bounds.south) &&
          box.north >= Math.min(area.north, bounds.north),
        `${radius} km at ${lat.toFixed(3)}`,
      );
    }
});

test('with no area, a padded product shows its data box, not the padding', async () => {
  const maps = weatherMaps({
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    dataBounds: { west: -171, south: 16, east: -49, north: 68 },
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: maps },
  });
  const result = await catalog.call('get_weather_map', {
    map: 'radar_north_america',
  });
  const box = maps.requests[0].bbox;
  assert.ok(box, 'a window, not the whole globe');
  assert.ok(
    box.west <= -171 && box.east >= -49 && box.south <= 16 && box.north >= 68,
    JSON.stringify(box),
  );
  assert.equal((box.east - box.west) / (box.north - box.south), 2);
  assert.deepEqual(result.data.box, box);
});

test('precipitation_global maps to the NASA IMERG estimate anywhere', async () => {
  const maps = weatherMaps({
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    dataBounds: { west: -180, south: -90, east: 180, north: 90 },
    coverage: 'Global multi-satellite estimate',
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weatherMaps: maps },
  });
  await catalog.call('get_weather_map', {
    map: 'precipitation_global',
    area: { lat: 1.35, lon: 103.8, radius_km: 100 },
  });
  assert.equal(maps.requests[0].product, 'precip-global');
  assert.ok(maps.requests[0].bbox, 'a window around Singapore');
});
