import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import {
  acceptDirectory,
  createSourceDirectory,
  isSafeSourceUrl,
  isUsableEntry,
  referralEntries,
} from '../../server/providers/sourceDirectory.js';
import { directorySystems } from '../../server/providers/gbfs.js';
import {
  bboxToCircle,
  directoryTransitFeed,
  parseBbox,
  publicDirectoryFeed,
  snapshotInBbox,
} from './transitDirectory.js';
import { readZipEntry } from './zipEntry.js';
import { createTransitService } from '../sources/transitService.js';
import { composeCatalog, coreTools } from '../tools/index.js';
import { referralSummary } from '../tools/queries/sources.js';

const entry = (over = {}) => ({
  id: 'bods-england',
  domain: 'transit.vehicles',
  name: 'Bus Open Data Service — England',
  provider: 'Department for Transport',
  coverage: { bbox: [49.86, -6.42, 55.82, 1.77], countries: ['GB'] },
  access: {
    url: 'https://data.bus-data.dft.gov.uk/avl/download/gtfsrt',
    redirectHosts: ['download.bus-data.dft.gov.uk'],
    unzip: 'gtfsrt.bin',
    headers: {},
    min_interval_s: 20,
  },
  format: 'gtfs-rt.vehicle-positions',
  licence: {
    id: 'OGL-UK-3.0',
    url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    display: true,
    commercial: true,
    attribution: 'Department for Transport',
  },
  health: { status: 'verified' },
  ...over,
});

test('source URLs: https, default port, DNS name, no credentials', () => {
  assert.equal(isSafeSourceUrl('https://cdn.example.org/vp.pb'), true);
  assert.equal(isSafeSourceUrl('http://cdn.example.org/vp.pb'), false);
  assert.equal(isSafeSourceUrl('https://cdn.example.org:8443/vp.pb'), false);
  assert.equal(isSafeSourceUrl('https://185.220.72.38/vp.pb'), false);
  assert.equal(isSafeSourceUrl('https://[::1]/vp.pb'), false);
  assert.equal(isSafeSourceUrl('https://user:pw@cdn.example.org/vp.pb'), false);
  assert.equal(
    isSafeSourceUrl('https://cdn.example.org/vp.pb?apiKey=x'),
    false,
  );
  assert.equal(isSafeSourceUrl('https://localhost/vp.pb'), false);
});

test('usable entries: verified, display allowed, known format, safe URLs', () => {
  assert.equal(isUsableEntry(entry()), true);
  assert.equal(
    isUsableEntry(entry({ health: { status: 'candidate' } })),
    false,
  );
  assert.equal(
    isUsableEntry(entry({ licence: { ...entry().licence, display: false } })),
    false,
  );
  assert.equal(isUsableEntry(entry({ format: 'geojson.earthquakes' })), false);
  assert.equal(
    isUsableEntry(
      entry({ licence: { ...entry().licence, url: 'javascript:alert(1)' } }),
    ),
    false,
  );
  assert.equal(
    isUsableEntry(
      entry({ access: { ...entry().access, url: 'https://10.0.0.1/x' } }),
    ),
    false,
  );
  assert.equal(isUsableEntry(entry({ id: 'Bad Id' })), false);
});

test('a refreshed directory that shrinks by > 20 % or doubles is refused', () => {
  const of = (n) => ({
    entries: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })),
  });
  assert.equal(acceptDirectory(of(10), null), true);
  assert.equal(acceptDirectory(of(0), null), false);
  assert.equal(acceptDirectory(of(8), of(10)), true);
  assert.equal(acceptDirectory(of(7), of(10)), false);
  assert.equal(acceptDirectory(of(21), of(10)), false);
  assert.equal(acceptDirectory({ nope: true }, of(10)), false);
});

test('directory refresh keeps the snapshot until a valid newer file arrives', async () => {
  const snapshot = { generated_at: 'a', entries: [entry()] };
  let body = { generated_at: 'b', entries: [entry(), entry({ id: 'mdb-1' })] };
  const directory = createSourceDirectory({
    snapshot,
    fetchImpl: async () =>
      new Response(JSON.stringify(body), { headers: { etag: '"1"' } }),
  });
  assert.equal(directory.generatedAt(), 'a');
  assert.equal(await directory.refresh(), true);
  assert.equal(directory.generatedAt(), 'b');
  assert.equal(directory.usable('transit.vehicles').length, 2);
  body = { generated_at: 'c', entries: [] };
  assert.equal(
    await directory.refresh(),
    false,
    'an emptied directory is refused',
  );
  assert.equal(directory.generatedAt(), 'b');
});

test('referral rows: covering entries, usable first, never a feed URL', () => {
  const rows = referralEntries(
    [
      entry({ id: 'a-listed', name: 'A', health: { status: 'candidate' } }),
      entry({ id: 'b-usable', name: 'B' }),
      entry({
        id: 'far',
        name: 'Far',
        coverage: { bbox: [0, 0, 1, 1], countries: [] },
      }),
    ],
    { lat: 51.5, lon: -0.12 },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b-usable', 'a-listed'],
  );
  assert.equal(rows[0].usable, true);
  assert.ok(
    !JSON.stringify(rows).includes('bus-data.dft.gov.uk/avl'),
    'no feed URL in referral rows',
  );
});

test('transit directory feeds: registry shape, national by coverage radius', () => {
  const feed = directoryTransitFeed(entry());
  assert.equal(feed.national, true);
  assert.equal(feed.unzip, 'gtfsrt.bin');
  assert.deepEqual(feed.redirectHosts, ['download.bus-data.dft.gov.uk']);
  assert.ok(feed.loadRadiusKm > 300);
  const pub = publicDirectoryFeed(feed);
  assert.equal(pub.url, undefined);
  assert.equal(pub.headers, undefined);
  const local = directoryTransitFeed(
    entry({
      id: 'mdb-1',
      coverage: { bbox: [49.6, -1.7, 49.7, -1.5], countries: ['FR'] },
    }),
  );
  assert.equal(local.national, false);
  const { center, loadRadiusKm } = bboxToCircle([0, 0, 2, 2]);
  assert.deepEqual(center, { lat: 1, lon: 1 });
  assert.ok(loadRadiusKm >= 157 && loadRadiusKm <= 158);
  assert.deepEqual(
    parseBbox('51.45,-0.25,51.56,0.02'),
    [51.45, -0.25, 51.56, 0.02],
  );
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('5,0,1,1'), null);
  const snap = {
    count: 2,
    vehicles: [
      { lat: 51.5, lon: -0.1 },
      { lat: 53.4, lon: -2.2 },
    ],
  };
  assert.equal(snapshotInBbox(snap, [51.45, -0.25, 51.56, 0.02]).count, 1);
});

/** A minimal zip with one deflated entry. */
function zipOf(name, data) {
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(30 + nameBytes.length + packed.length, 16);
  return new Uint8Array(
    Buffer.concat([local, nameBytes, packed, central, nameBytes, eocd]),
  );
}

test('zip entry: read by name, missing and oversize refused', async () => {
  const data = Buffer.from('vehicle positions '.repeat(40));
  const zip = zipOf('gtfsrt.bin', data);
  assert.deepEqual(Buffer.from(await readZipEntry(zip, 'gtfsrt.bin')), data);
  await assert.rejects(readZipEntry(zip, 'other.bin'), /not found/);
  await assert.rejects(readZipEntry(zip, 'gtfsrt.bin', 10), /over 10 bytes/);
});

/** GTFS-RT FeedMessage with full-dataset header and the given vehicles. */
function feedMessage(vehicles, timestamp = Math.floor(Date.now() / 1000)) {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, (_, p) => {
    p.writeStringField(1, '2.0');
    p.writeVarintField(2, 0);
    p.writeVarintField(3, timestamp);
  });
  vehicles.forEach((v, i) =>
    pbf.writeMessage(2, (_, p) => {
      p.writeStringField(1, `e${i}`);
      p.writeMessage(4, (__, vp) => {
        vp.writeMessage(8, (___, v8) => v8.writeStringField(1, `v${i}`));
        vp.writeMessage(2, (___, pos) => {
          pos.writeFloatField(1, v.lat);
          pos.writeFloatField(2, v.lon);
        });
        vp.writeVarintField(5, timestamp);
      });
    }),
  );
  return pbf.finish();
}

test('transit service: directory feeds join the catalog, national feeds need and honour bbox', async () => {
  const zip = zipOf(
    'gtfsrt.bin',
    Buffer.from(
      feedMessage([
        { lat: 51.5, lon: -0.1 },
        { lat: 53.48, lon: -2.24 },
      ]),
    ),
  );
  const requested = [];
  const directoryFetch = async (url) => {
    requested.push(url);
    if (url.startsWith('https://data.bus-data.dft.gov.uk/'))
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://download.bus-data.dft.gov.uk/avl/gtfsrt_1.zip',
        },
      });
    return new Response(zip, { status: 200 });
  };
  const directory = createSourceDirectory({
    snapshot: { generated_at: 'x', entries: [entry()] },
    fetchImpl: async () => new Response(null, { status: 304 }),
  });
  const service = createTransitService({
    fetchImpl: async () => {
      throw new Error('static fetch must not be used for directory feeds');
    },
    directory,
    directoryFetch,
  });
  const get = async (path) =>
    service.handle({
      url: `http://localhost/api/transit${path}`,
      method: 'GET',
    });
  try {
    const feeds = (await (await get('/feeds')).json()).feeds;
    const bods = feeds.find((f) => f.id === 'bods-england');
    assert.equal(bods.directory, true);
    assert.equal(bods.national, true);
    assert.equal(bods.url, undefined, 'no upstream URL in the public catalog');
    assert.equal((await get('/vehicles/bods-england')).status, 400);
    const london = await get(
      '/vehicles/bods-england?bbox=51.45,-0.25,51.56,0.02',
    );
    assert.equal(london.status, 200);
    const body = await london.json();
    assert.equal(body.count, 1);
    assert.deepEqual(requested, [
      'https://data.bus-data.dft.gov.uk/avl/download/gtfsrt',
      'https://download.bus-data.dft.gov.uk/avl/gtfsrt_1.zip',
    ]);
  } finally {
    service.close();
  }
});

test('gbfs directory systems map to the registry shape', () => {
  const systems = directorySystems([
    {
      id: 'gbfs-lyon',
      name: 'Vélo’v — Lyon',
      provider: 'JCDecaux',
      coverage: { bbox: [45.7, 4.8, 45.8, 4.9], countries: ['FR'] },
      access: {
        url: 'https://transport.data.gouv.fr/gbfs/lyon/station_status.json',
        related: {
          station_information:
            'https://transport.data.gouv.fr/gbfs/lyon/station_information.json',
        },
      },
      licence: {
        id: 'ODbL-1.0',
        url: 'https://opendatacommons.org/licenses/odbl/1.0/',
        attribution: 'JCDecaux',
      },
    },
    {
      id: 'no-info',
      coverage: { bbox: [0, 0, 1, 1] },
      access: { url: 'https://x.example/station_status.json' },
      licence: {},
    },
  ]);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].directory, true);
  assert.equal(
    systems[0].stationStatusUrl,
    'https://transport.data.gouv.fr/gbfs/lyon/station_status.json',
  );
  assert.ok(
    Number.isFinite(systems[0].centerLat) && systems[0].loadRadiusKm >= 10,
  );
});

test('find_data_sources answers from the directory; mobility tools fall back to it', async () => {
  const rows = [
    {
      id: 'bods-england',
      domain: 'transit.vehicles',
      name: 'BODS England',
      usable: true,
      status: 'verified',
    },
    {
      id: 'mdb-9',
      domain: 'transit.vehicles',
      name: 'Somewhere RT',
      usable: false,
      status: 'candidate',
    },
  ];
  const queries = [];
  const sources = {
    find: async (query) => {
      queries.push(query);
      return { generatedAt: 'g', sources: rows };
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      sources,
      transit: {
        getFeeds: async () => [],
        requestSnapshot: async () => ({ ok: false }),
      },
    },
  });
  const direct = await catalog.call('find_data_sources', {
    area: { lat: 51.5, lon: -0.12, radius_km: 10 },
    topic: 'transit',
  });
  assert.match(
    direct.summary,
    /1 can be shown in God's Eye View: BODS England \(transit\)/,
  );
  assert.match(direct.summary, /1 listed but not shown/);
  assert.equal(queries[0].domain, 'transit.vehicles');
  const transit = await catalog.call('get_transit_vehicles', {
    area: { lat: 51.5, lon: -0.12, radius_km: 10 },
  });
  assert.match(
    transit.summary,
    /^No supported transit feed covers .*Keyless sources covering/,
  );
  assert.equal(transit.data.other_sources.length, 2);
  assert.equal(
    referralSummary('Nowhere', []),
    'No keyless live source in the source directory covers Nowhere.',
  );
});
