import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueries } from './queries.js';

/** coverageHere over a stub viewport at a view no static feed covers. */
function coverageWith({ catalogFailed, retryFixes = false }) {
  const state = {
    _catalogReady: true,
    _catalogFailed: catalogFailed,
    _activeFeeds: new Map(),
    _vehicles: new Map(),
  };
  const parts = {
    catalog: {
      load: async () => {
        if (retryFixes) state._catalogFailed = false;
        return false;
      },
      feeds: () => [],
    },
    viewport: {
      altitudeGateOpen: () => true,
      getCameraAltitude: () => 5_000,
      getCameraCenterLatLon: () => ({ lat: -54.8, lon: -68.3 }),
    },
  };
  const source = { listed: { requestSettled: async () => 0 } };
  return createQueries({ state, parts, source }).methods.coverageHere();
}

test('transit coverage is unchecked, not "no feed", when the feed list failed to load', async () => {
  await assert.rejects(
    coverageWith({ catalogFailed: true }),
    /could not be loaded/,
  );
  assert.equal((await coverageWith({ catalogFailed: false })).covered, false);
});

test('a failed transit feed list is asked for again on the next coverage check', async () => {
  const here = await coverageWith({ catalogFailed: true, retryFixes: true });
  assert.equal(here.covered, false, 'answered from the reloaded list');
});
