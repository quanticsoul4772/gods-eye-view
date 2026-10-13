import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Keyless terrain tiles through the local server, cached on disk.
 *
 * The globe's keyless terrain is Re:Earth's quantized mesh. The browser used to
 * fetch every tile straight from terrain.reearth.land, so each visit — and
 * every fresh browser profile — downloaded the same tiles again, and a fly-to
 * burst drew HTTP 429s from the free service (520–1,010 per test session,
 * 2026-10-12). This proxy serves a tile from disk when it has one and asks the
 * service otherwise, one request per tile however many arrive at once.
 *
 * The cache is capped (GEV_TERRAIN_CACHE_MB, default 256 MB; 0 disables disk
 * caching): past the cap the oldest tiles are deleted down to 90 % of it, so a
 * long session can never fill the drive. Tiles older than the upstream's own
 * 30-day max-age are fetched again. layer.json is held in memory for an hour.
 * 429s and server errors are passed through with Retry-After and never cached,
 * so the client's retry policy (src/maps/terrainRetry.js) still governs them.
 */

export const TERRAIN_MESH_UPSTREAM =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid';
const DEFAULT_CACHE_MB = 256;
const TILE_MAX_AGE_MS = 30 * 24 * 3600_000;
const LAYER_MAX_AGE_MS = 3600_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Only these paths are proxied: no open relay to the upstream host. */
const TILE_PATH = /^\/\d{1,2}\/\d{1,7}\/\d{1,7}\.terrain$/;
const LAYER_PATH = '/layer.json';

/** The configured cache cap in bytes (GEV_TERRAIN_CACHE_MB). */
export function terrainCacheLimitBytes(env = process.env) {
  const mb = Number(env.GEV_TERRAIN_CACHE_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_CACHE_MB) * 1024 * 1024;
}

/**
 * A size-capped directory of cached tile bodies, keyed by request. The oldest
 * written tiles are evicted first.
 * @param {{dir: string, maxBytes: number, fs?: typeof fsp, now?: () => number}} options
 */
export function createTerrainMeshCache({
  dir,
  maxBytes,
  fs = fsp,
  now = () => Date.now(),
}) {
  /** file name → { bytes, writtenAt } */
  let index = null;
  let total = 0;
  let loading = null;
  const fileFor = (key) =>
    `${crypto.createHash('sha1').update(key).digest('hex')}.bin`;

  function load() {
    loading ??= (async () => {
      const entries = new Map();
      let bytes = 0;
      try {
        await fs.mkdir(dir, { recursive: true });
        for (const name of await fs.readdir(dir)) {
          if (!name.endsWith('.bin')) continue;
          try {
            const stat = await fs.stat(path.join(dir, name));
            entries.set(name, { bytes: stat.size, writtenAt: stat.mtimeMs });
            bytes += stat.size;
          } catch {
            /* removed meanwhile */
          }
        }
      } catch {
        /* unreadable directory: start empty */
      }
      index = entries;
      total = bytes;
    })();
    return loading;
  }

  async function forget(name) {
    const entry = index.get(name);
    if (!entry) return;
    index.delete(name);
    total -= entry.bytes;
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }

  async function evict() {
    if (total <= maxBytes) return;
    const target = maxBytes * 0.9;
    const oldestFirst = [...index.entries()].sort(
      (a, b) => a[1].writtenAt - b[1].writtenAt,
    );
    for (const [name] of oldestFirst) {
      if (total <= target) break;
      await forget(name);
    }
  }

  return {
    /** The cached body for `key`, or null when absent or older than 30 days. */
    async get(key) {
      if (maxBytes <= 0) return null;
      await load();
      const name = fileFor(key);
      const entry = index.get(name);
      if (!entry) return null;
      if (now() - entry.writtenAt > TILE_MAX_AGE_MS) {
        await forget(name);
        return null;
      }
      try {
        return await fs.readFile(path.join(dir, name));
      } catch {
        index.delete(name);
        total -= entry.bytes;
        return null;
      }
    },
    /** Store a body, then evict down to the cap if it is exceeded. */
    async put(key, body) {
      if (maxBytes <= 0 || body.length > maxBytes) return;
      await load();
      const name = fileFor(key);
      const file = path.join(dir, name);
      const temp = `${file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temp, body);
        await fs.rename(temp, file);
      } catch {
        await fs.unlink(temp).catch(() => {});
        return;
      }
      const previous = index.get(name);
      if (previous) total -= previous.bytes;
      index.set(name, { bytes: body.length, writtenAt: now() });
      total += body.length;
      await evict();
    },
    /** For diagnostics and tests. */
    async stats() {
      await load();
      return { files: index.size, bytes: total, maxBytes };
    },
  };
}

/** The `extensions=` part of a quantized-mesh Accept header, for the cache key. */
function acceptedExtensions(accept = '') {
  return /extensions=([a-z-]+)/i.exec(accept)?.[1]?.toLowerCase() ?? '';
}

/** Vite/preview plugin mounting /api/terrain/mesh. */
export function terrainMeshProxy({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'terrain-mesh'),
  maxBytes = terrainCacheLimitBytes(),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = createTerrainMeshCache({ dir: cacheDir, maxBytes, now });
  /** @type {Map<string, Promise<{status: number, body: Buffer|null, retryAfter: string|null}>>} */
  const inflight = new Map();
  let layer = null; // { body, at }

  async function fetchUpstream(pathname, search, accept) {
    try {
      const response = await fetchImpl(
        `${TERRAIN_MESH_UPSTREAM}${pathname}${search}`,
        {
          headers: accept ? { Accept: accept } : {},
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      const body = response.ok
        ? Buffer.from(await response.arrayBuffer())
        : null;
      return {
        status: response.status,
        body,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
      };
    } catch {
      return { status: 502, body: null, retryAfter: null };
    }
  }

  function send(res, status, body, { type, maxAgeSec, retryAfter, source }) {
    res.statusCode = status;
    if (body) {
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', `public, max-age=${maxAgeSec}`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    if (source) res.setHeader('X-Terrain-Cache', source);
    res.end(body ?? undefined);
  }

  const install = (server) => {
    server.middlewares.use('/api/terrain/mesh', async (req, res) => {
      const url = new URL(req.url || '/', 'http://internal');
      const { pathname, search } = url;
      const accept = req.headers?.accept || '';
      if (pathname === LAYER_PATH) {
        if (!layer || now() - layer.at > LAYER_MAX_AGE_MS) {
          const fetched = await fetchUpstream(pathname, search, accept);
          if (!fetched.body) {
            send(res, fetched.status, null, { retryAfter: fetched.retryAfter });
            return;
          }
          layer = { body: fetched.body, at: now() };
        }
        send(res, 200, layer.body, {
          type: 'application/json',
          maxAgeSec: 3600,
        });
        return;
      }
      if (!TILE_PATH.test(pathname)) {
        send(res, 404, null, {});
        return;
      }
      const key = `${pathname}${search}|${acceptedExtensions(accept)}`;
      const tileHeaders = {
        type: 'application/vnd.quantized-mesh',
        maxAgeSec: 86400,
      };
      const cached = await cache.get(key);
      if (cached) {
        send(res, 200, cached, { ...tileHeaders, source: 'hit' });
        return;
      }
      let pending = inflight.get(key);
      if (!pending) {
        pending = fetchUpstream(pathname, search, accept)
          .then(async (fetched) => {
            if (fetched.body) await cache.put(key, fetched.body);
            return fetched;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const fetched = await pending;
      send(res, fetched.body ? 200 : fetched.status, fetched.body, {
        ...tileHeaders,
        retryAfter: fetched.retryAfter,
        source: 'miss',
      });
    });
  };

  return {
    name: 'terrain-mesh-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** For tests and diagnostics. */
    cache,
  };
}
