import * as Cesium from 'cesium';
import { createAirSensorsLayer } from '../../layers/airSensors/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  airSensorFeedCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/** Wire Sensor.Community air sensors into the application catalog. */
export function createApplicationAirSensors(options) {
  return createAirSensorsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    credits: { registerDynamicCredit, airSensorFeedCredit },
    ...options,
  });
}
