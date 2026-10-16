import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  buildCellCard,
  buildSelectedFireCard,
  createFirmsHeatmapLayer,
} from './firmsHeatmap.js';
import { accentForSeverity, isMutedStatic } from './firmsLabels.js';
import { adaptFirmsRecords } from './firmsAdapt.js';

const NOW = Date.UTC(2026, 9, 15, 21, 0);

test('adapter keeps only known static-source values and the escalated flag', () => {
  const [solar, industrial, junk, plain] = adaptFirmsRecords([
    { lat: 36.52, lon: -114.76, staticSource: 'solar' },
    { lat: 36.36, lon: -114.91, staticSource: 'industrial', escalated: true },
    { lat: 1, lon: 1, staticSource: 'volcano', escalated: 'yes' },
    { lat: 2, lon: 2 },
  ]);
  assert.deepEqual(
    [solar.staticSource, solar.escalated, isMutedStatic(solar)],
    ['solar', false, true],
  );
  assert.deepEqual(
    [industrial.staticSource, industrial.escalated, isMutedStatic(industrial)],
    ['industrial', true, false],
    'escalated: a known site, but likely a real fire, so it stays visible',
  );
  assert.deepEqual([junk.staticSource, junk.escalated], [null, false]);
  assert.equal(isMutedStatic(plain), false);
});

const base = {
  index: 1,
  lat: 36.52,
  lon: -114.76,
  frp: 690.6,
  confidence: 0.3,
  brightness: 207,
  night: false,
  acqMs: NOW - 3_600_000,
  sensor: 'VIIRS',
  satellite: 'N21',
};

test('cards: a likely static source reads HEAT with its site line; escalated reads FIRE', () => {
  const glint = buildSelectedFireCard({ ...base, staticSource: 'solar', escalated: false }, NOW);
  assert.equal(glint.title, 'HEAT · 691 MW');
  assert.equal(glint.details[2], 'SOLAR FARM · likely sun glint');
  assert.equal(glint.accent, accentForSeverity('grey'));
  const kiln = buildSelectedFireCard({ ...base, staticSource: 'industrial', escalated: true }, NOW);
  assert.equal(kiln.title, 'FIRE · 691 MW');
  assert.equal(kiln.details[2], 'INDUSTRIAL SITE · unusually strong, may be a real fire');
  const plain = buildSelectedFireCard({ ...base, staticSource: null }, NOW);
  assert.equal(plain.details.length, 2, 'ordinary detections are unchanged');
  const onlyStatic = buildCellCard(
    { cell: { count: 24, staticCount: 24, maxFrp: 690, newestAcqMs: 0 }, position: {} },
    NOW,
  );
  assert.equal(onlyStatic.title, '24 AT SOLAR/INDUSTRIAL SITES');
  const mixed = buildCellCard(
    { cell: { count: 10, staticCount: 3, maxFrp: 90, newestAcqMs: 0 }, position: {} },
    NOW,
  );
  assert.equal(mixed.title, '7 FIRES', 'static sources are not counted as fires');
});

class MockEvent {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function recentRecord(over) {
  const at = new Date(Date.now() - 2 * 3_600_000);
  // Far side of the globe from the test camera: the layer skips label
  // projection there, so these tests exercise state without a real scene.
  return {
    lat: -30,
    lon: 82,
    frp: 10,
    confidence: 'n',
    brightness: 330,
    daynight: 'D',
    acqDate: at.toISOString().slice(0, 10),
    acqTime: at.toISOString().slice(11, 16).replace(':', ''),
    satellite: 'N21',
    instrument: 'VIIRS',
    ...over,
  };
}

// The layer listens on window; each test file runs in its own process.
globalThis.window ??= new EventTarget();

async function loadedLayer(t, payload) {
  const viewer = {
    dataSources: { add: (value) => value, remove() {} },
    camera: {
      moveEnd: new MockEvent(),
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 20_000_000),
      positionCartographic: { height: 20_000_000 },
      computeViewRectangle: () => undefined,
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new MockEvent(),
      primitives: { contains: () => false, add: (p) => p, remove() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
  };
  const layer = createFirmsHeatmapLayer({
    id: 'local-firms',
    name: 'Active Fires',
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
    feed: { getSnapshot: async () => payload },
  });
  layer.init(viewer);
  // Restoring a share link calls setParams before data or enable: accepted.
  assert.equal(layer.setParams({ hideStatic: false }), true);
  await layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  return layer;
}

test('layer: static sources shown grey by default, chip hides them, one rule for the assistant', async (t) => {
  const payload = {
    fetchedAt: Date.now(),
    maskAvailable: true,
    fires: [
      recentRecord({ frp: 691, staticSource: 'solar' }),
      recentRecord({ frp: 413, staticSource: 'solar' }),
      recentRecord({ frp: 900, staticSource: 'industrial' }),
      recentRecord({ frp: 300, staticSource: 'industrial', escalated: true }),
      recentRecord({ frp: 12 }),
    ],
  };
  const layer = await loadedLayer(t, payload);
  assert.deepEqual(layer.getParams(), { hideStatic: false });
  let stats = layer.getStats();
  assert.equal(stats.count, 5, 'drawn grey, not hidden');
  assert.equal(stats.hiddenStatic, undefined);
  assert.match(stats.countOf, /including 3 shown grey at known solar farms or industrial sites/);
  const [chip] = layer.getRowControls().chips;
  assert.equal(chip.label, 'SOLAR & INDUSTRIAL · 3');
  assert.equal(chip.active, true);
  assert.deepEqual(chip.params, { hideStatic: true });
  // The biggest "fire" is never a likely static source, whatever the chip shows.
  assert.equal(layer.getStrongestFire().frp, 300);
  assert.deepEqual(
    layer.getAnalystRecords().map((r) => r.frp),
    [300, 12],
  );

  assert.equal(layer.setParams({ hideStatic: true }), true);
  stats = layer.getStats();
  assert.equal(stats.count, 2, 'the escalated and the plain detection');
  assert.equal(stats.hiddenStatic, 3);
  assert.match(stats.countOf, /excluding 3 at known solar farms or industrial sites/);
  assert.equal(layer.getRowControls().chips[0].active, false);
  assert.equal(layer.getStrongestFire().frp, 300);
  assert.deepEqual(
    layer.getAnalystRecords().map((r) => r.frp),
    [300, 12],
    'the assistant follows one rule, not the chip',
  );
});

test('layer: no chip without a mask or without flagged detections', async (t) => {
  const noMask = await loadedLayer(t, {
    fetchedAt: Date.now(),
    maskAvailable: false,
    fires: [recentRecord({})],
  });
  assert.deepEqual(noMask.getRowControls(), { chips: [] });
  const clean = await loadedLayer(t, {
    fetchedAt: Date.now(),
    maskAvailable: true,
    fires: [recentRecord({})],
  });
  assert.deepEqual(clean.getRowControls(), { chips: [] });
});

test('layer: when every detection is a hidden static source the count is 0, nothing drawn', async (t) => {
  const layer = await loadedLayer(t, {
    fetchedAt: Date.now(),
    maskAvailable: true,
    fires: [recentRecord({ staticSource: 'solar' })],
  });
  assert.equal(layer.getStats().count, 1, 'shown grey by default');
  layer.setParams({ hideStatic: true });
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStrongestFire(), null);
  assert.equal(layer.getRowControls().chips.length, 1);
});
