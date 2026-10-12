#!/usr/bin/env node
/**
 * qa-paced-render — how many frames the scene draws, and how many of them
 * show anything new, on this machine's REAL GPU. A measurement harness, not a
 * pass/fail gate: run it before and after a render-governor change and compare
 * the JSON it writes.
 *
 * Per 10 s window it records:
 *   ticks/s       Cesium render-loop ticks (preUpdate; `targetFrameRate` caps these)
 *   renders/s     frames actually drawn (postRender)
 *   moving/s      drawn frames that carried billboard changes — frames that
 *                 showed motion (read from each BillboardCollection's count of
 *                 billboards changed since its last draw)
 *   wasted/s      drawn frames with no billboard change at all
 *   gapP95/gapMax ms between moving frames (how smooth the motion looks)
 *   renderMs/s    JS time from the tick's start to postRender on drawn frames
 *   tilesPending  drawn frames while globe tiles were still loading (window is
 *                 unreliable when > 0)
 *   aircraft      Live Flights count, so before/after runs compare like traffic
 *   gpu3d%        average 3D-engine utilisation of the whole machine (Windows
 *                 typeperf), sampled during the window
 *
 * Usage: node scripts/qa-paced-render.mjs [--url http://localhost:4173]
 *          [--out claudedocs/paced-render-after.json] [--shots dir]
 *          [--detection-off]
 * Add `?pacedRender=0` to --url for the continuous-render control run.
 * Requires a running dev server. Refuses to run on SwiftShader.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  governorDiagnostics,
  launchProbeBrowser,
  parkAndClear,
  webglRenderer,
} from './qa-renderProbe.mjs';

const argv = process.argv;
const arg = (name, fallback) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const url = arg('--url', 'http://localhost:4173');
const out = arg('--out', null);
const shots = arg('--shots', null);
const detectionOff = argv.includes('--detection-off');
const WINDOW_MS = 10_000;
const DENVER = { lon: -104.99, lat: 39.74, height: 60_000 };

/** Average whole-machine 3D-engine utilisation over `seconds` (Windows only). */
function sampleGpu(seconds) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = '';
    const proc = spawn('typeperf', [
      '\\GPU Engine(*engtype_3D)\\Utilization Percentage',
      '-si', '1', '-sc', String(seconds),
    ]);
    proc.stdout.on('data', (chunk) => { text += chunk; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const rows = text.split(/\r?\n/).filter((line) => /^"\d/.test(line));
      const sums = rows.map((row) =>
        row.split('","').slice(1)
          .map((cell) => Number(cell.replace(/"/g, '')))
          .filter(Number.isFinite)
          .reduce((a, b) => a + b, 0));
      resolve(sums.length ? +(sums.reduce((a, b) => a + b, 0) / sums.length).toFixed(1) : null);
    });
  });
}

/**
 * Install the in-page probe: finds every BillboardCollection under the scene.
 * Cesium's billboard setters are not configurable, so instead of wrapping them
 * the probe reads each collection's own count of billboards changed since its
 * last draw (`_billboardsToUpdateIndex`, reset when the frame draws them). Read
 * in preRender after the layers' own ticks, it says whether this frame shows
 * any change. Re-run before each window: layers add collections as they load.
 */
function installProbe(page) {
  return page.evaluate(() => {
    const collections = [];
    const walk = (node, depth = 0) => {
      if (!node || depth > 5) return;
      if (typeof node._billboardsToUpdateIndex === 'number') collections.push(node);
      if (typeof node.get === 'function' && Number.isFinite(node.length))
        for (let i = 0; i < node.length; i += 1) walk(node.get(i), depth + 1);
    };
    walk(window.__godsEyeView.viewer.scene.primitives);
    window.__pacedProbe = {
      collections,
      pending: () => collections.reduce((sum, c) => sum + (c.isDestroyed?.() ? 0 : c._billboardsToUpdateIndex), 0),
    };
    return collections.length;
  });
}

/**
 * Measure one window in the page. `drive` names an optional per-tick camera
 * driver; `everyTick` requests a frame on every tick, which draws exactly what
 * continuous rendering draws — the in-page control for a paced window, under
 * the same traffic and machine load.
 */
function measureWindow(page, ms, drive = null, everyTick = false) {
  return page.evaluate((ms, drive, everyTick) => new Promise((resolve) => {
    const gev = window.__godsEyeView;
    const scene = gev.viewer.scene;
    const probe = window.__pacedProbe ?? { pending: () => 0 };
    let ticks = 0; let renders = 0; let moving = 0; let tilesPending = 0;
    let renderMs = 0; let frameStart = 0; let frameChanged = false;
    let lastMovingAt = null; const gaps = [];
    // Timed from the tick's start, so the layers' own preRender work counts.
    const onTick = () => {
      ticks += 1;
      frameStart = performance.now();
      if (drive === 'pan') gev.viewer.camera.rotateRight(0.0006);
      if (everyTick) scene.requestRender();
    };
    // Per collection too: two fleets stepping on the same frame is one moving
    // frame, so the per-collection rates show whether each fleet still steps.
    const perCollection = new Map();
    const onPreRender = () => {
      frameChanged = probe.pending() > 0;
      for (const collection of probe.collections ?? [])
        if (!collection.isDestroyed?.() && collection._billboardsToUpdateIndex > 0)
          perCollection.set(collection, (perCollection.get(collection) ?? 0) + 1);
    };
    const onPostRender = () => {
      const now = performance.now();
      renderMs += now - frameStart;
      renders += 1;
      if (!scene.globe.tilesLoaded) tilesPending += 1;
      if (frameChanged) {
        moving += 1;
        if (lastMovingAt !== null) gaps.push(now - lastMovingAt);
        lastMovingAt = now;
      }
    };
    const removers = [
      scene.preUpdate.addEventListener(onTick),
      scene.preRender.addEventListener(onPreRender),
      scene.postRender.addEventListener(onPostRender),
    ];
    setTimeout(() => {
      for (const remove of removers) remove();
      gaps.sort((a, b) => a - b);
      const per = (n) => +(n / ms * 1000).toFixed(1);
      resolve({
        ticksPerSec: per(ticks),
        rendersPerSec: per(renders),
        movingPerSec: per(moving),
        wastedPerSec: per(renders - moving),
        gapP95Ms: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]) : null,
        gapMaxMs: gaps.length ? Math.round(gaps.at(-1)) : null,
        renderMsPerSec: Math.round(renderMs / ms * 1000),
        tilesPending,
        aircraft: gev.dataManager.layers.get('flights')?.module?.getStats?.()?.count ?? null,
        // Busiest billboard collections' changed frames per second.
        collectionStepsPerSec: [...perCollection.values()].sort((a, b) => b - a).slice(0, 3).map(per),
      });
    }, ms);
  }), ms, drive, everyTick);
}

/** Time from a camera stop to the first frame that carries billboard changes. */
function rotationAfterStop(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const { viewer } = window.__godsEyeView;
    const probe = window.__pacedProbe;
    let ticks = 0;
    const removePan = viewer.scene.preUpdate.addEventListener(() => {
      ticks += 1;
      if (ticks <= 30) viewer.camera.rotateRight(0.003);
    });
    const removeEnd = viewer.camera.moveEnd.addEventListener(() => {
      removeEnd();
      removePan();
      const stoppedAt = performance.now();
      const removePre = viewer.scene.preRender.addEventListener(() => {
        if (probe.pending() === 0) return;
        removePre();
        resolve(Math.round(performance.now() - stoppedAt));
      });
      setTimeout(() => { removePre(); resolve(null); }, 3000);
    });
  }));
}

/** Time from tracking a plane to the first drawn frame afterwards. */
function trackLatency(page) {
  return page.evaluate(async () => {
    const { viewer, voiceCommands } = window.__godsEyeView;
    const query = await voiceCommands.runner('analyst_query', {
      layers: ['flights'], scope: { kind: 'view' }, sortBy: 'altitudeM', sortDir: 'desc', limit: 1,
    });
    const callsign = JSON.stringify(query).match(/"callsign":"([A-Z0-9]{3,8})"/)?.[1];
    if (!callsign) return { callsign: null, firstFrameMs: null };
    let changedAt = null; let firstFrameMs = null;
    const removeChanged = viewer.trackedEntityChanged.addEventListener(() => { changedAt = performance.now(); });
    const removePost = viewer.scene.postRender.addEventListener(() => {
      if (changedAt !== null && firstFrameMs === null) firstFrameMs = Math.round(performance.now() - changedAt);
    });
    await voiceCommands.runner('track_entity', { query: callsign, layerId: 'flights' });
    await new Promise((r) => setTimeout(r, 1500));
    removeChanged(); removePost();
    return { callsign, firstFrameMs };
  });
}

async function scenario(page, label, { drive = null, everyTick = false } = {}) {
  await installProbe(page);
  const [window, gpu3dPercent] = await Promise.all([
    measureWindow(page, WINDOW_MS, drive, everyTick),
    sampleGpu(Math.floor(WINDOW_MS / 1000) - 1),
  ]);
  const governor = await governorDiagnostics(page);
  const result = { label, ...window, gpu3dPercent, mode: governor?.mode, holds: governor?.holds, paced: governor?.paced ?? null };
  console.log(`  ${label.padEnd(30)} ticks ${result.ticksPerSec}/s  renders ${result.rendersPerSec}/s  moving ${result.movingPerSec}/s  wasted ${result.wastedPerSec}/s  per-collection [${result.collectionStepsPerSec}]  gap p95 ${result.gapP95Ms} ms  render JS ${result.renderMsPerSec} ms/s  gpu ${gpu3dPercent}%  tiles ${result.tilesPending}  aircraft ${result.aircraft}  mode ${result.mode}`);
  if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/\W+/g, '-')}.png`) });
  return result;
}

const browser = await launchProbeBrowser({ gpu: true });
const report = { url, at: new Date().toISOString(), scenarios: [] };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.voiceCommands?.runner, { timeout: 120_000 });
  report.renderer = await webglRenderer(page);
  if (!report.renderer || /swiftshader/i.test(report.renderer))
    throw new Error(`Not on a real GPU: ${report.renderer}`);
  console.log(`renderer: ${report.renderer}`);
  if (shots) fs.mkdirSync(shots, { recursive: true });
  await new Promise((r) => setTimeout(r, 12_000));
  await parkAndClear(page, DENVER);
  report.detection = detectionOff ? 'off' : 'default';
  if (detectionOff)
    await page.evaluate(() => window.__godsEyeView.styleManager._setDetectionMode('OFF'));
  await new Promise((r) => setTimeout(r, 12_000));

  const add = (r) => report.scenarios.push(r);
  add(await scenario(page, 'idle'));
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('flights', true, { origin: 'user' }));
  await new Promise((r) => setTimeout(r, 25_000));
  if (!(await installProbe(page))) throw new Error('No billboard collection found to probe');
  // Control (every tick drawn) and paced windows alternate under the same
  // traffic and machine state; compare them pairwise.
  for (const round of [1, 2]) {
    add(await scenario(page, `flights parked control ${round}`, { everyTick: true }));
    add(await scenario(page, `flights parked ${round}`));
  }
  add(await scenario(page, 'flights pan', { drive: 'pan' }));
  report.rotationAfterStopMs = await rotationAfterStop(page);
  console.log(`  rotation pass after camera stop: ${report.rotationAfterStopMs} ms`);
  await new Promise((r) => setTimeout(r, 3_000));
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('military', true, { origin: 'user' }));
  await new Promise((r) => setTimeout(r, 20_000));
  for (const round of [1, 2]) {
    add(await scenario(page, `flights+mil parked control ${round}`, { everyTick: true }));
    add(await scenario(page, `flights+mil parked ${round}`));
  }
  report.track = await trackLatency(page);
  console.log(`  track ${report.track.callsign}: first frame after ${report.track.firstFrameMs} ms`);
  add(await scenario(page, 'tracked flight'));
} finally {
  await browser.close();
}
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
