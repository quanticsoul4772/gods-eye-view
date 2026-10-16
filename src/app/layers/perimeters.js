import * as Cesium from 'cesium';
import {
  createFirePerimetersLayer,
  createInciwebIndexSource,
  createInciwebPublicationSource,
} from '../../layers/perimeters/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  perimeterFeedCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/** Wire fire perimeters (WFIGS and provincial feeds) into the application catalog. */
export function createApplicationFirePerimeters(options) {
  return createFirePerimetersLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    inciwebSource: createInciwebIndexSource(),
    inciwebPublications: createInciwebPublicationSource(),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    credits: { registerDynamicCredit, perimeterFeedCredit },
    ...options,
  });
}
