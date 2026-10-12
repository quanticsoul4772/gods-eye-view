import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  FLEET_JOIN_MIN_FRACTION,
  _resetFleetStepSyncForTest,
  canJoinFleetStep,
  noteFleetStep,
} from './fleetStepSync.js';

beforeEach(() => _resetFleetStepSyncForTest());

test('a fleet joins a step taken this frame once most of its interval has passed', () => {
  noteFleetStep(42);
  assert.equal(canJoinFleetStep(42, 80 * FLEET_JOIN_MIN_FRACTION, 80), true);
  assert.equal(canJoinFleetStep(42, 79, 80), true);
  assert.equal(canJoinFleetStep(42, 30, 80), false, 'too soon after its own step');
  assert.equal(canJoinFleetStep(43, 79, 80), false, 'a step from another frame');
});

test('nothing to join before any fleet has stepped, or with no frame number', () => {
  assert.equal(canJoinFleetStep(0, 79, 80), false);
  noteFleetStep(-1);
  noteFleetStep(NaN);
  assert.equal(canJoinFleetStep(-1, 79, 80), false);
  assert.equal(canJoinFleetStep(NaN, 79, 80), false);
});

/**
 * Two fleets with the same 80 ms gate on a 60 Hz loop, each frame drawn only
 * when one of them is due (as the paced governor does), stepping in listener
 * order. Returns the frames drawn and each fleet's step times.
 */
function simulate({ join, phaseMs, seconds = 10 }) {
  const tick = 1000 / 60;
  const fleets = [
    { last: 0, steps: [] },
    { last: phaseMs, steps: [] },
  ];
  let frame = 0;
  let drawn = 0;
  for (let t = phaseMs + tick; t < seconds * 1000; t += tick) {
    if (!fleets.some((f) => t - f.last >= 82)) continue; // nothing due: no frame
    frame += 1;
    drawn += 1;
    for (const fleet of fleets) {
      const since = t - fleet.last;
      if (since < 80 && !(join && canJoinFleetStep(frame, since, 80))) continue;
      fleet.last = t;
      fleet.steps.push(t);
      if (join) noteFleetStep(frame);
    }
  }
  return { drawn, fleets };
}

test('out-of-phase fleets lock onto shared frames and keep their step rate', () => {
  const apart = simulate({ join: false, phaseMs: 40 });
  _resetFleetStepSyncForTest();
  const joined = simulate({ join: true, phaseMs: 40 });
  // Apart, each fleet draws its own frames; joined, one frame carries both.
  assert.ok(apart.drawn >= 220, `apart drew ${apart.drawn}`);
  assert.ok(joined.drawn <= 125, `joined drew ${joined.drawn}`);
  for (const [i, fleet] of joined.fleets.entries()) {
    const rate = fleet.steps.length / 10;
    assert.ok(rate >= 11.5, `fleet ${i} stepped ${rate}/s`);
  }
});
