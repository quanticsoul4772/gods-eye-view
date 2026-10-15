/**
 * Detail modes for the Google 3D tileset.
 *
 * Standard keeps Cesium's settings. Fast centre turns on skip-level-of-detail,
 * which lets Cesium's foveated (centre-first) loading take effect for
 * Google's replace-refined tiles: the middle of the view sharpens first and
 * the edges follow once the camera rests. It can briefly show coarse patches
 * while moving (CesiumGS/cesium#7903).
 */

export const TILE_DETAIL_MODES = Object.freeze(['standard', 'fast-centre']);
export const TILE_DETAIL_STORAGE_KEY = 'gev:tile-detail:v1';

const FAST_CENTRE = Object.freeze({
  skipLevelOfDetail: true,
  foveatedConeSize: 0.08,
  foveatedTimeDelay: 0.5,
});
const TUNED_KEYS = Object.keys(FAST_CENTRE);

/** Values the tileset had before the first change, to restore Standard. */
const originals = new WeakMap();

/** @returns {'standard'|'fast-centre'} */
export function normalizeTileDetailMode(mode) {
  return mode === 'fast-centre' ? 'fast-centre' : 'standard';
}

/**
 * @param {object|null} tileset Cesium3DTileset, or null on the keyless globe.
 * @param {string} mode 'standard' | 'fast-centre'.
 * @param {() => void} [requestRender] Draws a frame in requestRenderMode.
 * @returns {boolean} Whether a tileset was tuned.
 */
export function applyTileDetailMode(tileset, mode, requestRender) {
  if (!tileset || tileset.isDestroyed?.()) return false;
  if (!originals.has(tileset))
    originals.set(
      tileset,
      Object.fromEntries(TUNED_KEYS.map((key) => [key, tileset[key]])),
    );
  const values =
    normalizeTileDetailMode(mode) === 'fast-centre'
      ? FAST_CENTRE
      : originals.get(tileset);
  for (const key of TUNED_KEYS) tileset[key] = values[key];
  requestRender?.();
  return true;
}
