import * as Cesium from 'cesium';
import { resolvePickId } from '../data/pickRegistry.js';

/** A double-click's two presses fall well inside this. */
const PRESS_WINDOW_MS = 1000;

/**
 * Whether a canvas position shows only the ground: no app overlay hit, and
 * every pick there is the ground tileset carrying no app id (the keyless
 * globe picks as nothing). Drill-picking also finds markers drawn under or
 * inside the 3D tiles.
 */
export function isPlainGroundAt(
  scene,
  position,
  { getGroundTileset, hitTestOverlay },
) {
  if (!position || hitTestOverlay?.(position.x, position.y)) return false;
  const ground = getGroundTileset?.() || null;
  const picks =
    typeof scene?.drillPick === 'function'
      ? scene.drillPick(position, 4) || []
      : [scene?.pick?.(position)].filter(Boolean);
  return picks.every(
    (picked) =>
      ground && picked?.primitive === ground && resolvePickId(picked) == null,
  );
}

/**
 * Double-click plain ground to bring it to the middle of the view.
 *
 * Each press of the double-click is recorded first. The double-click only
 * acts when nothing else claimed those presses: no tool held the pointer
 * (some release it after their first click), no navigation started (a click
 * on a vessel or fire flies the camera) and nothing new was selected (a
 * marker, a radio station). Releasing a followed aircraft is fine: the first
 * click on the ground stops following, the double-click then looks there.
 *
 * @returns {{destroy(): void}}
 */
export function bindGroundFocusGesture({
  viewer,
  focusAt,
  isGroundAt,
  isPointerFree,
  readNavigationGeneration,
  readSelection,
  now = () => performance.now(),
  createHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
}) {
  const canvas = viewer.scene.canvas;
  const presses = [];
  const onPointerDown = () => {
    presses.push({
      at: now(),
      free: isPointerFree(),
      generation: readNavigationGeneration(),
      selection: readSelection(),
    });
    if (presses.length > 2) presses.shift();
  };
  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });

  const handler = createHandler(canvas);
  handler.setInputAction(({ position }) => {
    const [first, second] = presses;
    if (!first || !second || now() - first.at > PRESS_WINDOW_MS) return;
    if (!first.free || !second.free || !isPointerFree()) return;
    if (readNavigationGeneration() !== first.generation) return;
    const selection = readSelection();
    if (selection != null && selection !== first.selection) return;
    if (viewer.trackedEntity || viewer.scene.tweens?.length > 0) return;
    if (!isGroundAt(position)) return;
    focusAt(position);
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  return {
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      });
      if (!handler.isDestroyed?.()) handler.destroy();
    },
  };
}
