/**
 * Shared browser plumbing for the render gates: qa-perf (relative, runs on
 * SwiftShader) and qa-paced-render (absolute numbers on a real GPU).
 */
import puppeteer from 'puppeteer';

/** Flags that keep rAF and timers honest in a headless or covered window. */
const HONEST_CLOCK_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--window-size=1440,900',
  // Never let background/occlusion throttling freeze rAF or timers — the
  // measurements depend on an honest frame clock.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

/** ANGLE flags that put headless Chrome on the machine's real GPU. */
export function realGpuArgs(platform = process.platform) {
  const angle = platform === 'darwin' ? 'metal' : platform === 'win32' ? 'd3d11' : 'vulkan';
  return [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'];
}

/**
 * Flags that free the frame clock from the display. Headless Chrome on Windows
 * paces frames from the compositor's vsync, which falls to ~10 Hz when the
 * display sleeps: a blank page measured 10 rAF/s, then 53 with these.
 */
export const UNCAPPED_FRAME_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

/**
 * Launch headless Chrome; `gpu: true` asks for the real GPU, `uncapped: true`
 * decouples frames from the display (see UNCAPPED_FRAME_ARGS).
 */
export function launchProbeBrowser({ gpu = false, headless = 'new', uncapped = false } = {}) {
  return puppeteer.launch({
    headless,
    protocolTimeout: 300_000,
    args: [
      ...HONEST_CLOCK_ARGS,
      ...(gpu ? realGpuArgs() : []),
      ...(uncapped ? UNCAPPED_FRAME_ARGS : []),
    ],
  });
}

/** requestAnimationFrame callbacks per second on a blank page (the frame clock). */
export async function blankPageRafRate(browser, ms = 2000) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const rate = await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const frame = () => {
          n += 1;
          if (performance.now() - t0 < ms) requestAnimationFrame(frame);
          else resolve(n / ((performance.now() - t0) / 1000));
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );
  await page.close();
  return rate;
}

/** The WebGL renderer string the page's Cesium context is using. */
export function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = window.__godsEyeView?.viewer?.scene?.context?._gl;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : null;
  });
}

/** Park the camera over Austin, top-down, and turn every layer off. */
export function parkAndClear(page, { lon = -97.74, lat = 30.27, height = 60_000 } = {}) {
  return page.evaluate(async (lon, lat, height) => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    const ell = v.scene.globe.ellipsoid;
    v.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* gate reports via counts */ } }
    }
  }, lon, lat, height);
}

/**
 * Count scene postRender fires (renders), Cesium render-loop ticks (preUpdate,
 * which `targetFrameRate` can make fewer than rAF) and rAF ticks over windowMs.
 */
export function countFrames(page, windowMs) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const scene = window.__godsEyeView.viewer.scene;
    let renders = 0; let rafs = 0; let ticks = 0;
    const removeRender = scene.postRender.addEventListener(() => { renders += 1; });
    const removeTick = scene.preUpdate.addEventListener(() => { ticks += 1; });
    const t0 = performance.now();
    const tick = () => {
      rafs += 1;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else { removeRender(); removeTick(); resolve({ renders, rafs, ticks }); }
    };
    requestAnimationFrame(tick);
  }), windowMs);
}

/** The render governor's diagnostics, or null. */
export function governorDiagnostics(page) {
  return page.evaluate(() => window.__godsEyeView.getRenderGovernorDiagnostics?.()
    || window.__gevRenderGovernor?.getDiagnostics?.() || null);
}

/**
 * The HUD's semantic summary refreshes on this cadence (`src/hud.js`,
 * `HUD_SUMMARY_INTERVAL_MS`). A layer-visibility change marks it dirty, and
 * the tick that picks that up types the new text in — reflowing an occluder
 * and, with a paint lane active, costing frames. Mirrored rather than
 * imported because the harnesses run against the built app, not the module.
 */
const HUD_SUMMARY_INTERVAL_MS = 15_000;
/** One full refresh period, plus a second of margin, in 1 s windows. */
const QUIET_RUN_WINDOWS = Math.ceil(HUD_SUMMARY_INTERVAL_MS / 1_000) + 1;

/**
 * Wait until the scene is genuinely settled, and report whether it ever was.
 *
 * Requires a CONSECUTIVE RUN of empty one-second windows at least one full
 * summary refresh period long, and resets that run on any activity. One empty
 * window — or three — proves nothing here: the scene is genuinely idle for the
 * whole gap between a teardown and the tick that notices it, so a short
 * confirmation happily reports "quiet" moments before the typewriter fires.
 * A run longer than the period cannot straddle that gap: it either contains
 * the burst, and restarts, or it postdates it.
 *
 * `quiet: false` is a FAILURE, not a fall-through: a scene rendering every
 * frame never produces an empty window at all, so this is what catches a real
 * hot loop — and equally a contaminant that has stopped being a one-shot. The
 * bound stays comfortably longer than settling takes and comfortably shorter
 * than forever: worst case is one interrupted run, the burst itself, then a
 * clean run (~55 s), against a 120 s ceiling.
 */
export async function settleUntilQuiet(page, maxMs = 120_000, requiredConsecutive = QUIET_RUN_WINDOWS) {
  const deadline = Date.now() + maxMs;
  let windows = 0;
  let consecutive = 0;
  let busiest = 0;
  let restarts = 0;
  while (Date.now() < deadline) {
    windows += 1;
    const { renders } = await countFrames(page, 1_000);
    busiest = Math.max(busiest, renders);
    if (renders === 0) consecutive += 1;
    else { if (consecutive > 0) restarts += 1; consecutive = 0; }
    if (consecutive >= requiredConsecutive) {
      return { quiet: true, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
    }
  }
  // A failure here reads as "never held N empty seconds in a row, best run was
  // M, restarted R times, busiest window was B" — enough to tell a hot loop
  // from a contaminant that has stopped being a one-shot.
  return { quiet: false, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
}
