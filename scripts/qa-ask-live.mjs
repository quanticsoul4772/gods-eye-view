#!/usr/bin/env node
/**
 * qa-ask-live.mjs — real Ask Claude turns against the real app.
 *
 * Where qa-ask-claude.mjs scripts Claude's replies (free, deterministic UI
 * proof) and qa-voice-bench.mjs stubs the tools (routing only), this runs the
 * whole path: the typed prompt goes through the composer to /api/claude/ask,
 * the model's app actions run in the page, and every round trip is recorded.
 * It finds bugs inside the tools (a wrong country label, a fly-to that lands
 * in the wrong Paris) that neither of those can see.
 *
 * It spends API credit: one Ask Claude conversation per prompt on the
 * server's configured model (claude-haiku-5-5 unless GEV_ASK_MODEL says
 * otherwise). Needs the dev server with ANTHROPIC_API_KEY.
 *
 * Usage:
 *   node scripts/qa-ask-live.mjs                 every prompt
 *   node scripts/qa-ask-live.mjs --only dubai,iss ids containing either
 *   node scripts/qa-ask-live.mjs --gpu           real GPU (default SwiftShader)
 *
 * Output (gitignored): qa-shots/ask-live/<stamp>/results.jsonl, report.md and
 * one screenshot per prompt. Exit code 1 when any machine check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchProbeBrowser } from './qa-renderProbe.mjs';
import { PROMPTS } from './ask-live/prompts.mjs';

const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
const gpu = argv.includes('--gpu');
const TURN_TIMEOUT_MS = 150_000;
const DEFAULT_START = { lat: 20, lon: 0, height: 12_000_000, pitch: -90 };

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('qa-shots', 'ask-live', stamp);
fs.mkdirSync(outDir, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const r = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** The text of a tool_result block's content. */
const resultText = (block) =>
  typeof block.content === 'string'
    ? block.content
    : (block.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

/** Did this tool result report a failure? (`ok: false` or an error field.) */
const resultFailed = (text, block) => {
  if (block.is_error) return true;
  try {
    const parsed = JSON.parse(text);
    return parsed?.ok === false || Boolean(parsed?.error);
  } catch {
    return /^\s*(error|failed)\b/i.test(text);
  }
};

const prompts = PROMPTS.filter(
  (p) => !only || only.split(',').some((part) => p.id.includes(part)),
);
const browser = await launchProbeBrowser({ gpu });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() =>
  sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
);

let rounds = [];
let pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});
page.on('request', (request) => {
  if (!request.url().endsWith('/api/claude/ask')) return;
  let messages = [];
  try {
    ({ messages = [] } = JSON.parse(request.postData() || '{}'));
  } catch {
    /* not JSON: recorded as an empty round */
  }
  rounds.push({ sentAt: Date.now(), messages, request });
});
page.on('response', async (response) => {
  if (!response.url().endsWith('/api/claude/ask')) return;
  const round = rounds.find((r) => r.request === response.request());
  if (!round) return;
  round.receivedAt = Date.now();
  round.status = response.status();
  try {
    round.body = await response.json();
  } catch {
    round.body = null;
  }
});

/** Every tool call and result across a conversation, in order. */
function transcript(conversationRounds) {
  const last = conversationRounds.at(-1);
  const messages = last?.body?.messages || last?.messages || [];
  const names = new Map();
  const calls = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        names.set(block.id, block.name);
        calls.push({ id: block.id, name: block.name, input: block.input });
      }
      if (block.type === 'tool_result') {
        const call = calls.find((c) => c.id === block.tool_use_id);
        const text = resultText(block);
        if (call) {
          call.result = text.length > 600 ? `${text.slice(0, 600)}…` : text;
          call.failed = resultFailed(text, block);
        }
      }
    }
  }
  return calls;
}

async function resetApp(start) {
  await page.evaluate(async (s) => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.trackedEntity = undefined;
    v.camera.cancelFlight();
    gev.styleManager.setHudLayout?.('professional');
    gev.annotations?.clear?.();
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) {
        try {
          await gev.dataManager.setEnabled(id, false, { origin: 'user' });
        } catch {
          /* a layer that will not turn off shows up in the next row */
        }
      }
    }
    const rad = Math.PI / 180;
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: s.lon * rad,
        latitude: s.lat * rad,
        height: s.height,
      }),
      orientation: { heading: 0, pitch: s.pitch * rad, roll: 0 },
    });
  }, start);
  const newChat = await page.$('#gev-ask-composer .gev-ask-new');
  if (newChat && (await newChat.evaluate((b) => !b.hidden && !b.disabled)))
    await newChat.click();
  await pause(3000);
}

async function appState() {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const c = gev.viewer.camera.positionCartographic;
    return {
      camera: {
        lat: (c.latitude * 180) / Math.PI,
        lon: (c.longitude * 180) / Math.PI,
        heightM: Math.round(c.height),
        headingDeg:
          Math.round((gev.viewer.camera.heading * 180) / Math.PI) % 360,
      },
      layersOn: gev.dataManager
        .getAll()
        .filter((l) => l.enabled)
        .map((l) => l.id),
      hudLayout: document.documentElement.dataset.hudLayout,
      tracking: Boolean(gev.viewer.trackedEntity),
      answer:
        document.getElementById('gev-voice-card-assistant-text')?.textContent ||
        '',
      status:
        document.querySelector('#gev-ask-composer .gev-ask-status span')
          ?.textContent || '',
    };
  });
}

/**
 * Seconds until the middle of the view is sharp: no drawn Google 3D tile
 * under any of nine rays through the central 30 % of the screen is still
 * coarser than Cesium's target while a child of it is in view (so it is
 * waiting to refine). Forces a frame per sample. Same measure as
 * scripts/qa-centre-detail.mjs. null when it never got there.
 */
async function centreSharpSeconds(limitS) {
  return page.evaluate(async (limitMs) => {
    const gev = window.__godsEyeView;
    const tileset = gev.tileset;
    if (!tileset) return { error: 'no Google 3D tiles (no key?)' };
    const { scene, camera } = gev.viewer;
    const frame = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        gev.requestRender();
      });
    const hits = (ray, sphere) => {
      const o = ray.origin;
      const d = ray.direction;
      const c = sphere.center;
      const lx = c.x - o.x;
      const ly = c.y - o.y;
      const lz = c.z - o.z;
      const along = lx * d.x + ly * d.y + lz * d.z;
      if (along < 0) return lx * lx + ly * ly + lz * lz <= sphere.radius ** 2;
      const miss = lx * lx + ly * ly + lz * lz - along * along;
      return miss <= sphere.radius ** 2;
    };
    const coarse = () => {
      const w = scene.canvas.clientWidth;
      const h = scene.canvas.clientHeight;
      const rays = [];
      for (const fx of [-0.15, 0, 0.15])
        for (const fy of [-0.15, 0, 0.15])
          rays.push(
            camera.getPickRay({ x: w * (0.5 + fx), y: h * (0.5 + fy) }),
          );
      const target = tileset.memoryAdjustedScreenSpaceError;
      let count = 0;
      for (const tile of tileset._selectedTiles) {
        if (
          tile._finalResolution === false ||
          !tile.children.some((child) => child.isVisible)
        )
          continue;
        if (!(tile._screenSpaceError > target)) continue;
        if (rays.some((ray) => hits(ray, tile.boundingSphere))) count += 1;
      }
      return count;
    };
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      await frame();
      const count = coarse();
      if (count === 0 && tileset.tilesLoaded)
        return { seconds: (performance.now() - start) / 1000 };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { seconds: null, coarse: coarse() };
  }, limitS * 1000);
}

function runChecks(checks = {}, calls, state, rounds) {
  const failures = [];
  const called = new Set(calls.map((c) => c.name));
  for (const tool of checks.tools || [])
    if (!called.has(tool)) failures.push(`did not call ${tool}`);
  for (const tool of checks.noTools || [])
    if (called.has(tool)) failures.push(`called ${tool}`);
  if (checks.answer && !checks.answer.test(state.answer))
    failures.push(`answer does not match ${checks.answer}`);
  if (checks.answerNot && checks.answerNot.test(state.answer))
    failures.push(`answer matches ${checks.answerNot}`);
  if (checks.cameraNear) {
    const { lat, lon, km } = checks.cameraNear;
    const d = haversineKm(lat, lon, state.camera.lat, state.camera.lon);
    if (d > km)
      failures.push(`camera ${Math.round(d)} km from target (max ${km})`);
  }
  if (
    Number.isFinite(checks.minHeightM) &&
    state.camera.heightM < checks.minHeightM
  )
    failures.push(
      `camera at ${state.camera.heightM} m (min ${checks.minHeightM})`,
    );
  for (const id of checks.layersOn || [])
    if (!state.layersOn.includes(id)) failures.push(`layer ${id} not on`);
  for (const id of checks.layersOff || [])
    if (state.layersOn.includes(id)) failures.push(`layer ${id} is on`);
  if (checks.maxRounds && rounds > checks.maxRounds)
    failures.push(`${rounds} round trips (max ${checks.maxRounds})`);
  if (checks.hudLayout && state.hudLayout !== checks.hudLayout)
    failures.push(
      `HUD layout ${state.hudLayout}, expected ${checks.hudLayout}`,
    );
  if (checks.facing) {
    const { headingDeg, toleranceDeg } = checks.facing;
    const off = Math.abs(
      ((state.camera.headingDeg - headingDeg + 540) % 360) - 180,
    );
    if (off > toleranceDeg)
      failures.push(
        `camera faces ${state.camera.headingDeg}°, expected ${headingDeg}° ± ${toleranceDeg}`,
      );
  }
  if (checks.centreSharp) {
    const sharp = state.centreSharp;
    if (sharp?.error) failures.push(`centre sharpness: ${sharp.error}`);
    else if (sharp?.seconds == null)
      failures.push(
        `centre still coarse after ${checks.centreSharp} s (${sharp?.coarse} tiles)`,
      );
  }
  return failures;
}

const results = [];
try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.getElementById('gev-ask-button') &&
      window.__godsEyeView?.voiceCommands?.runner,
    { timeout: 150_000 },
  );
  await pause(4000);
  await page.keyboard.press('/');
  await page.waitForSelector('#gev-ask-composer input', { visible: true });

  for (const item of prompts) {
    await resetApp(item.start || DEFAULT_START);
    rounds = [];
    pageErrors = [];
    const startedAt = Date.now();
    let timedOut = false;
    // A follow-up (`then`) is typed into the same conversation once the
    // previous turn has finished.
    for (const text of [item.prompt, ...(item.then || [])]) {
      await page.$eval('#gev-ask-composer input', (input) => {
        input.value = '';
        input.focus();
      });
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      try {
        await page.waitForFunction(
          () =>
            !document.querySelector('#gev-ask-composer .gev-ask-cancel')
              ?.hidden,
          { timeout: 10_000 },
        );
      } catch {
        /* answered before the cancel button showed */
      }
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('#gev-ask-composer .gev-ask-cancel')?.hidden,
          { timeout: TURN_TIMEOUT_MS },
        );
      } catch {
        timedOut = true;
        break;
      }
      if (item.then) await pause(2500);
    }
    await pause(2500); // let a final fly-to settle before reading the camera
    const totalMs = Date.now() - startedAt;
    const state = await appState();
    if (item.checks?.centreSharp)
      state.centreSharp = await centreSharpSeconds(item.checks.centreSharp);
    const calls = transcript(rounds);
    const modelMs = rounds.reduce(
      (sum, r) => sum + ((r.receivedAt || r.sentAt) - r.sentAt),
      0,
    );
    const usage = rounds.reduce(
      (sum, r) => {
        const u = r.body?.usage || {};
        sum.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
        sum.output += u.output_tokens || 0;
        return sum;
      },
      { input: 0, output: 0 },
    );
    const failures = runChecks(item.checks, calls, state, rounds.length);
    if (timedOut) failures.push('turn did not finish');
    const errors = rounds
      .map((r) => r.body?.error)
      .filter(Boolean)
      .concat(
        rounds.filter((r) => r.status >= 400).map((r) => `HTTP ${r.status}`),
      );
    const shot = `${item.id}.png`;
    await page.screenshot({ path: path.join(outDir, shot) });
    const row = {
      id: item.id,
      prompt: item.prompt,
      totalMs,
      modelMs,
      clientMs: Math.max(0, totalMs - modelMs - 2500),
      rounds: rounds.length,
      usage,
      calls,
      failedCalls: calls.filter((c) => c.failed).map((c) => c.name),
      errors,
      pageErrors: [...new Set(pageErrors)].slice(0, 5),
      state,
      failures,
      shot,
    };
    results.push(row);
    fs.appendFileSync(
      path.join(outDir, 'results.jsonl'),
      `${JSON.stringify(row)}\n`,
    );
    console.log(
      `${failures.length ? 'FAIL' : 'ok  '} ${item.id.padEnd(30)} ${String(
        Math.round(totalMs / 100) / 10,
      ).padStart(
        5,
      )}s  ${calls.map((c) => c.name + (c.failed ? '!' : '')).join(' → ') || '(no tools)'}${failures.length ? `  [${failures.join('; ')}]` : ''}`,
    );
  }
} finally {
  await browser.close();
}

const md = [
  `# Ask Claude live run ${stamp}`,
  '',
  `${results.length} prompts, ${results.filter((r) => r.failures.length).length} with failed checks.`,
  '',
  '| id | s | model s | rounds | tools | checks |',
  '|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.id} | ${(r.totalMs / 1000).toFixed(1)} | ${(r.modelMs / 1000).toFixed(1)} | ${r.rounds} | ${r.calls.map((c) => c.name + (c.failed ? '!' : '')).join(', ')} | ${r.failures.join('; ') || 'ok'} |`,
  ),
  '',
  ...results.flatMap((r) => [
    `## ${r.id}`,
    '',
    `> ${r.prompt}`,
    '',
    ...r.calls.map(
      (c) =>
        `- \`${c.name}\` ${JSON.stringify(c.input)}${c.failed ? ' **FAILED**' : ''}\n  - ${String(
          c.result || '',
        )
          .replace(/\n/g, ' ')
          .slice(0, 300)}`,
    ),
    '',
    `**Answer:** ${r.state.answer || '(none)'}`,
    '',
    `Camera ${r.state.camera.lat.toFixed(3)}, ${r.state.camera.lon.toFixed(3)} at ${r.state.camera.heightM} m; layers: ${r.state.layersOn.join(', ') || 'none'}; HUD ${r.state.hudLayout}.`,
    ...(r.pageErrors.length
      ? ['', `Page errors: ${r.pageErrors.join(' | ')}`]
      : []),
    ...(r.errors.length ? ['', `Errors: ${r.errors.join(' | ')}`] : []),
    '',
  ]),
].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), md);
console.log(`\nReport: ${path.join(outDir, 'report.md')}`);
process.exitCode = results.some((r) => r.failures.length) ? 1 : 0;
