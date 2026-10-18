import assert from 'node:assert/strict';
import test from 'node:test';

import { cctvOffPacks } from './catalog.js';

const withEnv = (t, values) => {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};
const names = () => cctvOffPacks().map((entry) => entry.pack);

test('opt-in packs are off until switched on, with what turns them on', (t) => {
  withEnv(t, { CCTV_NYC_ENABLED: undefined, ONTARIO_511_API_KEY: 'k' });
  const nyc = cctvOffPacks().find((entry) => entry.pack === 'NYC DOT');
  assert.match(nyc.enable, /CCTV_NYC_ENABLED=1/);
  assert.ok(nyc.region.south < 40.758 && nyc.region.north > 40.758);
  withEnv(t, { CCTV_NYC_ENABLED: '1' });
  assert.equal(names().includes('NYC DOT'), false);
});

test('Ontario 511 is off without its developer key', (t) => {
  withEnv(t, {
    ONTARIO_511_API_KEY: undefined,
    CCTV_ONTARIO_ENABLED: undefined,
  });
  const ontario = cctvOffPacks().find((entry) => entry.pack === 'Ontario 511');
  assert.match(ontario.enable, /ONTARIO_511_API_KEY/);
  withEnv(t, { ONTARIO_511_API_KEY: 'key' });
  assert.equal(names().includes('Ontario 511'), false);
});

test('a default-on pack switched off names the variable to remove', (t) => {
  withEnv(t, { CCTV_TFL_ENABLED: '0' });
  const tfl = cctvOffPacks().find((entry) =>
    entry.pack.startsWith('Transport for London'),
  );
  assert.match(tfl.enable, /CCTV_TFL_ENABLED is set to 0/);
  withEnv(t, { CCTV_TFL_ENABLED: undefined });
  assert.equal(
    names().some((name) => name.startsWith('Transport for London')),
    false,
  );
});
