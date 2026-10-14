#!/usr/bin/env node
/**
 * qa-bench.mjs — repeatable performance benchmark with a saved baseline.
 *
 * docs/PERFORMANCE.md records one Apple M5 capture whose scripts were never
 * committed. This is the runnable counterpart: the same scenario families
 * (startup, idle, motion, cold layer activation, detection density, visual
 * styles, a combined stress scene), measured the same way every run, written
 * as JSON, and compared against a saved baseline.
 *
 * Every window records, from inside the page and from Chrome's DevTools
 * protocol:
 *   fps (rAF), Cesium ticks and renders per second, frame-time p50/p95/max,
 *   long tasks (count, total ms), main-thread script ms/s and task ms/s,
 *   JS heap MiB.
 * Layers also record activation time (enable resolved, first data), the live
 * object count, heap after GC while on, and heap retained after turning the
 * layer off again (a leak signal). Startup runs cold (cache disabled, fresh
 * browser context) three times and records network bytes and requests.
 *
 * Run it against the production build (npm run build, then vite preview):
 * the dev server serves ~1,300 unbundled modules plus live-reload code, so its
 * startup, network and heap numbers measure Vite, not the app. Every result
 * records which it measured (conditions.server: 'build' | 'dev').
 *
 * Keyless sources only, so anyone can run it. Live feeds change, so object
 * counts are recorded with every number; compare like with like.
 *
 * Usage:
 *   npm run build && npx vite preview --port 4180 --strictPort   (another shell)
 *   QA_BASE_URL=http://localhost:4180 node scripts/qa-bench.mjs   all scenarios, real GPU
 *   node scripts/qa-bench.mjs --only startup,layers   a subset
 *   node scripts/qa-bench.mjs --save-baseline arc-win11
 *   node scripts/qa-bench.mjs --compare bench/baselines/arc-win11.json
 *   node scripts/qa-bench.mjs --only layers --layers cctv,radio   chosen layers
 *   node scripts/qa-bench.mjs --only leaks            3 on/off cycles per layer; growth > 3 MiB fails
 *   node scripts/qa-bench.mjs --reps 3                3 windows per sample (median; default 2)
 *   node scripts/qa-bench.mjs --profile               also save .cpuprofile per window
 *   node scripts/qa-bench.mjs --uncapped              frames not tied to the display (noisier; see below)
 *   node scripts/qa-bench.mjs --allow-software        permit SwiftShader (numbers are relative only)
 *
 * Output: qa-shots/bench/<stamp>/results.json and report.md (gitignored).
 * Baselines: bench/baselines/<name>.json (committed).
 * Exit code 1 when --compare finds a regression beyond the thresholds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blankPageRafRate,
  launchProbeBrowser,
  UNCAPPED_FRAME_ARGS,
  webglRenderer,
} from './qa-renderProbe.mjs';

const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const argv = process.argv.slice(2);
const opt = (flag, fallback = null) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const PROFILE = argv.includes('--profile');
const ALLOW_SOFTWARE = argv.includes('--allow-software');
const SAVE_BASELINE = opt('--save-baseline');
const COMPARE = opt('--compare');
const STARTUP_SAMPLES = Number(opt('--startup-samples', '3'));
const WINDOW_MS = Number(opt('--window-ms', '5000'));
/** Measured windows per rest/motion sample; each metric is their median. */
const REPS = Number(opt('--reps', '2'));

/** Austin from 60 km, looking straight down: the harnesses' shared park spot. */
const PARK = { lat: 30.27, lon: -97.74, height: 60_000, pitch: -90 };
const LAYER_FILTER = (opt('--layers', '') || '').split(',').filter(Boolean);
const ALL_LAYERS = [
  'flights',
  'military',
  'satellites',
  'earthquakes',
  'transit',
  'bikeshare',
  'radio',
  'cctv',
  'local-datacenters',
  'telegeography-submarine-cables',
  'local-dams',
  'weather-radar',
  'rocket-launches',
];
const LAYERS = LAYER_FILTER.length ? LAYER_FILTER : ALL_LAYERS;
const STYLES = [
  'normal',
  'retro',
  'surveillance',
  'thermal',
  'anime',
  'noir',
  'snow',
];
const DETECTION = [25, 50, 100];
const COMBINED = [
  'flights',
  'military',
  'satellites',
  'telegeography-submarine-cables',
  'local-datacenters',
];

/**
 * Regression thresholds for --compare (relative to the baseline), set from two
 * identical runs on the Arc baseline machine (2026-10-13):
 * - heap, retained heap, startup timings and bytes repeated within ~5 %;
 * - fps of the heavy scenes (flights ~12k, cables, CCTV, combined) within
 *   ~15-25 %;
 * - fps of mid-weight scenes was bimodal (datacenters 30 vs 59, satellites 34
 *   vs 59): one run cannot judge them, so a flag there needs a second run;
 * - layer activation swung 2-4x with the network (CCTV 4.3-15.5 s), so it is
 *   reported, not gated, until layers have recorded fixtures.
 */
const THRESHOLDS = {
  fps: -0.25,
  frameP95Ms: 0.5,
  heapMiB: 0.1,
  heapDeltaMiB: 0.1,
  retainedMiB: 0.15,
  appReadyMs: 0.15,
  tilesLoadedMs: 0.2,
  settledMs: 0.15,
  networkMiB: 0.1,
};

/** Heap growth between on/off cycle 1 and 3 that counts as a leak (MiB). */
const LEAK_GROWTH_LIMIT_MIB = 3;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('qa-shots', 'bench', stamp);
fs.mkdirSync(outDir, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const want = (name) => !ONLY.length || ONLY.includes(name);
const round = (value, digits = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ── page helpers ────────────────────────────────────────────────────────────

async function openApp(browser, { cacheDisabled = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    window.__benchLongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__benchLongTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* longtask unsupported: counts stay 0 */
    }
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  if (cacheDisabled) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  }
  return { page, cdp };
}

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function heapAfterGcMiB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await cdpMetrics(cdp);
  return round(m.JSHeapUsedSize / 2 ** 20);
}

function park(page, at = PARK) {
  return page.evaluate((s) => {
    const v = window.__godsEyeView.viewer;
    v.trackedEntity = undefined;
    v.camera.cancelFlight();
    const rad = Math.PI / 180;
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: s.lon * rad,
        latitude: s.lat * rad,
        height: s.height,
      }),
      orientation: { heading: 0, pitch: s.pitch * rad, roll: 0 },
    });
  }, at);
}

function waitTiles(page, timeout) {
  return page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      {
        timeout,
        polling: 200,
      },
    )
    .then(
      () => true,
      () => false,
    );
}

/**
 * One measurement window. `motion` turns the camera a little every Cesium
 * tick, the way qa-perf's moving-camera check does.
 */
async function measureWindow(
  page,
  cdp,
  label,
  { motion = false, ms = WINDOW_MS } = {},
) {
  if (PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const before = await cdpMetrics(cdp);
  const inPage = await page.evaluate(
    (ms, motion) =>
      new Promise((resolve) => {
        const v = window.__godsEyeView.viewer;
        const scene = v.scene;
        const longStart = window.__benchLongTasks.length;
        let renders = 0;
        let ticks = 0;
        const deltas = [];
        const removeRender = scene.postRender.addEventListener(() => {
          renders += 1;
        });
        const removeTick = scene.preUpdate.addEventListener(() => {
          ticks += 1;
          if (motion) v.camera.rotateRight(0.002);
        });
        if (motion) scene.requestRender();
        const t0 = performance.now();
        let last = t0;
        const frame = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(frame);
          else {
            removeRender();
            removeTick();
            const elapsed = (performance.now() - t0) / 1000;
            const long = window.__benchLongTasks.slice(longStart);
            const sorted = deltas.slice(1).sort((a, b) => a - b);
            const pct = (p) =>
              sorted.length
                ? sorted[
                    Math.min(sorted.length - 1, Math.floor(p * sorted.length))
                  ]
                : null;
            resolve({
              elapsed,
              fps: deltas.length / elapsed,
              ticksPerSec: ticks / elapsed,
              rendersPerSec: renders / elapsed,
              frameP50Ms: pct(0.5),
              frameP95Ms: pct(0.95),
              frameMaxMs: sorted.at(-1) ?? null,
              longTasks: long.length,
              longTaskMs: long.reduce((a, b) => a + b, 0),
            });
          }
        };
        requestAnimationFrame(frame);
      }),
    ms,
    motion,
  );
  const after = await cdpMetrics(cdp);
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    fs.writeFileSync(
      path.join(outDir, `${label.replace(/[^\w.-]+/g, '_')}.cpuprofile`),
      JSON.stringify(profile),
    );
  }
  const secs = inPage.elapsed;
  return {
    // Cesium render-loop ticks per second (the app caps them at 60). Headless
    // rAF is not tied to a 60 Hz display (it read 84/s at idle), so it is kept
    // only as rafFps.
    fps: round(inPage.ticksPerSec),
    rafFps: round(inPage.fps),
    ticksPerSec: round(inPage.ticksPerSec),
    rendersPerSec: round(inPage.rendersPerSec),
    frameP50Ms: round(inPage.frameP50Ms),
    frameP95Ms: round(inPage.frameP95Ms),
    frameMaxMs: round(inPage.frameMaxMs),
    longTasks: inPage.longTasks,
    longTaskMs: round(inPage.longTaskMs, 0),
    scriptMsPerSec: round(
      ((after.ScriptDuration - before.ScriptDuration) * 1000) / secs,
    ),
    taskMsPerSec: round(
      ((after.TaskDuration - before.TaskDuration) * 1000) / secs,
    ),
    heapMiB: round(after.JSHeapUsedSize / 2 ** 20),
  };
}

/**
 * Warm up (an unmeasured camera turn, then tiles), then REPS rest windows and
 * REPS motion windows, each metric the median of its windows. Without the
 * warm-up the first scene measured after a camera move ran at half speed
 * while its tiles and shaders loaded.
 */
async function restAndMotion(page, cdp, label) {
  await measureWindow(page, cdp, `${label}-warmup`, { motion: true, ms: 3000 });
  await waitTiles(page, 20_000);
  await pause(1500);
  const windows = async (motion) => {
    const runs = [];
    for (let i = 0; i < REPS; i += 1)
      runs.push(
        await measureWindow(
          page,
          cdp,
          `${label}-${motion ? 'motion' : 'rest'}-${i}`,
          { motion },
        ),
      );
    return Object.fromEntries(
      Object.keys(runs[0]).map((k) => [
        k,
        round(median(runs.map((r) => r[k]))),
      ]),
    );
  };
  return { rest: await windows(false), motion: await windows(true) };
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function startupSample(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  let bytes = 0;
  let requests = 0;
  cdp.on('Network.loadingFinished', (e) => {
    bytes += e.encodedDataLength || 0;
    requests += 1;
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180_000,
    polling: 50,
  });
  const appReadyMs = await page.evaluate(() => performance.now());
  await waitTiles(page, 60_000);
  const tilesMs = await page.evaluate(() => performance.now());
  // Settled: the first full second with no renders after tiles loaded.
  let settledMs = null;
  for (let i = 0; i < 30 && settledMs === null; i += 1) {
    const quiet = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const scene = window.__godsEyeView.viewer.scene;
          let renders = 0;
          const remove = scene.postRender.addEventListener(() => {
            renders += 1;
          });
          setTimeout(() => {
            remove();
            resolve(renders === 0 ? performance.now() - 1000 : null);
          }, 1000);
        }),
    );
    if (quiet !== null) settledMs = quiet;
  }
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { dcl: n?.domContentLoadedEventEnd, load: n?.loadEventEnd };
  });
  const heapMiB = await heapAfterGcMiB(cdp);
  const m = await cdpMetrics(cdp);
  await context.close();
  return {
    domContentLoadedMs: round(nav.dcl, 0),
    loadEventMs: round(nav.load, 0),
    appReadyMs: round(appReadyMs, 0),
    tilesLoadedMs: round(tilesMs, 0),
    settledMs: round(settledMs, 0),
    scriptMs: round(m.ScriptDuration * 1000, 0),
    heapMiB,
    networkMiB: round(bytes / 2 ** 20, 2),
    requests,
  };
}

async function layerScenario(page, cdp, layerId) {
  const heapBefore = await heapAfterGcMiB(cdp);
  const timing = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    const t0 = performance.now();
    let error = null;
    try {
      await dm.setEnabled(id, true, { origin: 'user' });
    } catch (e) {
      error = String(e?.message || e);
    }
    const enabledMs = performance.now() - t0;
    const count = () => dm.getAll().find((l) => l.id === id)?.stats?.count || 0;
    let firstDataMs = null;
    const deadline = t0 + 60_000;
    while (performance.now() < deadline) {
      if (count() > 0) {
        firstDataMs = performance.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const layer = dm.getAll().find((l) => l.id === id);
    return {
      enabledMs,
      firstDataMs,
      count: count(),
      enabled: Boolean(layer?.enabled),
      feedState: layer?.stats?.feedState ?? null,
      error,
    };
  }, layerId);
  await waitTiles(page, 20_000);
  const windows = await restAndMotion(page, cdp, `layer-${layerId}`);
  // Detection is on by default and labels every layer's objects, so the
  // layer's own cost is the detection-off window; the default-state windows
  // above are what a new user sees.
  await setDetection(page, null);
  await pause(1500);
  const motionDetectionOff = await measureWindow(
    page,
    cdp,
    `layer-${layerId}-motion-detoff`,
    {
      motion: true,
    },
  );
  const heapOnMiB = await heapAfterGcMiB(cdp);
  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, false, {
        origin: 'user',
      }),
    layerId,
  );
  await pause(2000);
  const heapOffMiB = await heapAfterGcMiB(cdp);
  return {
    activationMs: round(timing.enabledMs, 0),
    firstDataMs: round(timing.firstDataMs, 0),
    count: timing.count,
    enabled: timing.enabled,
    error: timing.error,
    heapOnMiB,
    heapDeltaMiB: round(heapOnMiB - heapBefore),
    retainedMiB: round(heapOffMiB - heapBefore),
    ...windows,
    motionDetectionOff,
  };
}

/** Detection on at a density, or off with null. */
async function setDetection(page, densityPct) {
  await page.evaluate(
    (d) =>
      window.__godsEyeView.voiceCommands.runner(
        'set_detection',
        d === null ? { enabled: false } : { enabled: true, densityPct: d },
      ),
    densityPct,
  );
}

async function enableLayers(page, ids) {
  return page.evaluate(async (ids) => {
    const dm = window.__godsEyeView.dataManager;
    for (const id of ids) await dm.setEnabled(id, true, { origin: 'user' });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      if (
        ids.every(
          (id) => (dm.getAll().find((l) => l.id === id)?.stats?.count || 0) > 0,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return Object.fromEntries(
      ids.map((id) => [
        id,
        dm.getAll().find((l) => l.id === id)?.stats?.count || 0,
      ]),
    );
  }, ids);
}

// ── compare ─────────────────────────────────────────────────────────────────

/** Flatten numeric leaves to "a.b.c" keys. */
function flatten(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value))
      flatten(value, name, out);
    else if (typeof value === 'number') out[name] = value;
  }
  return out;
}

function compare(current, baseline) {
  const now = flatten(current.scenarios);
  const then = flatten(baseline.scenarios);
  const rows = [];
  for (const [key, value] of Object.entries(now)) {
    const was = then[key];
    if (!Number.isFinite(was) || was === 0) continue;
    const metric = key.split('.').at(-1);
    const limit = THRESHOLDS[metric];
    if (limit === undefined) continue;
    const change = (value - was) / Math.abs(was);
    const regressed = limit < 0 ? change < limit : change > limit;
    rows.push({ key, was, now: value, change: round(change * 100), regressed });
  }
  return rows;
}

// ── run ─────────────────────────────────────────────────────────────────────

// Frames follow the display's vsync, as in a real browser. With the display
// asleep the compositor paces headless Chrome at ~10 Hz (a whole run read
// 7-9 fps), so a blank-page check refuses to measure then. --uncapped frees
// the clock from the display (UNCAPPED_FRAME_ARGS) for a machine whose display
// cannot stay awake, but it also lets light scenes run rAF at 100-300/s,
// which made fps noisy between runs; vsync is the default.
const UNCAPPED = argv.includes('--uncapped');
const browser = await launchProbeBrowser({ gpu: true, uncapped: UNCAPPED });
const MIN_FRAME_CLOCK = UNCAPPED ? 50 : 55;
// A busy moment (a build just finished, a server starting) dips the clock for
// a few seconds, so measure up to three times before refusing.
let frameClock = await blankPageRafRate(browser);
for (let i = 0; i < 2 && frameClock < MIN_FRAME_CLOCK; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  frameClock = await blankPageRafRate(browser);
}
// Memory and startup do not depend on the frame clock; only frame-rate
// scenarios need it.
const FRAME_RATE_SCENARIOS = [
  'idle',
  'layers',
  'detection',
  'styles',
  'combined',
];
const needsFrameClock = FRAME_RATE_SCENARIOS.some((name) => want(name));
if (needsFrameClock && frameClock < MIN_FRAME_CLOCK) {
  await browser.close();
  console.error(
    `The frame clock runs at ${frameClock.toFixed(1)}/s on a blank page (need ≥ ${MIN_FRAME_CLOCK}). Wake the display (a sleeping display throttles frames), close GPU-heavy apps, and run again. Not measuring.`,
  );
  process.exit(2);
}
const results = {
  label: SAVE_BASELINE || stamp,
  capturedAt: new Date().toISOString(),
  machine: {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGiB: round(os.totalmem() / 2 ** 30),
    node: process.version,
    chrome: await browser.version(),
  },
  conditions: {
    viewport: '1440x900@1',
    windowMs: WINDOW_MS,
    reps: REPS,
    isolation: 'fresh page per scenario',
    frameClock: `${UNCAPPED ? `uncapped (${UNCAPPED_FRAME_ARGS.join(' ')})` : 'display vsync'}, blank page ${frameClock.toFixed(0)} rAF/s`,
    park: PARK,
    appUrl: APP_URL,
  },
  scenarios: {},
};

try {
  if (want('startup')) {
    const samples = [];
    for (let i = 0; i < STARTUP_SAMPLES; i += 1) {
      samples.push(await startupSample(browser));
      console.log(
        `startup ${i + 1}/${STARTUP_SAMPLES}`,
        JSON.stringify(samples.at(-1)),
      );
    }
    const keys = Object.keys(samples[0]);
    results.scenarios.startup = {
      median: Object.fromEntries(
        keys.map((k) => [k, median(samples.map((s) => s[k]))]),
      ),
      samples,
    };
  }

  // Every scenario runs on a fresh page: a layer that keeps memory or work
  // after it is turned off must not slow the next measurement (it did, in the
  // first single-page baseline: styles measured at 22 fps instead of 55).
  const fresh = async () => {
    const app = await openApp(browser);
    await app.page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await app.page.waitForFunction(
      () =>
        window.__godsEyeView?.viewer &&
        window.__godsEyeView.voiceCommands?.runner,
      { timeout: 180_000 },
    );
    await pause(4000);
    await park(app.page);
    await waitTiles(app.page, 30_000);
    return app;
  };

  {
    const { page } = await fresh();
    results.conditions.server = await page.evaluate(() =>
      document.querySelector('script[src*="/@vite/client"]') ? 'dev' : 'build',
    );
    const renderer = await webglRenderer(page);
    results.machine.gpu = renderer;
    results.conditions.detectionDefault = await page.evaluate(
      () =>
        window.__godsEyeView.styleManager.getControlState?.()?.detection ??
        null,
    );
    await page.close();
    if (
      /swiftshader|llvmpipe|software/i.test(renderer || '') &&
      !ALLOW_SOFTWARE
    ) {
      throw new Error(
        `Software renderer (${renderer}); pass --allow-software for relative numbers only`,
      );
    }
    console.log(`GPU: ${renderer}  server: ${results.conditions.server}`);
  }

  if (want('idle')) {
    const { page, cdp } = await fresh();
    await setDetection(page, null);
    await pause(16_000); // past one HUD summary refresh (qa-renderProbe settle note)
    results.scenarios.idle = {
      ...(await restAndMotion(page, cdp, 'idle')),
      heapMiB: await heapAfterGcMiB(cdp),
    };
    await page.close();
    console.log('idle', JSON.stringify(results.scenarios.idle));
  }

  if (want('layers')) {
    results.scenarios.layers = {};
    for (const id of LAYERS) {
      const { page, cdp } = await fresh();
      results.scenarios.layers[id] = await layerScenario(page, cdp, id);
      await page.close();
      const r = results.scenarios.layers[id];
      console.log(
        `layer ${id.padEnd(32)} on ${r.activationMs} ms, data ${r.firstDataMs} ms, n=${r.count}, rest ${r.rest.fps} fps / motion ${r.motion.fps} fps (detection off ${r.motionDetectionOff.fps}), heap +${r.heapDeltaMiB} MiB, kept ${r.retainedMiB} MiB`,
      );
    }
  }

  if (want('leaks')) {
    // Three on/off cycles per layer. Several layers keep a bounded cache when
    // off (CCTV's catalog, Radio's stations), which is by design; growth from
    // cycle 1 to cycle 3 is what a leak looks like, and it is gated absolutely
    // (LEAK_GROWTH_LIMIT_MIB) whatever the baseline says.
    results.scenarios.leaks = {};
    for (const id of LAYERS) {
      const { page, cdp } = await fresh();
      const base = await heapAfterGcMiB(cdp);
      const kept = [];
      for (let i = 0; i < 3; i += 1) {
        await page.evaluate(async (id) => {
          const dm = window.__godsEyeView.dataManager;
          await dm.setEnabled(id, true, { origin: 'user' });
          const t0 = performance.now();
          while (
            performance.now() - t0 < 45_000 &&
            !((dm.getAll().find((l) => l.id === id)?.stats?.count || 0) > 0)
          )
            await new Promise((r) => setTimeout(r, 200));
          await new Promise((r) => setTimeout(r, 4000));
          await dm.setEnabled(id, false, { origin: 'user' });
        }, id);
        await pause(4000);
        kept.push(round((await heapAfterGcMiB(cdp)) - base));
      }
      await page.close();
      results.scenarios.leaks[id] = {
        keptAfter1MiB: kept[0],
        keptAfter3MiB: kept[2],
        growthMiB: round(kept[2] - kept[0]),
      };
      console.log(
        `leaks ${id.padEnd(32)} kept ${kept.join(' / ')} MiB after cycles 1/2/3, growth ${results.scenarios.leaks[id].growthMiB}`,
      );
    }
  }

  if (want('detection')) {
    const { page, cdp } = await fresh();
    const counts = await enableLayers(page, ['flights']);
    results.scenarios.detection = { counts };
    for (const d of [null, ...DETECTION]) {
      await setDetection(page, d);
      const key = d === null ? 'off' : `d${d}`;
      results.scenarios.detection[key] = await restAndMotion(
        page,
        cdp,
        `detection-${key}`,
      );
      console.log(
        `detection ${key}`,
        JSON.stringify(results.scenarios.detection[key].motion),
      );
    }
    await page.close();
  }

  if (want('styles')) {
    results.scenarios.styles = {};
    for (const style of STYLES) {
      const { page, cdp } = await fresh();
      await page.evaluate(
        (s) =>
          window.__godsEyeView.voiceCommands.runner('set_visual_style', {
            style: s,
          }),
        style,
      );
      results.scenarios.styles[style] = await restAndMotion(
        page,
        cdp,
        `style-${style}`,
      );
      await page.close();
      console.log(
        `style ${style}`,
        JSON.stringify(results.scenarios.styles[style].motion),
      );
    }
  }

  if (want('combined')) {
    const { page, cdp } = await fresh();
    const counts = await enableLayers(page, COMBINED);
    await setDetection(page, 100);
    results.scenarios.combined = {
      counts,
      ...(await restAndMotion(page, cdp, 'combined')),
      heapMiB: await heapAfterGcMiB(cdp),
    };
    await page.close();
    console.log('combined', JSON.stringify(results.scenarios.combined.motion));
  }
} finally {
  await browser.close();
}

if (fs.existsSync('dist/assets')) {
  const files = fs.readdirSync('dist/assets').map((f) => ({
    f,
    bytes: fs.statSync(path.join('dist/assets', f)).size,
  }));
  const sum = (re) =>
    files.filter((x) => re.test(x.f)).reduce((a, x) => a + x.bytes, 0);
  results.bundle = {
    jsMiB: round(sum(/\.js$/) / 2 ** 20, 2),
    cssKiB: round(sum(/\.css$/) / 1024, 0),
    largestJs: files
      .filter((x) => x.f.endsWith('.js'))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .map((x) => `${x.f} ${round(x.bytes / 2 ** 20, 2)} MiB`),
  };
}

fs.writeFileSync(
  path.join(outDir, 'results.json'),
  JSON.stringify(results, null, 2),
);
let regressions = [];
for (const [id, leak] of Object.entries(results.scenarios.leaks || {}))
  if (leak.growthMiB > LEAK_GROWTH_LIMIT_MIB)
    regressions.push({
      key: `leaks.${id}.growthMiB`,
      was: LEAK_GROWTH_LIMIT_MIB,
      now: leak.growthMiB,
      change: null,
      regressed: true,
    });
const md = [
  `# Benchmark ${results.label}`,
  '',
  '```',
  JSON.stringify(results.machine, null, 2),
  '```',
  '',
];
if (COMPARE) {
  const baseline = JSON.parse(fs.readFileSync(COMPARE, 'utf8'));
  const rows = compare(results, baseline);
  regressions = [...regressions, ...rows.filter((r) => r.regressed)];
  md.push(
    `## Compared with ${baseline.label}`,
    '',
    '| metric | baseline | now | change % | |',
    '|---|---:|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.key} | ${r.was} | ${r.now} | ${r.change} | ${r.regressed ? '**REGRESSED**' : ''} |`,
    ),
    '',
  );
}
md.push(
  '## Results',
  '',
  '```json',
  JSON.stringify(results.scenarios, null, 2),
  '```',
);
fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));
if (SAVE_BASELINE) {
  fs.mkdirSync('bench/baselines', { recursive: true });
  const file = path.join('bench', 'baselines', `${SAVE_BASELINE}.json`);
  // A partial run (--only) updates its scenarios and keeps the others.
  const saved =
    fs.existsSync(file) && ONLY.length
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : null;
  const merged = saved
    ? { ...results, scenarios: { ...saved.scenarios, ...results.scenarios } }
    : results;
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  console.log(`Baseline saved: bench/baselines/${SAVE_BASELINE}.json`);
}
console.log(`Report: ${path.join(outDir, 'report.md')}`);
if (regressions.length) {
  console.log(`${regressions.length} regression(s):`);
  for (const r of regressions)
    console.log(`  ${r.key}: ${r.was} → ${r.now} (${r.change}%)`);
  process.exitCode = 1;
}
