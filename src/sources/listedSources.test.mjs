import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createListedSourceCounter,
  listedSourcesText,
} from './sourceDirectory.js';
import { sourceDirectoryProxy } from '../../server/providers/sourceDirectory.js';
import { createQueries } from '../layers/transit/queries.js';
import { createControls } from '../layers/bikeshare/controls.js';

const listed = (id, over = {}) => ({
  id,
  domain: 'transit.vehicles',
  name: id,
  provider: 'p',
  coverage: { bbox: [40, -80, 41, -79], countries: [] },
  access: null,
  format: 'gtfs-rt.vehicle-positions',
  licence: { id: null, url: null, display: false },
  health: { status: 'candidate' },
  ...over,
});

test('the directory route filters by usability and reports the total beyond its limit', () => {
  let handler;
  const plugin = sourceDirectoryProxy({
    start() {},
    close() {},
    generatedAt: () => 'g',
    entries: () => Array.from({ length: 30 }, (_, i) => listed(`e-${i}`)),
  });
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const get = (query) => {
    let body;
    handler(
      { url: `/?${query}` },
      { writeHead() {}, end: (text) => (body = JSON.parse(text)) },
    );
    return body;
  };
  const all = get('lat=40.5&lon=-79.5&limit=1');
  assert.equal(all.total, 30);
  assert.equal(all.sources.length, 1);
  assert.equal(get('lat=40.5&lon=-79.5&usable=false&limit=1').total, 30);
  assert.equal(get('lat=40.5&lon=-79.5&usable=true').total, 0);
  assert.equal(get('lat=10&lon=10').total, 0);
});

test('listed-source counts: one request per 0.5° cell, one in flight', async () => {
  const asked = [];
  let release;
  const counter = createListedSourceCounter({
    domain: 'transit.vehicles',
    directory: {
      find: (query) => {
        asked.push(query);
        return new Promise((resolve) => {
          release = () => resolve({ total: 3, sources: [] });
        });
      },
    },
  });
  assert.equal(counter.count(40.6, -79.6), null);
  const first = counter.request(40.6, -79.6);
  assert.equal(await counter.request(10, 10), false, 'one request at a time');
  release();
  assert.equal(await first, true);
  assert.deepEqual(asked, [
    {
      lat: 40.75,
      lon: -79.75,
      domain: 'transit.vehicles',
      usable: false,
      limit: 1,
    },
  ]);
  assert.equal(counter.count(40.9, -79.9), 3, 'same cell');
  assert.equal(await counter.request(40.9, -79.9), false, 'cached');
  assert.equal(counter.count(41.1, -79.9), null, 'next cell');
});

test('a failed count is asked again later', async () => {
  let fail = true;
  const counter = createListedSourceCounter({
    domain: 'bikeshare.stations',
    directory: {
      find: async () => {
        if (fail) throw new Error('offline');
        return { total: 2, sources: [] };
      },
    },
  });
  assert.equal(await counter.request(1, 1), false);
  assert.equal(counter.count(1, 1), null);
  fail = false;
  assert.equal(await counter.request(1, 1), true);
  assert.equal(counter.count(1, 1), 2);
});

test('listed-source status text', () => {
  assert.equal(listedSourcesText(null), '');
  assert.equal(listedSourcesText(0), '');
  assert.equal(listedSourcesText(1), ' · 1 listed source');
  assert.equal(listedSourcesText(4), ' · 4 listed sources');
});

const source = (count) => ({ listed: { count: () => count } });

test('transit status names listed sources where no feed covers the view', () => {
  const state = {
    _enabled: true,
    _activeFeeds: new Map(),
    _vehicles: new Map(),
    _lastUpdate: null,
    _altitudeGateOpen: true,
    _center: { lat: 40.5, lon: -79.5 },
  };
  const parts = { catalog: { feeds: () => [1, 2, 3] }, ingestion: {} };
  let stats = createQueries({
    state,
    parts,
    source: source(4),
  }).methods.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, 'No feed here yet · 4 listed sources');
  stats = createQueries({
    state,
    parts,
    source: source(null),
  }).methods.getStats();
  assert.equal(stats.statusMessage, 'No feed here yet · 3 regions available');
});

test('bike-share status names listed sources where no system is in range', () => {
  const state = {
    _count: 0,
    _lastUpdate: null,
    _loading: false,
    _error: null,
    _altitudeGateEnabled: true,
    _activeCityIds: new Set(),
    _center: { lat: 40.5, lon: -79.5 },
  };
  const getStats = (count) =>
    createControls({
      state,
      services: {},
      parts: {},
      source: source(count),
    }).methods.getStats();
  assert.equal(getStats(2).statusMessage, 'No system here · 2 listed sources');
  assert.equal(getStats(2).status, 'empty');
  assert.equal(getStats(null).statusMessage, 'No system here');
  state._activeCityIds.add('nyc');
  assert.equal(getStats(2).statusMessage, undefined);
});
