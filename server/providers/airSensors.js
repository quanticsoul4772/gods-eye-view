import { normalizeSensorCommunity } from '../../src/layers/airSensors/records.js';
import { AIRQUALITY_DOMAIN } from '../../src/data/sourceDomains.js';
import { publicOnlyFetch } from './sourceDirectory.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const MIB = 1024 * 1024;
/** The hourly file is about 8.7 MB, served uncompressed. */
const MAX_RESPONSE_BYTES = 24 * MIB;
/** The file is rebuilt every few minutes but holds 1-hour means. */
const REFRESH_MS = 20 * 60_000;
/** Readings older than this are not air quality now (records.js drops them too). */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** After a failed refresh, the next upstream attempt waits this long. */
const RETRY_MS = 60_000;
/** How long a request waits for the directory's first live load. */
const DIRECTORY_WAIT_MS = 15_000;
/**
 * Sensor.Community asks clients to send a User-Agent that lets them reach
 * whoever is making the requests.
 */
const USER_AGENT =
  'gods-eye-view-air-sensors/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/**
 * Sensor.Community particulate readings from the source directory's
 * `airquality.sensors` entries, normalized to compact rows
 * (layers/airSensors/records.js) and cached. One failing feed keeps its
 * last good rows (served stale); with no usable entry the route answers
 * 503 `no_source`.
 *
 * Route: GET /api/air-sensors →
 *   {fetchedAt, stale?, sources:[{id, ok, count, at, attribution, licenceUrl}],
 *    types, rows}
 *
 * @param {{directory?: ?{usable: Function, ready?: Function},
 *   directoryFetch?: Function, now?: () => number}} [options]
 */
export function airSensorsProxy({
  directory = null,
  directoryFetch = publicOnlyFetch,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {at: number, ok: boolean, rows: Array, types: string[], attribution: ?string, licenceUrl: ?string}>} */
  const sources = new Map();
  /** @type {?{value: object, savedAt: number}} */
  let cached = null;
  const inFlight = new Map();
  let failedAt = -Infinity;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function usableEntries() {
    if (!directory) return [];
    if (typeof directory.ready === 'function') {
      let timer;
      await Promise.race([
        directory.ready(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DIRECTORY_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    return directory.usable(AIRQUALITY_DOMAIN);
  }

  /** One feed through the public-only fetch; a redirect fails. */
  async function fetchEntry(entry) {
    const signal = AbortSignal.timeout(60_000);
    const response = await directoryFetch(entry.access.url, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    const normalized = normalizeSensorCommunity(payload, { now: now() });
    if (!normalized) throw new Error('invalid_snapshot');
    return normalized;
  }

  /** Refresh every usable feed and merge; throws when there is nothing to serve. */
  async function load() {
    const entries = await usableEntries();
    if (!entries.length)
      throw Object.assign(new Error('no_source'), { status: 503 });
    const at = now();
    const results = await Promise.allSettled(entries.map(fetchEntry));
    entries.forEach((entry, index) => {
      const result = results[index];
      if (result.status === 'fulfilled')
        sources.set(entry.id, {
          at,
          ok: true,
          rows: result.value.rows,
          types: result.value.types,
          attribution: entry.licence?.attribution || null,
          licenceUrl: entry.licence?.url || null,
        });
      else {
        console.warn(
          `[air-sensors] ${entry.id} failed:`,
          result.reason?.message || result.reason,
        );
        const last = sources.get(entry.id);
        if (last) sources.set(entry.id, { ...last, ok: false });
      }
    });
    const live = new Set(entries.map((entry) => entry.id));
    for (const id of sources.keys()) if (!live.has(id)) sources.delete(id);
    // Every feed failed this round: not a fresh snapshot (the caller serves
    // the previous one while it is under 3 hours old).
    if (!sources.size || results.every((r) => r.status === 'rejected'))
      throw new Error('upstream_unavailable');
    // Merge: re-index each feed's sensor types and its source position.
    const types = [];
    const typeIndex = new Map();
    const rows = [];
    const list = [...sources.entries()];
    list.forEach(([, source], sourceIndex) => {
      const remap = source.types.map((type) => {
        if (!typeIndex.has(type)) {
          typeIndex.set(type, types.length);
          types.push(type);
        }
        return typeIndex.get(type);
      });
      for (const row of source.rows) {
        const copy = row.slice();
        copy[6] = remap[row[6]];
        copy[10] = sourceIndex;
        rows.push(copy);
      }
    });
    const stale = list.some(([, source]) => !source.ok);
    return {
      fetchedAt: at,
      ...(stale ? { stale: true } : {}),
      sources: list.map(([id, source]) => ({
        id,
        ok: source.ok,
        count: source.rows.length,
        at: source.at,
        attribution: source.attribution,
        licenceUrl: source.licenceUrl,
      })),
      types,
      rows,
    };
  }

  /** Rows older than the records' 3 h limit are dropped on every serve. */
  function current(value) {
    const cutoff = now() - MAX_AGE_MS;
    const rows = value.rows.filter((row) => row[5] >= cutoff);
    return rows.length === value.rows.length ? value : { ...value, rows };
  }

  /** Earlier readings while Sensor.Community fails, but never past 3 h. */
  function staleOr(error) {
    if (cached && now() - cached.value.fetchedAt <= MAX_AGE_MS)
      return { value: current(cached.value), stale: true };
    throw error;
  }

  async function acquire() {
    if (cached && now() - cached.savedAt < REFRESH_MS)
      return { value: current(cached.value), stale: false };
    // After a failure, wait before the next 8.7 MB attempt.
    if (now() - failedAt < RETRY_MS)
      return staleOr(new Error('upstream_unavailable'));
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'air-sensors',
        async () => {
          const value = await load();
          cached = { value, savedAt: now() };
          return value;
        },
      );
      return { value: current(await promise), stale: false };
    } catch (error) {
      if (error.status === 503) throw error;
      failedAt = now();
      return staleOr(error);
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(
        200,
        stale ? { ...value, stale: true } : value,
        stale || value.stale === true,
      );
    } catch (error) {
      if (error.status === 503) return json(503, { error: 'no_source' });
      json(502, { error: 'air_sensors_unavailable' });
    }
  }

  return {
    name: 'air-sensors',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-sensors', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-sensors', handler);
    },
  };
}
