import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  PEER_TO_PEER_HOSTS,
  createSharedMobilityService,
} from '../../server/providers/sharedMobility.js';

const entry = (over = {}) => ({
  id: 'gbfs-nextbike-ka-vehicles',
  domain: 'sharedmobility.vehicles',
  name: 'KVV.nextbike',
  provider: 'nextbike',
  coverage: { bbox: [48.9, 8.3, 49.1, 8.5], countries: ['DE'] },
  access: {
    url: 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_ka/free_bike_status.json',
    related: {
      vehicle_types:
        'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_ka/vehicle_types.json',
    },
    min_interval_s: 60,
  },
  format: 'gbfs.vehicle-status',
  gbfs: { form_factors: ['bicycle'] },
  licence: {
    id: 'CC0-1.0',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: 'nextbike',
    display: true,
  },
  health: { status: 'verified' },
  ...over,
});

const feed = {
  ttl: 0,
  last_updated: 1792022064,
  data: {
    bikes: [
      {
        bike_id: 'b-1',
        lat: 49.01,
        lon: 8.4,
        vehicle_type_id: '15',
        rental_uris: { web: 'https://nextbike.net/station?id=35913434' },
      },
      { bike_id: 'b-2', lat: 49.02, lon: 8.41, station_id: '99' },
    ],
  },
};
const types = {
  data: {
    vehicle_types: [
      {
        vehicle_type_id: '15',
        form_factor: 'cargo_bicycle',
        propulsion_type: 'human',
      },
    ],
  },
};

function setup({ entries = [entry()], respond, admit = () => true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return respond
      ? respond(url)
      : new Response(
          JSON.stringify(url.includes('vehicle_types') ? types : feed),
        );
  };
  const service = createSharedMobilityService({
    directory: { usable: () => entries },
    fetchImpl,
    admit,
  });
  const get = async (path) => {
    const response = await service.handle({
      url: `http://localhost/api/sharedmobility${path}`,
      method: 'GET',
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };
  return { service, get, calls };
}

test('systems: usable entries in registry shape, no URLs, peer-to-peer and bad areas left out', async () => {
  const { get } = setup({
    entries: [
      entry(),
      entry({
        id: 'gbfs-locomotion-montreal-vehicles',
        access: {
          url: 'https://locomotion.app/gbfs/v3/montreal/vehicle_status.json',
        },
      }),
      entry({ id: 'bad-area', coverage: { bbox: [10, 0, 5, 1] } }),
    ],
  });
  const { status, body } = await get('/systems');
  assert.equal(status, 200);
  assert.equal(body.systems.length, 1);
  const [system] = body.systems;
  assert.equal(system.id, 'gbfs-nextbike-ka-vehicles');
  assert.deepEqual(system.formFactors, ['bicycle']);
  assert.ok(system.loadRadiusKm >= 10);
  assert.equal(JSON.stringify(body).includes('nextbike.net/maps'), false);
  assert.ok(PEER_TO_PEER_HOSTS.has('locomotion.app'));
});

test('vehicles: free vehicles only, typed, no ids or rental links; cached for the clamped ttl', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const { get, calls } = setup();
    const first = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.body.vehicles.length, 1);
    assert.equal(first.body.vehicles[0].formFactor, 'cargo_bicycle');
    assert.equal(first.body.expiresInS, 60, 'ttl 0 is cached 60 s');
    const text = JSON.stringify(first.body);
    for (const leak of ['b-1', 'bike_id', 'rental_uris', '35913434'])
      assert.equal(text.includes(leak), false, leak);
    assert.equal(calls.length, 2, 'types + feed');
    mock.timers.tick(30_000);
    const second = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(second.headers.get('x-gev-cache'), 'HIT');
    assert.equal(second.body.expiresInS, 30);
    assert.equal(calls.length, 2);
    mock.timers.tick(31_000);
    await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(calls.length, 3, 'types cached a day; only the feed again');
  } finally {
    mock.timers.reset();
  }
});

test('vehicles: unknown, listed-only, malformed and peer-to-peer ids are 404; URLs are never accepted', async () => {
  const { get, calls } = setup({
    entries: [
      entry({
        id: 'gbfs-locomotion-sherbrooke-vehicles',
        access: { url: 'https://locomotion.app/x/vehicle_status.json' },
      }),
    ],
  });
  for (const path of [
    '/vehicles/nope',
    '/vehicles/gbfs-locomotion-sherbrooke-vehicles',
    `/vehicles/${encodeURIComponent('https://evil.example/feed.json')}`,
    '/vehicles/%E0%A4%A',
    '/feeds',
  ])
    assert.equal((await get(path)).status, 404, path);
  assert.equal(calls.length, 0);
});

test('vehicles: a failed upstream cools down, then the last good copy is served', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    let fail = false;
    const { get, calls } = setup({
      respond: (url) =>
        fail && !url.includes('vehicle_types')
          ? new Response('<html>oops</html>', { status: 500 })
          : new Response(
              JSON.stringify(url.includes('vehicle_types') ? types : feed),
            ),
    });
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(
      (await get('/vehicles/gbfs-nextbike-ka-vehicles')).status,
      200,
    );
    fail = true;
    mock.timers.tick(61_000);
    const stale = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('x-gev-cache'), 'STALE');
    const fetched = calls.length;
    const cooling = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(cooling.headers.get('x-gev-cache'), 'STALE');
    assert.equal(calls.length, fetched, 'no fetch during the cooldown');
    mock.timers.tick(10 * 60_000);
    const gone = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(gone.status, 503, 'nothing fresh enough to serve');
    assert.ok(Number(gone.headers.get('retry-after')) >= 1);
    assert.ok(warn.mock.callCount() >= 1);
    warn.mock.restore();
  } finally {
    mock.timers.reset();
  }
});

test('vehicles: over the upstream budget with nothing cached answers 503', async () => {
  const { get, calls } = setup({ admit: () => false });
  const response = await get('/vehicles/gbfs-nextbike-ka-vehicles');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-gev-backoff'), 'rate-limited');
  assert.equal(calls.length, 0);
});

test('vehicles: unreadable vehicle types are not asked for again on every refresh', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const warn = mock.method(console, 'warn', () => {});
  try {
    let typeCalls = 0;
    const { get } = setup({
      respond: (url) => {
        if (url.includes('vehicle_types')) {
          typeCalls += 1;
          return new Response('nope', { status: 404 });
        }
        return new Response(JSON.stringify(feed));
      },
    });
    await get('/vehicles/gbfs-nextbike-ka-vehicles');
    mock.timers.tick(61_000);
    await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(typeCalls, 1, 'second refresh reuses the failure');
    mock.timers.tick(60 * 60_000);
    await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(typeCalls, 2, 'asked again after an hour');
  } finally {
    warn.mock.restore();
    mock.timers.reset();
  }
});

test('systems carry the feed host the layer de-duplicates by, never a URL', async () => {
  const { get } = setup();
  const [system] = (await get('/systems')).body.systems;
  assert.equal(system.feedHost, 'gbfs.nextbike.net');
});

test('vehicles: unreadable vehicle types fall back to the entry form factor', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const { get } = setup({
      respond: (url) =>
        url.includes('vehicle_types')
          ? new Response('nope', { status: 404 })
          : new Response(JSON.stringify(feed)),
    });
    const { status, body } = await get('/vehicles/gbfs-nextbike-ka-vehicles');
    assert.equal(status, 200);
    assert.equal(body.vehicles[0].formFactor, 'bicycle');
  } finally {
    warn.mock.restore();
  }
});
