import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CCTV_SOURCE_FILE, CCTV_SOURCE_CACHE_MS } from './constants.js';
import { allocateSourceCap, resolveCatalogCap } from './cap.js';
import { loadGroundHeights, joinGroundHeights } from './groundHeights.js';
import { cameraRegion, normalizeSourceItem } from './normalize.js';
import { loadLithuaniaSources } from './lithuania.js';
import {
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadTflSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadTxdotSourcesFromOpenData,
  loadTallinnSourcesFromCatalog,
  loadTarkteeSourcesFromDatex,
  loadWarendorfSourcesFromCatalog,
  loadNswSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadCataloniaSourcesFromOpenData,
  loadDelDOTSourcesFromOpenData,
  loadKingCountySourcesFromOpenData,
  loadWsdotSourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
  loadNycSourcesFromOpenData,
  loadTorontoSourcesFromOpenData,
} from './sources.js';

/** Env kill switch: unset or anything but "0" means enabled. */
const envEnabled = (name) => String(process.env[name] || '1').trim() !== '0';
/** Env opt-in: only "1" enables. For packs whose feed access needs an
 * operator agreement or whose terms are unconfirmed, so an unset flag never
 * reaches the upstream. */
const envOptIn = (name) => String(process.env[name] || '').trim() === '1';

/**
 * Live open-data packs, in merge order. Adding a region is one entry here
 * plus its loader (in sources.js or its own module); the catalog cap is
 * shared across entries round-robin (cap.js), so a new pack never silently
 * evicts an older one.
 * Each pack fails independently (allSettled) and is gated by its own env
 * kill switch, or by an opt-in flag where access needs an agreement or the
 * terms are unconfirmed.
 */
const LIVE_PACKS = [
  { name: 'austin', enabled: () => true, load: loadAustinSourcesFromOpenData },
  {
    name: 'caltrans',
    enabled: () => true,
    load: loadCaltransSourcesFromOpenData,
  },
  {
    name: 'tfl',
    enabled: () => envEnabled('CCTV_TFL_ENABLED'),
    label: 'Transport for London JamCams',
    area: { south: 51.28, west: -0.51, north: 51.69, east: 0.33 },
    offHint: 'CCTV_TFL_ENABLED is set to 0; remove it to turn the pack on',
    load: loadTflSourcesFromOpenData,
  },
  {
    name: 'ontario',
    enabled: () => envEnabled('CCTV_ONTARIO_ENABLED'),
    // The 511on.ca API needs a developer key; without it the pack is empty.
    unavailable: () =>
      String(process.env.ONTARIO_511_API_KEY ?? '').trim()
        ? null
        : 'set ONTARIO_511_API_KEY (a free 511on.ca developer key)',
    label: 'Ontario 511',
    area: { south: 41.6, west: -95.2, north: 56.9, east: -74.3 },
    offHint: 'CCTV_ONTARIO_ENABLED is set to 0; remove it to turn the pack on',
    load: loadOntarioSourcesFromOpenData,
  },
  {
    name: 'fintraffic',
    enabled: () => envEnabled('CCTV_FINTRAFFIC_ENABLED'),
    label: 'Fintraffic (Finland)',
    area: { south: 59.7, west: 20.5, north: 70.1, east: 31.6 },
    offHint:
      'CCTV_FINTRAFFIC_ENABLED is set to 0; remove it to turn the pack on',
    load: loadFintrafficSourcesFromOpenData,
  },
  {
    name: 'drivebc',
    enabled: () => envEnabled('CCTV_DRIVEBC_ENABLED'),
    label: 'DriveBC (British Columbia)',
    area: { south: 48.2, west: -139.1, north: 60.0, east: -114.0 },
    offHint: 'CCTV_DRIVEBC_ENABLED is set to 0; remove it to turn the pack on',
    load: loadDriveBcSourcesFromOpenData,
  },
  {
    name: 'txdot',
    enabled: () => envEnabled('CCTV_TXDOT_ENABLED'),
    label: 'TxDOT (Texas)',
    area: { south: 25.8, west: -106.7, north: 36.5, east: -93.5 },
    offHint: 'CCTV_TXDOT_ENABLED is set to 0; remove it to turn the pack on',
    load: loadTxdotSourcesFromOpenData,
  },
  {
    name: 'tallinn',
    enabled: () => envEnabled('CCTV_TALLINN_ENABLED'),
    label: 'City of Tallinn',
    area: { south: 59.35, west: 24.55, north: 59.5, east: 24.95 },
    offHint: 'CCTV_TALLINN_ENABLED is set to 0; remove it to turn the pack on',
    load: loadTallinnSourcesFromCatalog,
  },
  {
    name: 'tarktee',
    enabled: () => envEnabled('CCTV_TARKTEE_ENABLED'),
    label: 'Transpordiamet (Estonia)',
    area: { south: 57.5, west: 21.7, north: 59.7, east: 28.2 },
    offHint: 'CCTV_TARKTEE_ENABLED is set to 0; remove it to turn the pack on',
    load: loadTarkteeSourcesFromDatex,
  },
  {
    name: 'warendorf',
    enabled: () => envEnabled('CCTV_WARENDORF_ENABLED'),
    label: 'Stadt Warendorf',
    area: { south: 51.9, west: 7.9, north: 52.0, east: 8.1 },
    offHint:
      'CCTV_WARENDORF_ENABLED is set to 0; remove it to turn the pack on',
    load: loadWarendorfSourcesFromCatalog,
  },
  {
    name: 'nsw',
    enabled: () => envEnabled('CCTV_NSW_ENABLED'),
    label: 'Live Traffic NSW',
    area: { south: -37.6, west: 140.9, north: -28.1, east: 153.7 },
    offHint: 'CCTV_NSW_ENABLED is set to 0; remove it to turn the pack on',
    load: loadNswSourcesFromOpenData,
  },
  {
    name: 'calgary',
    enabled: () => envEnabled('CCTV_CALGARY_ENABLED'),
    label: 'City of Calgary',
    area: { south: 50.8, west: -114.35, north: 51.25, east: -113.85 },
    offHint: 'CCTV_CALGARY_ENABLED is set to 0; remove it to turn the pack on',
    load: loadCalgarySourcesFromOpenData,
  },
  {
    name: 'catalonia',
    enabled: () => envEnabled('CCTV_CATALONIA_ENABLED'),
    label: 'Servei Català de Trànsit',
    area: { south: 40.5, west: 0.15, north: 42.9, east: 3.35 },
    offHint:
      'CCTV_CATALONIA_ENABLED is set to 0; remove it to turn the pack on',
    load: loadCataloniaSourcesFromOpenData,
  },
  {
    name: 'deldot',
    enabled: () => envEnabled('CCTV_DELDOT_ENABLED'),
    label: 'DelDOT (Delaware)',
    area: { south: 38.45, west: -75.8, north: 39.85, east: -75.0 },
    offHint: 'CCTV_DELDOT_ENABLED is set to 0; remove it to turn the pack on',
    load: loadDelDOTSourcesFromOpenData,
  },
  {
    name: 'kingcounty',
    enabled: () => envEnabled('CCTV_KINGCOUNTY_ENABLED'),
    label: 'King County Road Services',
    area: { south: 47.08, west: -122.55, north: 47.78, east: -121.06 },
    offHint:
      'CCTV_KINGCOUNTY_ENABLED is set to 0; remove it to turn the pack on',
    load: loadKingCountySourcesFromOpenData,
  },
  {
    name: 'wsdot',
    enabled: () => envEnabled('CCTV_WSDOT_ENABLED'),
    label: 'WSDOT (Washington)',
    area: { south: 45.5, west: -124.8, north: 49.0, east: -116.9 },
    offHint: 'CCTV_WSDOT_ENABLED is set to 0; remove it to turn the pack on',
    load: loadWsdotSourcesFromOpenData,
  },
  {
    name: 'vegvesen',
    enabled: () => envEnabled('CCTV_VEGVESEN_ENABLED'),
    label: 'Statens vegvesen (Norway)',
    area: { south: 57.9, west: 4.5, north: 71.2, east: 31.1 },
    offHint: 'CCTV_VEGVESEN_ENABLED is set to 0; remove it to turn the pack on',
    load: loadVegvesenSourcesFromOpenData,
  },
  {
    // NYC DOT requires a data-sharing agreement for this feed, so the pack is
    // off unless the operator opts in (see DATA_SOURCES.md).
    name: 'nyc',
    enabled: () => envOptIn('CCTV_NYC_ENABLED'),
    label: 'NYC DOT',
    area: { south: 40.49, west: -74.26, north: 40.92, east: -73.7 },
    offHint:
      "set CCTV_NYC_ENABLED=1; NYC DOT's feed needs a data-sharing agreement",
    load: loadNycSourcesFromOpenData,
  },
  {
    name: 'toronto',
    enabled: () => envEnabled('CCTV_TORONTO_ENABLED'),
    label: 'City of Toronto RESCU',
    area: { south: 43.58, west: -79.64, north: 43.86, east: -79.11 },
    offHint: 'CCTV_TORONTO_ENABLED is set to 0; remove it to turn the pack on',
    load: loadTorontoSourcesFromOpenData,
  },
  {
    // Opt-in until the Via Lietuva open-data terms are confirmed to cover the
    // camera photos (see DATA_SOURCES.md).
    name: 'lithuania',
    enabled: () => envOptIn('CCTV_LITHUANIA_ENABLED'),
    label: 'Via Lietuva (Lithuania)',
    area: { south: 53.9, west: 20.9, north: 56.5, east: 26.9 },
    offHint: 'set CCTV_LITHUANIA_ENABLED=1; the photo terms are unconfirmed',
    load: loadLithuaniaSources,
  },
];
/**
 * Camera packs that are switched off here, with where their cameras would be
 * and what turns them on, so an empty camera search can say why instead of
 * implying no cameras exist.
 * @returns {Array<{pack: string, region: object, enable: string}>}
 */
export function cctvOffPacks() {
  return LIVE_PACKS.filter(
    (pack) => pack.area && (!pack.enabled() || pack.unavailable?.()),
  ).map((pack) => ({
    pack: pack.label,
    region: pack.area,
    enable: !pack.enabled() ? pack.offHint : pack.unavailable(),
  }));
}

/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
function loadSourcesFromFile(sourceRoot) {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] failed to read source file:',
      resolved,
      error?.message || error,
    );
    return [];
  }
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Create an independent catalog rooted in the consuming application. */
export function createCctvCatalog({ sourceRoot = process.cwd() } = {}) {
  /** @type {Array<object>} Cached merged + normalized CCTV source list. */
  let _cctvSourceCache = [];
  /** @type {number} Epoch-ms when the source cache was last refreshed. */
  let _cctvSourceCacheAt = 0;
  /** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
   * callers so a post-TTL burst launches ONE refetch, not one per request. */
  let _cctvSourceInflight = null;
  /** @type {Array<{pack: string, available: number, served: number}>} Packs
   * that serve fewer cameras than they offer. */
  let _cctvTrimmedPacks = [];

  /**
   * Assemble and cache the merged CCTV source list.
   *
   * Merges every source pack (live open-data packs, local file, env
   * variable), deduplicates by ID, shares the catalog cap fairly across
   * packs, and caches for CCTV_SOURCE_CACHE_MS. Past that, the cached list is
   * returned while a background refresh replaces it; only a first load waits.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function getCctvSources() {
    const now = Date.now();
    if (
      _cctvSourceCache.length &&
      now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS
    ) {
      return _cctvSourceCache;
    }
    // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
    // instead of each launching the full multi-provider refetch. The `.finally`
    // clears the ref so the next post-TTL cycle starts fresh.
    if (!_cctvSourceInflight) {
      _cctvSourceInflight = refreshCctvSources().finally(() => {
        _cctvSourceInflight = null;
      });
      // A background refresh has no caller waiting on it: report its failure
      // here, once per refresh rather than once per request it serves.
      if (_cctvSourceCache.length) {
        _cctvSourceInflight.catch((error) => {
          console.warn(
            '[CCTV] background catalog refresh failed:',
            error?.message || error,
          );
        });
      }
    }
    // With a catalog in hand, answer with it while the refresh runs: the
    // refresh lasts as long as the slowest pack (Tarktee's DATEX feeds take up
    // to its 30 s timeout), and every /api/cctv request would otherwise wait
    // for it. Only the first load, with nothing to serve yet, waits.
    return _cctvSourceCache.length ? _cctvSourceCache : _cctvSourceInflight;
  }

  /**
   * Assemble and cache the merged CCTV source list from file/env + live packs.
   * Always resolves (loaders self-catch to []); on a fully-empty refresh with a
   * good prior catalog it serves stale rather than blanking the CCTV layer.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function refreshCctvSources() {
    const fromFile = loadSourcesFromFile(sourceRoot);
    const fromEnv = loadSourcesFromEnv();

    const forceAustin =
      String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
    const preferAustin =
      String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
    // Live open-data packs load unless a file/env pack is configured and live
    // packs aren't forced — the same gate that governed the Austin-only fetch
    // now governs every entry in LIVE_PACKS.
    const needsLiveSources =
      forceAustin || (fromFile.length + fromEnv.length === 0 && preferAustin);
    const liveResults = needsLiveSources
      ? await Promise.allSettled(
          // Invoked inside the promise so a loader that throws synchronously
          // (a file-based pack on a malformed row) is isolated like any other
          // failed pack instead of rejecting the whole refresh.
          LIVE_PACKS.map((pack) =>
            Promise.resolve().then(() =>
              pack.enabled() ? pack.load({ sourceRoot }) : [],
            ),
          ),
        )
      : [];
    // Live packs first so file/env overrides win on duplicate IDs; each pack
    // keeps its own priority order and the catalog cap is shared fairly.
    const normalizePack = (name, items) => ({
      name,
      sources: items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({ ...normalizeSourceItem(item), pack: name }))
        .filter((item) => item.id),
      available: Number.isFinite(items.available)
        ? items.available
        : items.length,
      region: items.region ?? null,
    });
    const packs = [
      ...LIVE_PACKS.map((pack, index) =>
        normalizePack(
          pack.name,
          liveResults[index]?.status === 'fulfilled'
            ? liveResults[index].value
            : [],
        ),
      ),
      normalizePack('file', fromFile),
      normalizePack('env', fromEnv),
    ];
    const maxCount = resolveCatalogCap(process.env.CCTV_MAX_SOURCES);
    const allocation = allocateSourceCap(packs, maxCount);
    // Shipped ground heights (src/data/local_data/cctv_ground_heights/, produced by
    // scripts/precompute-cctv-heights.mjs) ride along on the served source so
    // the client can place a camera and its monitor plane with zero sampling.
    const capped = joinGroundHeights(
      allocation.sources,
      loadGroundHeights(sourceRoot),
    );
    const trimmed = allocation.packs.filter((pack) => pack.kept < pack.offered);
    // Each pack's own nearest-first cap and the shared catalog cap both trim.
    const trimmedPacks = packs
      .map((pack, index) => ({
        pack: pack.name,
        available: Math.max(pack.available, allocation.packs[index].offered),
        served: allocation.packs[index].kept,
        // Where the pack's cameras are, including those not served.
        region: pack.region ?? cameraRegion(pack.sources),
      }))
      .filter((pack) => pack.served < pack.available);
    if (trimmed.length) {
      const detail = trimmed
        .map((pack) => `${pack.name} ${pack.kept}/${pack.offered}`)
        .join(', ');
      console.warn(
        `[CCTV] source catalog exceeds cap ${maxCount}; shared round-robin across packs (${detail}). Raise CCTV_MAX_SOURCES or lower a per-pack cap to change the mix.`,
      );
    }
    if (capped.length > 0 || _cctvSourceCache.length === 0) {
      _cctvSourceCache = capped;
      _cctvTrimmedPacks = trimmedPacks;
    } else {
      // Every source came back empty (all live packs timed out / upstream outage)
      // but a good catalog is already cached — serve it stale rather than blanking
      // every CCTV route. Advancing the timestamp waits one TTL before retrying,
      // which (with single-flight) bounds load on a persistently-down upstream.
      console.warn(
        `[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`,
      );
    }
    _cctvSourceCacheAt = Date.now();
    return _cctvSourceCache;
  }

  /** Packs serving fewer cameras than they offer, as of the last refresh. */
  getCctvSources.trimmedPacks = () => _cctvTrimmedPacks;
  return getCctvSources;
}
