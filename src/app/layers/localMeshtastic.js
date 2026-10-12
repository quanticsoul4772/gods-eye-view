import { createLocalMeshtasticLayer } from '../../layers/localMeshtastic/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire the Local Meshtastic layer to the application overlay host. */
export function createApplicationLocalMeshtastic(options) {
  return createLocalMeshtasticLayer({ overlayHost, ...options });
}
