import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';

test('only the newest directory-systems load sets the failure flag', async () => {
  const pending = [];
  const state = {
    _cities: new Map(),
    _systemsLoadSeq: 0,
    _systemsLoadFailed: false,
    _systemsReady: false,
    _enabled: false,
  };
  const { loadDirectorySystems } = createLifecycle({
    state,
    services: { sprites: {}, picking: {} },
    parts: { viewport: { runProximityCheck: async () => {} } },
    source: {
      getSystems: () =>
        new Promise((resolve, reject) => pending.push({ resolve, reject })),
    },
  });
  // A disable/enable starts a second load while the first is still out.
  const first = loadDirectorySystems();
  const second = loadDirectorySystems();
  pending[1].resolve([]);
  await second;
  assert.equal(state._systemsLoadFailed, false);
  // The first load fails late: it must not mark the newer success failed.
  pending[0].reject(new Error('network'));
  await first;
  assert.equal(state._systemsLoadFailed, false);
  assert.equal(state._systemsReady, true);
});
