import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  annotateStaticSources,
  buildMaskIndex,
  countRecurringCells,
  recordUnflaggedDays,
  staticSourceOf,
  stripStaticSources,
} from '../../server/providers/firmsStaticMask.js';
import { firmsProxy } from '../../server/providers/firms.js';

const SOLAR = 0;
const INDUSTRIAL = 1;
// Moapa-like solar box, an industrial box, and a solar box wider than the
// 0.1° index grid (its interior cells must find it too).
const ROWS = [
  [SOLAR, -114.79, 36.5, -114.72, 36.56, 'moapa'],
  [INDUSTRIAL, -114.92, 36.35, -114.9, 36.37, 'apex'],
  [SOLAR, 71.8, 27.4, 72.2, 27.7, 'bhadla'],
  [SOLAR, 179.95, -16.6, -179.95, -16.5, 'dateline'],
];

test('mask index: boxes found in every cell they cover, antimeridian split, cells', () => {
  const index = buildMaskIndex(ROWS);
  assert.deepEqual(staticSourceOf(index, 36.52, -114.76, false), {
    kind: 'solar',
    siteId: 'moapa',
  });
  assert.equal(
    staticSourceOf(index, 36.52, -114.76, true),
    null,
    'no solar glint at night',
  );
  assert.deepEqual(staticSourceOf(index, 36.357, -114.91, true), {
    kind: 'industrial',
    siteId: 'apex',
  });
  assert.equal(
    staticSourceOf(index, 27.55, 72.05, false)?.siteId,
    'bhadla',
    'an interior grid cell of a box wider than 0.1°',
  );
  assert.equal(staticSourceOf(index, -16.55, 179.97, false)?.siteId, 'dateline');
  assert.equal(staticSourceOf(index, -16.55, -179.97, false)?.siteId, 'dateline');
  assert.equal(staticSourceOf(index, -16.55, 0, false), null);
  // Irregular sites ship as 0.01° cells keyed "<latIndex>:<lonIndex>".
  const cellIndex = buildMaskIndex([
    [SOLAR, `${Math.floor((10.005 + 90) / 0.01)}:${Math.floor((20.005 + 180) / 0.01)}`, 's'],
    [INDUSTRIAL, `${Math.floor((10.005 + 90) / 0.01)}:${Math.floor((20.005 + 180) / 0.01)}`, 'k'],
  ]);
  assert.deepEqual(staticSourceOf(cellIndex, 10.005, 20.005, false), {
    kind: 'industrial',
    siteId: 'k',
  }, 'industrial wins a shared cell');
  assert.equal(staticSourceOf(index, 0, 0, false), null);
  assert.equal(staticSourceOf(buildMaskIndex([]), 36.52, -114.76, false), null);
  assert.equal(buildMaskIndex([[2, 0, 0, 1, 1, 'x'], ['bad'], null]).size, 0);
});

const fire = (lat, lon, over = {}) => ({
  lat,
  lon,
  frp: 5,
  daynight: 'D',
  satellite: 'N21',
  acqDate: '2026-10-15',
  acqTime: '2027',
  ...over,
});

test('annotation: matches only; solar seen again 45 min later and strong industrial escalate', () => {
  const index = buildMaskIndex(ROWS);
  const glint = [fire(36.52, -114.76), fire(36.53, -114.75)];
  const elsewhere = fire(10, 10);
  const night = fire(36.52, -114.76, { daynight: 'N' });
  const kiln = fire(36.357, -114.91, { daynight: 'N', frp: 2 });
  const fires = [...glint, elsewhere, night, kiln];
  assert.deepEqual(annotateStaticSources(fires, index), {
    flagged: 3,
    escalated: 0,
  });
  assert.equal(glint[0].staticSource, 'solar');
  assert.equal(kiln.staticSource, 'industrial');
  assert.equal('staticSource' in elsewhere, false, 'no field on non-matches');
  assert.equal('staticSource' in night, false);
  assert.equal('escalated' in glint[0], false);

  // The same solar site again on a later pass: a real fire, not glint.
  const later = fire(36.52, -114.76, { acqTime: '2125' });
  stripStaticSources(fires);
  assert.equal('staticSource' in glint[0], false);
  assert.deepEqual(annotateStaticSources([...glint, later], index), {
    flagged: 3,
    escalated: 3,
  });

  // Industrial: an unusually strong detection, or many pixels in one pass.
  const strong = fire(36.357, -114.91, { frp: 400 });
  const pass = [1, 2, 3].map(() => fire(36.36, -114.91, { frp: 3 }));
  const rules = { industrialFrpMin: 300, industrialPassPixels: 3 };
  assert.deepEqual(annotateStaticSources([strong, ...pass], index, rules), {
    flagged: 4,
    escalated: 4,
  });
  const modis = fire(36.357, -114.91, { instrument: 'MODIS', satellite: 'T' });
  assert.deepEqual(annotateStaticSources([modis], index), {
    flagged: 0,
    escalated: 0,
  });
  assert.equal('staticSource' in modis, false, 'MODIS is never annotated');
  assert.deepEqual(annotateStaticSources([fire(36.357, -114.91)], null), {
    flagged: 0,
    escalated: 0,
  });
});

function install(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (route, h) => (handler = h) } });
  return async (url = '/') => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
}

// One hour ago, date and time from the same instant (between 00:00 and
// 01:00 UTC, "today" with the earlier hour would be in the future).
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const today = hourAgo.slice(0, 10);
const hhmm = hourAgo.slice(11, 16).replace(':', '');
const csv =
  'latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight\n' +
  `36.52,-114.76,340,${today},${hhmm},N21,n,80,D\n` +
  `10,10,330,${today},${hhmm},N21,n,4,D\n`;

function keylessSetup(t, disk = null) {
  t.mock.method(fsp, 'readFile', async () => {
    if (!disk) throw Error('no disk cache');
    return JSON.stringify(disk);
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
  const previous = process.env.FIRMS_MAP_KEY;
  delete process.env.FIRMS_MAP_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.FIRMS_MAP_KEY = previous;
  });
  const directory = {
    usable: (domain) =>
      domain === 'hazards.fires'
        ? [{ id: 'firms-viirs-noaa21-24h', access: { url: 'https://x.example/v.csv' } }]
        : [],
  };
  return { directory, directoryFetch: async () => new Response(csv) };
}

test('proxy: payloads carry annotations, counts unchanged, status reports the mask', async (t) => {
  const options = keylessSetup(t);
  const request = install(
    firmsProxy({
      ...options,
      staticMask: () => ({ id: 'mask-a', index: buildMaskIndex(ROWS), escalation: {} }),
    }),
  );
  const payload = (await request()).body;
  assert.equal(payload.count, 2, 'nothing removed');
  assert.equal(payload.maskAvailable, true);
  assert.deepEqual(
    payload.fires.map((f) => f.staticSource ?? null),
    ['solar', null],
  );
  const status = (await request('/status')).body;
  assert.equal(status.maskAvailable, true);
  assert.equal(status.staticFlagged, 1);
  assert.equal(status.staticEscalated, 0);
});

test('proxy: no mask means no annotation and maskAvailable false', async (t) => {
  const request = install(firmsProxy({ ...keylessSetup(t), staticMask: () => null }));
  const payload = (await request()).body;
  assert.equal(payload.maskAvailable, false);
  assert.ok(payload.fires.every((f) => !('staticSource' in f)));
  assert.equal((await request('/status')).body.maskAvailable, false);
});

test('proxy: a disk cache from another mask is re-annotated with the current one', async (t) => {
  const at = Date.now();
  const disk = {
    at,
    mode: 'keyless',
    maskId: 'old-mask',
    staticFlagged: 1,
    sources: [{ source: 'firms-viirs-noaa21-24h', count: 2, ok: true }],
    fires: [
      { lat: 10, lon: 10, daynight: 'D', acqDate: today, acqTime: hhmm, staticSource: 'industrial' },
      { lat: 36.52, lon: -114.76, daynight: 'D', acqDate: today, acqTime: hhmm },
    ],
  };
  const request = install(
    firmsProxy({
      ...keylessSetup(t, disk),
      staticMask: () => ({ id: 'mask-b', index: buildMaskIndex(ROWS), escalation: {} }),
    }),
  );
  const payload = (await request()).body;
  assert.deepEqual(
    payload.fires.map((f) => f.staticSource ?? null),
    [null, 'solar'],
    'the old flag is gone, the new mask applied',
  );
  assert.equal((await request('/status')).body.staticFlagged, 1);
});

test('recurrence: unflagged daytime VIIRS cells per day, 7 days kept, 3+ days counted', () => {
  const day = (date, over = {}) => fire(5, 5, { acqDate: date, ...over });
  let days = recordUnflaggedDays({}, [
    day('2026-10-01'),
    day('2026-10-01', { lat: 5.001 }), // same ~400 m cell
    day('2026-10-01', { daynight: 'N', lat: 30 }),
    day('2026-10-01', { staticSource: 'solar', lat: 31 }),
    day('2026-10-01', { instrument: 'MODIS', lat: 32 }),
  ]);
  assert.deepEqual(Object.keys(days), ['2026-10-01']);
  assert.equal(days['2026-10-01'].length, 1, 'night, flagged and MODIS left out');
  days = recordUnflaggedDays(days, [day('2026-10-03'), day('2026-10-03', { lat: -40 })]);
  assert.equal(countRecurringCells(days), 0, 'two days is not enough');
  days = recordUnflaggedDays(days, [day('2026-10-07')]);
  assert.equal(countRecurringCells(days), 1);
  days = recordUnflaggedDays(days, [day('2026-10-08', { lat: -40 })]);
  assert.deepEqual(
    Object.keys(days),
    ['2026-10-03', '2026-10-07', '2026-10-08'],
    'days older than 7 before the newest are dropped',
  );
  assert.equal(countRecurringCells(days), 0, 'the 10-01 detection aged out');
  assert.equal(countRecurringCells(days, 2), 2);
  assert.deepEqual(JSON.parse(JSON.stringify(days)), days, 'stored as JSON');
  assert.deepEqual(recordUnflaggedDays({}, [day('bad')]), {});
});

test('proxy: status counts recurring unflagged cells from the stored history', async (t) => {
  const stored = {
    maskId: 'mask-a',
    days: Object.fromEntries(
      ['2026-10-14', '2026-10-15'].map((date) => [
        date,
        recordUnflaggedDays({}, [fire(10, 10, { acqDate: date })])[date],
      ]),
    ),
  };
  const options = keylessSetup(t);
  const written = [];
  t.mock.method(fsp, 'readFile', async (file) => {
    if (String(file).endsWith('firms-recurrence.json')) return JSON.stringify(stored);
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'writeFile', async (file, text) => written.push([String(file), text]));
  const request = install(
    firmsProxy({
      ...options,
      staticMask: () => ({ id: 'mask-a', index: buildMaskIndex(ROWS), escalation: {} }),
    }),
  );
  let status = (await request('/status')).body;
  assert.equal(status.unflaggedRecurringDays, 2);
  assert.equal(status.unflaggedRecurring, 0);
  await request(); // today's refresh: the 10,10 detection is unflagged, Moapa is not
  status = (await request('/status')).body;
  assert.equal(status.unflaggedRecurringDays, 3);
  assert.equal(status.unflaggedRecurring, 1);
  const history = written.find(([file]) => file.endsWith('firms-recurrence.json'));
  assert.ok(history, 'the history is written next to the cache');
  assert.equal(JSON.parse(history[1]).maskId, 'mask-a');
});

test('proxy: a history from another mask is not counted and is replaced', async (t) => {
  const options = keylessSetup(t);
  t.mock.method(fsp, 'readFile', async (file) => {
    if (String(file).endsWith('firms-recurrence.json'))
      return JSON.stringify({ maskId: 'old', days: { '2026-10-14': [1], '2026-10-15': [1] } });
    throw Error('no disk cache');
  });
  const request = install(
    firmsProxy({
      ...options,
      staticMask: () => ({ id: 'mask-a', index: buildMaskIndex(ROWS), escalation: {} }),
    }),
  );
  let status = (await request('/status')).body;
  assert.equal(status.unflaggedRecurring, null);
  assert.equal(status.unflaggedRecurringDays, 0);
  await request();
  status = (await request('/status')).body;
  assert.equal(status.unflaggedRecurringDays, 1, 'started over under the current mask');
  assert.equal(status.unflaggedRecurring, 0);
});
