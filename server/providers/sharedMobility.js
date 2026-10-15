/**
 * Free-floating shared vehicles (bikes, scooters, mopeds, cars) from the
 * keyless source directory's `sharedmobility.vehicles` domain.
 *
 *   GET /api/sharedmobility/systems           systems the app may show (no URLs)
 *   GET /api/sharedmobility/vehicles/<id>     one system's free vehicles
 *
 * The browser names a directory entry id, never a URL. Feeds are fetched
 * server side through `publicOnlyFetch` and reduced by `parseVehicleFeed`, so
 * vehicle ids and rental links never leave the server. Only the latest
 * snapshot per system is held: no history, no trails.
 */
import { fetchGbfsUpstream } from './gbfs.js';
import { publicOnlyFetch } from './sourceDirectory.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter } from './common/rate-limit.js';
import { bboxToCircle } from '../../src/data/geoCircle.js';
import { SHAREDMOBILITY_DOMAIN } from '../../src/data/sourceDomains.js';
import {
  normalizeFormFactors,
  parseVehicleFeed,
  parseVehicleTypes,
  vehicleFeedTtlS,
} from '../../src/data/sharedVehicles.js';

/**
 * Hosts never shown: neighbour-to-neighbour sharing of members' own vehicles,
 * which the user excluded with all peer-to-peer sharing (a stable vehicle
 * parked at home locates its owner).
 */
export const PEER_TO_PEER_HOSTS = new Set(['locomotion.app']);
const TYPES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A failed vehicle_types fetch is retried after this long, not on every refresh. */
const TYPES_RETRY_MS = 60 * 60 * 1000;
const SERVE_STALE_MS = 10 * 60 * 1000;
const COOLDOWN_STEPS_MS = [5_000, 15_000, 60_000, 300_000];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const isBbox = (b) =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -90 &&
  b[2] <= 90 &&
  b[1] >= -180 &&
  b[3] <= 180 &&
  b[0] <= b[2] &&
  b[1] <= b[3];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/**
 * @param {{directory: {usable(domain: string): object[]}, fetchImpl?: Function,
 *   admit?: (key: string) => boolean}} options
 */
export function createSharedMobilityService({
  directory,
  fetchImpl = publicOnlyFetch,
  admit = makeRateLimiter({ windowMs: 60_000, max: 3, globalMax: 60 }),
}) {
  const snapshots = new Map(); // id → {lastUpdated, vehicles, fetchedAt, ttlS}
  const vehicleTypes = new Map(); // id → {types, fetchedAt}
  const cooldown = new Map(); // id → {failures, nextAttemptAt}
  const inFlight = new Map();

  /** Usable entries the app shows: a valid area, not peer-to-peer. */
  function entries() {
    return directory
      .usable(SHAREDMOBILITY_DOMAIN)
      .filter(
        (e) =>
          isBbox(e.coverage?.bbox) &&
          !PEER_TO_PEER_HOSTS.has(hostOf(e.access?.url)),
      );
  }

  function systems() {
    return entries().map((e) => {
      const { center, loadRadiusKm } = bboxToCircle(e.coverage.bbox);
      return {
        id: e.id,
        name: e.name,
        provider: e.provider,
        centerLat: center.lat,
        centerLon: center.lon,
        loadRadiusKm: Math.max(10, loadRadiusKm),
        formFactors: normalizeFormFactors(e.gbfs?.form_factors),
        // Overlapping entries of one operator share a feed host under
        // different provider names; the layer de-duplicates by it.
        feedHost: hostOf(e.access.url),
        attribution: e.licence?.attribution || e.provider,
        license: e.licence?.id || null,
        licenseUrl: e.licence?.url || null,
      };
    });
  }

  async function fetchJson(url) {
    const upstream = await fetchGbfsUpstream(url, { fetchImpl });
    if (upstream.status !== 200)
      throw new Error(`${hostOf(url)} answered HTTP ${upstream.status}`);
    return JSON.parse(upstream.body);
  }

  /** The system's vehicle types: cached a day; a failed fetch keeps the last copy (or none: unknown types). */
  async function typesFor(entry, now) {
    const url = entry.access.related?.vehicle_types;
    if (!url) return new Map();
    const known = vehicleTypes.get(entry.id);
    if (known && now - known.fetchedAt < TYPES_MAX_AGE_MS) return known.types;
    try {
      const types = parseVehicleTypes(await fetchJson(url));
      vehicleTypes.set(entry.id, { types, fetchedAt: now });
      return types;
    } catch (error) {
      console.warn(
        `[shared-mobility] ${entry.id} vehicle types unavailable: ${error?.message || error}`,
      );
      // Retry in an hour, not on every refresh (outside the fetch budget).
      const types = known?.types || new Map();
      vehicleTypes.set(entry.id, {
        types,
        fetchedAt: now - TYPES_MAX_AGE_MS + TYPES_RETRY_MS,
      });
      return types;
    }
  }

  async function refresh(entry, now) {
    const types = await typesFor(entry, now);
    const payload = await fetchJson(entry.access.url);
    const parsed = parseVehicleFeed(payload, {
      types,
      formFactors: normalizeFormFactors(entry.gbfs?.form_factors),
      bbox: entry.coverage.bbox,
    });
    const snapshot = {
      ...parsed,
      fetchedAt: now,
      ttlS: vehicleFeedTtlS(payload, entry.access.min_interval_s),
    };
    snapshots.set(entry.id, snapshot);
    cooldown.delete(entry.id);
    return snapshot;
  }

  function noteFailure(id, now) {
    const failures = (cooldown.get(id)?.failures || 0) + 1;
    const wait =
      COOLDOWN_STEPS_MS[Math.min(failures, COOLDOWN_STEPS_MS.length) - 1];
    cooldown.set(id, { failures, nextAttemptAt: now + wait });
    return wait;
  }

  function body(id, snapshot, now) {
    return {
      system: id,
      lastUpdated: snapshot.lastUpdated,
      fetchedAt: snapshot.fetchedAt,
      expiresInS: Math.max(
        0,
        Math.ceil((snapshot.fetchedAt + snapshot.ttlS * 1000 - now) / 1000),
      ),
      vehicles: snapshot.vehicles,
    };
  }

  async function vehicles(id) {
    const entry = ID_PATTERN.test(id)
      ? entries().find((e) => e.id === id)
      : null;
    if (!entry) return json(404, { error: 'Unknown shared mobility system' });
    const now = Date.now();
    const cached = snapshots.get(id);
    if (cached && now - cached.fetchedAt < cached.ttlS * 1000)
      return json(200, body(id, cached, now), { 'X-GEV-Cache': 'HIT' });
    const stale =
      cached && now - cached.fetchedAt < SERVE_STALE_MS ? cached : null;
    const unavailable = (reason, retryS) =>
      stale
        ? json(200, body(id, stale, now), { 'X-GEV-Cache': 'STALE' })
        : json(
            503,
            { error: 'Shared mobility feed unavailable', retryInSec: retryS },
            { 'Retry-After': String(retryS), 'X-GEV-Backoff': reason },
          );
    const waiting = cooldown.get(id);
    if (waiting && waiting.nextAttemptAt > now && !inFlight.has(id))
      return unavailable(
        'cooldown',
        Math.max(1, Math.ceil((waiting.nextAttemptAt - now) / 1000)),
      );
    if (!inFlight.has(id) && !admit(id)) return unavailable('rate-limited', 60);
    const request = coalesceProxyRequest(inFlight, id, () =>
      refresh(entry, now),
    );
    try {
      const fresh = await request.promise;
      return json(200, body(id, fresh, Date.now()), {
        'X-GEV-Cache': request.shared ? 'INFLIGHT' : 'MISS',
      });
    } catch (error) {
      if (!request.shared) {
        const wait = noteFailure(id, Date.now());
        console.warn(
          `[shared-mobility] ${id} unavailable: ${error?.message || error} — next attempt in ${Math.round(wait / 1000)}s`,
        );
      }
      const pending = cooldown.get(id);
      return unavailable(
        'upstream',
        pending
          ? Math.max(1, Math.ceil((pending.nextAttemptAt - Date.now()) / 1000))
          : 60,
      );
    }
  }

  return {
    /** Answer one request; `request.url` is absolute, `/api/sharedmobility/...`. */
    async handle(request) {
      if ((request.method || 'GET') !== 'GET')
        return json(405, { error: 'Method Not Allowed' });
      const path = new URL(request.url).pathname.replace(
        /^\/api\/sharedmobility/,
        '',
      );
      if (path === '/systems')
        return json(
          200,
          { systems: systems() },
          {
            'Cache-Control': 'public, max-age=600',
          },
        );
      const match = path.match(/^\/vehicles\/([^/]+)$/);
      if (match) {
        let id;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          return json(404, { error: 'Unknown shared mobility system' });
        }
        return vehicles(id);
      }
      return json(404, { error: 'Not found' });
    },
    close() {
      snapshots.clear();
      vehicleTypes.clear();
      cooldown.clear();
    },
  };
}

/** Vite plugin: the shared mobility routes on the dev and preview servers. */
export function sharedMobilityProxy(options) {
  const service = createSharedMobilityService(options);
  function install(server) {
    server.middlewares.use('/api/sharedmobility', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/sharedmobility${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'shared-mobility',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
