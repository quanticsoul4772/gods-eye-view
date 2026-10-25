import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';

/** Controls over a stub viewport: one docking system and one vehicle system. */
function coverageAt({ mode, center, altitude }) {
  const docks = new Map([['docks', { id: 'docks' }]]);
  const scooters = new Map([['scooters', { id: 'scooters' }]]);
  const state = {
    _mode: mode,
    _viewer: {},
    _systemsLoaded: Promise.resolve(),
    _vehicleSystems: scooters,
    _vehicleSystemsReady: true,
    _vehicleSystemsRetryAt: 0,
  };
  const inRange = {
    docks: center === 'docks',
    scooters: center === 'scooters',
  };
  const parts = {
    viewport: {
      getCameraAltitude: () => altitude,
      getCameraCenterLatLon: () => ({ lat: 1, lon: 2 }),
      shouldActivateAtAltitude: (height) => height < 100_000,
      computeInRangeCities: (_center, systems = docks) =>
        new Set([...systems.keys()].filter((id) => inRange[id])),
    },
  };
  const source = { listed: { requestSettled: async () => 3 } };
  const { methods } = createControls({ state, services: {}, parts, source });
  return methods.coverageHere();
}

test('bike-share coverage counts the shared vehicles its mode draws', async () => {
  // Scooters only, low enough for them to show: covered in Both and Vehicles.
  for (const mode of ['both', 'vehicles'])
    assert.deepEqual(
      await coverageAt({ mode, center: 'scooters', altitude: 5_000 }),
      {
        covered: true,
        listed: null,
        altitudeGateOpen: true,
        center: { lat: 1, lon: 2 },
      },
      mode,
    );
  // Stations mode draws no scooters: nothing it can show here.
  assert.deepEqual(
    await coverageAt({ mode: 'stations', center: 'scooters', altitude: 5_000 }),
    {
      covered: false,
      listed: 3,
      altitudeGateOpen: false,
      center: { lat: 1, lon: 2 },
    },
  );
  // Scooters show only below 14 km; docks from much higher.
  assert.equal(
    (await coverageAt({ mode: 'both', center: 'scooters', altitude: 50_000 }))
      .altitudeGateOpen,
    false,
  );
  assert.equal(
    (await coverageAt({ mode: 'both', center: 'docks', altitude: 50_000 }))
      .altitudeGateOpen,
    true,
  );
});
