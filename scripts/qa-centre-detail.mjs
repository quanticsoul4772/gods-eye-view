#!/usr/bin/env node
/**
 * How long the middle of the view takes to come into focus on Google 3D
 * tiles, with Cesium's own refinement rule (`?refineFix=0`), with the app's
 * fix (default) and with Fast centre.
 *
 * For each view, in a fresh browser context with the cache off: park the
 * camera, then every 250 ms force a frame and count the drawn tiles that are
 * still coarser than Cesium's target (and have finer children) over the
 * central 30 % of the screen. "Sharp" is the first sample after which that
 * count stays 0. A view that never gets there shows "never".
 *
 * Needs a production build with GOOGLE_MAPS_API_KEY in .env (the key is baked
 * in at build time) and a real GPU. Each run is one billable Google tiles
 * session per view and mode. Not part of `npm test`.
 *
 *   npm run build && npx vite preview --port 4180 --strictPort
 *   npm run qa:centre-detail [-- --views austin,paris --modes default,fast]
 *
 * After a Cesium upgrade, run this with src/maps/tileRefinement.test.mjs:
 * the fix replaces a private Cesium function.
 */
import { launchProbeBrowser, webglRenderer } from './qa-renderProbe.mjs';

const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4180';
const argv = process.argv.slice(2);
const opt = (flag, fallback = null) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
const ALLOW_SOFTWARE = argv.includes('--allow-software');
const TIMEOUT_MS = Number(opt('--timeout', '30000'));

/** Oblique city views; Austin is the reported blurry-centre view. */
const VIEWS = {
  austin: { lat: 30.2672, lon: -97.7431, alt: 841, heading: 0, pitch: -30 },
  manhattan: { lat: 40.758, lon: -73.9855, alt: 600, heading: 200, pitch: -25 },
  sanfrancisco: {
    lat: 37.7955,
    lon: -122.3937,
    alt: 900,
    heading: 270,
    pitch: -35,
  },
  tokyo: { lat: 35.6595, lon: 139.7005, alt: 700, heading: 0, pitch: -30 },
  paris: { lat: 48.8584, lon: 2.2945, alt: 800, heading: 120, pitch: -30 },
};
const MODES = {
  cesium: { query: '?refineFix=0', fastCentre: false },
  default: { query: '', fastCentre: false },
  fast: { query: '', fastCentre: true },
};
const pick = (flag, all) => {
  const names = (opt(flag, '') || '').split(',').filter(Boolean);
  for (const name of names)
    if (!all[name]) throw new Error(`Unknown ${flag.slice(2)} "${name}"`);
  return names.length ? names : Object.keys(all);
};

async function measure(browser, view, mode) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setCacheEnabled(false);
    let tileRequests = 0;
    page.on('request', (request) => {
      if (/tile\.googleapis\.com/.test(request.url())) tileRequests += 1;
    });
    await page.goto(`${APP_URL}/${mode.query}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__godsEyeView?.viewer, {
      timeout: 180_000,
      polling: 100,
    });
    const renderer = await webglRenderer(page);
    if (
      /swiftshader|llvmpipe|software/i.test(renderer || '') &&
      !ALLOW_SOFTWARE
    )
      throw new Error(
        `Software renderer (${renderer}); pass --allow-software for relative numbers only`,
      );
    const ready = await page.evaluate(() =>
      Boolean(window.__godsEyeView.tileset && window.Cesium),
    );
    if (!ready)
      throw new Error(
        'No Google 3D tileset (or no Cesium global): build with GOOGLE_MAPS_API_KEY and serve the production build',
      );
    if (mode.fastCentre)
      await page.evaluate(() =>
        window.__godsEyeView.styleManager._visualSettings._setTileDetailMode(
          'fast-centre',
          { syncShare: false, persist: false },
        ),
      );
    const requestsBefore = tileRequests;
    const result = await page.evaluate(
      async (view, timeoutMs) => {
        const Cesium = window.Cesium;
        const { viewer, tileset, requestRender } = window.__godsEyeView;
        const { scene, camera } = viewer;
        viewer.trackedEntity = undefined;
        camera.cancelFlight?.();
        camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            view.lon,
            view.lat,
            view.alt,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(view.heading),
            pitch: Cesium.Math.toRadians(view.pitch),
            roll: 0,
          },
        });
        const nextFrame = () =>
          new Promise((resolve) => {
            const remove = scene.postRender.addEventListener(() => {
              remove();
              resolve();
            });
            requestRender();
          });
        const canvas = scene.canvas;
        const centralRays = () => {
          const w = canvas.clientWidth;
          const h = canvas.clientHeight;
          const rays = [];
          for (const fx of [-0.15, 0, 0.15])
            for (const fy of [-0.15, 0, 0.15])
              rays.push(
                camera.getPickRay(
                  new Cesium.Cartesian2(w * (0.5 + fx), h * (0.5 + fy)),
                ),
              );
          return rays;
        };
        const coarseCentre = () => {
          const target = tileset.memoryAdjustedScreenSpaceError;
          const rays = centralRays();
          let count = 0;
          for (const tile of tileset._selectedTiles) {
            if (!tile.children.length || tile._finalResolution === false)
              continue;
            if (!(tile._screenSpaceError > target)) continue;
            if (
              rays.some((ray) =>
                Cesium.IntersectionTests.raySphere(ray, tile.boundingSphere),
              )
            )
              count += 1;
          }
          return count;
        };
        const start = performance.now();
        let lastCoarseMs = 0;
        let tilesLoadedMs = null;
        let coarse = 0;
        while (performance.now() - start < timeoutMs) {
          await nextFrame();
          const now = performance.now() - start;
          coarse = coarseCentre();
          if (coarse > 0) lastCoarseMs = now;
          if (tileset.tilesLoaded && tilesLoadedMs === null)
            tilesLoadedMs = now;
          if (!tileset.tilesLoaded) tilesLoadedMs = null;
          if (tilesLoadedMs !== null && coarse === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return {
          sharpMs: coarse === 0 ? lastCoarseMs : null,
          tilesLoadedMs,
          coarseAtEnd: coarse,
          memoryMiB: tileset.totalMemoryUsageInBytes / 2 ** 20,
          tilesWithContent: tileset.statistics.numberOfTilesWithContentReady,
        };
      },
      view,
      TIMEOUT_MS,
    );
    return { ...result, tileRequests: tileRequests - requestsBefore };
  } finally {
    await context.close();
  }
}

const views = pick('--views', VIEWS);
const modes = pick('--modes', MODES);
const browser = await launchProbeBrowser({ gpu: true });
const rows = [];
let failed = false;
try {
  for (const viewName of views)
    for (const modeName of modes) {
      try {
        const r = await measure(browser, VIEWS[viewName], MODES[modeName]);
        rows.push({
          view: viewName,
          mode: modeName,
          'sharp centre':
            r.sharpMs === null ? 'never' : `${(r.sharpMs / 1000).toFixed(1)} s`,
          'tiles loaded':
            r.tilesLoadedMs === null
              ? '-'
              : `${(r.tilesLoadedMs / 1000).toFixed(1)} s`,
          'coarse at end': r.coarseAtEnd,
          'memory MiB': Math.round(r.memoryMiB),
          'tiles ready': r.tilesWithContent,
          requests: r.tileRequests,
        });
      } catch (error) {
        failed = true;
        rows.push({
          view: viewName,
          mode: modeName,
          'sharp centre': `ERROR ${error.message}`,
        });
        if (/Software renderer|No Google 3D tileset/.test(error.message))
          throw error;
      }
    }
} finally {
  await browser.close();
  console.table(rows);
}
process.exitCode = failed ? 1 : 0;
