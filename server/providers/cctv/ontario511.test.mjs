import assert from 'node:assert/strict';
import test from 'node:test';

import { loadOntarioSourcesFromOpenData } from './sources.js';

const ROW = {
  Id: '42',
  Latitude: 43.6532,
  Longitude: -79.3832,
  Location: 'Hwy 401 near Yonge St',
  Direction: 'Eastbound',
  Views: [
    {
      Status: 'Enabled',
      Url: 'https://511on.ca/map/Cctv/4201',
      Description: 'Eastbound',
    },
  ],
};

test('without ONTARIO_511_API_KEY the Ontario pack is skipped, logged once', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('no request without a key'),
  );
  assert.deepEqual(await loadOntarioSourcesFromOpenData({}, {}), []);
  assert.deepEqual(await loadOntarioSourcesFromOpenData({}, {}), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ONTARIO_511_API_KEY/);
});

test('with a key the camera list is requested with it and parsed', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([ROW]);
  });
  const cameras = await loadOntarioSourcesFromOpenData(
    { sourceRoot: '/ignored' },
    { ONTARIO_511_API_KEY: ' test-key ' },
  );
  const url = new URL(requested[0]);
  assert.equal(url.host, '511on.ca');
  assert.equal(url.searchParams.get('key'), 'test-key');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'on-42');
  assert.equal(cameras[0].url, 'https://511on.ca/map/Cctv/4201');
});

test('a rejected key is reported by status, never by the key itself', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ Message: 'Invalid Key' }, { status: 400 }),
  );
  const cameras = await loadOntarioSourcesFromOpenData(
    {},
    { ONTARIO_511_API_KEY: 'secret-key-value' },
  );
  assert.deepEqual(cameras, []);
  assert.match(warnings.join('\n'), /400/);
  assert.doesNotMatch(warnings.join('\n'), /secret-key-value/);
});
