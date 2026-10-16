import { createNominatimProvider } from './nominatim.js';
import { createGeospatialServices } from './geospatial.js';
import { createHttpGeospatialProvider } from './http.js';
import { createPlaceSearch } from './placeSearch.js';
import { createGoogleGeocoder } from './google.js';
import {
  createPhotonGeocoder,
  createPhotonReverseGeocoder,
} from '../keylessGeocoder.js';
import { createCoordinateGeocoder } from './coordinateGeocoder.js';
import { createPresetGeocoder } from './presetGeocoder.js';
import { createAlpsGeocoder } from './alpsGeocoder.js';

/**
 * Coordinates, bundled names and the unqualified Alps first — all offline —
 * then Google when configured, then keyless Photon, then the local Nominatim
 * route as a last resort. Transport stays local to setup.
 *
 * `presets` is the caller's bundled place data. It is passed in rather than
 * imported so this package keeps reading no application state; with none
 * supplied there is simply no bundled-name provider.
 */
export function createDefaultPlaceSearch({
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  signal,
  endpoints = {},
  providers = {},
  presets = null,
  geocoding = null,
} = {}) {
  if (geocoding && geocoding.provider !== 'nominatim')
    throw new TypeError('Unsupported geocoding provider');
  const selected = geocoding
    ? createNominatimProvider({ ...geocoding, fetchImpl })
    : null;
  if (selected && !selected.geocode)
    throw new TypeError('Nominatim searchEndpoint is required');
  const forward = createPlaceSearch({
    signal,
    providers: providers.geocode || [
      createCoordinateGeocoder(),
      ...(presets ? [createPresetGeocoder({ presets })] : []),
      createAlpsGeocoder(),
      ...(selected
        ? [selected]
        : [
            // Google answers through the local proxy, which holds the server
            // key: its Geocoding web service refuses referrer-restricted keys,
            // so calling it from here would force the bundled browser key to be
            // left unrestricted (#363). That key still gates the provider,
            // because a keyless session must not spend a request to learn it
            // has no Google: the proxy's "not configured" reads as an
            // unanswered provider, which stops the chain caching the negative
            // Photon or Nominatim then produces.
            createGoogleGeocoder({
              request(query, { bias, signal }) {
                if (!resolveApiKey?.()) return null;
                const params = new URLSearchParams({ address: query });
                if (bias) params.set('bounds', bias);
                return fetchImpl(
                  `${endpoints.geocode || '/api/google/geocode'}?${params}`,
                  { signal },
                );
              },
            }),
            createPhotonGeocoder({ fetchImpl, endpoint: endpoints.photon }),
            // Last resort: the local Nominatim route, which answers with no key when
            // neither of the two above did. It speaks the same result shape, so it
            // rides the existing Google adapter rather than needing its own.
            createGoogleGeocoder({
              request(query, { bias, signal }) {
                const params = new URLSearchParams({ q: query });
                if (bias) params.set('bounds', bias);
                return fetchImpl(
                  `${endpoints.nominatim || '/api/geocode'}?${params}`,
                  {
                    signal,
                  },
                );
              },
            }),
          ]),
    ],
  });
  const operations = createHttpGeospatialProvider({
    fetchImpl,
    resolveApiKey,
    endpoints,
  });
  // Google answers reverse lookups only with a key. Without one (or when it
  // finds nothing) Photon / OpenStreetMap answers, keyless, but only for a
  // caller that opts in with { keyless: true }: it sends the point to a third
  // party, so automatic callers (the HUD summary) stay Google-only.
  const photonReverse = createPhotonReverseGeocoder({
    fetchImpl,
    endpoint: endpoints.photonReverse,
  });
  return {
    ...forward,
    ...createGeospatialServices({
      signal,
      providers: {
        ...operations,
        async reverseGeocode(latitude, longitude, options) {
          return (
            (await operations.reverseGeocode(latitude, longitude, options)) ??
            (options?.keyless
              ? photonReverse(latitude, longitude, options)
              : null)
          );
        },
        attribution: {
          ...operations.attribution,
          reverseGeocode: 'Google, or Photon / OpenStreetMap without a key',
        },
        ...(selected
          ? {
              reverseGeocode: selected.reverseGeocode,
              attribution: {
                ...operations.attribution,
                ...selected.attribution,
              },
            }
          : {}),
        ...providers,
      },
    }),
  };
}

// Compatibility for direct module callers. Application composition supplies its own instance.
export const defaultGeospatial = createDefaultPlaceSearch({
  resolveApiKey: () => globalThis.window?.__GOOGLE_MAPS_API_KEY__,
});
