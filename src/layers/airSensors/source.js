import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { expandReadings } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

/** About 9,300 compact rows are under 1 MB; anything past this is not a snapshot. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Request Sensor.Community readings through the same-origin air-sensors
 * proxy (server/providers/airSensors.js).
 * @param {{fetchImpl?: Function}} [options]
 * @returns {{getSnapshot: ({signal}?: {signal?: AbortSignal}) => Promise<{readings: Array<object>, sources: Array<object>, stale: boolean}>}}
 */
export function createAirSensorsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/air-sensors', { signal });
      if (response.status === 503)
        throw new Error(msg('No verified air-sensor source yet'));
      if (!response.ok) throw new Error(`Air sensors HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows) || !Array.isArray(payload?.sources))
        throw new Error(msg('Malformed air-sensor snapshot'));
      return {
        readings: expandReadings(payload),
        sources: payload.sources,
        stale: payload.stale === true,
      };
    },
  };
}
