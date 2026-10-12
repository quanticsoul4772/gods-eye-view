import { createLocalMeshtasticLayer } from '../../layers/localMeshtastic/index.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

/** Wire the Local Meshtastic layer to the overlay host and pick registry. */
export function createApplicationLocalMeshtastic(options) {
  return createLocalMeshtasticLayer({ overlayHost, picking, ...options });
}
