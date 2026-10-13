import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createTerrainMeshCache,
  terrainCacheLimitBytes,
  terrainMeshProxy,
} from '../../server/providers/terrainMesh.js';

const tempDir = (t) =>
  fs.mkdtemp(path.join(os.tmpdir(), 'gev-terrain-')).then((dir) => {
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  });
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);

test('the cache cap comes from GEV_TERRAIN_CACHE_MB, 256 MB by default', () => {
  assert.equal(terrainCacheLimitBytes({}), 256 * 1024 * 1024);
  assert.equal(terrainCacheLimitBytes({ GEV_TERRAIN_CACHE_MB: '64' }), 64 * 1024 * 1024);
  assert.equal(terrainCacheLimitBytes({ GEV_TERRAIN_CACHE_MB: '0' }), 0);
  assert.equal(terrainCacheLimitBytes({ GEV_TERRAIN_CACHE_MB: 'lots' }), 256 * 1024 * 1024);
});

test('past the cap the oldest tiles go first, down to 90 % of it', async (t) => {
  const dir = await tempDir(t);
  let clock = 1000;
  const cache = createTerrainMeshCache({ dir, maxBytes: 1000, now: () => clock });
  for (const key of ['a', 'b', 'c', 'd']) {
    clock += 10;
    await cache.put(key, bytes(300));
  }
  // 1,200 bytes > 1,000: drop oldest until ≤ 900.
  const stats = await cache.stats();
  assert.ok(stats.bytes <= 900, `${stats.bytes} bytes kept`);
  assert.equal(await cache.get('a'), null, 'oldest evicted');
  // Dropping one tile reached 900 bytes, so the newer three stay.
  for (const key of ['b', 'c', 'd']) assert.deepEqual(await cache.get(key), bytes(300), key);
  assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith('.bin')).length, stats.files);
});

test('a restarted server finds its cache, and an old tile is fetched again', async (t) => {
  const dir = await tempDir(t);
  let clock = Date.now();
  await createTerrainMeshCache({ dir, maxBytes: 10_000, now: () => clock }).put('k', bytes(10));
  const reopened = createTerrainMeshCache({ dir, maxBytes: 10_000, now: () => clock });
  assert.deepEqual(await reopened.get('k'), bytes(10));
  clock += 31 * 24 * 3600_000;
  assert.equal(await reopened.get('k'), null, 'older than 30 days');
  assert.equal((await reopened.stats()).files, 0);
});

test('a zero cap keeps nothing on disk', async (t) => {
  const dir = await tempDir(t);
  const cache = createTerrainMeshCache({ dir, maxBytes: 0 });
  await cache.put('k', bytes(10));
  assert.equal(await cache.get('k'), null);
});

/** Mount the proxy and return a request function. */
function mount(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_route, fn) => { handler = fn; } } });
  return async (url, headers = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { this.body = body; },
    };
    await handler({ url, headers }, res);
    return res;
  };
}

const upstreamResponse = (status, body = null, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(Object.entries(headers)),
  arrayBuffer: async () => (body ?? Buffer.alloc(0)),
});

test('a tile is fetched once, then served from disk', async (t) => {
  const dir = await tempDir(t);
  const urls = [];
  const proxy = terrainMeshProxy({
    cacheDir: dir,
    maxBytes: 1_000_000,
    fetchImpl: async (url) => { urls.push(url); return upstreamResponse(200, bytes(64)); },
  });
  const get = mount(proxy);
  const first = await get('/8/119/177.terrain');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], 'application/vnd.quantized-mesh');
  assert.equal(first.headers['x-terrain-cache'], 'miss');
  const second = await get('/8/119/177.terrain');
  assert.equal(second.headers['x-terrain-cache'], 'hit');
  assert.deepEqual(second.body, bytes(64));
  assert.deepEqual(urls, ['https://terrain.reearth.land/cesium-mesh/ellipsoid/8/119/177.terrain']);
});

test('requests for the same tile at once make one upstream request', async (t) => {
  const dir = await tempDir(t);
  let calls = 0;
  const get = mount(terrainMeshProxy({
    cacheDir: dir,
    maxBytes: 1_000_000,
    fetchImpl: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return upstreamResponse(200, bytes(8)); },
  }));
  const results = await Promise.all([1, 2, 3].map(() => get('/5/1/2.terrain')));
  assert.equal(calls, 1);
  for (const res of results) assert.equal(res.statusCode, 200);
});

test('a throttled tile passes the 429 and Retry-After through and is not cached', async (t) => {
  const dir = await tempDir(t);
  let status = 429;
  const get = mount(terrainMeshProxy({
    cacheDir: dir,
    maxBytes: 1_000_000,
    fetchImpl: async () => upstreamResponse(status, status === 200 ? bytes(8) : null, { 'retry-after': '3' }),
  }));
  const throttled = await get('/7/48/99.terrain');
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['retry-after'], '3');
  assert.equal(throttled.headers['cache-control'], 'no-store');
  status = 200;
  const later = await get('/7/48/99.terrain');
  assert.equal(later.statusCode, 200, 'the retry reaches the upstream again');
});

test('only layer.json and tile paths are proxied; layer.json is held in memory', async (t) => {
  const dir = await tempDir(t);
  const urls = [];
  const get = mount(terrainMeshProxy({
    cacheDir: dir,
    maxBytes: 1_000_000,
    fetchImpl: async (url) => { urls.push(url); return upstreamResponse(200, Buffer.from('{"tiles":["{z}/{x}/{y}.terrain"]}')); },
  }));
  for (const bad of ['/../secret', '/foo.json', '/8/1/x.terrain', '/https://evil.example/']) {
    assert.equal((await get(bad)).statusCode, 404, bad);
  }
  assert.equal(urls.length, 0, 'nothing invalid reaches the upstream');
  const layer = await get('/layer.json');
  assert.equal(layer.headers['content-type'], 'application/json');
  await get('/layer.json');
  assert.equal(urls.length, 1);
});
