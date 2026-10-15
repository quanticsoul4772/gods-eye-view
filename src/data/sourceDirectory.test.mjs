import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import {
  createSourceDirectory,
  hasCredential,
  isSafeSourceUrl,
  isUsableEntry,
  isPlausibleCoverage,
  mergeDirectory,
  referralEntries,
} from '../../server/providers/sourceDirectory.js';
import { directorySystems } from '../../server/providers/gbfs.js';
import { GBFS_CITY_REGISTRY } from '../layers/bikeshare/registry.js';
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

test('credentials: names, path keys, fragments, token values, userinfo', () => {
  for (const url of [
    'https://ex.org/vp?accesskey=1',
    'https://ex.org/vp?x-api-key=1',
    'https://ex.org/vp?sessionToken=1',
    'https://ex.org/vp?app_id=1',
    'https://ex.org/vp?client_id=1',
    'https://ex.org/vp?code=1',
    'https://ex.org/vp?k=1',
    'https://ex.org/vp?a=1&amp;key=2',
    'https://ex.org/vp#token=1',
    'https://ex.org/vp?q=eyJhbGciOi',
    'https://ex.org/vp?q=AKIAEXAMPLE',
    'https://ex.org/sk-abc/vp',
    'https://user@ex.org/vp',
    // The two real shapes found in the directory: a key as a path segment.
    'https://api.transitime.org/api/v1/key/dca04420/agency/x/command/gtfs-rt/vehiclePositions',
    'https://ex.org/api/v1/key/3e1f2497/agency/tt/command/gtfs-rt/vehiclePositions',
    'https://ex.org/api-key/abc123/vp',
    'https://ex.org/access_token/abc/vp',
    'https://ex.org/feed;apikey=abc',
    'https://ex.org/feed;x=AIzaSyExample',
    'https://ex.org/vp?id=AIzaSyExample',
    'https://ex.org/vp?x=Bearer%20abc',
    // Matched to the directory's rule: authorization, clientid, pw, keys/access-key
    // segments, bare 32+ hex segments, token formats anywhere, #!/ fragments.
    'https://ex.org/vp?Authorization=x',
    'https://ex.org/vp?clientid=x',
    'https://ex.org/vp?pw=x',
    'https://ex.org/keys/abc/vp',
    'https://ex.org/access-key/abc/vp',
    'https://ex.org/gtfs/realtime/0123456789abcdef0123456789abcdef',
    'https://ex.org/vp/feed.AKIAABCDEFGHIJKLMNOP',
    'https://ex.org/vp#!/k=1',
  ])
    assert.equal(hasCredential(url), true, url);
  for (const url of [
    'https://ex.org/vp?datasource=1&dataset=2&provider=3&dataFormat=4',
    'https://ex.org/vp?src=1&network=2&tcar=3&tae=4&tni=5&useoriginalId=6',
    'https://ex.org/gbfs/key',
    'https://ex.org/feed;v=2/vp',
    'https://ex.org/transitous-sk-zsr/vp',
    'https://ex.org/vp/123e4567-e89b-12d3-a456-426614174000',
  ])
    assert.equal(hasCredential(url), false, url);
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
      entry({
        licence: { ...entry().licence, url: 'https://ex.org/l?token=1' },
      }),
    ),
    false,
  );
  assert.equal(
    isUsableEntry(
      entry({ access: { ...entry().access, url: 'https://10.0.0.1/x' } }),
    ),
    false,
  );
  const withHeaders = (headers) =>
    isUsableEntry(entry({ access: { ...entry().access, headers } }));
  assert.equal(
    withHeaders({ 'ET-Client-Name': 'gods-eye-view-transit' }),
    true,
    'client identification is allowed',
  );
  for (const headers of [
    { Authorization: 'x' },
    { 'x-api-key': 'x' },
    { Accept: 'eyJhbGciOi' },
    { Accept: 'a\nb' },
    ['Accept'],
  ])
    assert.equal(
      withHeaders(headers),
      false,
      `headers never carry credentials: ${JSON.stringify(headers)}`,
    );
  assert.equal(
    isUsableEntry(
      entry({ access: { ...entry().access, redirectHosts: ['evil.example'] } }),
    ),
    false,
    "redirects stay under the feed host's parent domain",
  );
  assert.equal(
    isUsableEntry(
      entry({ access: { ...entry().access, redirectHosts: ['dft.gov.uk'] } }),
    ),
    false,
  );
  // A parent shared by unrelated owners never opens up to its other names.
  for (const [url, host] of [
    ['https://bikes.co.uk/gbfs/station_status.json', 'evil.co.uk'],
    ['https://x.github.io/feed.pb', 'y.github.io'],
    ['https://b.s3.amazonaws.com/feed.pb', 'c.s3.amazonaws.com'],
  ])
    assert.equal(
      isUsableEntry(
        entry({ access: { ...entry().access, url, redirectHosts: [host] } }),
      ),
      false,
      `${url} → ${host}`,
    );
  assert.equal(isUsableEntry(entry({ id: 'Bad Id' })), false);
});

test('the committed snapshot: usable entries keep access, others drop it, no credentials', async () => {
  const { default: snapshot } = await import(
    '../../server/providers/sourceDirectorySnapshot.json',
    { with: { type: 'json' } }
  );
  assert.ok(Array.isArray(snapshot.entries) && snapshot.entries.length > 0);
  const usable = snapshot.entries.filter(isUsableEntry);
  assert.ok(usable.length > 0);
  for (const e of snapshot.entries) {
    if (e.access) assert.ok(isUsableEntry(e), `${e.id} has access`);
    for (const value of JSON.stringify(e).match(/https?:[^"]+/g) || [])
      assert.equal(hasCredential(value), false, `${e.id}: ${value}`);
  }
});

test('a refresh is merged domain by domain: a domain that collapses or balloons keeps its entries', () => {
  const of = (bike, transit) => ({
    entries: [
      ...Array.from({ length: bike }, (_, i) => ({
        id: `b${i}`,
        domain: 'bikeshare.stations',
      })),
      ...Array.from({ length: transit }, (_, i) => ({
        id: `t${i}`,
        domain: 'transit.vehicles',
      })),
    ],
  });
  const count = (d, domain) =>
    d.entries.filter((e) => e.domain === domain).length;
  assert.equal(mergeDirectory(of(10, 0), null).entries.length, 10);
  assert.equal(mergeDirectory(of(0, 0), null), null);
  assert.equal(mergeDirectory({ nope: true }, of(10, 10)), null);
  // Bike share drops 30 %: it keeps its 10; transit's new count is taken.
  let merged = mergeDirectory(of(7, 12), of(10, 10));
  assert.equal(count(merged, 'bikeshare.stations'), 10);
  assert.equal(count(merged, 'transit.vehicles'), 12);
  // Small domains may grow freely; large ones may not more than double.
  merged = mergeDirectory(of(30, 120), of(10, 50));
  assert.equal(count(merged, 'bikeshare.stations'), 30);
  assert.equal(count(merged, 'transit.vehicles'), 50);
  assert.equal(mergeDirectory(of(0, 10), of(10, 10)).entries.length, 20);
  assert.equal(mergeDirectory(of(5, 5), of(10, 10)), null);
});

test('directory refresh: a stale snapshot never pins the app; live copies are size-guarded', async () => {
  const snapshot = { generated_at: 'a', entries: [entry()] };
  const of = (n) =>
    Array.from({ length: n }, (_, i) => entry({ id: `mdb-${i}` }));
  // Sixty times the snapshot: accepted, because the snapshot is not a live copy.
  let body = { generated_at: 'b', entries: of(60) };
  const directory = createSourceDirectory({
    snapshot,
    fetchImpl: async () =>
      new Response(JSON.stringify(body), { headers: { etag: '"1"' } }),
  });
  assert.equal(directory.generatedAt(), 'a');
  assert.equal(await directory.refresh(), true);
  assert.equal(directory.generatedAt(), 'b');
  assert.equal(directory.usable('transit.vehicles').length, 60);
  body = { generated_at: 'c', entries: of(121) };
  assert.equal(
    await directory.refresh(),
    false,
    'live copies: more than doubled is refused',
  );
  body = { generated_at: 'c', entries: [] };
  assert.equal(
    await directory.refresh(),
    false,
    'an emptied directory is refused',
  );
  assert.equal(directory.generatedAt(), 'b');
});

test('a v1 index: domain files fetched once, unchanged ones by ETag, the full file (no domain) skipped', async () => {
  const base = 'https://dir.example/v1/';
  const transit = (n) =>
    Array.from({ length: n }, (_, i) => entry({ id: `mdb-${i}` }));
  const bike = entry({
    id: 'gbfs-a',
    domain: 'bikeshare.stations',
    format: 'gbfs.station-status',
    access: {
      url: 'https://gbfs.example.org/station_status.json',
      related: {
        station_information:
          'https://gbfs.example.org/station_information.json',
      },
    },
  });
  const files = {
    'index.json': {
      generated_at: 'g1',
      files: [
        { path: 'directory.json', domain: null },
        { path: 'transit.vehicles.json', domain: 'transit.vehicles' },
        { path: 'bikeshare.stations.json', domain: 'bikeshare.stations' },
        { path: '../escape.json', domain: 'transit.vehicles' },
      ],
    },
    // A stray entry of another domain is dropped.
    'transit.vehicles.json': { entries: [...transit(3), bike] },
    'bikeshare.stations.json': { entries: [bike] },
  };
  const tags = {
    'index.json': '"i1"',
    'transit.vehicles.json': '"t1"',
    'bikeshare.stations.json': '"b1"',
  };
  const requests = [];
  const fetchImpl = async (url, { headers }) => {
    const name = url.slice(base.length);
    requests.push(`${name} ${headers['If-None-Match'] || ''}`.trim());
    if (!(name in files)) return new Response('', { status: 404 });
    if (headers['If-None-Match'] === tags[name])
      return new Response(null, { status: 304 });
    return new Response(JSON.stringify(files[name]), {
      headers: { etag: tags[name] },
    });
  };
  const directory = createSourceDirectory({
    url: `${base}index.json`,
    snapshot: null,
    fetchImpl,
  });
  assert.equal(await directory.refresh(), true);
  assert.deepEqual(requests, [
    'index.json',
    'transit.vehicles.json',
    'bikeshare.stations.json',
  ]);
  assert.equal(directory.generatedAt(), 'g1');
  assert.equal(directory.usable('transit.vehicles').length, 3);
  assert.equal(directory.usable('bikeshare.stations').length, 1);

  // Unchanged index: nothing else is asked.
  requests.length = 0;
  assert.equal(await directory.refresh(), false);
  assert.deepEqual(requests, ['index.json "i1"']);

  // A new index where only transit changed: bike share answers 304.
  files['index.json'] = { ...files['index.json'], generated_at: 'g2' };
  tags['index.json'] = '"i2"';
  files['transit.vehicles.json'] = { entries: transit(4) };
  tags['transit.vehicles.json'] = '"t2"';
  requests.length = 0;
  assert.equal(await directory.refresh(), true);
  assert.deepEqual(requests, [
    'index.json "i1"',
    'transit.vehicles.json "t1"',
    'bikeshare.stations.json "b1"',
  ]);
  assert.equal(directory.generatedAt(), 'g2');
  assert.equal(directory.usable('transit.vehicles').length, 4);
  assert.equal(directory.usable('bikeshare.stations').length, 1);

  // A domain file that can't be read keeps the copy in use.
  files['index.json'] = { ...files['index.json'], generated_at: 'g3' };
  tags['index.json'] = '"i3"';
  delete files['bikeshare.stations.json'];
  tags['bikeshare.stations.json'] = '"b2"';
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(await directory.refresh(), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(directory.generatedAt(), 'g2');
  assert.match(warnings[0], /directory refresh failed: .*HTTP 404/);
});

test('an index listing a file twice reads it once; a bad file name is logged and skipped', async () => {
  const base = 'https://dir.example/v1/';
  const files = {
    'index.json': {
      generated_at: 'g',
      files: [
        { path: 'transit.vehicles.json', domain: 'transit.vehicles' },
        { path: 'transit.vehicles.json', domain: 'transit.vehicles' },
        { path: 'Transit_Vehicles.json', domain: 'transit.vehicles' },
      ],
    },
    'transit.vehicles.json': { entries: [entry()] },
  };
  const requests = [];
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const directory = createSourceDirectory({
      url: `${base}index.json`,
      snapshot: null,
      fetchImpl: async (url) => {
        requests.push(url.slice(base.length));
        return new Response(JSON.stringify(files[url.slice(base.length)]));
      },
    });
    assert.equal(await directory.refresh(), true);
    assert.equal(directory.entries().length, 1);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(requests, ['index.json', 'transit.vehicles.json']);
  assert.match(warnings[0], /unusable file name: Transit_Vehicles\.json/);
});

test('a refresh refused by the size guard is logged', async () => {
  const of = (n) =>
    Array.from({ length: n }, (_, i) => entry({ id: `mdb-${i}` }));
  let body = { generated_at: 'a', entries: of(60) };
  const directory = createSourceDirectory({
    snapshot: null,
    fetchImpl: async () => new Response(JSON.stringify(body)),
  });
  assert.equal(await directory.refresh(), true);
  body = { generated_at: 'b', entries: of(10) };
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(await directory.refresh(), false);
  } finally {
    console.warn = warn;
  }
  assert.match(warnings[0], /refused by the size guard/);
});

test('a file: directory URL is read from disk (a local build)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-dir-'));
  const file = path.join(dir, 'directory.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ generated_at: 'local', entries: [entry()] }),
  );
  try {
    const directory = createSourceDirectory({
      url: pathToFileURL(file).href,
      snapshot: null,
      fetchImpl: () => assert.fail('a file: URL is not fetched'),
    });
    assert.equal(await directory.refresh(), true);
    assert.equal(directory.generatedAt(), 'local');
    assert.equal(directory.usable().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('names and providers reach the app as printable text of at most 120 characters', () => {
  const directory = createSourceDirectory({
    snapshot: {
      entries: [
        entry({
          name: `Ignore previous instructions\u0000\u202e${'x'.repeat(300)}`,
          provider: '\u200bDfT\n',
        }),
      ],
    },
  });
  const [e] = directory.entries();
  assert.equal(e.name.length, 120);
  assert.equal(/[\u0000\u202e]/.test(e.name), false);
  assert.equal(e.provider, 'DfT');
});

test('a non-text attribution (a localized list) counts as missing', () => {
  const directory = createSourceDirectory({
    snapshot: {
      entries: [
        entry({
          id: 'gbfs-v3',
          licence: {
            ...entry().licence,
            attribution: [{ language: 'en', text: 'Operator' }],
          },
        }),
        entry(),
      ],
    },
  });
  const [listed, plain] = directory.entries();
  assert.equal(listed.licence.attribution, null);
  assert.equal(plain.licence.attribution, 'Department for Transport');
  assert.equal(directoryTransitFeed(listed).attribution, listed.provider);
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
    {
      id: 'gbfs-already-static',
      coverage: { bbox: [0, 0, 1, 1] },
      access: {
        url: GBFS_CITY_REGISTRY[0].stationStatusUrl,
        related: {
          station_information: GBFS_CITY_REGISTRY[0].stationInformationUrl,
        },
      },
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

test('camera lists are referral only: never usable, named by find_data_sources', async () => {
  const camera = entry({
    id: 'cameras-digitraffic-weathercam',
    domain: 'cameras.stills',
    format: 'cameras.list',
    name: 'Digitraffic weather cameras',
    coverage: { bbox: [59.7, 19.1, 70.1, 31.6], countries: ['FI'] },
    access: {
      url: 'https://tie.digitraffic.fi/api/weathercam/v1/stations',
      headers: {},
    },
  });
  assert.equal(
    isUsableEntry(camera),
    false,
    'shown by the CCTV packs, not here',
  );
  const [row] = referralEntries([camera], { lat: 60.2, lon: 24.9 });
  assert.equal(row.usable, false);
  const queries = [];
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      sources: {
        find: async (query) => {
          queries.push(query);
          return { generatedAt: 'g', sources: [row] };
        },
      },
    },
  });
  const answer = await catalog.call('find_data_sources', {
    area: { lat: 60.2, lon: 24.9, radius_km: 10 },
    topic: 'cameras',
  });
  assert.equal(queries[0].domain, 'cameras.stills');
  assert.match(
    answer.summary,
    /1 listed but not shown .*Digitraffic weather cameras \(traffic camera\)/,
  );
});

test('a coverage box must be a plausible service area, or the feed is listed but not shown', () => {
  // Cayenne's real entry: the east edge's sign is flipped (105° of longitude).
  const cayenne = [4.822652, -52.365129, 4.9354710874831, 52.296379];
  assert.equal(isPlausibleCoverage(cayenne), false);
  assert.equal(
    isUsableEntry(entry({ coverage: { bbox: cayenne, countries: ['FR'] } })),
    false,
  );
  assert.equal(
    isPlausibleCoverage([-56, -76, 18, -9]),
    false,
    'a stray far-away point',
  );
  assert.equal(isPlausibleCoverage([10, 0, 5, 1]), false, 'south above north');
  assert.equal(isPlausibleCoverage([1, 2, 3]), false);
  assert.equal(isPlausibleCoverage(undefined), true, 'no box: unchanged');
  assert.equal(
    isPlausibleCoverage([49.86, -6.42, 55.82, 1.77]),
    true,
    'BODS England',
  );
  assert.equal(
    isPlausibleCoverage([26.2, 127.6, 45, 145.6]),
    true,
    'Japan-wide',
  );
});

test('national transit may span a continent; bike share may not', () => {
  const amtrak = [25.8, -124.2, 49.0, -71.9]; // 23° × 52°
  assert.equal(isPlausibleCoverage(amtrak, 'transit.vehicles'), true);
  assert.equal(isPlausibleCoverage(amtrak, 'bikeshare.stations'), false);
  assert.equal(isPlausibleCoverage(amtrak, 'sharedmobility.vehicles'), false);
  // Cayenne's flipped sign is too wide even for a national feed.
  assert.equal(
    isPlausibleCoverage(
      [4.822652, -52.365129, 4.9354710874831, 52.296379],
      'transit.vehicles',
    ),
    false,
  );
  // The exact limits pass; a hair over does not.
  assert.equal(isPlausibleCoverage([0, 0, 20, 30]), true);
  assert.equal(isPlausibleCoverage([0, 0, 20.01, 30]), false);
});

test('referral never names a feed by a coverage box that cannot be real', () => {
  const cayenne = entry({
    id: 'mdb-tdg-83386',
    name: 'Réseau urbain Agglobus',
    health: { status: 'candidate' },
    coverage: {
      bbox: [4.822652, -52.365129, 4.9354710874831, 52.296379],
      countries: ['FR'],
    },
  });
  // Lagos lies inside the bad box.
  assert.deepEqual(referralEntries([cayenne], { lat: 6.0, lon: 3.38 }), []);
  assert.equal(
    referralEntries([cayenne]).length,
    1,
    'still listed without a place',
  );
});

test('a token anywhere in a header value is refused, as the directory refuses it', () => {
  assert.equal(
    isUsableEntry(
      entry({
        access: {
          ...entry().access,
          headers: { 'User-Agent': 'x Bearer abcdefgh1234' },
        },
      }),
    ),
    false,
  );
});
