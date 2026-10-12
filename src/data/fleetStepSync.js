/**
 * One step phase for the aircraft fleets.
 *
 * Flights and Military Flights each move on an 80 ms step and pace the render
 * loop at it (`holdPacedRender`). Left alone, the two steps drift out of phase
 * and each draws its own frame: with both on, ~21 frames/s where ~12 would
 * carry every step. So when one fleet steps in a frame, the other may step in
 * that same frame once most of its own interval has passed. After a step or two
 * both land on the same frames and the governor draws one frame for both.
 *
 * Stepping early is harmless: positions are dead-reckoned from the time of the
 * step, so a step taken at 50 ms instead of 80 ms is simply a shorter step.
 */

/** A fleet may join another's step once this share of its interval has passed. */
export const FLEET_JOIN_MIN_FRACTION = 0.6;

/** The rendered frame in which a fleet last stepped (`frameState.frameNumber`). */
let _lastStepFrame = -1;

/**
 * Record that a fleet stepped in this rendered frame.
 * @param {number} frameNumber The scene's `frameState.frameNumber`.
 * @returns {void}
 */
export function noteFleetStep(frameNumber) {
  if (Number.isFinite(frameNumber) && frameNumber >= 0)
    _lastStepFrame = frameNumber;
}

/**
 * May a fleet whose own step is not yet due step now, joining the step another
 * fleet already took in this frame?
 * @param {number} frameNumber The scene's `frameState.frameNumber`.
 * @param {number} sinceLastMs Time since this fleet's own last step.
 * @param {number} intervalMs This fleet's step.
 * @returns {boolean}
 */
export function canJoinFleetStep(frameNumber, sinceLastMs, intervalMs) {
  return (
    Number.isFinite(frameNumber) &&
    frameNumber >= 0 &&
    frameNumber === _lastStepFrame &&
    sinceLastMs >= intervalMs * FLEET_JOIN_MIN_FRACTION
  );
}

/** Test seam. */
export function _resetFleetStepSyncForTest() {
  _lastStepFrame = -1;
}
