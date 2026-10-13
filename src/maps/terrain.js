import * as Cesium from 'cesium';
import { createTerrainRetryPolicy } from './terrainRetry.js';

/** Re:Earth / Mapterhorn ellipsoidal quantized mesh, CC BY 4.0. */
export const KEYLESS_TERRAIN_URL =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid';
/**
 * The same tiles through the app's own server, cached on disk
 * (server/providers/terrainMesh.js), so repeat views do not download them
 * again from the free service.
 */
export const KEYLESS_TERRAIN_PROXY_URL = '/api/terrain/mesh';

/** These factories are lazy: a hidden globe must not trigger terrain loading. */
export async function createWorldTerrain(accessToken, { signal } = {}) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken)
    throw new Error('World terrain requires an explicit ion token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(1, { accessToken });
  signal?.throwIfAborted();
  return {
    provider: await Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: true,
      requestWaterMask: false,
      ellipsoid: Cesium.Ellipsoid.WGS84,
    }),
  };
}

function logThrottle({ statusCode, delayMs, inWindow }) {
  // One line per cooldown window, not per tile: a burst throttles dozens.
  if (inWindow !== 1) return;
  console.warn(
    `[MapStack] Re:Earth terrain answered ${statusCode}; retrying throttled tiles after ${Math.round(delayMs)} ms`,
  );
}

/**
 * The Re:Earth resource with the tile retry policy attached. Cesium copies
 * `retryCallback`/`retryAttempts` onto every derived resource, so layer.json
 * and each `{z}/{x}/{y}.terrain` fetch inherit it (see `terrainRetry.js`).
 * @param {ReturnType<typeof createTerrainRetryPolicy>} [policy]
 * @returns {Cesium.Resource}
 */
export function createKeylessTerrainResource(
  policy = createTerrainRetryPolicy({ onThrottle: logThrottle }),
  url = KEYLESS_TERRAIN_URL,
) {
  return new Cesium.Resource({
    url,
    retryCallback: policy.retryCallback,
    retryAttempts: policy.retryAttempts,
  });
}

/**
 * Wraps a retry policy for the proxy resource: a tile the app's server cannot
 * serve — the route gone (404, e.g. while a dev server restarts), the proxy
 * down (no status) or failing (502) — is fetched from the public service
 * instead. Without this an open page whose server lost the route marked every
 * tile failed and the globe disappeared. Throttling (429) and the upstream's
 * own errors still go through the wrapped policy's backoff.
 * @param {ReturnType<typeof createTerrainRetryPolicy>} policy
 */
export function withPublicTileFallback(policy) {
  const marker = `${KEYLESS_TERRAIN_PROXY_URL}/`;
  return {
    ...policy,
    retryAttempts: policy.retryAttempts + 1,
    async retryCallback(resource, error) {
      const url = String(resource?.url ?? '');
      const at = url.indexOf(marker);
      const status = error?.statusCode;
      if (at !== -1 && (status === 404 || status === 502 || status == null)) {
        resource.url = `${KEYLESS_TERRAIN_URL}/${url.slice(at + marker.length)}`;
        return true;
      }
      return policy.retryCallback(resource, error);
    },
  };
}

/**
 * Whether the app's own server is answering the terrain route. Cesium does not
 * fail on a missing layer.json — it assumes default tiling — so a host without
 * the server (a static build) would otherwise get a provider whose every tile
 * 404s. The proxy holds layer.json in memory, so this costs no second upstream
 * request when Cesium asks for it next.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function keylessTerrainProxyAvailable(
  fetchImpl = globalThis.fetch,
) {
  try {
    const response = await fetchImpl(
      `${KEYLESS_TERRAIN_PROXY_URL}/layer.json`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    return (
      response.ok && /json/i.test(response.headers?.get?.('content-type') || '')
    );
  } catch {
    return false;
  }
}

export async function createKeylessTerrain() {
  // The local cache when the app's server answers for it; the public service
  // otherwise.
  if (await keylessTerrainProxyAvailable()) {
    try {
      return {
        provider: await Cesium.CesiumTerrainProvider.fromUrl(
          createKeylessTerrainResource(
            withPublicTileFallback(
              createTerrainRetryPolicy({ onThrottle: logThrottle }),
            ),
            KEYLESS_TERRAIN_PROXY_URL,
          ),
        ),
      };
    } catch {
      /* fall through to the public service */
    }
  }
  try {
    return {
      provider: await Cesium.CesiumTerrainProvider.fromUrl(
        createKeylessTerrainResource(),
      ),
    };
  } catch (error) {
    console.warn(
      '[MapStack] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:',
      error,
    );
    return { provider: new Cesium.EllipsoidTerrainProvider() };
  }
}
