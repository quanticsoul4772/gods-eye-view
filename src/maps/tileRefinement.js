/**
 * Let Cesium refine through content-less tiles of the Google tileset.
 *
 * Cesium 1.138's base traversal stops at a content-less tile whose own
 * screen-space error is already under the target. When that tile is the root
 * of an external sub-tileset under a renderable parent, the parent waits on
 * it forever: the centre of the view stays coarse while everything around it
 * is sharp (CesiumGS/cesium#12683; the upstream fix is limited to vector
 * tilesets). Walking such tiles, as Cesium already does for external-tileset
 * tiles, lets the traversal reach the real content below them.
 *
 * Only tilesets passed to the installer are affected. `canTraverse` is a
 * private Cesium function: after a Cesium upgrade, run
 * tileRefinement.test.mjs (it drives Cesium's real traversal) and
 * `npm run qa:centre-detail`. Remove this once Cesium refines through empty
 * tiles for every tileset.
 */

const WRAPPED = Symbol('emptyTileRefinement');

/**
 * @param {typeof import('cesium')} Cesium
 * @param {object} tileset Cesium3DTileset to fix.
 * @param {{enabled?: boolean}} [options] `enabled: false` leaves Cesium as is.
 * @returns {boolean} Whether the tileset is now refined through empty tiles.
 */
export function installEmptyTileRefinementFix(
  Cesium,
  tileset,
  { enabled = true } = {},
) {
  const traversal = Cesium?.Cesium3DTilesetTraversal;
  if (!enabled || !tileset || typeof traversal?.canTraverse !== 'function')
    return false;
  if (!traversal.canTraverse[WRAPPED]) {
    const original = traversal.canTraverse;
    const registered = new WeakSet();
    const canTraverse = (tile) =>
      (registered.has(tile.tileset) &&
        tile.hasEmptyContent &&
        tile.children.length > 0) ||
      original(tile);
    canTraverse[WRAPPED] = registered;
    traversal.canTraverse = canTraverse;
  }
  traversal.canTraverse[WRAPPED].add(tileset);
  return true;
}

/** `?refineFix=0` leaves Cesium's refinement rule alone, for comparison. */
export function emptyTileRefinementEnabled(
  search = globalThis.location?.search,
) {
  return new URLSearchParams(search ?? '').get('refineFix') !== '0';
}
