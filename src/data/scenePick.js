/**
 * Validation for positions that came back from a Cesium screen pick.
 *
 * `scene.pickPosition()` reads the depth buffer. Over empty sky — high-altitude
 * views where the pick ray misses everything renderable — that read can produce
 * a Cartesian that is not a place on the globe. Feeding one to
 * `Cartographic.fromCartesian` either throws
 * `DeveloperError: normalized result is not a number`, returns undefined, or —
 * worst of all — quietly succeeds and hands back somewhere underground.
 *
 * A pick that does not name a real place on the globe is a MISSED pick, so
 * callers treat a degenerate result exactly as they already treat a miss.
 */

/**
 * FLOOR. WGS84's polar radius is 6,356,752 m and the deepest bathymetry is
 * ~11 km below the geoid, so nothing this app renders can sit nearer the
 * ellipsoid's center than ~6,346,000 m. Six million keeps ~346 km of margin
 * below that while still rejecting every core-interior value — and those are
 * the dangerous ones, because they are finite and non-zero and so convert
 * WITHOUT complaint: `(500, 0, 0)` becomes a point 6,378 km underground that
 * reverse-geocodes as 0°, 0°.
 */
const MIN_PICK_MAGNITUDE_M = 6_000_000;

/**
 * CEILING. The highest thing this app draws is a geostationary satellite,
 * 42,164 km from the center. A million kilometres is ~24× that (and well past
 * the Moon), so it cannot reject a real contact — but it does reject the absurd
 * finite magnitudes that overflow Cesium's geodetic iteration into NaN, which
 * throws exactly like a NaN input does.
 */
const MAX_PICK_MAGNITUDE_M = 1_000_000_000;

/**
 * Whether a picked Cartesian names a real position on or above the globe, and
 * so can be converted to a Cartographic both safely and meaningfully.
 *
 * @param {{x: number, y: number, z: number}|null|undefined} position
 * @returns {boolean}
 */
export function isPickedWorldPosition(position) {
  if (!position) return false;
  const { x, y, z } = position;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return false;
  const magnitude = Math.hypot(x, y, z);
  return magnitude >= MIN_PICK_MAGNITUDE_M && magnitude <= MAX_PICK_MAGNITUDE_M;
}

/**
 * The rendered surface under a canvas position (CSS pixels), or null.
 *
 * A ray pick first. `scene.pickPosition` decodes the depth saved from the
 * last drawn frame with the main view's CURRENT frustum, and every
 * `scene.pick` (a click, a hover) recomputes that frustum without drawing.
 * With frames drawn only on request the two stay mismatched until the next
 * frame: in Austin a click before a depth read put the point 51 m up in the
 * air. A ray pick renders its own pass, 4 ms median on Google 3D tiles
 * against 1 ms, so it suits a pick per click or per question, not per mouse
 * move. The depth read stays as the next step for a ray that finds nothing.
 *
 * @param {object} scene Cesium Scene.
 * @param {object} camera Cesium Camera.
 * @param {{x: number, y: number}} position Canvas position in CSS pixels.
 * @returns {object|null} Cartesian3 on the rendered surface.
 */
export function pickRenderedSurface(scene, camera, position) {
  if (!scene || !camera || !position) return null;
  let target = null;
  if (
    typeof scene.pickFromRay === 'function' &&
    typeof camera.getPickRay === 'function'
  ) {
    try {
      target = scene.pickFromRay(camera.getPickRay(position))?.position ?? null;
    } catch {
      target = null;
    }
  }
  if (
    !isPickedWorldPosition(target) &&
    scene.pickPositionSupported &&
    typeof scene.pickPosition === 'function'
  ) {
    try {
      target = scene.pickPosition(position);
    } catch {
      target = null;
    }
  }
  return isPickedWorldPosition(target) ? target : null;
}
