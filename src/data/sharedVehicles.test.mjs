import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFormFactor,
  normalizeFormFactors,
  parseGbfsTime,
  parseVehicleFeed,
  parseVehicleTypes,
  vehicleFeedTtlS,
} from './sharedVehicles.js';

const v3 = {
  ttl: 60,
  last_updated: '2026-10-14T23:54:15Z',
  data: {
    vehicles: [
      {
        vehicle_id: 'secret-uuid-1',
        lat: 49.0123456,
        lon: 8.4012345,
        is_reserved: false,
        is_disabled: false,
        last_reported: '2026-10-14T23:50:42Z',
        rental_uris: { ios: 'https://dnky.bike/bike?bike_id=secret-uuid-1' },
        vehicle_type_id: 'ebike',
        current_range_meters: 31234,
        pricing_plan_id: 'p1',
      },
      // Docked: belongs to the station feed.
      {
        vehicle_id: 'docked',
        lat: 49.01,
        lon: 8.4,
        station_id: '33220',
        vehicle_type_id: 'ebike',
      },
      { vehicle_id: 'off', lat: 49.02, lon: 8.41, is_disabled: true },
      { vehicle_id: 'held', lat: 49.03, lon: 8.42, is_reserved: 1 },
      { vehicle_id: 'nowhere', lat: 0, lon: 0 },
      { vehicle_id: 'bad', lat: 'x', lon: 8 },
      { vehicle_id: 'far', lat: 52.5, lon: 13.4 },
    ],
  },
};

const types = parseVehicleTypes({
  data: {
    vehicle_types: [
      {
        vehicle_type_id: 'ebike',
        form_factor: 'bicycle',
        propulsion_type: 'electric_assist',
        name: [{ language: 'en', text: 'E-bike' }],
      },
      { vehicle_type_id: 7, form_factor: 'scooter', propulsion_type: 'warp' },
    ],
  },
});

test('vehicle types: form factor and propulsion by id, v2 scooter mapped', () => {
  assert.deepEqual(types.get('ebike'), {
    formFactor: 'bicycle',
    propulsion: 'electric_assist',
  });
  assert.deepEqual(types.get('7'), {
    formFactor: 'scooter_standing',
    propulsion: null,
  });
  assert.equal(parseVehicleTypes(null).size, 0);
});

test('a v3 feed keeps only free, available vehicles inside the system, with no ids', () => {
  const { lastUpdated, vehicles } = parseVehicleFeed(v3, {
    types,
    bbox: [48.9, 8.3, 49.1, 8.5],
  });
  assert.equal(lastUpdated, Date.parse('2026-10-14T23:54:00Z'));
  assert.deepEqual(vehicles, [
    {
      lat: 49.0123,
      lon: 8.4012,
      formFactor: 'bicycle',
      propulsion: 'electric_assist',
      reportedAt: Date.parse('2026-10-14T23:50:00Z'),
    },
  ]);
  const json = JSON.stringify(vehicles);
  for (const leak of [
    'vehicle_id',
    'bike_id',
    'rental_uris',
    'pricing_plan_id',
    'secret-uuid',
    'current_range',
  ])
    assert.equal(json.includes(leak), false, leak);
});

test('a v2 feed: bikes array, empty station_id is free, POSIX seconds, form factor fallback', () => {
  const { vehicles } = parseVehicleFeed(
    {
      last_updated: 1792022064,
      data: {
        bikes: [
          { bike_id: 'a', lat: 49.28, lon: -123.12, station_id: '' },
          { bike_id: 'b', lat: 49.29, lon: -123.13, station_id: 17 },
          {
            bike_id: 'c',
            lat: 49.3,
            lon: -123.1,
            is_disabled: 'false',
            last_reported: 0,
          },
        ],
      },
    },
    { formFactors: ['bicycle'] },
  );
  assert.equal(vehicles.length, 2);
  assert.equal(vehicles[0].formFactor, 'bicycle');
  assert.equal(vehicles[0].reportedAt, Math.floor(1792022064 / 60) * 60_000);
  assert.equal(
    vehicles[1].reportedAt,
    vehicles[0].reportedAt,
    'falls back to the feed time',
  );
});

test('empty or several form factors without a type mean unknown, never bicycle', () => {
  const feed = { data: { vehicles: [{ lat: 54.3, lon: 10.1 }] } };
  assert.equal(parseVehicleFeed(feed).vehicles[0].formFactor, 'unknown');
  assert.equal(
    parseVehicleFeed(feed, { formFactors: ['bicycle', 'cargo_bicycle'] })
      .vehicles[0].formFactor,
    'unknown',
  );
});

test('form factors, times and ttl', () => {
  assert.equal(normalizeFormFactor('Scooter'), 'scooter_standing');
  assert.equal(normalizeFormFactor('hoverboard'), 'other');
  assert.equal(normalizeFormFactor(''), null);
  assert.deepEqual(normalizeFormFactors(['moped', 'scooter', 'moped', 7]), [
    'moped',
    'other',
    'scooter_standing',
  ]);
  assert.equal(parseGbfsTime(0), null);
  assert.equal(parseGbfsTime(-5), null);
  assert.equal(parseGbfsTime('nonsense'), null);
  assert.equal(parseGbfsTime('1792022064'), 1792022064000);
  assert.equal(
    parseGbfsTime('2026-10-14T23:54:15.297320Z'),
    Date.parse('2026-10-14T23:54:15.297Z'),
  );
  assert.equal(
    parseGbfsTime('2026-10-14T23:54:15+00:00'),
    Date.parse('2026-10-14T23:54:15Z'),
  );
  assert.equal(vehicleFeedTtlS({ ttl: 0 }), 60);
  assert.equal(vehicleFeedTtlS({ ttl: 240 }), 240);
  assert.equal(vehicleFeedTtlS({ ttl: 9999 }), 300);
  assert.equal(vehicleFeedTtlS({ ttl: 30 }, 120), 120);
  assert.equal(vehicleFeedTtlS({}), 60);
});

test('the shared-vehicle domain is shown and has its find_data_sources topic', async () => {
  const { SOURCE_TOPICS, domainOfTopic, formatOfDomain, nounOfDomain } =
    await import('./sourceDomains.js');
  assert.ok(SOURCE_TOPICS.includes('sharedmobility'));
  assert.equal(domainOfTopic('sharedmobility'), 'sharedmobility.vehicles');
  assert.equal(
    formatOfDomain('sharedmobility.vehicles'),
    'gbfs.vehicle-status',
  );
  assert.equal(nounOfDomain('sharedmobility.vehicles'), 'shared vehicle');
});

test('vehicles leave in position order, never the feed order', () => {
  const bikes = [
    { bike_id: 'a', lat: 49.03, lon: 8.41 },
    { bike_id: 'b', lat: 49.01, lon: 8.43 },
    { bike_id: 'c', lat: 49.01, lon: 8.42 },
    { bike_id: 'd', lat: 49.02, lon: 8.4 },
  ];
  const forward = parseVehicleFeed({ data: { bikes } }).vehicles;
  const reversed = parseVehicleFeed({
    data: { bikes: [...bikes].reverse() },
  }).vehicles;
  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.map((v) => [v.lat, v.lon]),
    [
      [49.01, 8.42],
      [49.01, 8.43],
      [49.02, 8.4],
      [49.03, 8.41],
    ],
  );
});
