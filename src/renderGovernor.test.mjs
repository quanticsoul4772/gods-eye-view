import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
  getRenderGovernorDiagnostics,
  holdPacedRender,
  markPacedStep,
  releasePacedRender,
  uninstallRenderGovernor,
  _resetRenderGovernorForTest,
} from './renderGovernor.js';

function makeViewer() {
  const calls = { requestRender: 0 };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() { calls.requestRender += 1; },
  };
  return { viewer: { scene }, scene, calls };
}

beforeEach(() => _resetRenderGovernorForTest());

test('install with zero holds enters idle mode and pins maximumRenderTimeChange', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  assert.equal(scene.requestRenderMode, true);
  assert.equal(scene.maximumRenderTimeChange, Infinity);
  assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
});

test('a hold flips to continuous; releasing the last hold returns to idle with a settling frame', () => {
  const { viewer, scene, calls } = makeViewer();
  installRenderGovernor(viewer);
  const settleBaseline = calls.requestRender;
  holdContinuousRender('flights');
  assert.equal(scene.requestRenderMode, false);
  assert.equal(getRenderGovernorDiagnostics().mode, 'continuous');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, true);
  // Entering idle renders one settling frame.
  assert.equal(calls.requestRender, settleBaseline + 1);
});

test('holds are identity-keyed: double-hold cannot leak, double-release cannot corrupt', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdContinuousRender('traffic');
  holdContinuousRender('traffic');
  releaseContinuousRender('traffic');
  assert.equal(scene.requestRenderMode, true, 'single release clears an idempotent double-hold');
  releaseContinuousRender('traffic');
  releaseContinuousRender('never-held');
  assert.equal(scene.requestRenderMode, true);
});

test('mode stays continuous until the LAST holder releases', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdContinuousRender('flights');
  holdContinuousRender('satellites');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, ['satellites']);
  releaseContinuousRender('satellites');
  assert.equal(scene.requestRenderMode, true);
});

test('governorRequestRender forwards to the scene and records reasons only in idle mode', () => {
  const { viewer, calls } = makeViewer();
  installRenderGovernor(viewer);
  const baseline = calls.requestRender;
  governorRequestRender('layer-tick:earthquakes');
  assert.equal(calls.requestRender, baseline + 1);
  assert.equal(getRenderGovernorDiagnostics().recentRequests.at(-1).reason, 'layer-tick:earthquakes');
  holdContinuousRender('flights');
  const idleRequests = getRenderGovernorDiagnostics().recentRequests.length;
  governorRequestRender('slider');
  assert.equal(
    getRenderGovernorDiagnostics().recentRequests.length,
    idleRequests,
    'continuous-mode requests are not recorded as idle diagnostics',
  );
});

test('hold/release/request are safe no-ops before install (test environments without a viewer)', () => {
  holdContinuousRender('flights');
  releaseContinuousRender('flights');
  governorRequestRender('noop');
  assert.equal(getRenderGovernorDiagnostics().installed, false);
});

test('holds registered before install apply at install time', () => {
  holdContinuousRender('flights');
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  assert.equal(scene.requestRenderMode, false, 'pre-install hold keeps continuous mode');
  releaseContinuousRender('flights');
  assert.equal(scene.requestRenderMode, true);
});

// ── Paced holds ──────────────────────────────────────────────────────────────

/** A Cesium-like Event: add returns a remover; raise calls every listener. */
function makeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
  };
}

/**
 * A scene whose `tick()` mirrors Cesium's Scene.render ordering: preUpdate on
 * every tick, preRender only when a frame is drawn (requested, or continuous).
 */
function makePacedViewer() {
  const clock = { t: 0 };
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    renderRequested: false,
    preUpdate: makeEvent(),
    preRender: makeEvent(),
    requestRender() {
      this.renderRequested = true;
    },
    tick(ms = 1000 / 60) {
      clock.t += ms;
      this.preUpdate.raise();
      const draw = !this.requestRenderMode || this.renderRequested;
      this.renderRequested = false;
      if (draw) this.preRender.raise();
      return draw;
    },
  };
  _resetRenderGovernorForTest({ now: () => clock.t });
  return { viewer: { scene }, scene, clock };
}

/** Run `seconds` of 60 Hz ticks; return the times frames were drawn. */
function runFor(scene, clock, seconds) {
  const drawn = [];
  const end = clock.t + seconds * 1000;
  while (clock.t < end) if (scene.tick()) drawn.push(clock.t);
  return drawn;
}

/** An owner's step gate as the layers write it: whole ms, in preRender. */
function ownerGate(scene, clock, interval) {
  const steps = [];
  let last = -Infinity;
  scene.preRender.addEventListener(() => {
    const now = Math.floor(clock.t);
    if (now - last < interval) return;
    last = now;
    steps.push(now);
  });
  return steps;
}

const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

test('a paced hold draws one frame per step and stays in request-render mode', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  runFor(scene, clock, 1);
  holdPacedRender('flights', 80);
  assert.equal(scene.requestRenderMode, true);
  assert.equal(getRenderGovernorDiagnostics().mode, 'paced');
  assert.deepEqual(getRenderGovernorDiagnostics().paced, { flights: 80 });
  assert.ok(scene.tick(), 'the first step is drawn on the next tick');
  const drawn = runFor(scene, clock, 2);
  // 80 ms + the 2 ms margin lands on every 5th 60 Hz tick: 12 frames a second.
  assert.equal(drawn.length, 24);
  for (const gap of gaps(drawn)) assert.ok(gap >= 82 && gap < 84, `gap ${gap}`);
});

test('every paced frame carries the owner step it was drawn for', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  const steps = ownerGate(scene, clock, 80);
  const drawn = runFor(scene, clock, 3);
  assert.equal(steps.length, drawn.length, 'no paced frame is drawn without a step');
});

test('frames drawn for other reasons before a step is due do not delay it', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('satellites', 1000);
  const steps = ownerGate(scene, clock, 1000);
  // A camera or tile frame every 300 ms in between the one-second steps.
  for (let i = 0; i < 600; i += 1) {
    if (i % 18 === 0) scene.requestRender();
    scene.tick();
  }
  assert.ok(steps.length >= 9, `${steps.length} steps`);
  for (const gap of gaps(steps)) assert.ok(gap <= 1000 + 20, `step gap ${gap}`);
});

test('owners with different steps each keep their own cadence', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('satellites', 1000);
  holdPacedRender('ships', 800);
  const satellites = ownerGate(scene, clock, 1000);
  const ships = ownerGate(scene, clock, 800);
  runFor(scene, clock, 10);
  // A shared timer would stretch the 1 s owner to 1.6 s. Each step lands
  // within a tick of its margin; when another owner's frame falls exactly on
  // a step boundary (whole-ms gate passes, the governor can't be sure it did)
  // the next step comes one more tick later.
  const tick = 1000 / 60;
  for (const gap of gaps(satellites)) assert.ok(gap <= 1000 + 2 + 2 * tick, `satellites ${gap}`);
  for (const gap of gaps(ships)) assert.ok(gap <= 800 + 2 + 2 * tick, `ships ${gap}`);
  assert.ok(satellites.length >= 9 && ships.length >= 11);
});

test('a continuous hold wins over paced ones and pacing resumes after it', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  holdContinuousRender('tracked-entity');
  assert.equal(scene.requestRenderMode, false);
  assert.equal(getRenderGovernorDiagnostics().mode, 'continuous');
  assert.ok(runFor(scene, clock, 1).length >= 60, 'every tick draws');
  releaseContinuousRender('tracked-entity');
  assert.equal(getRenderGovernorDiagnostics().mode, 'paced');
  assert.ok(scene.tick(), 'the settling frame');
  const drawn = runFor(scene, clock, 1);
  assert.ok(drawn.length >= 11 && drawn.length <= 12, `${drawn.length}`);
});

test('re-holding changes the step; the last release settles and stops drawing', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  holdPacedRender('flights', 80);
  runFor(scene, clock, 0.2);
  holdPacedRender('flights', 1000);
  assert.deepEqual(getRenderGovernorDiagnostics().paced, { flights: 1000 });
  assert.ok(runFor(scene, clock, 3).length <= 4);
  releasePacedRender('flights');
  assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
  assert.ok(scene.tick(), 'one settling frame paints the final state');
  assert.equal(runFor(scene, clock, 2).length, 0);
  releasePacedRender('flights');
  releasePacedRender('never-held');
  assert.equal(runFor(scene, clock, 1).length, 0, 'releasing again draws nothing');
});

test('paced holds before install apply at install; uninstall removes the listeners', () => {
  const { viewer, scene, clock } = makePacedViewer();
  holdPacedRender('flights', 80);
  installRenderGovernor(viewer);
  installRenderGovernor(viewer);
  assert.equal(scene.preUpdate.listeners.size, 1, 'one listener per viewer');
  assert.equal(scene.preRender.listeners.size, 1);
  const drawn = runFor(scene, clock, 1);
  assert.ok(drawn.length >= 12 && drawn.length <= 13, `${drawn.length}`);
  uninstallRenderGovernor(viewer);
  assert.equal(scene.preUpdate.listeners.size, 0);
  assert.equal(scene.preRender.listeners.size, 0);
  assert.deepEqual(getRenderGovernorDiagnostics().paced, {});
});

test('invalid intervals are ignored and tiny ones clamp to one frame', () => {
  const { viewer } = makePacedViewer();
  installRenderGovernor(viewer);
  for (const bad of [0, -5, NaN, Infinity, undefined]) holdPacedRender('x', bad);
  holdPacedRender('', 80);
  assert.deepEqual(getRenderGovernorDiagnostics().paced, {});
  holdPacedRender('fast', 1);
  assert.deepEqual(getRenderGovernorDiagnostics().paced, { fast: 16 });
});

test('a scene without frame events still accepts paced holds', () => {
  const { viewer, scene } = makeViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  assert.equal(scene.requestRenderMode, true);
  assert.equal(getRenderGovernorDiagnostics().mode, 'paced');
  releasePacedRender('flights');
  assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
});

test('requests made in paced mode are recorded in diagnostics', () => {
  const { viewer } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  governorRequestRender('flights-move-end');
  assert.equal(getRenderGovernorDiagnostics().recentRequests.at(-1).reason, 'flights-move-end');
});

test('?pacedRender=0 turns paced holds into continuous ones', () => {
  const { viewer, scene } = makePacedViewer();
  _resetRenderGovernorForTest({ pacedDisabled: true });
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  assert.equal(scene.requestRenderMode, false);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, ['flights']);
  releasePacedRender('flights');
  assert.equal(scene.requestRenderMode, true);
});

test('an owner whose step runs late in the frame keeps its cadence when it reports the step', () => {
  // The military fleet ticks after the flights fleet in the same preRender; how
  // long flights takes varies frame to frame (measured: military fell from
  // 10.6 to 8.8 steps/s without reporting).
  const delays = [12, 2, 9, 1, 14, 3, 0, 11];
  const run = (mode) => {
    const report = mode === 'reported';
    const { viewer, scene, clock } = makePacedViewer();
    installRenderGovernor(viewer);
    if (mode === 'continuous') holdContinuousRender('military');
    else holdPacedRender('military', 80);
    let last = -Infinity;
    let steps = 0;
    let frame = 0;
    scene.preRender.addEventListener(() => {
      const now = Math.floor(clock.t + delays[frame++ % delays.length]);
      if (now - last < 80) return;
      last = now;
      steps += 1;
      if (report) {
        const t = clock.t;
        clock.t = now;
        markPacedStep('military');
        clock.t = t;
      }
    });
    runFor(scene, clock, 10);
    return steps;
  };
  const continuous = run('continuous');
  const silent = run('silent');
  const reported = run('reported');
  assert.ok(reported > silent, `reporting ${reported} vs silent ${silent}`);
  assert.ok(reported >= continuous * 0.9, `reported ${reported} vs continuous ${continuous}`);
});

test('an owner that stops stepping does not make the governor draw every tick', () => {
  const { viewer, scene, clock } = makePacedViewer();
  installRenderGovernor(viewer);
  holdPacedRender('flights', 80);
  markPacedStep('never-held');
  const drawn = runFor(scene, clock, 2);
  assert.ok(drawn.length <= 25, `${drawn.length} frames with no step reported`);
});
