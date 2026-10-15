import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import {
  gbfsSystemCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/**
 * Construct one layer using the application scene owners and a supplied source.
 * `surface.groundFloor` (optional) places free-floating vehicles on the 3D-tiles
 * ground when the globe is hidden.
 */
export function createApplicationBikeshare({ source, surface }) {
  const groundFloor = surface?.groundFloor;
  return createBikeshareLayer({
    source,
    services: {
      render,
      sprites,
      picking,
      overlays,
      credits: { registerDynamicCredit, gbfsSystemCredit },
      ground: groundFloor
        ? {
            cachedGroundFloor: groundFloor.cachedGroundFloor,
            warmGroundFloor: groundFloor.warmGroundFloor,
          }
        : null,
    },
  });
}
