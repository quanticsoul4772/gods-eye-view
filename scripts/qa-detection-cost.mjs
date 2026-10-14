#!/usr/bin/env node
/**
 * qa-detection-cost.mjs — what the detection overlay costs where it is dense,
 * measured so that a 2 renders/s change is distinguishable from noise.
 *
 * Detection's own JS is small (0.5-4 ms per frame); its cost on Google 3D is
 * GPU contention from compositing a full-screen overlay while the GPU is
 * already the limit. That shows only as a few renders/s out of ~50, inside
 * the drift of a long run, so every result here is a paired, same-session
 * comparison:
 *
 * - Variants (detection off, on, or a surface-filter override) and targets
 *   (two servers, e.g. the build before and after a change) alternate in one
 *   browser, in A,B,B,A order (round 2 runs the list reversed), which cancels
 *   linear drift such as GPU clocks settling.
 * - Each round records every variant; the paired delta is variant minus the
 *   reference variant (the first) of the same round. Median and range of the
 *   deltas are the result, judged against a noise floor measured the same way
 *   with two identical variants (`--variants A:on,A:on`).
 * - Before each window: 3D tiles loaded and still loaded a second later, the
 *   detection fade done, and the page that is not being measured has its
 *   render loop stopped, so it does not share the GPU.
 * - Each window records what was on screen (detection observations and labels
 *   drawn); rounds whose windows differ by more than 10 % are reported as
 *   such. The GPU renderer, a blank-page frame clock before and after, and AC
 *   power are recorded with the run.
 *
 * Scenarios:
 *   still  camera fixed, clock paused, every Cesium tick rendered — the
 *          mechanism (how much a rendered frame costs).
 *   live   camera fixed, feed live, the app's own render demand — what a user
 *          watching vessels sees.
 *   orbit  the camera turns along the same path each window (tiles cached by
 *          a first unmeasured orbit) — motion; judge only "no regression".
 *   diag   detection's own paintMs / frameTotalMs at density 25/75/100 while
 *          orbiting, on each basemap in --basemaps.
 *
 * Usage (against `npm run build` + `npx vite preview --port 4180`):
 *   node scripts/qa-detection-cost.mjs --scenario still --case channel
 *   node scripts/qa-detection-cost.mjs --variants A:on,A:on           A/A floor
 *   node scripts/qa-detection-cost.mjs --targets A=http://localhost:4180,B=http://localhost:4181 \
 *        --variants A:off,A:on,B:on --noise-floor 1.2
 *   node scripts/qa-detection-cost.mjs --variants A:off,A:on,A:filter=none
 *   node scripts/qa-detection-cost.mjs --scenario diag --basemaps esri-imagery,photoreal
 *   node scripts/qa-detection-cost.mjs --uncapped     frames not tied to the display (display asleep)
 *   node scripts/qa-detection-cost.mjs --high-performance-gpu --expect-gpu RTX   a laptop's discrete GPU
 *
 * Variants: `off`, `on`, `filter=<css>` (detection on, with the overlay's
 * CSS filter replaced, e.g. `filter=none` or `filter=contrast(1.1)`), or
 * `frozen` (detection on, its surface never redrawn: the most that skipping
 * unchanged repaints could save).
 *
 * Output: qa-shots/detection-cost/<stamp>/results.json (gitignored).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  blankPageRafRate,
  launchProbeBrowser,
  UNCAPPED_FRAME_ARGS,
  webglRenderer,
} from './qa-renderProbe.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback = null) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const list = (value) => String(value || '').split(',').filter(Boolean);

const TARGETS = Object.fromEntries(
  list(opt('--targets', `A=${process.env.QA_BASE_URL || 'http://localhost:4180'}`)).map(
    (entry) => entry.split(/=(.*)/s).slice(0, 2),
  ),
);
const SCENARIO = opt('--scenario', 'still');
const CASES = {
  channel: { layer: 'ais-live-vessels', lat: 51.5, lon: 2.5, height: 600_000, pitch: -70 },
  brazil: { layer: 'local-firms', lat: -9.5, lon: -50, height: 1_500_000, pitch: -70 },
};
const CASE = opt('--case', 'channel');
const BASEMAPS = list(opt('--basemaps', opt('--basemap', 'photoreal')));
const VARIANTS = list(opt('--variants', 'A:off,A:on')).map((spec, i, all) => {
  const [target, variant] = spec.includes(':') ? spec.split(/:(.*)/s) : ['A', spec];
  if (!TARGETS[target]) throw new Error(`unknown target "${target}" in ${spec}`);
  // An A/A run lists the same variant twice; keep their windows apart.
  const key = all.indexOf(spec) === i ? spec : `${spec}#${i + 1}`;
  return { key, spec, target, variant };
});
const ROUNDS = Number(opt('--rounds', '6'));
const WINDOW_MS = Number(opt('--window-ms', '5000'));
const WARMUP_MS = Number(opt('--warmup-ms', '12000'));
const DENSITY = Number(opt('--density', '75'));
const NOISE_FLOOR = opt('--noise-floor') === null ? null : Number(opt('--noise-floor'));
const EXPECT_GPU = opt('--expect-gpu');
const DPR = Number(opt('--dpr', '1'));
/**
 * Frames free of the display's vsync (UNCAPPED_FRAME_ARGS), for a machine whose
 * display sleeps. Noisier than vsync; compare only within one run.
 */
const UNCAPPED = argv.includes('--uncapped');
/** A laptop's discrete GPU instead of the integrated one (check --expect-gpu). */
const HIGH_PERFORMANCE_GPU = argv.includes('--high-performance-gpu');
/** Detection's enable fade (DETECTION_ENABLE_FADE_MS, 220 ms) plus margin. */
const AFTER_TOGGLE_MS = 1_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function onAcPower() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus"',
      { encoding: 'utf8' },
    ).trim();
    // No battery: a desktop, always on mains. 2 = AC; 1 = discharging.
    return out === '' ? true : out === '2';
  } catch {
    return null;
  }
}

// ── page setup ─────────────────────────────────────────────────────────────

async function openTarget(browser, url, basemap, c) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: DPR });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.voiceCommands?.runner,
    { timeout: 180_000, polling: 200 },
  );
  await pause(3_000);
  const count = await page.evaluate(
    async (c, basemap) => {
      const g = window.__godsEyeView;
      const v = g.viewer;
      const run = g.voiceCommands.runner;
      await run('set_map_stack', { stack: basemap });
      for (const [id, entry] of g.dataManager.layers)
        if (entry.enabled) await g.dataManager.setEnabled(id, false, { origin: 'user' });
      await g.dataManager.setEnabled(c.layer, true, { origin: 'user' });
      const stats = () =>
        g.dataManager.getAll().find((l) => l.id === c.layer)?.stats?.count || 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 90_000 && stats() === 0)
        await new Promise((r) => setTimeout(r, 300));
      return stats();
    },
    c,
    basemap,
  );
  if (!count) throw new Error(`${c.layer} loaded nothing at ${url} (no key?)`);
  await placeCamera(page, c);
  return { page, count };
}

/**
 * Put the camera on the case's fixed view. Called before every motion window:
 * the orbit turns the camera about the globe's axis, so without this each
 * window would start further from the dense area than the last.
 */
function placeCamera(page, c) {
  return page.evaluate((c) => {
    const v = window.__godsEyeView.viewer;
    v.trackedEntity = undefined;
    v.camera.cancelFlight();
    const rad = Math.PI / 180;
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: c.lon * rad,
        latitude: c.lat * rad,
        height: c.height,
      }),
      orientation: { heading: 0, pitch: c.pitch * rad, roll: 0 },
    });
  }, c);
}

/**
 * Stop or restart a page's Cesium render loop (the idle page must not share the
 * GPU). A running page is brought to the front: a background tab gets no
 * animation frames, and the app suspends work while hidden.
 */
async function setLoop(page, running) {
  if (running) await page.bringToFront();
  return page.evaluate((running) => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = running;
  }, running);
}

async function applyVariant(page, variant) {
  await page.evaluate(
    async (variant, density) => {
      const g = window.__godsEyeView;
      const on = variant !== 'off';
      await g.voiceCommands.runner(
        'set_detection',
        on ? { enabled: true, densityPct: density } : { enabled: false },
      );
      // The detection surface is the overlay element blended with `screen`.
      const surface = [...document.querySelectorAll('canvas, div')].find(
        (el) => el.style.mixBlendMode === 'screen',
      );
      if (!surface) return;
      surface.dataset.qaShippedFilter ??= surface.style.filter;
      surface.style.filter = variant.startsWith('filter=')
        ? variant.slice('filter='.length)
        : surface.dataset.qaShippedFilter;
      // Undo a previous `frozen` window.
      const ctx = surface.getContext?.('2d');
      if (ctx?.qaDrawing) {
        Object.assign(ctx, ctx.qaDrawing);
        delete ctx.qaDrawing;
      }
    },
    variant,
    DENSITY,
  );
  await pause(AFTER_TOGGLE_MS);
  if (variant === 'frozen')
    // The ceiling for skipping unchanged repaints: detection keeps running,
    // but its surface is never drawn again (no clear, no strokes, no upload),
    // so the last frame stays on screen and is only composited.
    await page.evaluate(() => {
      const surface = [...document.querySelectorAll('canvas')].find(
        (el) => el.style.mixBlendMode === 'screen',
      );
      const ctx = surface.getContext('2d');
      const names = ['clearRect', 'fillRect', 'strokeRect', 'stroke', 'fill', 'fillText', 'strokeText', 'drawImage', 'putImageData'];
      ctx.qaDrawing = Object.fromEntries(names.map((n) => [n, ctx[n]]));
      for (const n of names) ctx[n] = () => {};
    });
}

/** 3D tiles (or the globe) loaded, and still loaded a second later. */
async function waitTilesSettled(page, timeoutMs = 30_000) {
  const loaded = () =>
    page.evaluate(() => {
      const g = window.__godsEyeView;
      const ts = g.tileset;
      return ts?.show ? ts.tilesLoaded : g.viewer.scene.globe.tilesLoaded;
    });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await loaded()) {
      await pause(1_000);
      if (await loaded()) return true;
    }
    await pause(250);
  }
  return false;
}

// ── one measured window ────────────────────────────────────────────────────

function measure(page, scenario, ms) {
  return page.evaluate(
    (scenario, ms) =>
      new Promise((resolve) => {
        const g = window.__godsEyeView;
        const v = g.viewer;
        const scene = v.scene;
        const restoreMode = scene.requestRenderMode;
        const restoreClock = v.clock.shouldAnimate;
        if (scenario === 'still') {
          v.clock.shouldAnimate = false;
          scene.requestRenderMode = false;
        }
        let renders = 0;
        let ticks = 0;
        let rafs = 0;
        const det = [];
        const removeTick = scene.preUpdate.addEventListener(() => {
          ticks += 1;
          if (scenario === 'orbit' || scenario === 'diag') v.camera.rotateRight(0.001);
        });
        const removeRender = scene.postRender.addEventListener(() => {
          renders += 1;
          const ds = document.querySelector('canvas[data-solve-revision]')?.dataset;
          if (!ds) return;
          const labels = Object.values(JSON.parse(ds.labelsByLayer || '{}')).reduce(
            (a, b) => a + (Number(b) || 0),
            0,
          );
          det.push({
            paintMs: +ds.paintMs,
            frameTotalMs: +ds.frameTotalMs,
            observations: +ds.observationCount,
            labels,
          });
        });
        if (scenario !== 'live') scene.requestRender();
        const t0 = performance.now();
        const frame = () => {
          rafs += 1;
          if (performance.now() - t0 < ms) return requestAnimationFrame(frame);
          removeTick();
          removeRender();
          scene.requestRenderMode = restoreMode;
          v.clock.shouldAnimate = restoreClock;
          const secs = (performance.now() - t0) / 1000;
          const avg = (k) =>
            det.length ? det.reduce((a, x) => a + (x[k] || 0), 0) / det.length : null;
          resolve({
            rendersPerSec: renders / secs,
            ticksPerSec: ticks / secs,
            rafFps: rafs / secs,
            paintMs: avg('paintMs'),
            frameTotalMs: avg('frameTotalMs'),
            observations: avg('observations'),
            labels: avg('labels'),
          });
        };
        requestAnimationFrame(frame);
      }),
    scenario,
    ms,
  );
}

// ── scenarios ──────────────────────────────────────────────────────────────

async function pairedRun(browser, basemap) {
  const c = CASES[CASE];
  const pages = {};
  for (const [name, url] of Object.entries(TARGETS)) {
    if (!VARIANTS.some((v) => v.target === name)) continue;
    pages[name] = await openTarget(browser, url, basemap, c);
    await setLoop(pages[name].page, false);
  }
  const renderer = await webglRenderer(Object.values(pages)[0].page);
  if (EXPECT_GPU && !new RegExp(EXPECT_GPU, 'i').test(renderer || ''))
    throw new Error(`renderer "${renderer}" is not ${EXPECT_GPU}`);

  // Warm each page: tiles in, GPU clocks settled, the orbit path cached.
  for (const { page } of Object.values(pages)) {
    await setLoop(page, true);
    await applyVariant(page, 'on');
    await waitTilesSettled(page);
    await measure(page, SCENARIO === 'live' ? 'still' : SCENARIO, WARMUP_MS);
    await placeCamera(page, c);
    await waitTilesSettled(page);
    await setLoop(page, false);
  }

  const rounds = [];
  for (let r = 0; r < ROUNDS; r += 1) {
    const order = r % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
    const windows = {};
    for (const v of order) {
      const { page } = pages[v.target];
      await setLoop(page, true);
      await applyVariant(page, v.variant);
      await placeCamera(page, c);
      const settled = await waitTilesSettled(page);
      const m = await measure(page, SCENARIO, WINDOW_MS);
      await setLoop(page, false);
      windows[v.key] = { ...m, tilesSettled: settled };
      // With detection off its diagnostics are the last frame it drew.
      if (v.variant === 'off') Object.assign(windows[v.key], { observations: null, labels: null });
      if (SCENARIO === 'still' && Math.abs(m.rendersPerSec - m.ticksPerSec) > 2)
        windows[v.key].warning = 'renders != ticks: not rendering every tick';
      process.stdout.write(
        `round ${r + 1} ${v.key.padEnd(24)} ${round(m.rendersPerSec)} renders/s` +
          `  obs ${round(m.observations, 0)} labels ${round(m.labels, 0)}\n`,
      );
    }
    rounds.push(windows);
  }
  for (const { page } of Object.values(pages)) await page.close();
  return { counts: Object.fromEntries(Object.entries(pages).map(([k, p]) => [k, p.count])), renderer, rounds };
}

/**
 * A window this far from its variant's median is an outlier: about one window
 * in ten on the Arc lands in a second, much slower performance state (~33
 * instead of ~45-53 renders/s) for reasons outside the variant. Outliers are
 * listed and left out of the paired deltas, not silently dropped.
 */
const OUTLIER_FRACTION = 0.2;

function summarise(rounds) {
  const value = (w, key) => w[key].rendersPerSec;
  const medians = Object.fromEntries(
    VARIANTS.map((v) => [v.key, median(rounds.map((w) => value(w, v.key)))]),
  );
  const outliers = [];
  rounds.forEach((w, r) => {
    for (const v of VARIANTS)
      if (Math.abs(value(w, v.key) - medians[v.key]) > OUTLIER_FRACTION * medians[v.key])
        outliers.push({ round: r + 1, variant: v.key, rendersPerSec: round(value(w, v.key)) });
  });
  const kept = (r, ...keys) =>
    !outliers.some((o) => o.round === r + 1 && keys.includes(o.variant));
  const judge = (deltas) => {
    const med = median(deltas);
    return {
      deltaMedian: round(med),
      deltaRange: deltas.length ? [round(Math.min(...deltas)), round(Math.max(...deltas))] : null,
      pairs: deltas.length,
      sameDirection: deltas.every((d) => Math.sign(d) === Math.sign(med)),
      ...(NOISE_FLOOR === null ? {} : { beyondTwiceFloor: Math.abs(med) > 2 * NOISE_FLOOR }),
    };
  };
  // Paired: variant minus reference, same round.
  const versus = (key, ref) => ({
    ...judge(
      rounds.flatMap((w, r) => (kept(r, key, ref) ? [value(w, key) - value(w, ref)] : [])),
    ),
    roundsWithContentOver10pct: rounds.filter((w) => {
      const a = w[key].observations;
      const b = w[ref].observations;
      return a && b && Math.abs(a - b) / Math.max(a, b) > 0.1;
    }).length,
  });
  const ref = VARIANTS[0].key;
  const refValues = rounds.filter((_, r) => kept(r, ref)).map((w) => value(w, ref));
  const summary = {
    reference: ref,
    medians: Object.fromEntries(Object.entries(medians).map(([k, m]) => [k, round(m)])),
    referenceSpread: round(Math.max(...refValues) - Math.min(...refValues)),
    outliers,
    versusReference: Object.fromEntries(
      VARIANTS.slice(1).map((v) => [v.key, versus(v.key, ref)]),
    ),
  };
  // Detection's cost on each target: its variants minus its own `off`, same
  // round; then how that cost changed between targets (round by round).
  const offOf = (target) => VARIANTS.find((v) => v.target === target && v.variant === 'off');
  const costs = {};
  for (const v of VARIANTS) {
    const off = offOf(v.target);
    if (!off || v === off) continue;
    costs[v.key] = {
      off: off.key,
      perRound: rounds.map((w, r) =>
        kept(r, v.key, off.key) ? value(w, v.key) - value(w, off.key) : null,
      ),
    };
    Object.assign(costs[v.key], judge(costs[v.key].perRound.filter((d) => d !== null)));
  }
  summary.costOnTarget = Object.fromEntries(
    Object.entries(costs).map(([k, { perRound, ...rest }]) => [k, rest]),
  );
  const firstTarget = VARIANTS[0].target;
  for (const v of VARIANTS) {
    if (v.target === firstTarget || !costs[v.key]) continue;
    const base = VARIANTS.find((b) => b.target === firstTarget && b.variant === v.variant);
    if (!base || !costs[base.key]) continue;
    summary.costChange ??= {};
    summary.costChange[`${v.key} vs ${base.key}`] = judge(
      rounds.flatMap((_, r) => {
        const a = costs[v.key].perRound[r];
        const b = costs[base.key].perRound[r];
        return a === null || b === null ? [] : [a - b];
      }),
    );
  }
  if (summary.referenceSpread > 3) summary.flag = 'reference windows spread > 3 renders/s';
  return summary;
}

async function diagRun(browser, basemap) {
  const c = CASES[CASE];
  const url = Object.values(TARGETS)[0];
  const { page, count } = await openTarget(browser, url, basemap, c);
  const rows = [];
  for (const variant of ['off', 25, 75, 100]) {
    await page.evaluate(
      (d) =>
        window.__godsEyeView.voiceCommands.runner(
          'set_detection',
          d === 'off' ? { enabled: false } : { enabled: true, densityPct: d },
        ),
      variant,
    );
    await pause(AFTER_TOGGLE_MS);
    await placeCamera(page, c);
    await waitTilesSettled(page);
    await measure(page, 'orbit', 3_000);
    await placeCamera(page, c);
    const m = await measure(page, 'diag', WINDOW_MS);
    // With detection off its diagnostics are the last frame it drew.
    if (variant === 'off')
      Object.assign(m, { paintMs: null, frameTotalMs: null, observations: null, labels: null });
    rows.push({ density: variant, ...Object.fromEntries(Object.entries(m).map(([k, x]) => [k, round(x, 2)])) });
    console.log(basemap, CASE, JSON.stringify(rows.at(-1)));
  }
  await page.close();
  return { count, rows };
}

// ── main ───────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('qa-shots', 'detection-cost', stamp);
fs.mkdirSync(outDir, { recursive: true });
const browser = await launchProbeBrowser({
  gpu: true,
  uncapped: UNCAPPED,
  extraArgs: HIGH_PERFORMANCE_GPU ? ['--force-high-performance-gpu'] : [],
});
const conditions = {
  date: new Date().toISOString(),
  scenario: SCENARIO,
  case: CASE,
  basemaps: BASEMAPS,
  targets: TARGETS,
  variants: VARIANTS.map((v) => v.spec),
  rounds: ROUNDS,
  windowMs: WINDOW_MS,
  density: DENSITY,
  dpr: DPR,
  frameClock: UNCAPPED ? `uncapped (${UNCAPPED_FRAME_ARGS.join(' ')})` : 'display vsync',
  acPower: onAcPower(),
  rafBefore: round(await blankPageRafRate(browser)),
};
// The first reading after launch is often low while Chrome warms up.
if (conditions.rafBefore < (UNCAPPED ? 50 : 55))
  conditions.rafBefore = round(await blankPageRafRate(browser));
// A sleeping display throttles headless Chrome's frame clock to ~10 Hz, which
// would measure the display, not the app (docs/PERF-TESTING.md).
if (conditions.rafBefore < (UNCAPPED ? 50 : 55)) {
  await browser.close();
  throw new Error(`frame clock ${conditions.rafBefore} rAF/s: the display is asleep or throttled`);
}
if (conditions.acPower === false) console.warn('on battery: GPU clocks are not comparable');

const results = { conditions, runs: {} };
for (const basemap of BASEMAPS) {
  if (SCENARIO === 'diag') {
    results.runs[basemap] = await diagRun(browser, basemap);
    continue;
  }
  const run = await pairedRun(browser, basemap);
  run.summary = summarise(run.rounds);
  results.runs[basemap] = run;
  console.log(`\n${basemap} ${CASE} ${SCENARIO} (${run.renderer})`);
  console.log(JSON.stringify(run.summary, null, 2));
}
conditions.rafAfter = round(await blankPageRafRate(browser));
await browser.close();
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nframe clock ${conditions.rafBefore} → ${conditions.rafAfter} rAF/s; ${path.join(outDir, 'results.json')}`);
