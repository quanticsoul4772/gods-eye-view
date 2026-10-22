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
 *   node scripts/qa-bench.mjs --only hud-pick         HUD place-label picks per summary build
 *   node scripts/qa-bench.mjs --save-baseline arc-win11
 *   node scripts/qa-bench.mjs --compare bench/baselines/arc-win11.json
 *   node scripts/qa-bench.mjs --only layers --layers cctv,radio   chosen layers
 *   node scripts/qa-bench.mjs --only leaks            3 on/off cycles per layer; growth > 3 MiB fails
 *   node scripts/qa-bench.mjs --reps 3                3 windows per sample (median; default 2)
 *   node scripts/qa-bench.mjs --profile               also save .cpuprofile per window
 *   node scripts/qa-bench.mjs --basemap esri-imagery  measure on a given map stack (startup keeps the default)
 *   node scripts/qa-bench.mjs --uncapped              frames not tied to the display (noisier; see below)
 *   node scripts/qa-bench.mjs --allow-software        permit SwiftShader (numbers are relative only)
 *   node scripts/qa-bench.mjs --camera fleet-oblique  view the contiguous US from 5,000 km at -55°
 *   node scripts/qa-bench.mjs --camera airport-atl    Atlanta airfield from 4 km at -35° (aircraft on the ground)
 *   node scripts/qa-bench.mjs --readback-stacks       attribute GPU readbacks to callers (dev server, untimed)
 *
 * Every window also counts synchronous GPU readbacks (WebGL readPixels and
 * getBufferSubData) and the Scene queries that cause them (sampleHeight,
 * clampToHeight, pickPosition, pick, drillPick, getHeight), with their
 * total ms. --readback-stacks also captures a stack per GL readback and names
 * its caller: the innermost app frame (/src/file:line), else the Cesium
 * internal source (clamped billboards, the camera height query, tileset
 * height callbacks). Capturing stacks slows frames, so its fps are not
 * comparable; run it against the dev server, whose Cesium is unminified.
 *
 * Output: qa-shots/bench/<stamp>/results.json and report.md (gitignored).
 * Baselines: bench/baselines/<name>.json (committed).
 * Exit code 1 when --compare finds a regression beyond the thresholds.
 */
import { execFileSync } from 'node:child_process';
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
/**
 * Map stack to measure on (e.g. esri-imagery, photoreal). With a Google Maps
 * key the app opens on Google's photorealistic 3D tiles, a much heavier scene
 * than the keyless Esri imagery; compare only runs on the same basemap.
 */
const BASEMAP = opt('--basemap');
const SAVE_BASELINE = opt('--save-baseline');
const COMPARE = opt('--compare');
const STARTUP_SAMPLES = Number(opt('--startup-samples', '3'));
const WINDOW_MS = Number(opt('--window-ms', '5000'));
/** Measured windows per rest/motion sample; each metric is their median. */
const REPS = Number(opt('--reps', '2'));

/** Austin from 60 km, looking straight down: the harnesses' shared park spot. */
const PARK = { lat: 30.27, lon: -97.74, height: 60_000, pitch: -90 };
/**
 * Camera for every scenario. `park` is the 69 x 43 km Austin frame above, in
 * which most aircraft are off screen; `fleet-oblique` looks at the middle of
 * the contiguous US from 5,000 km at -55°, so the whole fleet is drawn;
 * `airport-atl` looks at Atlanta's airfield from 4 km at -35°, so aircraft
 * on the ground (whose models ask the ground snap for heights) are in view.
 */
const CAMERAS = {
  park: null,
  'fleet-oblique': {
    lon: -97,
    lat: 38,
    heading: 0,
    pitch: -55,
    range: 5_000_000,
  },
  'airport-atl': {
    lon: -84.4277,
    lat: 33.6407,
    heading: 0,
    pitch: -35,
    range: 4_000,
  },
};
const CAMERA = opt('--camera', 'park');
if (!Object.hasOwn(CAMERAS, CAMERA))
  throw new Error(
    `Unknown --camera ${CAMERA}; use ${Object.keys(CAMERAS).join(' or ')}`,
  );
const READBACK_STACKS = argv.includes('--readback-stacks');
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
  // Keyed: AISStream, NASA FIRMS, TomTom. Without a key they record count 0.
  'ais-live-vessels',
  'local-firms',
  'traffic',
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
/**
 * Style runs. Sharpen is on by default in every style, and Cesium allocates
 * and clears the post-process framebuffer while any stage exists, even a
 * disabled one, so `normal` is also measured with sharpen off and with every
 * (then disabled) stage removed.
 */
const STYLE_RUNS = [
  { key: 'normal', style: 'normal' },
  { key: 'normal-sharpen-off', style: 'normal', sharpenOff: true },
  {
    key: 'normal-stages-removed',
    style: 'normal',
    sharpenOff: true,
    removeStages: true,
  },
  ...STYLES.slice(1).map((style) => ({ key: style, style })),
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
 * - layer activation swung 2-4x with the network (CCTV 4.3-15.5 s), so it is
 *   reported, not gated, until layers have recorded fixtures.
 * fps and rAF frame times follow the display, so they are not gated; the
 * work-per-frame metrics get thresholds once an A/A pair has measured their
 * noise.
 */
const THRESHOLDS = {
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
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message)));
  await page.evaluateOnNewDocument((stacks) => {
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

    // Synchronous readbacks: every call and its ms, per method name.
    const readbacks = { calls: {}, ms: {}, callers: {}, samples: {} };
    window.__benchReadbacks = readbacks;
    if (stacks) Error.stackTraceLimit = 100;
    /**
     * The innermost frame that names who asked for the readback. An app
     * frame is followed by the next app frame in another file, so a shared
     * helper (scenePick.js) also names its caller: "helper ← caller".
     */
    const callerOf = (stack) => {
      const lines = String(stack).split('\n').slice(1);
      const appFrame = (line) =>
        line.match(/(\/src\/[^\s?:)]+)(?:\?[^\s:)]*)?:(\d+)/);
      for (const [index, line] of lines.entries()) {
        const src = appFrame(line);
        if (src) {
          const outer = lines
            .slice(index + 1)
            .map(appFrame)
            .find((frame) => frame && frame[1] !== src[1]);
          return outer
            ? `${src[1]}:${src[2]} ← ${outer[1]}:${outer[2]}`
            : `${src[1]}:${src[2]}`;
        }
        if (line.includes('_updateClamping'))
          return 'Billboard._updateClamping';
        if (line.includes('getGlobeHeight') || line.includes('initializeFrame'))
          return 'Scene.initializeFrame/getGlobeHeight';
        if (line.includes('processUpdateHeight'))
          return 'Cesium3DTileset.processUpdateHeight';
        if (line.includes('callbackWrapper'))
          return 'Scene.updateHeight callback (tile loaded)';
      }
      return 'other Cesium';
    };
    const wrap = (proto, name, { gl = false } = {}) => {
      const original = proto?.[name];
      if (typeof original !== 'function') return;
      proto[name] = function benchReadback(...args) {
        const t0 = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const ms = performance.now() - t0;
          readbacks.calls[name] = (readbacks.calls[name] || 0) + 1;
          readbacks.ms[name] = (readbacks.ms[name] || 0) + ms;
          if (gl && stacks) {
            const stack = new Error().stack;
            const caller = callerOf(stack);
            // A few raw stacks per caller, to read where an unnamed one is.
            const samples = (readbacks.samples[caller] ||= []);
            if (samples.length < 3) samples.push(stack);
            const entry = (readbacks.callers[caller] ||= { calls: 0, ms: 0 });
            entry.calls += 1;
            entry.ms += ms;
          }
        }
      };
    };
    for (const proto of [
      window.WebGL2RenderingContext?.prototype,
      window.WebGLRenderingContext?.prototype,
    ])
      wrap(proto, 'readPixels', { gl: true });
    wrap(window.WebGL2RenderingContext?.prototype, 'getBufferSubData', {
      gl: true,
    });
    window.__benchWrapScene = (scene) => {
      const proto = Object.getPrototypeOf(scene);
      if (proto.__benchWrapped) return;
      for (const name of [
        'sampleHeight',
        'clampToHeight',
        'pickPosition',
        'pick',
        'drillPick',
        'getHeight',
        'pickFromRay',
      ])
        wrap(proto, name);
      // Height callbacks run after a tile loads, with no trace of who asked
      // for them, so stacks mode counts their registrations by caller.
      const register = proto.updateHeight;
      if (stacks && typeof register === 'function') {
        readbacks.heightCallbacks = {};
        proto.updateHeight = function benchUpdateHeight(...args) {
          const caller = callerOf(new Error().stack);
          readbacks.heightCallbacks[caller] =
            (readbacks.heightCallbacks[caller] || 0) + 1;
          return register.apply(this, args);
        };
      }
      proto.__benchWrapped = true;
    };
  }, READBACK_STACKS);
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  if (cacheDisabled) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  }
  return { page, cdp, pageErrors };
}

/** Readback counters so far (calls and ms per method, callers by stack). */
function readbackTotals(page) {
  return page.evaluate(() => structuredClone(window.__benchReadbacks));
}

/** Per-method readback calls and ms between two totals, as flat metrics. */
function readbackDelta(before, after) {
  const out = {};
  for (const name of Object.keys(after.calls)) {
    out[`${name}Calls`] = after.calls[name] - (before.calls[name] || 0);
    out[`${name}Ms`] = round(after.ms[name] - (before.ms[name] || 0));
  }
  const callers = {};
  for (const [caller, entry] of Object.entries(after.callers)) {
    const was = before.callers[caller] || { calls: 0, ms: 0 };
    if (entry.calls > was.calls)
      callers[caller] = {
        calls: entry.calls - was.calls,
        ms: round(entry.ms - was.ms),
      };
  }
  return { metrics: out, callers };
}

/**
 * Whether the ground is loaded: the globe's tiles and every shown 3D tileset's
 * (Google's photorealistic tiles hide the globe, whose tilesLoaded is then
 * true at once). Runs in the page.
 */
function tilesReadyInPage() {
  const scene = window.__godsEyeView.viewer.scene;
  if (!scene.globe.tilesLoaded) return false;
  const primitives = scene.primitives;
  for (let i = 0; i < primitives.length; i += 1) {
    const primitive = primitives.get(i);
    if (
      primitive?.show !== false &&
      typeof primitive?.tilesLoaded === 'boolean' &&
      !primitive.tilesLoaded
    )
      return false;
  }
  return true;
}

/**
 * Shown primitives, and billboards and points shown and on screen (inside the
 * view frustum and above the horizon), plus entities per data source. Taken
 * between windows, outside the timed interval. Runs in the page; uses only
 * live Cesium instances, since the dev server has no window.Cesium.
 */
function sceneCountsInPage() {
  const viewer = window.__godsEyeView.viewer;
  const scene = viewer.scene;
  const camera = scene.camera;
  const planes = camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  ).planes;
  const radii = scene.globe.ellipsoid.radii;
  const eye = {
    x: camera.positionWC.x / radii.x,
    y: camera.positionWC.y / radii.y,
    z: camera.positionWC.z / radii.z,
  };
  const eyeHorizonSq = eye.x ** 2 + eye.y ** 2 + eye.z ** 2 - 1;
  const onScreen = (p) => {
    for (const plane of planes)
      if (plane.x * p.x + plane.y * p.y + plane.z * p.z + plane.w < 0)
        return false;
    // Cesium's EllipsoidalOccluder test, in the ellipsoid's scaled space.
    const t = {
      x: p.x / radii.x - eye.x,
      y: p.y / radii.y - eye.y,
      z: p.z / radii.z - eye.z,
    };
    const tDotEye = -(t.x * eye.x + t.y * eye.y + t.z * eye.z);
    return !(
      tDotEye > eyeHorizonSq &&
      tDotEye ** 2 / (t.x ** 2 + t.y ** 2 + t.z ** 2) > eyeHorizonSq
    );
  };
  const counts = {
    primitivesShown: 0,
    billboards: 0,
    billboardsOnScreen: 0,
    points: 0,
    pointsOnScreen: 0,
  };
  const visit = (collection) => {
    for (let i = 0; i < collection.length; i += 1) {
      const primitive = collection.get(i);
      if (!primitive || primitive.show === false) continue;
      if (Array.isArray(primitive._primitives)) {
        visit(primitive);
        continue;
      }
      counts.primitivesShown += 1;
      const kind = Array.isArray(primitive._billboards)
        ? 'billboards'
        : Array.isArray(primitive._pointPrimitives)
          ? 'points'
          : null;
      if (!kind) continue;
      for (let j = 0; j < primitive.length; j += 1) {
        const item = primitive.get(j);
        if (!item?.show) continue;
        counts[kind] += 1;
        if (onScreen(item.position)) counts[`${kind}OnScreen`] += 1;
      }
    }
  };
  visit(scene.primitives);
  visit(scene.groundPrimitives);
  // Aircraft on the ground in view: each one's 3D model asks the ground snap
  // for a height, so its sample counts are compared per aircraft.
  // (A finite limit: getAnalystRecords falls back to 2,000 for Infinity.)
  const rad = Math.PI / 180;
  counts.onGroundAircraftOnScreen = 0;
  for (const id of ['flights', 'military']) {
    const module = window.__godsEyeView.dataManager.layers.get(id)?.module;
    for (const record of module?.getAnalystRecords?.(Number.MAX_SAFE_INTEGER) ||
      []) {
      if (!record.onGround || record.lat === null || record.lon === null)
        continue;
      const position = scene.globe.ellipsoid.cartographicToCartesian({
        longitude: record.lon * rad,
        latitude: record.lat * rad,
        height: 0,
      });
      if (onScreen(position)) counts.onGroundAircraftOnScreen += 1;
    }
  }
  const entities = {};
  for (let i = 0; i < viewer.dataSources.length; i += 1) {
    const source = viewer.dataSources.get(i);
    if (source.show === false) continue;
    const name = source.name || `source-${i}`;
    entities[name] = (entities[name] || 0) + source.entities.values.length;
  }
  return { ...counts, entities };
}

/** The GPU names and driver versions Windows reports; null elsewhere. */
function gpuDrivers() {
  if (process.platform !== 'win32') return null;
  return execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) $($_.DriverVersion)" }) -join "; "',
    ],
    { encoding: 'utf8' },
  ).trim();
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
  const view = CAMERAS[CAMERA];
  if (view)
    return page.evaluate((s) => {
      const v = window.__godsEyeView.viewer;
      v.trackedEntity = undefined;
      v.camera.cancelFlight();
      const rad = Math.PI / 180;
      const target = v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: s.lon * rad,
        latitude: s.lat * rad,
        height: 0,
      });
      v.camera.lookAt(target, {
        heading: s.heading * rad,
        pitch: s.pitch * rad,
        range: s.range,
      });
      // Release the look-at frame so the camera moves freely again; Matrix4
      // is read off a live instance (the dev server has no window.Cesium).
      v.camera.lookAtTransform(v.camera.transform.constructor.IDENTITY);
    }, view);
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
    .waitForFunction(tilesReadyInPage, {
      timeout,
      polling: 200,
    })
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
  const tilesLoadedAtStart = (await page.evaluate(tilesReadyInPage)) ? 1 : 0;
  const readbacksBefore = await readbackTotals(page);
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
        // Work per frame, which the display's refresh rate does not change:
        // CPU ms from a tick's preUpdate to its postRender (rendered frames
        // only), and GPU ms from preRender to postRender by a WebGL2 timer
        // query, read a few frames later when the GPU reports it.
        const gl = scene.context._gl;
        const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const cpuMs = [];
        const gpuMs = [];
        const pending = [];
        let gpuDisjoint = 0;
        let tickStart = null;
        let query = null;
        const collectQueries = () => {
          if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
            // A disjoint event makes every query in flight meaningless.
            gpuDisjoint += pending.length;
            for (const q of pending.splice(0)) gl.deleteQuery(q);
            return;
          }
          while (
            pending.length &&
            gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)
          ) {
            const q = pending.shift();
            gpuMs.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(q);
          }
        };
        const removeRender = scene.postRender.addEventListener(() => {
          renders += 1;
          if (tickStart !== null) cpuMs.push(performance.now() - tickStart);
          tickStart = null;
          if (query) {
            gl.endQuery(timer.TIME_ELAPSED_EXT);
            pending.push(query);
            query = null;
          }
        });
        const removePreRender = scene.preRender.addEventListener(() => {
          if (!timer || query) return;
          collectQueries();
          query = gl.createQuery();
          gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        });
        const removeTick = scene.preUpdate.addEventListener(() => {
          ticks += 1;
          tickStart = performance.now();
          if (motion) v.camera.rotateRight(0.002);
        });
        if (motion) scene.requestRender();
        const t0 = performance.now();
        let last = t0;
        const frame = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(frame);
          else finish();
        };
        const percentile = (values, p) => {
          const sorted = values.slice().sort((a, b) => a - b);
          return sorted.length
            ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
            : null;
        };
        const finish = async () => {
          removeRender();
          removePreRender();
          removeTick();
          const elapsed = (performance.now() - t0) / 1000;
          // Queries still in flight report within a few frames.
          if (timer)
            for (let i = 0; i < 30 && pending.length; i += 1) {
              await new Promise((r) => setTimeout(r, 16));
              collectQueries();
            }
          const gpuUnread = pending.length;
          if (timer) for (const q of pending.splice(0)) gl.deleteQuery(q);
          const long = window.__benchLongTasks.slice(longStart);
          const frameDeltas = deltas.slice(1);
          resolve({
            cpuFrameP50Ms: percentile(cpuMs, 0.5),
            cpuFrameP95Ms: percentile(cpuMs, 0.95),
            cpuFrames: cpuMs.length,
            gpuFrameP50Ms: timer ? percentile(gpuMs, 0.5) : null,
            gpuFrameP95Ms: timer ? percentile(gpuMs, 0.95) : null,
            gpuFrames: gpuMs.length,
            gpuDisjoint,
            gpuUnread,
            elapsed,
            fps: deltas.length / elapsed,
            ticksPerSec: ticks / elapsed,
            rendersPerSec: renders / elapsed,
            frameP50Ms: percentile(frameDeltas, 0.5),
            frameP95Ms: percentile(frameDeltas, 0.95),
            frameMaxMs: percentile(frameDeltas, 1),
            longTasks: long.length,
            longTaskMs: long.reduce((a, b) => a + b, 0),
          });
        };
        requestAnimationFrame(frame);
      }),
    ms,
    motion,
  );
  const after = await cdpMetrics(cdp);
  const readbacks = readbackDelta(readbacksBefore, await readbackTotals(page));
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    fs.writeFileSync(
      path.join(outDir, `${label.replace(/[^\w.-]+/g, '_')}.cpuprofile`),
      JSON.stringify(profile),
    );
  }
  const secs = inPage.elapsed;
  return {
    // Work per frame decides comparisons: the display's refresh rate, dynamic
    // refresh and sleep change how often frames are drawn, not how long one
    // takes to make.
    cpuFrameP50Ms: round(inPage.cpuFrameP50Ms, 2),
    cpuFrameP95Ms: round(inPage.cpuFrameP95Ms, 2),
    cpuFrames: inPage.cpuFrames,
    gpuFrameP50Ms: round(inPage.gpuFrameP50Ms, 2),
    gpuFrameP95Ms: round(inPage.gpuFrameP95Ms, 2),
    gpuFrames: inPage.gpuFrames,
    gpuDisjoint: inPage.gpuDisjoint,
    gpuUnread: inPage.gpuUnread,
    // Cesium render-loop ticks per second (the app caps them at 60), reported
    // only: it follows the display. Headless rAF is kept as rafFps.
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
    tilesLoadedAtStart,
    ...readbacks.metrics,
    ...(READBACK_STACKS ? { readbackCallers: readbacks.callers } : {}),
  };
}

/**
 * Combine a sample's windows: the median of each metric (a readback method
 * absent from a window had 0 calls), the minimum of tilesLoadedAtStart (0
 * when any window started while tiles streamed), and summed readback callers.
 */
function combineWindows(runs) {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run)))];
  const out = {};
  for (const key of keys) {
    if (key === 'readbackCallers') {
      const callers = {};
      for (const run of runs)
        for (const [caller, entry] of Object.entries(run.readbackCallers)) {
          const sum = (callers[caller] ||= { calls: 0, ms: 0 });
          sum.calls += entry.calls;
          sum.ms = round(sum.ms + entry.ms);
        }
      out.readbackCallers = callers;
    } else if (key === 'tilesLoadedAtStart') {
      out[key] = Math.min(...runs.map((run) => run[key]));
    } else {
      out[key] = round(
        median(runs.map((run) => (run[key] === undefined ? 0 : run[key]))),
      );
    }
  }
  return out;
}

/**
 * Warm up (an unmeasured camera turn, then tiles), then REPS rest windows and
 * REPS motion windows, each metric the median of its windows. Without the
 * warm-up the first scene measured after a camera move ran at half speed
 * while its tiles and shaders loaded.
 */
/**
 * Put the camera back on the scenario's view and let its tiles load. Motion
 * turns the camera about the Earth's axis (rotateRight), so the 3 s warm-up
 * alone moved the view ~20° of longitude, and a build drawing more frames
 * moved it further: every window and count starts from the parked view.
 */
async function repark(page) {
  await park(page);
  await waitTiles(page, 20_000);
  await pause(1500);
}

async function restAndMotion(page, cdp, label) {
  await measureWindow(page, cdp, `${label}-warmup`, { motion: true, ms: 3000 });
  const windows = async (motion) => {
    const runs = [];
    for (let i = 0; i < REPS; i += 1) {
      await repark(page);
      runs.push(
        await measureWindow(
          page,
          cdp,
          `${label}-${motion ? 'motion' : 'rest'}-${i}`,
          { motion },
        ),
      );
    }
    return combineWindows(runs);
  };
  const rest = await windows(false);
  const motion = await windows(true);
  await repark(page);
  return {
    rest,
    motion,
    sceneCounts: await page.evaluate(sceneCountsInPage),
    ...(READBACK_STACKS
      ? {
          readbackSamples: await page.evaluate(
            () => window.__benchReadbacks.samples,
          ),
          heightCallbackRegistrations: await page.evaluate(
            () => window.__benchReadbacks.heightCallbacks,
          ),
        }
      : {}),
  };
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
  await repark(page);
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

// Frames follow the display's vsync, as in a real browser, so how many are
// drawn depends on the display (its refresh rate, dynamic refresh, sleep:
// asleep, the compositor paced headless Chrome at ~10 Hz). Comparisons are
// therefore judged on work per frame (cpuFrame*/gpuFrame*), which does not
// depend on it, the way Chromium's ANGLE perf tests measure CPU and GPU work
// under vsync; the blank-page frame clock is recorded, not gated.
// --uncapped frees the clock from the display (UNCAPPED_FRAME_ARGS); it let
// light scenes run rAF at 100-300/s.
const UNCAPPED = argv.includes('--uncapped');
const browser = await launchProbeBrowser({ gpu: true, uncapped: UNCAPPED });
const frameClock = await blankPageRafRate(browser);
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
    gpuDrivers: gpuDrivers(),
  },
  conditions: {
    viewport: '1440x900@1',
    windowMs: WINDOW_MS,
    reps: REPS,
    isolation: 'fresh page per scenario',
    frameClock: `${UNCAPPED ? `uncapped (${UNCAPPED_FRAME_ARGS.join(' ')})` : 'display vsync'}, blank page ${frameClock.toFixed(0)} rAF/s`,
    park: PARK,
    camera: { name: CAMERA, view: CAMERAS[CAMERA] ?? PARK },
    readbackStacks: READBACK_STACKS,
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
    await app.page.evaluate(() =>
      window.__benchWrapScene(window.__godsEyeView.viewer.scene),
    );
    await pause(4000);
    if (BASEMAP)
      await app.page.evaluate(
        (stack) =>
          window.__godsEyeView.voiceCommands.runner('set_map_stack', { stack }),
        BASEMAP,
      );
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
    // What the scenarios' camera shows, to check the view by eye.
    await page.screenshot({ path: path.join(outDir, `camera-${CAMERA}.png`) });
    results.conditions.basemap = await page.evaluate(
      () =>
        window.__godsEyeView.mapStackController?.getState?.()?.activeId ?? null,
    );
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
    console.log(
      `GPU: ${renderer}  server: ${results.conditions.server}  basemap: ${results.conditions.basemap}`,
    );
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
    const setStyle = (page, style) =>
      page.evaluate(
        (s) =>
          window.__godsEyeView.voiceCommands.runner('set_visual_style', {
            style: s,
          }),
        style,
      );
    {
      // Unmeasured: the first style page fills the HTTP and shader caches,
      // which otherwise slowed whichever style ran first.
      const { page, cdp } = await fresh();
      await setStyle(page, 'normal');
      await measureWindow(page, cdp, 'style-warm', { motion: true, ms: 3000 });
      await waitTiles(page, 20_000);
      await page.close();
    }
    for (const run of STYLE_RUNS) {
      const { page, cdp, pageErrors } = await fresh();
      await setStyle(page, run.style);
      if (run.sharpenOff)
        await page.evaluate(() =>
          window.__godsEyeView.voiceCommands.runner('set_post_processing', {
            sharpen: { enabled: false },
          }),
        );
      let stagesRemaining = null;
      if (run.removeStages) {
        stagesRemaining = await page.evaluate(() => {
          const stages = window.__godsEyeView.viewer.scene.postProcessStages;
          for (let i = stages.length - 1; i >= 0; i -= 1)
            if (!stages.get(i).enabled) stages.remove(stages.get(i));
          return stages.length;
        });
        if (stagesRemaining !== 0)
          throw new Error(
            `style ${run.key}: ${stagesRemaining} post-process stage(s) still enabled after sharpen off`,
          );
      }
      results.scenarios.styles[run.key] = {
        ...(await restAndMotion(page, cdp, `style-${run.key}`)),
        ...(run.removeStages ? { stagesRemaining } : {}),
        pageErrors: pageErrors.length,
      };
      await page.close();
      console.log(
        `style ${run.key}`,
        JSON.stringify(results.scenarios.styles[run.key].motion),
      );
    }
  }

  if (want('hud-pick')) {
    // The HUD summary's place label picks the screen centre. It refreshes
    // every 15 s and on moveEnd, so a timed window holds 0-1 refreshes; this
    // builds the summary context a fixed number of times while the camera
    // turns and counts the picks per build (no summary request is sent).
    const { page } = await fresh();
    const builds = 10;
    const before = await readbackTotals(page);
    const elapsedMs = await page.evaluate(async (n) => {
      const v = window.__godsEyeView.viewer;
      const hud = window.__godsEyeView.styleManager.hud;
      const removeTick = v.scene.preUpdate.addEventListener(() =>
        v.camera.rotateRight(0.002),
      );
      v.scene.requestRender();
      let ms = 0;
      for (let i = 0; i < n; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const t0 = performance.now();
        await hud._summaryContext();
        ms += performance.now() - t0;
      }
      removeTick();
      return ms;
    }, builds);
    const delta = readbackDelta(before, await readbackTotals(page));
    results.scenarios.hudPick = {
      builds,
      contextMsPerBuild: round(elapsedMs / builds),
      pickFromRayPerBuild: round(
        (delta.metrics.pickFromRayCalls || 0) / builds,
      ),
      readPixelsPerBuild: round((delta.metrics.readPixelsCalls || 0) / builds),
      readPixelsMsPerBuild: round((delta.metrics.readPixelsMs || 0) / builds),
    };
    await page.close();
    console.log('hud-pick', JSON.stringify(results.scenarios.hudPick));
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
