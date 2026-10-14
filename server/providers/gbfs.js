import { readResponseTextCapped } from './common/http.js';
import { publicOnlyFetch } from './sourceDirectory.js';
import { bboxToCircle } from '../../src/data/geoCircle.js';
import { BIKESHARE_DOMAIN } from '../../src/data/sourceDomains.js';
import { GBFS_CITY_REGISTRY } from '../../src/layers/bikeshare/registry.js';
import {
  isAllowedGbfsHost,
  isAllowedGbfsPath,
  gbfsCacheControl,
} from '../../src/data/gbfsSource.js';

// ---------------------------------------------------------------------------
// GBFS (General Bikeshare Feed Specification) proxy constants
// ---------------------------------------------------------------------------
/** Upstream fetch timeout for GBFS requests (ms). */
const GBFS_PROXY_TIMEOUT_MS = 12000;

export const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

function gbfsRedirectHost(location, requestUrl) {
  if (!location) return '';
  try {
    return new URL(String(location), requestUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Fetch one validated GBFS endpoint without following redirects and with the
 * body cap enforced while the response streams.
 *
 * The middleware validates the target before calling this; the network step
 * lives apart from it so a unit test can stand in for a hostile upstream — the
 * host allowlist keeps the real handler from being pointed at a local server.
 * `redirect: 'manual'` makes fetch() return a 3xx response instead of
 * following it, so an allowlisted operator that redirects cannot steer the
 * proxy to a destination the allowlist never saw; any 3xx is rejected with
 * { code:'GBFS_REDIRECT', redirectHost }. An oversized body surfaces as
 * { code:'RESPONSE_TOO_LARGE' } from readResponseTextCapped, which cancels the
 * upstream read the moment the running byte count passes the cap.
 *
 * @param {string} url - Validated https GBFS endpoint URL.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch] - Fetch implementation.
 * @param {number} [options.timeoutMs=GBFS_PROXY_TIMEOUT_MS] - Upstream abort timeout.
 * @param {number} [options.maxBytes=GBFS_MAX_BODY_BYTES] - Body byte cap.
 * @returns {Promise<{status:number,contentType:string,body:string}>}
 */
export async function fetchGbfsUpstream(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = GBFS_PROXY_TIMEOUT_MS,
    maxBytes = GBFS_MAX_BODY_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  try {
    upstream = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      try {
        void upstream.body?.cancel().catch(() => {});
      } catch {
        /* no-op */
      }
      const err = new Error(
        'GBFS upstream redirected; redirects are not followed',
      );
      err.code = 'GBFS_REDIRECT';
      err.redirectHost = gbfsRedirectHost(
        upstream.headers.get('location'),
        url,
      );
      throw err;
    }

    const body = await readResponseTextCapped(
      upstream,
      maxBytes,
      controller.signal,
    );
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/json',
      body,
    };
  } catch (error) {
    controller.abort();
    if (upstream?.body && !upstream.body.locked) {
      void upstream.body.cancel().catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vite plugin: GBFS bike-share proxy with host allowlisting and size limits.
 *
 * Accepts GET /api/gbfs/<encoded-upstream-URL> and proxies the request
 * to the upstream GBFS provider. Validates hostname against an allowlist,
 * restricts to station_information/station_status paths, enforces HTTPS,
 * and caps response body at 5 MB.
 *
 * Systems from the keyless source directory are accepted too, but only by
 * EXACT station URL of a verified, display-cleared entry, and fetched through
 * `publicOnlyFetch` (public addresses only). GET /api/gbfs/systems lists
 * them in the bike-share registry's shape.
 *
 * @param {{directory?: object|null}} [options]
 * @returns {import('vite').Plugin}
 */
export function gbfsProxy({ directory = null } = {}) {
  let version;
  let systems = [];
  let directoryUrls = new Set();
  function refreshDirectory() {
    if (!directory || directory.generatedAt() === version) return;
    version = directory.generatedAt();
    systems = directorySystems(directory.usable(BIKESHARE_DOMAIN));
    directoryUrls = new Set(
      systems.flatMap((s) => [s.stationStatusUrl, s.stationInformationUrl]),
    );
  }
  const installMiddleware = (server) => {
    server.middlewares.use('/api/gbfs', async (req, res) => {
      try {
        refreshDirectory();
        if (
          req.method === 'GET' &&
          (req.url || '').split('?')[0] === '/systems'
        ) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end(JSON.stringify({ systems }));
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        const url = new URL(req.url || '/', 'http://localhost');
        const encodedTarget = url.pathname.replace(/^\/+/, '');
        if (!encodedTarget) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
          return;
        }

        let decodedTarget = '';
        try {
          decodedTarget = decodeURIComponent(encodedTarget);
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
          return;
        }

        let upstreamUrl = null;
        try {
          upstreamUrl = new URL(decodedTarget);
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
          return;
        }

        if (upstreamUrl.protocol !== 'https:') {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ error: 'Only https GBFS targets are allowed' }),
          );
          return;
        }

        const fromDirectory = directoryUrls.has(upstreamUrl.toString());
        if (!fromDirectory && !isAllowedGbfsHost(upstreamUrl.hostname)) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
          return;
        }

        if (!fromDirectory && !isAllowedGbfsPath(upstreamUrl.pathname)) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error:
                'Only station_information/station_status endpoints are allowed',
            }),
          );
          return;
        }

        const upstream = await fetchGbfsUpstream(upstreamUrl.toString(), {
          fetchImpl:
            fromDirectory && !isAllowedGbfsHost(upstreamUrl.hostname)
              ? publicOnlyFetch
              : fetch,
        });
        res.writeHead(upstream.status, {
          'Content-Type': upstream.contentType,
          'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
          'X-GBFS-Upstream': upstreamUrl.hostname,
          'X-GBFS-Cache': 'MISS',
        });
        res.end(upstream.body);
      } catch (error) {
        if (error?.name === 'AbortError') {
          res.writeHead(504, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
          return;
        }
        if (
          error?.code === 'GBFS_REDIRECT' ||
          error?.code === 'RESPONSE_TOO_LARGE'
        ) {
          if (error.code === 'GBFS_REDIRECT')
            console.warn('[GBFS Proxy] Redirect refused', error.redirectHost);
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error:
                error.code === 'GBFS_REDIRECT'
                  ? 'GBFS upstream redirect refused'
                  : 'GBFS upstream response too large',
            }),
          );
          return;
        }
        console.error('[GBFS Proxy]', error?.message || String(error));
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'GBFS proxy error' }));
      }
    });
  };
  return {
    name: 'gbfs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

const STATIC_STATUS_URLS = new Set(
  GBFS_CITY_REGISTRY.map((city) => city.stationStatusUrl),
);

/**
 * Directory bike-share entries in the registry's shape (`src/layers/bikeshare/registry.js`),
 * skipping systems that registry already serves (by station URL).
 * @param {object[]} entries usable directory entries (domain bikeshare.stations)
 */
export function directorySystems(entries) {
  const out = [];
  for (const e of entries) {
    const status = e.access?.url;
    const info = e.access?.related?.station_information;
    if (!status || !info || !Array.isArray(e.coverage?.bbox)) continue;
    if (STATIC_STATUS_URLS.has(status)) continue;
    const { center, loadRadiusKm } = bboxToCircle(e.coverage.bbox);
    out.push({
      id: e.id,
      city: e.name,
      centerLat: center.lat,
      centerLon: center.lon,
      loadRadiusKm: Math.max(10, loadRadiusKm),
      stationInformationUrl: info,
      stationStatusUrl: status,
      provider: e.provider,
      attribution: e.licence?.attribution || e.provider,
      license: e.licence?.id || null,
      licenseUrl: e.licence?.url || null,
      directory: true,
    });
  }
  return out;
}
